/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError, RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { BackboardAnalyticsProps, IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardOAuth, backboardConfigAccessToken, backboardConfigResource, readBackboardConfigJson } from '../../chat/common/backboardAuth.js';
import { isBackboardOAuthRotation, refreshBackboardOAuthCredentials } from '../../chat/browser/backboardUserInfo.js';
import { BillingOperation, IBackboardBillingService, IBillingAutoReload, IBillingCatalog, IBillingStatus, IPendingAccountCheckout, IPendingBillingCheckout, isBillingCreditAmount, isBillingSessionId, parsePendingCheckout } from '../common/backboardBilling.js';

const checkoutAnalyticsKey = 'backboardAnalytics.billingCheckoutOutcomes';
const pendingKey = 'backboard.billing.pendingCheckout';
const apiOrigin = BackboardOAuth.userInfoUrl.slice(0, BackboardOAuth.userInfoUrl.lastIndexOf('/oauth/'));

export class BillingRequestError extends Error {
	constructor(readonly statusCode: number, message: string, readonly code?: string, readonly pendingCheckout?: IPendingAccountCheckout) { super(message); }
}

export class BackboardBillingService extends Disposable implements IBackboardBillingService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	status: IBillingStatus | undefined;
	catalog: IBillingCatalog | undefined;
	pending: IPendingBillingCheckout | undefined;
	loading = false;
	busy = false;
	message = '';
	needsSignIn = false;
	private revision = 0;
	private readonly observedStatus = new Map<number, { snapshot: string; subscription: string }>();
	private queuedRefresh = false;
	private queuedSessionId: string | undefined;
	private readonly configResource: Promise<URI>;
	private readonly expirationRefresh = this._register(new RunOnceScheduler(() => {
		if (this.status?.pending_checkout?.state === 'open') {
			this.message = 'Confirming checkout expiration…';
			this.changed.fire();
			void this.refresh();
		}
	}, 0));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IHostService hostService: IHostService,
		@ICommandService commandService: ICommandService,
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
	) {
		super();
		this.configResource = backboardConfigResource(pathService);
		try {
			const stored = JSON.parse(storageService.get(pendingKey, StorageScope.APPLICATION, 'null'));
			this.pending = parsePendingCheckout(stored);
		} catch { /* An invalid local record is not a checkout. */ }
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, pendingKey, this._store)(() => {
			try { this.pending = parsePendingCheckout(JSON.parse(storageService.get(pendingKey, StorageScope.APPLICATION, 'null'))); }
			catch { this.pending = undefined; }
			this.changed.fire();
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused && !this.busy && !this.loading) { void this.refresh(); }
		}));
		this._register(commandService.onDidExecuteCommand(event => {
			if (['backboard.signIn', 'backboard.extension.signIn', 'backboard.signOut', 'backboard.extension.signOut'].includes(event.commandId)) { void this.refresh(); }
		}));
	}

	private savePending(value: IPendingBillingCheckout | undefined): void {
		this.pending = value;
		if (value) { this.storageService.store(pendingKey, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.MACHINE); }
		else { this.storageService.remove(pendingKey, StorageScope.APPLICATION); }
	}

	/** Billing context is separate from the signed-in person's PostHog identity. */
	private billingProps(status = this.status): BackboardAnalyticsProps {
		return {
			billing_account_id: status?.account.id,
			plan: status?.plan?.plan_name ?? 'free', subscription_status: status?.plan?.status ?? 'none',
			cancel_at_period_end: status?.plan?.cancel_at_period_end ?? false,
			scheduled_downgrade_plan: status?.plan?.scheduled_downgrade_plan,
			plan_monthly_amount_usd: status?.plan?.plan_amount_usd,
			credit_balance_usd: status?.wallet.balance_usd,
			purchased_credit_balance_usd: status?.wallet.purchased_balance_usd,
			included_credit_remaining_usd: status?.wallet.plan_grant_remaining_usd,
			auto_reload_enabled: status?.wallet.auto_reload_enabled,
		};
	}

	private observeBillingStatus(): void {
		if (!this.analytics.enabled || !this.status) { return; }
		const props = this.billingProps();
		const snapshot = JSON.stringify(props);
		const subscription = JSON.stringify(this.status.plan);
		const previous = this.observedStatus.get(this.status.account.id);
		if (snapshot !== previous?.snapshot) { this.analytics.capture('billing_status_loaded', props); }
		// An existing subscription on first load is a snapshot, not a new sale.
		if (previous && subscription !== previous.subscription) {
			this.analytics.capture('billing_subscription_changed', props);
		}
		this.observedStatus.set(this.status.account.id, { snapshot, subscription });
	}

	private trackCheckoutOutcome(state: string, pending: IPendingBillingCheckout | undefined, operation?: string): void {
		if (!this.analytics.enabled || !['fulfilled', 'expired', 'failed'].includes(state) || !pending) { return; }
		const ids = [pending.operationId, pending.sessionId].filter((id): id is string => !!id).map(id => `${pending.accountId}:${id}:${state}`);
		if (!ids.length) { return; }
		let seen: string[] = [];
		try {
			const stored = JSON.parse(this.storageService.get(checkoutAnalyticsKey, StorageScope.APPLICATION, '[]'));
			if (Array.isArray(stored)) { seen = stored.filter(id => typeof id === 'string'); }
		} catch { /* Invalid local deduplication records do not affect billing. */ }
		if (ids.some(id => seen.includes(id))) { return; }
		const eventId = `desktop-billing-${ids[0]}`;
		this.analytics.capture(state === 'fulfilled' ? 'billing_checkout_completed' : state === 'expired' ? 'billing_checkout_expired' : 'billing_checkout_failed', {
			...this.billingProps(), billing_account_id: pending.accountId,
			kind: operation ?? pending.operation ?? 'checkout', requested_plan: pending.plan,
			requested_amount_usd: pending.amountUsd, confirmation_source: 'billing_api',
			event_id: eventId, $insert_id: eventId,
		});
		this.storageService.store(checkoutAnalyticsKey, JSON.stringify([...seen, ...ids].slice(-200)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private restoreAccountCheckout(status: IBillingStatus): void {
		const remote = status.pending_checkout;
		this.expirationRefresh.cancel();
		if (remote?.state === 'open' && remote.expires_at && remote.expires_at * 1000 > Date.now()) {
			this.expirationRefresh.schedule(remote.expires_at * 1000 - Date.now() + 50);
		}
		if (!remote) { return; }
		if (remote.is_initiator && remote.operation_id) {
			const previous = this.pending?.accountId === status.account.id && this.pending.operationId === remote.operation_id ? this.pending : undefined;
			this.savePending({ ...previous, accountId: status.account.id, operationId: remote.operation_id,
				...(remote.operation === 'credits' ? { operation: 'credits/checkout', amountUsd: remote.amount_usd }
					: remote.operation === 'subscribe' || remote.operation === 'change-plan' ? { operation: remote.operation, plan: ['starter', 'builder', 'scale'].includes(remote.target_plan?.toLowerCase() ?? '') ? remote.target_plan?.toLowerCase() : undefined } : {}) });
		}
		this.message = !remote.is_initiator ? 'Another admin has a checkout in progress.'
			: remote.state === 'requires_review' ? 'This payment needs review. Please contact support.'
				: remote.state === 'processing' ? 'Payment is still processing. Refresh Billing to check again.'
					: remote.expires_at && remote.expires_at * 1000 <= Date.now() ? 'Confirming checkout expiration…'
						: 'A checkout is pending. Resume or cancel it before starting another purchase.';
	}

	async refresh(sessionId?: string): Promise<void> {
		if (this.busy) { this.queuedRefresh = true; this.queuedSessionId = sessionId ?? this.queuedSessionId; return; }
		const revision = ++this.revision;
		this.loading = true;
		this.message = '';
		this.changed.fire();
		try {
			const [status, catalog] = await Promise.all([
				this.request<IBillingStatus>('/status'), this.request<IBillingCatalog>('/plans'),
			]);
			if (revision !== this.revision || this._store.isDisposed) { return; }
			if (!status.account || typeof status.can_manage_billing !== 'boolean' || !Array.isArray(catalog.plans)) { throw new BillingRequestError(503, 'Billing is temporarily unavailable. Please refresh.'); }
			this.status = status;
			this.catalog = catalog;
			this.needsSignIn = false;
			this.restoreAccountCheckout(status);
			if (!status.pending_checkout && this.pending?.operationId && this.pending.accountId === status.account.id && status.can_manage_billing) {
				const operationId = this.pending.operationId;
				const result = await this.request<{ state: string; operation?: string }>(`/checkouts/${encodeURIComponent(operationId)}?account_id=${status.account.id}`);
				if (revision !== this.revision || this._store.isDisposed) { return; }
				if (['fulfilled', 'expired', 'failed'].includes(result.state)) {
					const confirmed = await this.request<IBillingStatus>(`/status?account_id=${status.account.id}`);
					if (revision !== this.revision || this._store.isDisposed || this.pending?.operationId !== operationId) { return; }
					if (confirmed.account.id !== status.account.id) { throw new BillingRequestError(409, 'Your account changed. Refresh Billing.'); }
					this.status = confirmed;
					this.trackCheckoutOutcome(result.state, this.pending, result.operation);
					this.savePending(undefined);
					this.message = result.state === 'fulfilled' ? result.operation === 'credits' ? 'Your purchased credits are updated.' : 'Your subscription and credits are updated.' : 'This checkout ended. You can start another purchase.';
					this.restoreAccountCheckout(confirmed);
				} else { this.message = 'Payment is still processing. Refresh Billing to check again.'; }
			}
			if (sessionId && !isBillingSessionId(sessionId)) { throw new BillingRequestError(400, 'Invalid checkout link. Refresh Billing to check your purchase.'); }
			if (this.pending && this.pending.accountId !== status.account.id) {
				this.message = 'A checkout was started for a different account. Sign in to that account to check it.';
			} else if (status.pending_checkout && !sessionId && (status.pending_checkout.state === 'open' || !this.pending?.sessionId)) {
				// Account state also restores checkouts created on another device.
			} else if (this.pending && !this.pending.sessionId && !this.pending.operationId) {
				// A return link cannot identify an interrupted request. Recover that
				// request by its id before associating it with any Stripe session.
				this.message = 'The checkout request was interrupted. Use Resume checkout to retry the same purchase.';
			} else if (sessionId || this.pending?.sessionId) {
				// Old browser tabs can return after another purchase has started.
				// Always verify the existing attempt before accepting another link.
				const id = this.pending?.sessionId ?? sessionId!;
				if (status.can_manage_billing) { await this.verify(id, revision); }
				else { this.message = 'An account admin can confirm the pending checkout.'; }
			}
			this.observeBillingStatus();
		} catch (error) {
			if (revision === this.revision) { this.fail(error); }
		} finally {
			if (revision === this.revision) { this.loading = false; this.changed.fire(); }
		}
	}

	private async verify(sessionId: string, revision: number): Promise<void> {
		const accountId = this.status!.account.id;
		const originalPending = this.pending;
		let expectedPending = originalPending;
		const isCurrent = () => revision === this.revision && !this._store.isDisposed
			&& this.status?.account.id === accountId
			&& this.pending?.accountId === expectedPending?.accountId
			&& this.pending?.sessionId === expectedPending?.sessionId
			&& this.pending?.requestId === expectedPending?.requestId;
		const deadline = Date.now() + 60000;
		let delay = 0;
		while (isCurrent() && Date.now() < deadline) {
			if (delay) { await timeout(Math.min(delay, Math.max(deadline - Date.now(), 0))); }
			if (!isCurrent()) { return; }
			const remaining = deadline - Date.now();
			if (remaining <= 0) { break; }
			let result: { state: 'pending' | 'fulfilled' | 'expired' | 'failed'; operation?: string; amount_usd?: number };
			const cancellation = new CancellationTokenSource();
			const deadlineTimer = setTimeout(() => cancellation.cancel(), remaining);
			try {
				result = await raceCancellationError(this.request(`/checkout-status?session_id=${encodeURIComponent(sessionId)}&account_id=${accountId}`, 'GET', Math.min(remaining, 15000), cancellation.token), cancellation.token);
			} catch (error) {
				if (Date.now() >= deadline) { break; }
				throw error;
			} finally { clearTimeout(deadlineTimer); cancellation.dispose(); }
			if (!isCurrent()) { return; }
			if (result.state === 'fulfilled' || result.state === 'expired' || result.state === 'failed') {
				const status = await this.request<IBillingStatus>(`/status?account_id=${accountId}`);
				if (!isCurrent()) { return; }
				if (status.account.id !== accountId) { throw new BillingRequestError(409, 'Your account changed. Refresh Billing.'); }
				this.status = status;
				this.trackCheckoutOutcome(result.state, originalPending ?? { accountId, sessionId }, result.operation);
				this.savePending(undefined);
				this.observeBillingStatus();
				this.message = result.state === 'fulfilled' ? result.operation === 'credits' ? 'Your purchased credits are updated.' : 'Your subscription and credits are updated.' : result.state === 'failed' ? 'Checkout failed. You can start another purchase.' : 'Checkout expired. You can start another purchase.';
				return;
			}
			if (result.state !== 'pending') { throw new BillingRequestError(503, 'Billing verification is temporarily unavailable. Please refresh.'); }
			expectedPending = { ...(originalPending ?? { accountId }), sessionId };
			this.savePending(expectedPending);
			this.message = 'Waiting for checkout and payment confirmation…';
			this.changed.fire();
			delay = delay ? Math.min(delay * 2, 10000) : 1500;
		}
		if (isCurrent()) { this.message = 'Payment is still processing. Refresh Billing to check again.'; }
	}

	async run(operation: BillingOperation, plan?: string, expectedAccountId?: number): Promise<void> {
		if (this.busy || this.loading || !this.status?.can_manage_billing) { return; }
		if (expectedAccountId !== undefined && this.status.account.id !== expectedAccountId) {
			this.message = 'Your billing account changed. Review the selected account and try again.';
			this.changed.fire();
			return;
		}
		if (operation !== 'update-payment-method' && (this.pending || this.status.pending_checkout)) { this.message = 'Finish or resume the existing checkout before changing your subscription.'; this.changed.fire(); return; }
		const accountId = this.status.account.id;
		const requestId = generateUuid();
		if (operation === 'subscribe' || operation === 'change-plan') {
			this.savePending({ accountId, requestId, operation, plan });
		}
		await this.perform(operation, plan, requestId, accountId);
	}

	async buyCredits(amountUsd: number, expectedAccountId?: number): Promise<void> {
		if (this.busy || this.loading || !this.status?.can_manage_billing) { return; }
		if (expectedAccountId !== undefined && this.status.account.id !== expectedAccountId) {
			this.message = 'Your billing account changed. Refresh Billing.';
		} else if (!this.status.can_purchase_credits || !this.catalog?.credit_purchase_minimum_usd) {
			this.message = 'An active subscription is required to add credits.';
		} else if (!isBillingCreditAmount(amountUsd, this.catalog.credit_purchase_minimum_usd)) {
			this.message = `Enter an amount of at least $${this.catalog.credit_purchase_minimum_usd} with no more than two decimal places.`;
		} else if (this.pending || this.status.pending_checkout) {
			this.message = 'Finish or resume the existing checkout before starting another purchase.';
		} else {
			const accountId = this.status.account.id;
			const requestId = generateUuid();
			this.savePending({ accountId, requestId, operation: 'credits/checkout', amountUsd });
			await this.perform('credits/checkout', undefined, requestId, accountId, amountUsd);
			return;
		}
		this.changed.fire();
	}

	async configureAutoReload(config: IBillingAutoReload, expectedAccountId?: number): Promise<boolean> {
		if (this.busy || this.loading || !this.status?.can_manage_billing) { return false; }
		const accountId = this.status.account.id;
		if (expectedAccountId !== undefined && expectedAccountId !== accountId) {
			this.message = 'Your billing account changed. Refresh Billing.';
			this.changed.fire();
			return false;
		}
		if (config.enabled && (!isBillingCreditAmount(config.amount_usd, this.catalog?.auto_reload_minimum_amount_usd ?? 5)
			|| !isBillingCreditAmount(config.threshold_usd, this.catalog?.auto_reload_minimum_threshold_usd ?? 5))) {
			this.message = 'Enter valid auto-reload amounts of at least $5 with no more than two decimal places.';
			this.changed.fire();
			return false;
		}
		this.busy = true;
		++this.revision;
		this.changed.fire();
		try {
			const current = await this.request<IBillingStatus>('/status');
			if (current.account.id !== accountId || !current.can_manage_billing) { throw new BillingRequestError(403, 'Your billing account or permissions changed. Refresh Billing.'); }
			if (config.enabled && !current.can_purchase_credits) { throw new BillingRequestError(403, 'An active subscription is required to enable auto-reload.'); }
			if (config.enabled && (current.pending_checkout || this.pending)) { throw new BillingRequestError(409, 'Finish the existing checkout before enabling auto-reload.'); }
			await this.request(`/auto-reload?account_id=${accountId}`, 'POST', 15000, CancellationToken.None, config);
			this.status = await this.request<IBillingStatus>(`/status?account_id=${accountId}`);
			this.observeBillingStatus();
			this.analytics.capture('billing_auto_reload_updated', { ...this.billingProps(), enabled: config.enabled, threshold_usd: config.threshold_usd, amount_usd: config.amount_usd });
			this.message = config.enabled ? 'Auto-reload settings saved.' : 'Auto-reload is turned off.';
			this.restoreAccountCheckout(this.status);
			return true;
		} catch (error) { this.trackOperationFailure('auto-reload', error); this.fail(error); return false; }
		finally { this.finishOperation(); }
	}

	private async perform(operation: BillingOperation | 'credits/checkout', plan: string | undefined, requestId: string, accountId: number, amountUsd?: number): Promise<void> {
		this.busy = true;
		++this.revision;
		this.message = '';
		this.changed.fire();
		try {
			// Recheck context before a mutation; never charge a newly selected account from stale UI.
			const current = await this.request<IBillingStatus>('/status');
			if (current.account.id !== accountId || !current.can_manage_billing) { throw new BillingRequestError(403, 'Your billing account or permissions changed. Refresh Billing.'); }
			if (operation === 'credits/checkout' && !current.can_purchase_credits) { throw new BillingRequestError(403, 'An active subscription is required to add credits.'); }
			const query = new URLSearchParams({ source: 'desktop', request_id: requestId, account_id: String(accountId) });
			if (plan) { query.set('plan', plan); }
			if (amountUsd !== undefined) { query.set('amount_usd', amountUsd.toFixed(2)); }
			const result = await this.request<{ id?: string; url?: string | null; operation_id?: string; state?: string }>(`/${operation}?${query}`, 'POST');
			this.analytics.capture('billing_operation_requested', { ...this.billingProps(current), kind: operation, requested_plan: plan, requested_amount_usd: amountUsd, event_id: `desktop-billing-request-${requestId}` });
			const purchase = operation === 'subscribe' || operation === 'change-plan' || operation === 'credits/checkout';
			if (purchase && (result.id || result.url)) {
				if (!isBillingSessionId(result.id)) { throw new BillingRequestError(503, 'Checkout could not be verified. Resume checkout to retry.'); }
				this.savePending({ accountId, requestId, operation: operation as IPendingBillingCheckout['operation'], plan, amountUsd, sessionId: result.id, operationId: result.operation_id, url: result.url ?? undefined });
				if (!result.url) {
					// Completed sessions may no longer have a URL. Verify the recovered
					// session rather than treating it as a non-payment settings change.
					this.queuedRefresh = true;
					this.queuedSessionId = result.id;
				}
			} else if (purchase) { this.savePending(undefined); }
			if (result.url) {
				await this.openStripe(result.url, purchase);
				this.message = 'Complete the payment step on Stripe, then return to Desktop.';
			} else {
				this.message = this.pending ? 'Checking the recovered checkout…' : result.state === 'failed' || result.state === 'expired' ? 'This checkout ended. You can start another purchase.' : 'Your subscription settings are updated.';
			}
			this.status = await this.request<IBillingStatus>('/status');
			this.observeBillingStatus();
			this.restoreAccountCheckout(this.status);
		} catch (error) {
			this.trackOperationFailure(operation, error);
			if (error instanceof BillingRequestError && error.pendingCheckout && this.status) {
				this.status = { ...this.status, pending_checkout: error.pendingCheckout };
				this.restoreAccountCheckout(this.status);
			} else if (!this.pending?.sessionId && !this.pending?.operationId && error instanceof BillingRequestError && error.statusCode >= 400 && error.statusCode < 500 && ![401, 408, 409, 429].includes(error.statusCode)) { this.savePending(undefined); }
			this.fail(error);
		} finally { this.finishOperation(); }
	}

	async resumeCheckout(): Promise<void> {
		if (this.status?.pending_checkout) {
			if (this.status.pending_checkout.can_resume) { await this.manageAccountCheckout('resume'); }
			return;
		}
		if (this.pending?.operationId) { await this.refresh(); return; }
		if (this.busy || this.loading || !this.pending || this.pending.accountId !== this.status?.account.id || !this.status.can_manage_billing) { return; }
		if (!this.pending.sessionId && this.pending.requestId && this.pending.operation) {
			await this.perform(this.pending.operation, this.pending.plan, this.pending.requestId, this.pending.accountId, this.pending.amountUsd);
			return;
		}
		if (!this.pending.url) { await this.refresh(); return; }
		this.busy = true;
		this.changed.fire();
		try {
			if (this.pending.url) {
				const current = await this.request<IBillingStatus>('/status');
				if (current.account.id !== this.pending.accountId || !current.can_manage_billing) { throw new BillingRequestError(403, 'Sign in to the account that started this checkout.'); }
				await this.openStripe(this.pending.url, true);
			}
		} catch (error) { this.fail(error); }
		finally { this.finishOperation(); }
	}

	async cancelCheckout(): Promise<void> { await this.manageAccountCheckout('cancel'); }

	private async manageAccountCheckout(action: 'resume' | 'cancel'): Promise<void> {
		const status = this.status;
		const remote = status?.pending_checkout;
		if (this.busy || this.loading || !status?.can_manage_billing || !remote?.operation_id || !remote.is_initiator || !(action === 'resume' ? remote.can_resume : remote.can_cancel)) { return; }
		this.busy = true;
		++this.revision;
		this.changed.fire();
		try {
			const result = await this.request<{ id?: string; url?: string; operation_id: string; state: string }>(`/checkouts/${encodeURIComponent(remote.operation_id)}/${action}?account_id=${status.account.id}`, 'POST');
			this.analytics.capture(action === 'resume' ? 'billing_checkout_resumed' : 'billing_checkout_cancel_requested', { ...this.billingProps(status), kind: remote.operation });
			if (result.state === 'expired' || result.state === 'fulfilled' || result.state === 'failed') {
				this.trackCheckoutOutcome(result.state, { ...this.pending, accountId: status.account.id, operationId: result.operation_id, sessionId: result.id ?? this.pending?.sessionId }, remote.operation);
				this.savePending(undefined);
			} else {
				this.savePending({ ...this.pending, accountId: status.account.id, operationId: result.operation_id, sessionId: result.id, url: result.url });
				if (action === 'resume' && result.url) { await this.openStripe(result.url, true); }
			}
			this.queuedRefresh = true;
		} catch (error) { this.trackOperationFailure(action, error); this.fail(error); }
		finally { this.finishOperation(); }
	}

	private finishOperation(): void {
		this.busy = false;
		this.changed.fire();
		if (this.queuedRefresh) {
			const sessionId = this.queuedSessionId;
			this.queuedRefresh = false;
			this.queuedSessionId = undefined;
			void this.refresh(sessionId);
		}
	}

	private async openStripe(url: string, trackCheckout = false): Promise<void> {
		const parsed = URI.parse(url);
		if (parsed.scheme !== 'https' || !['checkout.stripe.com', 'billing.stripe.com'].includes(parsed.authority)) { throw new BillingRequestError(503, 'Stripe returned an unexpected checkout address. Please retry.'); }
		if (!await this.openerService.open(parsed, { openExternal: true, allowCommands: false })) { throw new Error('Could not open the browser. Use Resume checkout to try again.'); }
		const sessionId = this.pending?.sessionId;
		if (trackCheckout && sessionId && this.analytics.enabled) {
			const eventId = `desktop-checkout-${sessionId}`;
			if (this.storageService.get('backboardAnalytics.lastCheckout', StorageScope.APPLICATION) !== eventId) {
				this.analytics.capture('checkout_started', { event_id: eventId, $insert_id: eventId, ...this.billingProps(), kind: this.pending?.operation ?? 'checkout', requested_plan: this.pending?.plan, requested_amount_usd: this.pending?.amountUsd });
				this.storageService.store('backboardAnalytics.lastCheckout', eventId, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		}
	}

	private trackOperationFailure(operation: string, error: unknown): void {
		// Error messages and checkout URLs can contain private details; send only the status code.
		this.analytics.capture('billing_operation_failed', { ...this.billingProps(), kind: operation, http_status: error instanceof BillingRequestError ? error.statusCode : undefined });
	}

	private fail(error: unknown): void {
		if (error instanceof BillingRequestError && (error.statusCode === 401 || error.message === 'billing_context_required')) {
			this.needsSignIn = true;
			this.status = undefined;
			this.message = 'Sign in to manage billing for your selected account.';
		} else if (error instanceof BillingRequestError && error.statusCode === 404) {
			this.message = 'This checkout is unavailable for the signed-in account, or billing has not been deployed yet. Check your account and refresh.';
		} else if (error instanceof BillingRequestError && error.message === 'subscription_required') {
			this.message = 'An active subscription is required to add credits.';
		} else { this.message = error instanceof Error ? error.message : 'Billing is temporarily unavailable. Please refresh.'; }
		this.logService.warn(`[Backboard Billing] Request failed${error instanceof BillingRequestError ? ` (${error.statusCode})` : ''}.`);
	}

	private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', timeoutMs = 15000, cancellation = CancellationToken.None, body?: unknown): Promise<T> {
		const resource = await this.configResource;
		let token = backboardConfigAccessToken(await readBackboardConfigJson(this.fileService, resource));
		if (!token) { throw new BillingRequestError(401, 'Sign in to manage billing.'); }
		for (let attempt = 0; attempt < 2; attempt++) {
			const context = await this.requestService.request({
				type: method, url: `${apiOrigin}/billing${path}`,
				headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
				...(body !== undefined ? { data: JSON.stringify(body) } : {}), timeout: timeoutMs, callSite: 'backboardBilling.request',
			}, cancellation);
			const code = context.res.statusCode ?? 503;
			const responseBody = (await streamToBuffer(context.stream)).toString();
			let payload: T & { detail?: string; code?: string; pending_checkout?: IPendingAccountCheckout };
			try { payload = JSON.parse(responseBody); } catch { throw new BillingRequestError(code >= 400 ? code : 503, 'Billing is temporarily unavailable. Please refresh.'); }
			if (code === 401 && attempt === 0) {
				const refreshed = await refreshBackboardOAuthCredentials(this.fileService, resource, this.requestService, this.logService, token);
				if (refreshed) { token = refreshed; continue; }
			}
			if (code < 200 || code >= 300) { throw new BillingRequestError(code, typeof payload.detail === 'string' ? payload.detail : 'Billing is temporarily unavailable. Please refresh.', payload.code, payload.pending_checkout); }
			// Ignore a response belonging to credentials replaced by another sign-in.
			const latest = backboardConfigAccessToken(await readBackboardConfigJson(this.fileService, resource));
			if (latest !== token && !isBackboardOAuthRotation(resource, token, latest)) { throw new BillingRequestError(409, 'Your account changed. Refresh Billing.'); }
			return payload;
		}
		throw new BillingRequestError(401, 'Sign in to manage billing.');
	}
}

registerSingleton(IBackboardBillingService, BackboardBillingService, InstantiationType.Delayed);
