/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { getTelemetryLevel } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { backboardConfigAccessToken, backboardConfigResource, readBackboardConfigJson } from '../../chat/common/backboardAuth.js';

/** Conversions the desktop app reports to the ad platforms. */
export type DesktopConversion = 'signed_in' | 'first_chat_message_sent' | 'checkout_started';

interface IConversionDetails {
	readonly eventId?: string;
	readonly value?: number;
	readonly currency?: string;
	readonly transactionId?: string;
	readonly kind?: string;
}

/**
 * Reports account and activation events to PostHog, with optional forwarding
 * through an authenticated relay. Payment revenue must come from confirmed
 * billing events on the backend; credit grants are not cash receipts.
 */
export class BackboardConversions {

	private readonly relayUrl = product.backboardAnalytics?.conversionsUrl?.trim() || undefined;

	constructor(
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) { }

	/** True when there is somewhere to send conversions and telemetry is on. */
	get enabled(): boolean {
		return !!this.relayUrl && getTelemetryLevel(this.configurationService) >= TelemetryLevel.USAGE;
	}

	/**
	 * Records the conversion in PostHog and forwards it to the ad platforms.
	 * Fire-and-forget: a relay failure is logged, never retried, so PostHog
	 * never sees the same conversion twice.
	 */
	async report(event: DesktopConversion, details: IConversionDetails = {}): Promise<void> {
		const eventId = details.eventId ?? generateUuid();
		this.analytics.capture(event, {
			event_id: eventId,
			value: details.value,
			currency: details.currency,
			transaction_id: details.transactionId,
			kind: details.kind,
		});
		if (!this.enabled) {
			return;
		}
		const config = await readBackboardConfigJson(this.fileService, await backboardConfigResource(this.pathService));
		const auth = backboardConfigAccessToken(config);
		if (!auth) {
			// API-key-only users have no sign-in the relay can verify; PostHog still has it.
			return;
		}
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: this.relayUrl!,
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth}` },
				data: JSON.stringify({
					source: 'desktop',
					event,
					event_id: eventId,
					value: details.value,
					currency: details.currency,
					transaction_id: details.transactionId,
					properties: { kind: details.kind, app_version: product.backboardVersion ?? product.version },
				}),
				callSite: 'backboardConversions.report',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				this.logService.trace(`[backboardConversions] relay rejected ${event}: ${status}`);
			}
		} catch (error) {
			this.logService.trace(`[backboardConversions] relay failed for ${event}`, error);
		}
	}

}
