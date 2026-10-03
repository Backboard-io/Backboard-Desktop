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
import { BackboardBillingService } from '../../browser/backboardBillingService.js';
import { BillingPlansView, planCards } from '../../browser/billingPlansView.js';
import { billingPlanAction, billingReturn, IBackboardBillingService, IBillingStatus, parsePendingCheckout } from '../../common/backboardBilling.js';

const status: IBillingStatus = {
	account: { id: 7, name: 'My organization', is_personal: false }, can_manage_billing: true,
	plan: null, wallet: { plan_grant_remaining_usd: 0, has_payment_method: false }
};
const catalog = { currency: 'USD', service_fee_percent: 5, plans: [{ id: 'builder', name: 'Builder', monthly_price_usd: 20, included_credits_usd: 20 }] };
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
		const billing = disposables.add(new BackboardBillingService(files, paths, request, log, opener, storage, host, commands));
		return { billing, storage, opened, files, resource };
	}

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
		disposables.add(new BillingPlansView(parent, { mode: 'standalone', onDone: () => { } }, billing, dialog, opener, new class extends mock<ICommandService>() { }));
		const button = (label: string) => Array.from(parent.querySelectorAll('button')).find(button => button.textContent === label);
		return { parent, button };
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
			refresh: async () => { }, run: async (operation: string) => { operations.push(operation); }, resumeCheckout: async () => { }
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
			refresh: async () => { }, run: async () => { assert.fail('no API checkout without the billing API'); }, resumeCheckout: async () => { }
		};
		const opened: string[] = [];
		const { parent, button } = plansView(billing, new class extends mock<IDialogService>() { }, opened);
		assert.deepStrictEqual(planCards(undefined).map(card => `${card.name} ${card.price}`), ['Builder $20', 'Scale $400', 'Enterprise Custom']);
		assert.doesNotMatch(parent.textContent!, /not been deployed/);
		button('Subscribe $20')!.click();
		await timeout(0);
		assert.deepStrictEqual(opened, ['https://app.backboard.io/dashboard/billing?plan=builder']);
		assert.match(parent.textContent!, /Finish checkout in your browser/);
	});

});
