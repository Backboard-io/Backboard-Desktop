/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { BackboardAnalyticsEvent, BackboardAnalyticsProps, IBackboardAnalyticsService } from '../../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { BackboardBillingService } from '../../browser/backboardBillingService.js';
import { BillingPlansView, planCards } from '../../browser/billingPlansView.js';
import { billingPlanAction, billingReturn, IBackboardBillingService, IBillingAutoReload, IBillingStatus, isBillingCreditAmount, parsePendingCheckout } from '../../common/backboardBilling.js';

const status: IBillingStatus = {
	account: { id: 7, name: 'My organization', is_personal: false }, can_manage_billing: true,
	plan: null, wallet: { plan_grant_remaining_usd: 0, has_payment_method: false }
};
const catalog = { currency: 'USD', service_fee_percent: 5, credit_purchase_minimum_usd: 5,
	auto_reload_minimum_threshold_usd: 5, auto_reload_minimum_amount_usd: 5,
	plans: [{ id: 'builder', name: 'Builder', monthly_price_usd: 20, included_credits_usd: 20 }] };
const creditStatus: IBillingStatus = { ...status, can_purchase_credits: true,
	plan: { plan_name: 'BUILDER', status: 'active', plan_amount_usd: 20, included_credits_usd: 20, cancel_at_period_end: false },
	wallet: { ...status.wallet, balance_usd: 24.90, purchased_balance_usd: 4.90, has_payment_method: true, auto_reload_enabled: false,
		auto_reload_threshold_usd: 5, auto_reload_amount_usd: 50 } };
const response = (body: unknown, code = 200): IRequestContext => ({ res: { statusCode: code, headers: {} }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(body))) });

suite('Backboard Billing', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(handler: (options: IRequestOptions) => Promise<IRequestContext>, stored?: unknown) {
		const log = new NullLogService();
		const files = disposables.add(new FileService(log));
		disposables.add(files.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/billing-test');
		const folder = URI.joinPath(home, '.backboard_ide');
		const resource = URI.joinPath(folder, 'config.json');
		await files.createFolder(folder);
		await files.writeFile(resource, VSBuffer.fromString(JSON.stringify({ oauth: { access_token: 'Backboard_at_test', refresh_token: 'refresh', selected_client_name: 'My organization' } })));
		const paths = new class extends mock<IPathService>() {
			override userHome(options: { preferLocal: true }): URI;
			override userHome(options?: { preferLocal: boolean }): Promise<URI>;
			override userHome(options?: { preferLocal: boolean }): URI | Promise<URI> { return options?.preferLocal ? home : Promise.resolve(home); }
		};
		const request = new class extends mock<IRequestService>() { override request(options: IRequestOptions): Promise<IRequestContext> { return handler(options); } };
		const storage = disposables.add(new InMemoryStorageService());
		if (stored) { storage.store('backboard.billing.pendingCheckout', JSON.stringify(stored), StorageScope.APPLICATION, StorageTarget.MACHINE); }
		const opened: string[] = [];
		const opener = new class extends mock<IOpenerService>() { override async open(uri: URI): Promise<boolean> { opened.push(uri.toString()); return true; } };
		const host = new class extends mock<IHostService>() { override readonly onDidChangeFocus = Event.None; };
		const commands = new class extends mock<ICommandService>() { override readonly onDidExecuteCommand = Event.None; };
		const events: { event: BackboardAnalyticsEvent; props?: BackboardAnalyticsProps }[] = [];
		const analytics = new class extends mock<IBackboardAnalyticsService>() {
			override readonly enabled = true;
			override capture(event: BackboardAnalyticsEvent, props?: BackboardAnalyticsProps): void { events.push({ event, props }); }
		};
		const billing = disposables.add(new BackboardBillingService(files, paths, request, log, opener, storage, host, commands, analytics));
		return { billing, storage, opened, files, resource, events };
	}

	test('reports checkout intent once across resume without reporting a payment', async () => {
		const { billing, events } = await setup(async options => response(options.type === 'POST'
			? { id: 'cs_test_analytics', url: 'https://checkout.stripe.com/pay/test' }
			: options.url!.endsWith('/plans') ? catalog : status));
		await billing.refresh();
		await billing.run('subscribe', 'builder');
		await billing.resumeCheckout();
		const checkouts = events.filter(item => item.event === 'checkout_started');
		assert.strictEqual(checkouts.length, 1);
		assert.strictEqual(checkouts[0].props?.event_id, 'desktop-checkout-cs_test_analytics');
		assert.strictEqual(checkouts[0].props?.value, undefined);
		assert.ok(!events.some(item => item.event === 'billing_checkout_completed'));
	});

	test('reports confirmed fulfillment once across return links without inventing paid revenue', async () => {
		const pending = { accountId: 7, operation: 'credits/checkout', amountUsd: 10, sessionId: 'cs_analytics_confirmed' };
		const { billing, events, storage } = await setup(async options => response(options.url!.includes('/checkout-status')
			? { state: 'fulfilled', operation: 'credits', amount_usd: 10 }
			: options.url!.endsWith('/plans') ? catalog : creditStatus), pending);
		await billing.refresh();
		await billing.refresh('cs_analytics_confirmed');
		storage.store('backboard.billing.pendingCheckout', JSON.stringify(pending), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await billing.refresh();
		const completed = events.filter(item => item.event === 'billing_checkout_completed');
		assert.strictEqual(completed.length, 1);
		assert.strictEqual(completed[0].props?.billing_account_id, 7);
		assert.strictEqual(completed[0].props?.kind, 'credits');
		assert.strictEqual(completed[0].props?.requested_amount_usd, 10);
		assert.strictEqual(completed[0].props?.value, undefined);
		assert.strictEqual(completed[0].props?.confirmation_source, 'billing_api');
		assert.ok(!events.some(item => item.event === 'purchase_completed'));
	});

	test('existing subscriptions are snapshots and changes retain the correct billing account', async () => {
		let current = creditStatus;
		const { billing, events } = await setup(async options => response(options.url!.endsWith('/plans') ? catalog : current));
		await billing.refresh();
		await billing.refresh();
		assert.strictEqual(events.filter(item => item.event === 'billing_status_loaded').length, 1);
		assert.ok(!events.some(item => item.event === 'billing_subscription_changed' || item.event === 'billing_checkout_completed'));
		current = { ...creditStatus, plan: { ...creditStatus.plan!, cancel_at_period_end: true } };
		await billing.refresh();
		const changes = events.filter(item => item.event === 'billing_subscription_changed');
		assert.strictEqual(changes.length, 1);
		assert.strictEqual(changes[0].props?.cancel_at_period_end, true);
		current = { ...status, account: { ...status.account, id: 8 } };
		await billing.refresh();
		assert.strictEqual(events.filter(item => item.event === 'billing_subscription_changed').length, 1);
	});

	test('failed and expired checkouts never become completed conversions', async () => {
		for (const state of ['expired', 'failed']) {
			const { billing, events } = await setup(async options => response(options.url!.includes('/checkout-status') ? { state }
				: options.url!.endsWith('/plans') ? catalog : status), { accountId: 7, sessionId: `cs_${state}` });
			await billing.refresh();
			assert.strictEqual(events.filter(item => item.event === `billing_checkout_${state}`).length, 1);
			assert.ok(!events.some(item => item.event === 'billing_checkout_completed'));
		}
	});

	test('recognizes billing callbacks without accepting arbitrary paths or malformed sessions', () => {
		assert.deepStrictEqual(billingReturn(URI.parse('backboard://billing/return?session_id=cs_test_123&token=ignored')), { sessionId: 'cs_test_123' });
		assert.deepStrictEqual(billingReturn(URI.parse('backboard://billing/cancel')), { sessionId: undefined });
		assert.strictEqual(billingReturn(URI.parse('backboard://billing/return?session_id=invalid')), undefined);
		assert.strictEqual(billingReturn(URI.parse('backboard://billing/arbitrary-command')), undefined);
		assert.strictEqual(billingReturn(URI.parse('backboard://other/return')), undefined);
	});

	test('plan actions respect organization membership and managed plans', () => {
		const plan = catalog.plans[0];
		assert.strictEqual(billingPlanAction(status, plan), 'subscribe');
		assert.strictEqual(billingPlanAction({ ...status, can_manage_billing: false }, plan), undefined);
		const active = { plan_name: 'STARTER', status: 'active', plan_amount_usd: 5, included_credits_usd: 5, cancel_at_period_end: false };
		assert.strictEqual(billingPlanAction({ ...status, plan: active }, plan), 'upgrade');
		assert.strictEqual(billingPlanAction({ ...status, plan: { ...active, plan_name: 'SCALE' } }, plan), 'downgrade');
		assert.strictEqual(billingPlanAction({ ...status, plan: { ...active, plan_name: 'ENTERPRISE' } }, plan), undefined);
		assert.strictEqual(billingPlanAction({ ...status, plan: { ...active, plan_name: 'INDIE' } }, plan), undefined);
	});

	test('uses OAuth, pins the account, and restores interrupted requests with the same request id', async () => {
		const mutations: string[] = [];
		const { billing, opened } = await setup(async options => {
			assert.strictEqual(options.headers?.Authorization, 'Bearer Backboard_at_test');
			assert.strictEqual(options.headers?.['X-API-Key'], undefined);
			if (options.type === 'POST') {
				mutations.push(options.url!);
				if (mutations.length === 1) { throw new Error('Connection interrupted'); }
				return response({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/test' });
			}
			return response(options.url!.endsWith('/plans') ? catalog : status);
		});
		await billing.refresh();
		await billing.run('subscribe', 'builder');
		assert.ok(billing.pending?.requestId);
		await billing.resumeCheckout();
		assert.strictEqual(mutations[0], mutations[1]);
		assert.strictEqual(new URL(mutations[0]).searchParams.get('account_id'), '7');
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
		assert.strictEqual(opened.length, 1);
		await billing.run('subscribe', 'builder');
		assert.strictEqual(mutations.length, 2);
	});

	test('only server fulfillment clears a restored checkout', async () => {
		const { billing, storage } = await setup(async options => response(options.url!.includes('/checkout-status') ? { state: 'fulfilled' }
			: options.url!.endsWith('/plans') ? catalog : status), { accountId: 7, sessionId: 'cs_test_123' });
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.strictEqual(storage.get('backboard.billing.pendingCheckout', StorageScope.APPLICATION), undefined);
		assert.match(billing.message, /updated/);
	});

	test('foreign-account pending sessions are retained and never verified', async () => {
		let verifications = 0;
		const { billing } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) { verifications++; }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, { accountId: 8, sessionId: 'cs_test_123' });
		await billing.refresh();
		assert.strictEqual(verifications, 0);
		assert.strictEqual(billing.pending?.accountId, 8);
		assert.match(billing.message, /different account/);
	});

	test('an old return link cannot replace a newer pending checkout', async () => runWithFakedTimers({}, async () => {
		const { billing, opened } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) {
				const query = new URL(options.url!).searchParams;
				assert.strictEqual(query.get('session_id'), 'cs_new');
				assert.strictEqual(query.get('account_id'), '7');
				return response({ state: 'pending' });
			}
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, { accountId: 7, sessionId: 'cs_new', url: 'https://checkout.stripe.com/pay/new' });
		await billing.refresh('cs_old');
		assert.strictEqual(billing.pending?.sessionId, 'cs_new');
		await billing.resumeCheckout();
		assert.deepStrictEqual(opened, ['https://checkout.stripe.com/pay/new']);
	}));

	test('a return link does not discard an interrupted purchase request', async () => {
		const attempt = { accountId: 7, operation: 'subscribe', plan: 'builder', requestId: '12345678-1234-4234-8234-123456789abc' };
		const { billing } = await setup(async options => {
			assert.ok(!options.url!.includes('/checkout-status'));
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, attempt);
		await billing.refresh('cs_old');
		assert.strictEqual(billing.pending?.requestId, attempt.requestId);
		assert.strictEqual(billing.pending?.sessionId, undefined);
		assert.match(billing.message, /interrupted/);
	});

	test('a delayed fulfillment refresh cannot overwrite a newly selected account', async () => {
		const finalStatusStarted = new DeferredPromise<void>();
		const finalStatus = new DeferredPromise<IRequestContext>();
		let account = status;
		const { billing } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) { return response({ state: 'fulfilled' }); }
			if (options.url!.includes('/status?account_id=7')) {
				finalStatusStarted.complete();
				return finalStatus.p;
			}
			return response(options.url!.endsWith('/plans') ? catalog : account);
		}, { accountId: 7, sessionId: 'cs_test_123' });
		const originalRefresh = billing.refresh();
		await finalStatusStarted.p;
		account = { ...status, account: { ...status.account, id: 8, name: 'Another account' } };
		await billing.refresh();
		finalStatus.complete(response(status));
		await originalRefresh;
		assert.strictEqual(billing.status?.account.id, 8);
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
		assert.match(billing.message, /different account/);
	});

	test('verification cannot clear a checkout replaced by another window', async () => {
		const verificationStarted = new DeferredPromise<void>();
		const verification = new DeferredPromise<IRequestContext>();
		const { billing, storage } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) { verificationStarted.complete(); return verification.p; }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, { accountId: 7, sessionId: 'cs_old' });
		const refreshing = billing.refresh();
		await verificationStarted.p;
		storage.store('backboard.billing.pendingCheckout', JSON.stringify({ accountId: 7, sessionId: 'cs_new' }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		verification.complete(response({ state: 'fulfilled' }));
		await refreshing;
		assert.strictEqual(billing.pending?.sessionId, 'cs_new');
	});

	test('a failed status refresh after fulfillment retains the checkout for retry', async () => {
		const { billing } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) { return response({ state: 'fulfilled' }); }
			if (options.url!.includes('/status?')) { return response({ detail: 'Temporarily unavailable' }, 503); }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, { accountId: 7, sessionId: 'cs_test_123' });
		await billing.refresh();
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
		assert.match(billing.message, /Temporarily unavailable/);
	});

	test('expired checkout allows another attempt without claiming success', async () => {
		const { billing } = await setup(async options => response(options.url!.includes('/checkout-status') ? { state: 'expired' }
			: options.url!.endsWith('/plans') ? catalog : status), { accountId: 7, sessionId: 'cs_test_123' });
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /expired/);
	});

	test('concurrent expired requests rotate OAuth once and retry with the replacement', async () => {
		let refreshes = 0;
		const { billing, files, resource } = await setup(async options => {
			if (options.url!.endsWith('/oauth/token')) { refreshes++; return response({ access_token: 'Backboard_at_new', refresh_token: 'new-refresh', expires_in: 3600 }); }
			if (options.headers?.Authorization === 'Bearer Backboard_at_test') { return response({ detail: 'expired' }, 401); }
			assert.strictEqual(options.headers?.Authorization, 'Bearer Backboard_at_new');
			return response(options.url!.endsWith('/plans') ? catalog : status);
		});
		await billing.refresh();
		assert.strictEqual(refreshes, 1);
		assert.strictEqual(billing.needsSignIn, false);
		assert.strictEqual(billing.status?.account.id, 7);
		const config = JSON.parse((await files.readFile(resource)).value.toString());
		assert.strictEqual(config.oauth.selected_client_name, 'My organization');
	});

	test('a concurrent valid response survives the other request rotating credentials', async () => {
		let releaseOriginal: (() => void) | undefined;
		const { billing } = await setup(async options => {
			if (options.url!.endsWith('/oauth/token')) { return response({ access_token: 'Backboard_at_new', refresh_token: 'refresh_new' }); }
			if (options.url!.endsWith('/status') && options.headers?.Authorization === 'Bearer Backboard_at_test') {
				return new Promise(resolve => { releaseOriginal = () => resolve(response(status)); });
			}
			if (options.headers?.Authorization === 'Bearer Backboard_at_test') { return response({ detail: 'expired' }, 401); }
			releaseOriginal?.();
			return response(catalog);
		});
		await billing.refresh();
		assert.strictEqual(billing.status?.account.id, 7);
		assert.strictEqual(billing.message, '');
	});

	test('missing OAuth asks for SSO and performs no API-key billing', async () => {
		let requests = 0;
		const { billing, files, resource } = await setup(async () => { requests++; return response(status); });
		await files.writeFile(resource, VSBuffer.fromString(JSON.stringify({ api_key: 'org-owner-key' })));
		await billing.refresh();
		assert.strictEqual(requests, 0);
		assert.strictEqual(billing.needsSignIn, true);
	});

	test('invalid local records cannot inject arbitrary operations', () => {
		assert.strictEqual(parsePendingCheckout({ accountId: 7, operation: 'arbitrary', requestId: 'bad' }), undefined);
		assert.strictEqual(parsePendingCheckout({ accountId: -1, sessionId: 'cs_test_123' }), undefined);
		assert.strictEqual(parsePendingCheckout({ accountId: 7, sessionId: 42 }), undefined);
	});

	test('bounded polling retains a checkout and confirms delayed fulfillment on next open', async () => runWithFakedTimers({}, async () => {
		let fulfilled = false;
		const times: number[] = [];
		const { billing } = await setup(async options => {
			if (options.url!.includes('/checkout-status')) { times.push(Date.now()); return response({ state: fulfilled ? 'fulfilled' : 'pending' }); }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		}, { accountId: 7, sessionId: 'cs_test_123' });
		const started = Date.now();
		await billing.refresh();
		assert.strictEqual(Date.now() - started, 60000);
		assert.ok(times.length > 3 && times.length < 12);
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
		assert.match(billing.message, /still processing/);
		fulfilled = true;
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /updated/);
	}));

	test('a stalled verification request also stops at the overall polling deadline', async () => runWithFakedTimers({}, async () => {
		const { billing } = await setup(async options => options.url!.includes('/checkout-status') ? new Promise<IRequestContext>(() => { })
			: response(options.url!.endsWith('/plans') ? catalog : status), { accountId: 7, sessionId: 'cs_test_123' });
		const started = Date.now();
		await billing.refresh();
		assert.strictEqual(Date.now() - started, 60000);
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
		assert.match(billing.message, /still processing/);
	}));

	test('a status failure after opening Stripe never forgets the pending session', async () => {
		let checkoutCreated = false;
		const { billing, opened } = await setup(async options => {
			if (options.type === 'POST') { checkoutCreated = true; return response({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/test' }); }
			if (checkoutCreated) { return response({ detail: 'Permission changed' }, 403); }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		});
		await billing.refresh();
		await billing.run('subscribe', 'builder');
		assert.strictEqual(opened.length, 1);
		assert.strictEqual(billing.pending?.sessionId, 'cs_test_123');
	});

	test('a recovered completed session is verified even when Stripe has removed its URL', async () => {
		let checks = 0;
		const { billing, opened } = await setup(async options => {
			if (options.type === 'POST') { return response({ id: 'cs_test_123', url: null }); }
			if (options.url!.includes('/checkout-status')) { checks++; return response({ state: 'fulfilled' }); }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		});
		await billing.refresh();
		await billing.run('subscribe', 'builder');
		await billing.refresh();
		assert.ok(checks > 0);
		assert.strictEqual(opened.length, 0);
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /updated/);
	});

	test('missing account context requires SSO again and unavailable billing is retryable', async () => {
		let code = 409;
		const { billing } = await setup(async () => response({ detail: code === 409 ? 'billing_context_required' : 'Unavailable' }, code));
		await billing.refresh();
		assert.strictEqual(billing.needsSignIn, true);
		code = 503;
		await billing.refresh();
		assert.strictEqual(billing.loading, false);
		assert.match(billing.message, /Unavailable/);
	});

	function plansView(billing: IBackboardBillingService, dialog: IDialogService, opened: string[] = []) {
		const opener = new class extends mock<IOpenerService>() { override async open(target: URI | string): Promise<boolean> { opened.push(target.toString()); return true; } };
		const parent = document.createElement('div');
		const events: { event: BackboardAnalyticsEvent; props?: BackboardAnalyticsProps }[] = [];
		disposables.add(new BillingPlansView(parent, { mode: 'standalone', onDone: () => { } }, billing, dialog, opener, new class extends mock<ICommandService>() { }, new class extends mock<IBackboardAnalyticsService>() { override capture(event: BackboardAnalyticsEvent, props?: BackboardAnalyticsProps) { events.push({ event, props }); } }));
		const button = (label: string) => Array.from(parent.querySelectorAll('button')).find(button => button.textContent === label);
		return { parent, button, events };
	}

	test('plans view renders admin restrictions and confirms cancellation and downgrade dates', async () => {
		const changed = disposables.add(new Emitter<void>());
		const operations: string[] = [];
		const confirmations: string[] = [];
		const end = Date.UTC(2026, 11, 1) / 1000;
		const billing = {
			_serviceBrand: undefined, onDidChange: changed.event, status: {
				...status,
				plan: { plan_name: 'SCALE', status: 'active', plan_amount_usd: 400, included_credits_usd: 400, current_period_end_ts: end, cancel_at_period_end: false }
			},
			catalog, pending: undefined, loading: false, busy: false, message: '', needsSignIn: false,
			refresh: async () => { }, run: async (operation: string) => { operations.push(operation); }, resumeCheckout: async () => { }, cancelCheckout: async () => { },
			buyCredits: async () => { }, configureAutoReload: async () => false
		};
		const dialog = new class extends mock<IDialogService>() {
			override async confirm(confirmation: { message: string }) { confirmations.push(confirmation.message); return { confirmed: true }; }
		};
		const { parent, button } = plansView(billing, dialog);
		assert.match(parent.textContent!, /My organization/);
		assert.match(parent.textContent!, /5% service fee/);
		button('Cancel Renewal')!.click();
		await timeout(0);
		button('Downgrade')!.click();
		await timeout(0);
		assert.deepStrictEqual(operations, ['cancel', 'change-plan']);
		assert.ok(confirmations.every(message => message.includes(new Date(end * 1000).toLocaleDateString())));
		billing.status = { ...billing.status, can_manage_billing: false };
		changed.fire();
		assert.match(parent.textContent!, /An account admin manages/);
		assert.strictEqual(button('Update Payment Details')!.disabled, true);
		assert.strictEqual(button('Downgrade'), undefined);
	});

	test('confirming a dialog cannot apply its action to an account selected while it was open', async () => {
		let mutations = 0;
		const { billing } = await setup(async options => {
			if (options.type === 'POST') { mutations++; }
			return response(options.url!.endsWith('/plans') ? catalog : status);
		});
		billing.status = { ...status, plan: { plan_name: 'SCALE', status: 'active', plan_amount_usd: 400, included_credits_usd: 400, cancel_at_period_end: false } };
		billing.catalog = catalog;
		const confirmation = new DeferredPromise<{ confirmed: boolean }>();
		const dialog = new class extends mock<IDialogService>() { override confirm() { return confirmation.p; } };
		const { button } = plansView(billing, dialog);
		button('Cancel Renewal')!.click();
		billing.status = { ...billing.status, account: { ...status.account, id: 8 } };
		await confirmation.complete({ confirmed: true });
		assert.strictEqual(mutations, 0);
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /billing account changed/);
	});

	test('before the billing API is deployed, cards use published prices and Subscribe opens the web billing page', async () => {
		const billing = {
			_serviceBrand: undefined, onDidChange: Event.None, status: undefined, catalog: undefined, pending: undefined,
			loading: false, busy: false, message: 'billing has not been deployed yet', needsSignIn: false,
			refresh: async () => { }, run: async () => { assert.fail('no API checkout without the billing API'); }, resumeCheckout: async () => { },
			buyCredits: async () => { assert.fail('no credit purchase without the billing API'); },
			configureAutoReload: async () => { assert.fail('no auto reload without the billing API'); }, cancelCheckout: async () => { }
		};
		const opened: string[] = [];
		const { parent, button, events } = plansView(billing, new class extends mock<IDialogService>() { }, opened);
		assert.deepStrictEqual(planCards(undefined).map(card => `${card.name} ${card.price}`), ['Builder $20', 'Scale $400', 'Enterprise Custom']);
		assert.doesNotMatch(parent.textContent!, /not been deployed/);
		button('Subscribe $20')!.click();
		await timeout(0);
		assert.deepStrictEqual(opened, ['https://app.backboard.io/dashboard/billing?plan=builder']);
		assert.strictEqual(events[0].event, 'billing_viewed');
		assert.strictEqual(events[1].event, 'checkout_started');
		assert.strictEqual(events[1].props?.requested_plan, 'builder');
		assert.ok(!events.some(item => item.event === 'billing_checkout_completed'));
		assert.match(parent.textContent!, /Finish checkout in your browser/);
	});

	test('restores the initiator checkout from another device and resumes the server URL', async () => {
		const operationId = '11111111-1111-4111-8111-111111111111';
		const remote = { state: 'open', operation: 'subscribe', target_plan: 'BUILDER', is_initiator: true,
			can_resume: true, can_cancel: true, operation_id: operationId, expires_at: Date.now() / 1000 + 1800 };
		let creates = 0;
		const { billing, opened } = await setup(async options => {
			if (options.url!.includes('/subscribe?')) { creates++; }
			if (options.url!.includes('/resume?')) { return response({ operation_id: operationId, id: 'cs_test_remote', state: 'open', url: 'https://checkout.stripe.com/pay/remote' }); }
			return response(options.url!.endsWith('/plans') ? catalog : { ...status, pending_checkout: remote });
		});
		await billing.refresh();
		assert.strictEqual(billing.pending?.operationId, operationId);
		await billing.run('subscribe', 'builder');
		assert.strictEqual(creates, 0);
		await billing.resumeCheckout();
		assert.deepStrictEqual(opened, ['https://checkout.stripe.com/pay/remote']);
	});

	test('another admin gets no resume or cancel action and cannot replace the reservation', async () => {
		let mutations = 0;
		const { billing } = await setup(async options => {
			if (options.type === 'POST') { mutations++; }
			return response(options.url!.endsWith('/plans') ? catalog : { ...status, pending_checkout: {
				state: 'open', operation: 'subscribe', is_initiator: false, can_resume: false, can_cancel: false
			} });
		});
		await billing.refresh();
		assert.match(billing.message, /Another admin/);
		await billing.resumeCheckout(); await billing.cancelCheckout(); await billing.run('subscribe', 'builder');
		assert.strictEqual(mutations, 0);
		assert.strictEqual(billing.pending, undefined);
	});

	test('an operation restored without a session clears only after a terminal backend result', async () => {
		let state = 'processing';
		const operationId = '11111111-1111-4111-8111-111111111111';
		const { billing } = await setup(async options => response(options.url!.endsWith('/plans') ? catalog
			: options.url!.includes('/checkouts/') ? { state } : status), { accountId: 7, operationId });
		await billing.refresh();
		assert.ok(billing.pending);
		state = 'expired';
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /checkout ended/);
	});

	test('an elapsed deadline keeps the reservation while expiration is being confirmed', async () => {
		const { billing } = await setup(async options => response(options.url!.endsWith('/plans') ? catalog : {
			...status, pending_checkout: { state: 'open', operation: 'subscribe', is_initiator: true, can_resume: true, can_cancel: true,
				operation_id: '11111111-1111-4111-8111-111111111111', expires_at: 1 }
		}));
		await billing.refresh();
		assert.ok(billing.pending);
		assert.match(billing.message, /Confirming checkout expiration/);
	});

	test('credit amounts and interrupted checkout records reject invalid values', () => {
		for (const value of [4.99, 0, -5, NaN, Infinity, 5.005, Number.MAX_VALUE, '10']) {
			assert.strictEqual(isBillingCreditAmount(value), false);
		}
		assert.ok(isBillingCreditAmount(5)); assert.ok(isBillingCreditAmount(25.75));
		const attempt = { accountId: 7, operation: 'credits/checkout', amountUsd: 25.75,
			requestId: '12345678-1234-4234-8234-123456789abc' };
		assert.deepStrictEqual(parsePendingCheckout(attempt), { ...attempt, sessionId: undefined, plan: undefined, url: undefined });
		assert.strictEqual(parsePendingCheckout({ ...attempt, amountUsd: undefined }), undefined);
	});

	test('credit checkout retries retain amount, UUID, account and desktop return source', async () => {
		const mutations: string[] = [];
		const { billing, opened } = await setup(async options => {
			if (options.type === 'POST') {
				mutations.push(options.url!);
				if (mutations.length === 1) { throw new Error('Connection interrupted'); }
				return response({ id: 'cs_credit', url: 'https://checkout.stripe.com/pay/credit' });
			}
			return response(options.url!.endsWith('/plans') ? catalog : creditStatus);
		});
		await billing.refresh();
		await billing.buyCredits(25.75, 7);
		assert.strictEqual(billing.pending?.amountUsd, 25.75);
		await billing.buyCredits(50, 7);
		assert.strictEqual(mutations.length, 1);
		await billing.resumeCheckout();
		assert.strictEqual(mutations[0], mutations[1]);
		const query = new URL(mutations[0]).searchParams;
		assert.strictEqual(query.get('amount_usd'), '25.75');
		assert.strictEqual(query.get('account_id'), '7');
		assert.strictEqual(query.get('source'), 'desktop');
		assert.deepStrictEqual(opened, ['https://checkout.stripe.com/pay/credit']);
	});

	test('credit checkout rechecks subscription eligibility before Stripe creation', async () => {
		let account = creditStatus;
		let mutations = 0;
		const { billing } = await setup(async options => {
			if (options.type === 'POST') { mutations++; }
			return response(options.url!.endsWith('/plans') ? catalog : account);
		});
		await billing.refresh();
		account = { ...creditStatus, can_purchase_credits: false };
		await billing.buyCredits(10);
		assert.strictEqual(mutations, 0);
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /active subscription/);
	});

	test('credit fulfillment clears restored state with a credit-specific message', async () => {
		const { billing } = await setup(async options => response(options.url!.includes('/checkout-status')
			? { state: 'fulfilled', operation: 'credits', amount_usd: 10 }
			: options.url!.endsWith('/plans') ? catalog : creditStatus),
		{ accountId: 7, sessionId: 'cs_credit', operation: 'credits/checkout', amountUsd: 10 });
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.match(billing.message, /purchased credits are updated/);
	});

	test('auto-reload JSON uses OAuth refresh retry, revalidates the account and refreshes saved settings', async () => {
		const configs: IBillingAutoReload[] = [];
		let account = creditStatus;
		const { billing } = await setup(async options => {
			if (options.url!.endsWith('/oauth/token')) { return response({ access_token: 'Backboard_at_rotated', refresh_token: 'rotated' }); }
			if (options.url!.includes('/auto-reload?')) {
				assert.strictEqual(new URL(options.url!).searchParams.get('account_id'), '7');
				assert.strictEqual(options.headers?.['Content-Type'], 'application/json');
				configs.push(JSON.parse(options.data as string));
				if (configs.length === 1) { return response({ detail: 'Expired token' }, 401); }
				assert.strictEqual(options.headers?.Authorization, 'Bearer Backboard_at_rotated');
				account = { ...creditStatus, wallet: { ...creditStatus.wallet, auto_reload_enabled: true, auto_reload_amount_usd: 25 } };
				return response(account.wallet);
			}
			return response(options.url!.endsWith('/plans') ? catalog : account);
		});
		await billing.refresh();
		const config = { enabled: true, threshold_usd: 5, amount_usd: 25 };
		assert.ok(await billing.configureAutoReload(config, 7));
		assert.deepStrictEqual(configs, [config, config]);
		assert.strictEqual(billing.status?.wallet.auto_reload_enabled, true);
		assert.strictEqual(billing.status?.wallet.auto_reload_amount_usd, 25);
		assert.match(billing.message, /Auto-reload settings saved/);
	});

	test('auto-reload allows disabling after expiry and rejects stale accounts, invalid amounts and non-admins', async () => {
		const posted: IBillingAutoReload[] = [];
		let account: IBillingStatus = { ...creditStatus, can_purchase_credits: false };
		const { billing } = await setup(async options => {
			if (options.type === 'POST') { posted.push(JSON.parse(options.data as string)); return response({}); }
			return response(options.url!.endsWith('/plans') ? catalog : account);
		});
		await billing.refresh();
		assert.strictEqual(await billing.configureAutoReload({ enabled: true, threshold_usd: 5, amount_usd: 4 }), false);
		assert.strictEqual(await billing.configureAutoReload({ enabled: true, threshold_usd: 5, amount_usd: 25 }), false);
		assert.ok(await billing.configureAutoReload({ enabled: false, threshold_usd: 5, amount_usd: 25 }));
		assert.strictEqual(posted.length, 1);
		account = { ...creditStatus, account: { ...status.account, id: 8 } };
		assert.strictEqual(await billing.configureAutoReload({ enabled: true, threshold_usd: 5, amount_usd: 25 }, 7), false);
		account = { ...creditStatus, can_manage_billing: false };
		await billing.refresh();
		await billing.buyCredits(10);
		assert.strictEqual(await billing.configureAutoReload({ enabled: false, threshold_usd: 5, amount_usd: 25 }), false);
		assert.strictEqual(posted.length, 1);
	});

	test('subscription lifecycle pins the account and wires checkout, downgrade, undo, cancellation, renewal and payment details', async () => {
		let current: IBillingStatus = status;
		const mutations: URL[] = [];
		const end = Date.UTC(2026, 11, 1) / 1000;
		const { billing, opened } = await setup(async options => {
			const url = new URL(options.url!);
			if (options.type === 'POST') {
				assert.strictEqual(options.headers?.Authorization, 'Bearer Backboard_at_test');
				mutations.push(url);
				const operation = url.pathname.split('/').pop();
				const plan = url.searchParams.get('plan');
				if (operation === 'subscribe' || (operation === 'change-plan' && plan === 'builder')) {
					const amount = operation === 'subscribe' ? 5 : 20;
					current = { ...current, can_purchase_credits: true,
						plan: { plan_name: plan!.toUpperCase(), status: 'active', plan_amount_usd: amount,
							included_credits_usd: amount, cancel_at_period_end: false, current_period_end_ts: end },
						wallet: { ...current.wallet, plan_grant_remaining_usd: amount } };
					return response({ id: `cs_test_${operation.replace(/-/g, '_')}`, url: `https://checkout.stripe.com/pay/${operation}` });
				}
				if (operation === 'change-plan') {
					current = { ...current, plan: { ...current.plan!, scheduled_downgrade_plan: plan!.toUpperCase(), scheduled_downgrade_date: end } };
					return response({ scheduled_downgrade_plan: plan!.toUpperCase(), effective_date: end });
				}
				if (operation === 'cancel-downgrade') {
					current = { ...current, plan: { ...current.plan!, scheduled_downgrade_plan: undefined, scheduled_downgrade_date: undefined } };
				} else if (operation === 'cancel' || operation === 'renew') {
					current = { ...current, plan: { ...current.plan!, cancel_at_period_end: operation === 'cancel' } };
				} else if (operation === 'update-payment-method') {
					return response({ url: 'https://billing.stripe.com/p/session_test' });
				} else { assert.fail(`Unexpected operation ${operation}`); }
				return response({});
			}
			if (url.pathname.endsWith('/checkout-status')) { return response({ state: 'fulfilled' }); }
			return response(url.pathname.endsWith('/plans') ? catalog : current);
		});
		await billing.refresh();
		await billing.run('subscribe', 'starter');
		assert.strictEqual(opened.length, 1);
		assert.ok(billing.pending?.sessionId);
		await billing.refresh();
		assert.strictEqual(billing.pending, undefined);
		assert.strictEqual(billing.status?.plan?.plan_name, 'STARTER');
		await billing.run('change-plan', 'builder');
		assert.strictEqual(opened.length, 2);
		await billing.refresh();
		assert.strictEqual(billing.status?.plan?.plan_name, 'BUILDER');
		await billing.run('change-plan', 'starter');
		assert.strictEqual(opened.length, 2, 'Scheduled downgrades must not open paid checkout');
		assert.strictEqual(billing.pending, undefined);
		assert.strictEqual(billing.status?.plan?.plan_name, 'BUILDER');
		assert.strictEqual(billing.status?.plan?.scheduled_downgrade_plan, 'STARTER');
		await billing.run('cancel-downgrade');
		assert.strictEqual(billing.status?.plan?.scheduled_downgrade_plan, undefined);
		await billing.run('cancel');
		assert.strictEqual(billing.status?.plan?.cancel_at_period_end, true);
		assert.strictEqual(billing.status?.plan?.status, 'active');
		await billing.run('renew');
		assert.strictEqual(billing.status?.plan?.cancel_at_period_end, false);
		await billing.run('update-payment-method');
		assert.strictEqual(opened[2], 'https://billing.stripe.com/p/session_test');
		assert.deepStrictEqual(mutations.map(url => url.pathname.split('/').pop()),
			['subscribe', 'change-plan', 'change-plan', 'cancel-downgrade', 'cancel', 'renew', 'update-payment-method']);
		for (const url of mutations) {
			assert.strictEqual(url.searchParams.get('account_id'), '7');
			assert.strictEqual(url.searchParams.get('source'), 'desktop');
			assert.match(url.searchParams.get('request_id')!, /^[0-9a-f-]{36}$/);
		}
	});

	test('all three plan cards load their artwork instead of the fallback', async () => {
		const { billing } = await setup(async options => response(options.url!.endsWith('/plans') ? catalog : status));
		await billing.refresh();
		billing.catalog = undefined; // Published plans are shown before the billing API is available.
		const { parent } = plansView(billing, new class extends mock<IDialogService>() { });
		const images = Array.from(parent.querySelectorAll<HTMLImageElement>('.bb-plan-art img'));
		assert.strictEqual(images.length, 3);
		await Promise.all(images.map(image => image.decode()));
		for (const image of images) {
			assert.ok(image.naturalWidth > 0 && image.naturalHeight > 0);
			assert.ok(!image.parentElement!.classList.contains('bb-plan-art-fallback'));
		}
	});

});
