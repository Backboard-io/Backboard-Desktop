/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { getTelemetryLevel } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { BackboardAnalyticsEvent, BackboardAnalyticsProps, IBackboardAnalyticsService } from '../common/backboardAnalytics.js';

const ANON_ID_KEY = 'backboardAnalytics.anonymousId';
const USER_ID_KEY = 'backboardAnalytics.userId';
const FLUSH_DELAY_MS = 3000;
const MAX_BATCH = 50;

/** PostHog properties may nest one level for `$set`. */
type PostHogProperties = Record<string, string | number | boolean | undefined | BackboardAnalyticsProps>;

interface IQueuedEvent {
	readonly event: string;
	readonly distinct_id: string;
	readonly timestamp: string;
	readonly properties: PostHogProperties;
}

/**
 * Sends product analytics to PostHog's batch endpoint. Inert until
 * `product.json` has `backboardAnalytics.posthogKey`, and silent whenever the
 * user's `telemetry.telemetryLevel` is below "all".
 *
 * Requests go through {@link IRequestService} (main process), so they are not
 * subject to renderer CORS or CSP.
 */
export class BackboardAnalyticsService extends Disposable implements IBackboardAnalyticsService {
	declare readonly _serviceBrand: undefined;

	private readonly key = product.backboardAnalytics?.posthogKey?.trim() || undefined;
	private readonly host = (product.backboardAnalytics?.posthogHost?.trim() || 'https://us.i.posthog.com').replace(/\/+$/, '');
	private readonly superProps: BackboardAnalyticsProps = {
		$lib: 'backboard-desktop',
		app_version: product.backboardVersion ?? product.version,
		os: OS === OperatingSystem.Macintosh ? 'mac' : OS === OperatingSystem.Windows ? 'windows' : 'linux',
		quality: product.quality,
	};
	private queue: IQueuedEvent[] = [];
	private readonly flusher = this._register(new RunOnceScheduler(() => void this.flush(), FLUSH_DELAY_MS));

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this._register(lifecycleService.onWillShutdown(() => void this.flush()));
	}

	get enabled(): boolean {
		return !!this.key && getTelemetryLevel(this.configurationService) >= TelemetryLevel.USAGE;
	}

	capture(event: BackboardAnalyticsEvent, props: BackboardAnalyticsProps = {}): void {
		this.enqueue(event, props);
	}

	private enqueue(event: string, props: PostHogProperties): void {
		if (!this.enabled) {
			return;
		}
		this.queue.push({
			event,
			distinct_id: this.distinctId(),
			timestamp: new Date().toISOString(),
			properties: { ...this.superProps, ...props },
		});
		if (this.queue.length >= MAX_BATCH) {
			void this.flush();
		} else if (!this.flusher.isScheduled()) {
			this.flusher.schedule();
		}
	}

	identify(userId: string, traits: BackboardAnalyticsProps = {}): void {
		if (!this.enabled || !userId) {
			return;
		}
		const anonId = this.anonymousId();
		const previous = this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION);
		this.storageService.store(USER_ID_KEY, userId, StorageScope.APPLICATION, StorageTarget.MACHINE);
		// Only the first identify needs to merge the anonymous history; later
		// ones just refresh the person's traits.
		this.enqueue('$identify', {
			$anon_distinct_id: previous === userId ? undefined : anonId,
			$set: traits,
		});
	}

	register(props: BackboardAnalyticsProps): void {
		Object.assign(this.superProps, props);
	}

	private distinctId(): string {
		return this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION) ?? this.anonymousId();
	}

	private anonymousId(): string {
		let id = this.storageService.get(ANON_ID_KEY, StorageScope.APPLICATION);
		if (!id) {
			id = generateUuid();
			this.storageService.store(ANON_ID_KEY, id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return id;
	}

	private async flush(): Promise<void> {
		this.flusher.cancel();
		if (!this.key || this.queue.length === 0) {
			return;
		}
		const batch = this.queue;
		this.queue = [];
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${this.host}/batch/`,
				data: JSON.stringify({ api_key: this.key, batch }),
				headers: { 'Content-Type': 'application/json' },
				callSite: 'backboardAnalytics.flush',
			}, CancellationToken.None);
			if (context.res.statusCode && context.res.statusCode >= 300) {
				this.logService.trace(`[backboardAnalytics] PostHog batch rejected: ${context.res.statusCode}`);
			}
		} catch (error) {
			this.logService.trace('[backboardAnalytics] PostHog batch failed', error);
		}
	}
}

registerSingleton(IBackboardAnalyticsService, BackboardAnalyticsService, InstantiationType.Delayed);
