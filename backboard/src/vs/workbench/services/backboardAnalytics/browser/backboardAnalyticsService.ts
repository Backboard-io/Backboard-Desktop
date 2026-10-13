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
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { AD_ATTRIBUTION_PARAMS, attributionFromQuery, BackboardAnalyticsEvent, BackboardAnalyticsProps, IBackboardAnalyticsService } from '../common/backboardAnalytics.js';

const ANON_ID_KEY = 'backboardAnalytics.anonymousId';
const USER_ID_KEY = 'backboardAnalytics.userId';
const ATTRIBUTION_KEY = 'backboardAnalytics.attribution';
const ATTRIBUTION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 3000;
const MAX_BATCH = 50;

/** PostHog properties may nest one level for `$set`. */
type PostHogProperties = Record<string, string | number | boolean | undefined | BackboardAnalyticsProps>;

interface IQueuedEvent {
	readonly event: string;
	readonly distinct_id: string;
	readonly timestamp: string;
	readonly properties: PostHogProperties;
	attempts: number;
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
	private flushing = false;
	private attribution: BackboardAnalyticsProps = { marketing_consent: 'denied' };
	private readonly flusher = this._register(new RunOnceScheduler(() => void this.flush(), FLUSH_DELAY_MS));

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this.superProps.$test_event = !environmentService.isBuilt;
		try {
			const saved = JSON.parse(storageService.get(ATTRIBUTION_KEY, StorageScope.APPLICATION) ?? 'null');
			if (saved && typeof saved.at === 'number' && saved.at <= Date.now() && Date.now() - saved.at < ATTRIBUTION_MAX_AGE_MS && typeof saved.query === 'string') {
				this.attribution = attributionFromQuery(saved.query);
			}
		} catch { /* Ignore expired or invalid campaign storage. */ }
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
			properties: {
				...this.superProps, ...this.attribution, ...props,
				$insert_id: props.$insert_id ?? props.event_id ?? generateUuid(),
				$is_identified: !!this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION),
				$process_person_profile: !!this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION),
			},
			attempts: 0,
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
		const previous = this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION);
		if (previous && previous !== userId) {
			this.reset();
		}
		const anonId = this.anonymousId();
		this.storageService.store(USER_ID_KEY, userId, StorageScope.APPLICATION, StorageTarget.MACHINE);
		// Only the first identify needs to merge the anonymous history; later
		// ones just refresh the person's traits.
		this.enqueue('$identify', {
			$anon_distinct_id: previous === userId ? undefined : anonId,
			$set: { ...this.attribution, ...traits },
			$set_once: Object.fromEntries(AD_ATTRIBUTION_PARAMS.map(key => [`$initial_${key}`, this.attribution[`first_${key}`] ?? this.attribution[key]]).filter(([, value]) => value !== undefined)) as BackboardAnalyticsProps,
		});
	}

	reset(): void {
		if (!this.storageService.get(USER_ID_KEY, StorageScope.APPLICATION)) { return; }
		this.storageService.remove(USER_ID_KEY, StorageScope.APPLICATION);
		this.storageService.remove(ANON_ID_KEY, StorageScope.APPLICATION);
		this.clearAttribution();
	}

	register(props: BackboardAnalyticsProps): void {
		Object.assign(this.superProps, props);
	}

	recordAttribution(props: BackboardAnalyticsProps): void {
		if (!this.enabled) { return; }
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(props)) { if (typeof value === 'string') { query.set(key, value); } }
		const next = attributionFromQuery(query.toString());
		if (next.marketing_consent !== 'granted') { this.clearAttribution(); return; }
		this.attribution = next;
		const sanitized = new URLSearchParams(Object.entries(next).map(([key, value]) => [key, String(value)]));
		this.storageService.store(ATTRIBUTION_KEY, JSON.stringify({ at: Date.now(), query: sanitized.toString() }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.capture('ad_attribution_received');
	}

	private clearAttribution(): void {
		this.attribution = { marketing_consent: 'denied' };
		this.storageService.remove(ATTRIBUTION_KEY, StorageScope.APPLICATION);
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
		if (!this.enabled) {
			this.queue = [];
			return;
		}
		if (this.queue.length === 0 || this.flushing) {
			return;
		}
		this.flushing = true;
		const batch = this.queue.splice(0, MAX_BATCH);
		for (const event of batch) { event.attempts++; }
		let retry = false;
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${this.host}/batch/`,
				data: JSON.stringify({ api_key: this.key, batch: batch.map(({ attempts, ...event }) => event) }),
				timeout: 15000,
				headers: { 'Content-Type': 'application/json' },
				callSite: 'backboardAnalytics.flush',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			retry = status === 0 || status === 429 || status >= 500;
			if (status < 200 || status >= 300) {
				this.logService.trace(`[backboardAnalytics] PostHog batch rejected: ${context.res.statusCode}`);
			}
		} catch (error) {
			retry = true;
			this.logService.trace('[backboardAnalytics] PostHog batch failed', error);
		} finally {
			this.flushing = false;
			if (retry && this.enabled) {
				this.queue = [...batch.filter(event => event.attempts < 3), ...this.queue].slice(0, 1000);
			}
			if (this.enabled && this.queue.length) { this.flusher.schedule(retry ? 10000 : FLUSH_DELAY_MS); }
		}
	}
}

registerSingleton(IBackboardAnalyticsService, BackboardAnalyticsService, InstantiationType.Delayed);
