/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError, timeout } from '../../../../base/common/async.js';
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
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardOAuth, backboardConfigAccessToken, backboardConfigResource, readBackboardConfigJson } from '../../chat/common/backboardAuth.js';
import { isBackboardOAuthRotation, refreshBackboardOAuthCredentials } from '../../chat/browser/backboardUserInfo.js';
import { BillingOperation, IBackboardBillingService, IBillingCatalog, IBillingStatus, IPendingBillingCheckout, isBillingSessionId, parsePendingCheckout } from '../common/backboardBilling.js';

const pendingKey = 'backboard.billing.pendingCheckout';
const apiOrigin = BackboardOAuth.userInfoUrl.slice(0, BackboardOAuth.userInfoUrl.lastIndexOf('/oauth/'));

export class BillingRequestError extends Error {
	constructor(readonly statusCode: number, message: string) { super(message); }
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
	private queuedRefresh = false;
	private queuedSessionId: string | undefined;
	private readonly configResource: Promise<URI>;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IHostService hostService: IHostService,
		@ICommandService commandService: ICommandService,
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
			if (focused && this.pending && !this.busy && !this.loading) { void this.refresh(); }
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
			if (sessionId && !isBillingSessionId(sessionId)) { throw new BillingRequestError(400, 'Invalid checkout link. Refresh Billing to check your purchase.'); }
			if (this.pending && this.pending.accountId !== status.account.id) {
				this.message = 'A checkout was started for a different account. Sign in to that account to check it.';
			} else if (this.pending && !this.pending.sessionId) {
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
			let result: { state: 'pending' | 'fulfilled' | 'expired' };
			const cancellation = new CancellationTokenSource();
			const deadlineTimer = setTimeout(() => cancellation.cancel(), remaining);
			try {
				result = await raceCancellationError(this.request(`/checkout-status?session_id=${encodeURIComponent(sessionId)}&account_id=${accountId}`, 'GET', Math.min(remaining, 15000), cancellation.token), cancellation.token);
			} catch (error) {
				if (Date.now() >= deadline) { break; }
				throw error;
			} finally { clearTimeout(deadlineTimer); cancellation.dispose(); }
			if (!isCurrent()) { return; }
			if (result.state === 'fulfilled' || result.state === 'expired') {
				const status = await this.request<IBillingStatus>(`/status?account_id=${accountId}`);
				if (!isCurrent()) { return; }
				if (status.account.id !== accountId) { throw new BillingRequestError(409, 'Your account changed. Refresh Billing.'); }
				this.savePending(undefined);
				this.status = status;
				this.message = result.state === 'fulfilled' ? 'Your subscription and credits are updated.' : 'Checkout expired. You can choose a plan again.';
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
		if (this.pending) { this.message = 'Finish or resume your existing checkout before starting another purchase.'; this.changed.fire(); return; }
		const accountId = this.status.account.id;
		const requestId = generateUuid();
		if (operation === 'subscribe' || operation === 'change-plan') {
			this.savePending({ accountId, requestId, operation, plan });
		}
		await this.perform(operation, plan, requestId, accountId);
	}

	private async perform(operation: BillingOperation, plan: string | undefined, requestId: string, accountId: number): Promise<void> {
		this.busy = true;
		++this.revision;
		this.message = '';
		this.changed.fire();
		try {
			// Recheck context before a mutation; never charge a newly selected account from stale UI.
			const current = await this.request<IBillingStatus>('/status');
			if (current.account.id !== accountId || !current.can_manage_billing) { throw new BillingRequestError(403, 'Your billing account or permissions changed. Refresh Billing.'); }
			const query = new URLSearchParams({ source: 'desktop', request_id: requestId, account_id: String(accountId) });
			if (plan) { query.set('plan', plan); }
			const result = await this.request<{ id?: string; url?: string | null }>(`/${operation}?${query}`, 'POST');
			const purchase = operation === 'subscribe' || operation === 'change-plan';
			if (purchase && (result.id || result.url)) {
				if (!isBillingSessionId(result.id)) { throw new BillingRequestError(503, 'Checkout could not be verified. Resume checkout to retry.'); }
				this.savePending({ accountId, requestId, operation, plan, sessionId: result.id, url: result.url ?? undefined });
				if (!result.url) {
					// Completed sessions may no longer have a URL. Verify the recovered
					// session rather than treating it as a non-payment settings change.
					this.queuedRefresh = true;
					this.queuedSessionId = result.id;
				}
			} else { this.savePending(undefined); }
			if (result.url) {
				await this.openStripe(result.url);
				this.message = 'Complete the payment step on Stripe, then return to Desktop.';
			} else {
				this.message = this.pending ? 'Checking the recovered checkout…' : 'Your subscription settings are updated.';
			}
			this.status = await this.request<IBillingStatus>('/status');
		} catch (error) {
			if (!this.pending?.sessionId && error instanceof BillingRequestError && error.statusCode >= 400 && error.statusCode < 500 && ![401, 408, 429].includes(error.statusCode)) { this.savePending(undefined); }
			this.fail(error);
		} finally { this.finishOperation(); }
	}

	async resumeCheckout(): Promise<void> {
		if (this.busy || this.loading || !this.pending || this.pending.accountId !== this.status?.account.id || !this.status.can_manage_billing) { return; }
		if (!this.pending.sessionId && this.pending.requestId && this.pending.operation) {
			await this.perform(this.pending.operation, this.pending.plan, this.pending.requestId, this.pending.accountId);
			return;
		}
		if (!this.pending.url) { await this.refresh(); return; }
		this.busy = true;
		this.changed.fire();
		try {
			if (this.pending.url) {
				const current = await this.request<IBillingStatus>('/status');
				if (current.account.id !== this.pending.accountId || !current.can_manage_billing) { throw new BillingRequestError(403, 'Sign in to the account that started this checkout.'); }
				await this.openStripe(this.pending.url);
			}
		} catch (error) { this.fail(error); }
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

	private async openStripe(url: string): Promise<void> {
		const parsed = URI.parse(url);
		if (parsed.scheme !== 'https' || !['checkout.stripe.com', 'billing.stripe.com'].includes(parsed.authority)) { throw new BillingRequestError(503, 'Stripe returned an unexpected checkout address. Please retry.'); }
		if (!await this.openerService.open(parsed, { openExternal: true, allowCommands: false })) { throw new Error('Could not open the browser. Use Resume checkout to try again.'); }
	}

	private fail(error: unknown): void {
		if (error instanceof BillingRequestError && (error.statusCode === 401 || error.message === 'billing_context_required')) {
			this.needsSignIn = true;
			this.status = undefined;
			this.message = 'Sign in to manage billing for your selected account.';
		} else if (error instanceof BillingRequestError && error.statusCode === 404) {
			this.message = 'This checkout is unavailable for the signed-in account, or billing has not been deployed yet. Check your account and refresh.';
		} else { this.message = error instanceof Error ? error.message : 'Billing is temporarily unavailable. Please refresh.'; }
		this.logService.warn(`[Backboard Billing] Request failed${error instanceof BillingRequestError ? ` (${error.statusCode})` : ''}.`);
	}

	private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', timeoutMs = 15000, cancellation = CancellationToken.None): Promise<T> {
		const resource = await this.configResource;
		let token = backboardConfigAccessToken(await readBackboardConfigJson(this.fileService, resource));
		if (!token) { throw new BillingRequestError(401, 'Sign in to manage billing.'); }
		for (let attempt = 0; attempt < 2; attempt++) {
			const context = await this.requestService.request({
				type: method, url: `${apiOrigin}/billing${path}`,
				headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs, callSite: 'backboardBilling.request',
			}, cancellation);
			const code = context.res.statusCode ?? 503;
			const body = (await streamToBuffer(context.stream)).toString();
			let payload: T & { detail?: string };
			try { payload = JSON.parse(body); } catch { throw new BillingRequestError(code >= 400 ? code : 503, 'Billing is temporarily unavailable. Please refresh.'); }
			if (code === 401 && attempt === 0) {
				const refreshed = await refreshBackboardOAuthCredentials(this.fileService, resource, this.requestService, this.logService, token);
				if (refreshed) { token = refreshed; continue; }
			}
			if (code < 200 || code >= 300) { throw new BillingRequestError(code, typeof payload.detail === 'string' ? payload.detail : 'Billing is temporarily unavailable. Please refresh.'); }
			// Ignore a response belonging to credentials replaced by another sign-in.
			const latest = backboardConfigAccessToken(await readBackboardConfigJson(this.fileService, resource));
			if (latest !== token && !isBackboardOAuthRotation(resource, token, latest)) { throw new BillingRequestError(409, 'Your account changed. Refresh Billing.'); }
			return payload;
		}
		throw new BillingRequestError(401, 'Sign in to manage billing.');
	}
}

registerSingleton(IBackboardBillingService, BackboardBillingService, InstantiationType.Delayed);
