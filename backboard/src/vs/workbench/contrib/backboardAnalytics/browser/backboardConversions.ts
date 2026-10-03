/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { getTelemetryLevel } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { backboardApiBaseUrl, backboardConfigAccessToken, backboardConfigApiKey, backboardConfigResource, readBackboardConfigJson } from '../../chat/common/backboardAuth.js';

/** Conversions the desktop app reports to the ad platforms. */
export type DesktopConversion = 'signed_in' | 'first_chat_message_sent' | 'checkout_started' | 'purchase_completed';

interface IConversionDetails {
	readonly eventId?: string;
	readonly value?: number;
	readonly currency?: string;
	readonly transactionId?: string;
	readonly kind?: string;
}

/** One row of `GET /billing/history` (Backboard-API `CreditLedger`). */
interface ILedgerEntry {
	readonly id: number;
	readonly change_usd: number;
	readonly reason: string;
	readonly stripe_invoice_id?: string | null;
	readonly created_at: string;
}

/** Ledger reasons that mean the customer paid money. */
const PAID_REASONS = new Set(['subscription_grant', 'subscription_upgrade', 'credit_purchase', 'auto_reload']);
const LEDGER_CURSOR_KEY = 'backboardAnalytics.ledgerCursor';

/**
 * Sends desktop conversions to the ad platforms (Meta, Google Ads, X,
 * LinkedIn). The app can't run ad pixels and must not ship ad-platform
 * secrets, so it posts to a conversions relay
 * (`product.backboardAnalytics.conversionsUrl`) authenticated with the user's
 * own Backboard sign-in. The relay checks the token, matches people by their
 * verified email, re-checks purchases against the billing ledger, and holds
 * the ad tokens.
 *
 * Purchases happen in the browser on app.backboard.io, so they are found by
 * reading the account's billing ledger: at startup, when the window regains
 * focus, and on a short timer after the user clicks Upgrade.
 */
export class BackboardConversions {

	private readonly relayUrl = product.backboardAnalytics?.conversionsUrl?.trim() || undefined;
	private checkingPurchases = false;

	constructor(
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
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

	/**
	 * Reports ledger entries that are new since the last check. The first check
	 * for an account only records where the ledger is, so past purchases are
	 * never reported.
	 */
	async checkPurchases(accountId: string): Promise<void> {
		if (this.checkingPurchases) {
			return;
		}
		this.checkingPurchases = true;
		try {
			const entries = await this.ledger();
			if (!entries) {
				return;
			}
			const cursorKey = `${LEDGER_CURSOR_KEY}.${accountId}`;
			const cursor = this.storageService.getNumber(cursorKey, StorageScope.APPLICATION);
			const newest = entries.reduce((max, entry) => Math.max(max, entry.id), cursor ?? 0);
			if (cursor === undefined) {
				this.storageService.store(cursorKey, newest, StorageScope.APPLICATION, StorageTarget.MACHINE);
				return;
			}
			// Move the cursor first so an overlapping check in another window
			// doesn't report the same rows.
			this.storageService.store(cursorKey, newest, StorageScope.APPLICATION, StorageTarget.MACHINE);
			const purchases = entries
				.filter(entry => entry.id > cursor && PAID_REASONS.has(entry.reason) && entry.change_usd > 0)
				.sort((a, b) => a.id - b.id);
			for (const entry of purchases) {
				await this.report('purchase_completed', {
					// The ledger id is stable, so a retry from another window or
					// machine de-duplicates on the ad platforms.
					eventId: `ledger-${entry.id}`,
					transactionId: String(entry.id),
					value: entry.change_usd,
					currency: 'USD',
					kind: entry.reason,
				});
			}
		} finally {
			this.checkingPurchases = false;
		}
	}

	private async ledger(): Promise<readonly ILedgerEntry[] | undefined> {
		const config = await readBackboardConfigJson(this.fileService, await backboardConfigResource(this.pathService));
		// /billing/history accepts API keys and web sessions. OAuth sign-in
		// tokens only work there once Backboard-API switches that route to
		// get_current_user_with_db_dual, so an API key is tried first.
		const apiKey = this.configurationService.getValue<string>('backboard.apiKey') || backboardConfigApiKey(config);
		const accessToken = backboardConfigAccessToken(config);
		const headers: Record<string, string> | undefined = apiKey ? { 'X-API-Key': apiKey } : accessToken ? { 'Authorization': `Bearer ${accessToken}` } : undefined;
		if (!headers) {
			return undefined;
		}
		const base = backboardApiBaseUrl(config, this.configurationService.getValue<string>('backboard.apiUrl') || undefined, this.configurationService.getValue<string>('backboard.env') || undefined);
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: `${base}/billing/history?limit=50`,
				headers,
				callSite: 'backboardConversions.ledger',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				this.logService.trace(`[backboardConversions] billing history returned ${status}`);
				return undefined;
			}
			const body: unknown = JSON.parse((await streamToBuffer(context.stream)).toString());
			return Array.isArray(body) ? body.filter(isLedgerEntry) : undefined;
		} catch (error) {
			this.logService.trace('[backboardConversions] billing history failed', error);
			return undefined;
		}
	}

}

function isLedgerEntry(value: unknown): value is ILedgerEntry {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const entry = value as Partial<ILedgerEntry>;
	return typeof entry.id === 'number' && typeof entry.change_usd === 'number' && typeof entry.reason === 'string';
}
