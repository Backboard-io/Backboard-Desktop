/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService, isSuccess } from '../../request/common/request.js';
import { IStateService } from '../../state/node/state.js';
import { StorageScope } from '../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { firstSessionDateStorageKey, TelemetryLevel } from '../../telemetry/common/telemetry.js';
import { getTelemetryLevel } from '../../telemetry/common/telemetryUtils.js';

export const STUDIO_PRODUCTION_API_URL = 'https://app.backboard.io/api';
export const STUDIO_TRACKING_API_URL_ENV = 'BACKBOARD_STUDIO_TRACKING_API_URL';
export const STUDIO_INSTALLATION_ID_KEY = 'backboard.studio.installationId';
export const STUDIO_FIRST_LAUNCH_REPORTED_KEY = 'backboard.studio.firstLaunchReported';

const REQUEST_TIMEOUT_MS = 15_000;

/** The parts of Electron's `process` the reporter reads. */
export interface IStudioProcess {
	readonly env: { readonly [key: string]: string | undefined };
	readonly platform: string;
	readonly arch: string;
	readonly windowsStore?: boolean;
}

/** Maps Node's platform and arch to the Backboard release name, e.g. `macos-aarch64`. */
export function studioPlatform(platform: string, arch: string): string | undefined {
	const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
	const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
	return os && cpu ? `${os}-${cpu}` : undefined;
}

/**
 * Reports this installation's first launch to Backboard once, for Studio adoption analytics.
 *
 * Optional telemetry: a failure is only logged. The "reported" flag is set after the server
 * accepts the report, so an offline or rejected launch is reported again on the next start,
 * with the same installation id.
 */
export class StudioFirstLaunchReporter {

	constructor(
		private readonly process: IStudioProcess,
		@IStateService private readonly stateService: IStateService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) { }

	async report(): Promise<void> {
		try {
			await this.doReport();
		} catch (error) {
			this.logService.warn(`[studioTracking] Could not report the first launch: ${toErrorMessage(error)}`);
		}
	}

	private async doReport(): Promise<void> {
		if (this.stateService.getItem<boolean>(STUDIO_FIRST_LAUNCH_REPORTED_KEY, false)) {
			return;
		}
		if (this.environmentMainService.disableTelemetry || getTelemetryLevel(this.configurationService) !== TelemetryLevel.USAGE) {
			return;
		}

		// Dev builds report only when pointed at an API on purpose, so local runs never reach production.
		const apiUrl = this.process.env[STUDIO_TRACKING_API_URL_ENV] ?? (this.environmentMainService.isBuilt ? STUDIO_PRODUCTION_API_URL : undefined);
		const platform = studioPlatform(this.process.platform, this.process.arch);
		const version = this.productService.backboardVersion;
		if (!apiUrl || !platform || !version) {
			return;
		}

		let installationId = this.stateService.getItem<string>(STUDIO_INSTALLATION_ID_KEY);
		if (!installationId) {
			installationId = generateUuid();
			this.stateService.setItem(STUDIO_INSTALLATION_ID_KEY, installationId);
		}

		await this.applicationStorageMainService.whenReady;
		const firstSessionAt = toIsoDate(this.applicationStorageMainService.get(firstSessionDateStorageKey, StorageScope.APPLICATION));

		const context = await this.requestService.request({
			type: 'POST',
			url: `${apiUrl}/studio/events/first-launch`,
			headers: {
				'Content-Type': 'application/json',
				'X-Backboard-Client': `studio/${version}`,
			},
			data: JSON.stringify({
				installation_id: installationId,
				platform,
				version,
				channel: this.productService.backboardUpdateChannel ?? 'dev',
				first_session_at: firstSessionAt,
				package: this.process.windowsStore ? 'store' : undefined,
			}),
			timeout: REQUEST_TIMEOUT_MS,
			callSite: 'studioTracking.firstLaunch',
		}, CancellationToken.None);

		if (isSuccess(context)) {
			this.stateService.setItem(STUDIO_FIRST_LAUNCH_REPORTED_KEY, true);
		} else {
			this.logService.warn(`[studioTracking] The first launch report was not accepted (status ${context.res.statusCode}); retrying on the next start.`);
		}
	}
}

/** `telemetry.firstSessionDate` is stored as `Date.toUTCString()`; the API takes ISO 8601. */
function toIsoDate(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const date = new Date(value);
	return isNaN(date.getTime()) ? undefined : date.toISOString();
}
