/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../../base/common/actions.js';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenu, IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyChangeEvent } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { MockContextKeyService, MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IBackboardBillingService, IBillingStatus } from '../../../backboardBilling/common/backboardBilling.js';
import { BackboardAccountMenu, backboardAccountInitials, combineBackboardAccountActions, IBackboardAccountMenuOptions } from '../../browser/backboardAccountMenu.js';
import { BackboardAuthContextKeys, IBackboardAuthService } from '../../common/backboardAuth.js';

suite('Backboard account menu', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const action = (id: string, label = id): IAction => toAction({ id, label, run: async () => { } });

	async function setup(options: IBackboardAccountMenuOptions = {}, signedIn = true, alternative = false, execute?: (id: string) => Promise<void>) {
		const store = disposables.add(new DisposableStore());
		const contextChanged = store.add(new Emitter<IContextKeyChangeEvent>());
		const context = new class extends MockContextKeyService {
			override get onDidChangeContext() { return contextChanged.event; }
		};
		const signedInKey = BackboardAuthContextKeys.signedIn.bindTo(context);
		signedInKey.set(signedIn);
		BackboardAuthContextKeys.alternativeConfigured.bindTo(context).set(alternative);
		const host = document.createElement('div');
		host.className = 'monaco-workbench';
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
		let closeView = () => { };
		let opened = 0;
		const views = new class extends mock<IContextViewService>() {
			override showContextView(delegate: IContextViewDelegate) {
				closeView();
				opened++;
				const container = document.createElement('div');
				host.appendChild(container);
				const rendered = delegate.render(container);
				let closed = false;
				const close = () => {
					if (closed) { return; }
					closed = true;
					rendered.dispose();
					container.remove();
					delegate.onHide?.();
				};
				closeView = close;
				delegate.focus?.();
				return { close };
			}
		};
		const existing = [action('workbench.action.showCommands', 'Command Palette…'),
			new SubmenuAction('profiles', 'Profiles', [action('profile')]), action('workbench.action.openSettings', 'Settings'),
			action('extensions', 'Extensions'), action('shortcuts', 'Keyboard Shortcuts'), action('snippets', 'Snippets'),
			action('tasks', 'Tasks'), new SubmenuAction('themes', 'Themes', [action('theme')]),
			action('update.checkForUpdate', 'Check for Updates…'), action('backboard.signOut', 'Sign Out')];
		const menus = new class extends mock<IMenuService>() {
			override createMenu(id: MenuId): IMenu {
				return new class extends mock<IMenu>() {
					override getActions(): ReturnType<IMenu['getActions']> {
						const items = id === MenuId.GlobalActivity ? existing.filter(item => item.id !== 'backboard.signOut' || signedInKey.get() || alternative) : [action('help', 'Documentation')];
						return [['main', items as ReturnType<IMenu['getActions']>[number][1]]];
					}
					override dispose(): void { }
				};
			}
		};
		const executed: string[] = [];
		const commands = new class extends mock<ICommandService>() {
			override readonly onDidExecuteCommand = Event.None;
			override async executeCommand<T>(id: string): Promise<T> {
				executed.push(id);
				await execute?.(id);
				return undefined as T;
			}
		};
		const files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/account-test');
		const folder = URI.joinPath(home, '.backboard_ide');
		const config = URI.joinPath(folder, 'config.json');
		await files.createFolder(folder);
		await files.writeFile(config, VSBuffer.fromString(JSON.stringify({ oauth: { user_name: 'Nihal Kodukula' } })));
		const paths = new class extends mock<IPathService>() {
			override userHome(options: { preferLocal: true }): URI;
			override userHome(options?: { preferLocal: boolean }): Promise<URI>;
			override userHome(options?: { preferLocal: boolean }): URI | Promise<URI> { return options?.preferLocal ? home : Promise.resolve(home); }
		};
		const requests = new class extends mock<IRequestService>() {
			override async request(): Promise<never> { throw new Error('Cached identity should not require a network request'); }
		};
		const errors: unknown[] = [];
		const notifications = new class extends mock<INotificationService>() { override error(error: unknown) { errors.push(error); } };
		let refreshes = 0;
		const billingChanged = store.add(new Emitter<void>());
		const billing = new class extends mock<IBackboardBillingService>() {
			override readonly onDidChange = billingChanged.event;
			override readonly needsSignIn = false;
			override status: IBillingStatus = {
				account: { id: 7, name: 'My organization', is_personal: false }, can_manage_billing: true,
				plan: { plan_name: 'BUILDER', status: 'active', plan_amount_usd: 20, included_credits_usd: 20, cancel_at_period_end: false },
				wallet: { plan_grant_remaining_usd: 20, has_payment_method: true }
			};
			override async refresh() { refreshes++; }
		};
		const auth = new class extends mock<IBackboardAuthService>() { override async refresh() { } };
		const menu = store.add(new BackboardAccountMenu(options, commands, views, menus, context, new MockKeybindingService(), files, paths, requests, new NullLogService(), notifications, billing, auth));
		const button = menu.render(host);
		// Cached file reads complete before identity assertions.
		await timeout(0);
		return { menu, button, host, executed, errors, billing, existing, billingChanged, files, config,
			get opened() { return opened; }, get refreshes() { return refreshes; },
			setSignedIn(value: boolean) {
				signedInKey.set(value);
				contextChanged.fire({ affectsSome: keys => keys.has(BackboardAuthContextKeys.signedIn.key), allKeysContainedIn: () => false });
			}
		};
	}

	function labels(host: HTMLElement): string[] {
		return Array.from(host.querySelectorAll('.action-menu-item .action-label'), item => item.textContent ?? '');
	}

	async function activate(host: HTMLElement, label: string): Promise<void> {
		const entry = Array.from(host.querySelectorAll<HTMLElement>('.action-menu-item')).find(item => item.querySelector('.action-label')?.textContent === label);
		assert.ok(entry, `${label} should be available`);
		// Native menus install their mouse activation after the opening event.
		await timeout(150);
		entry.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
		await timeout(20);
	}

	test('preserves every Editor command, submenu, state, and native promoted action', async () => {
		const settings = { ...action('settings'), checked: true, enabled: false };
		const themes = new SubmenuAction('themes', 'Themes', [action('theme')]);
		const existing = [new Separator(), action('palette'), new Separator(), settings, themes, action('extensions'), action('shortcuts'), action('snippets'), action('tasks'), action('update'), action('signOut')];
		const combined = combineBackboardAccountActions([action('usage'), action('billing'), action('settings')], existing, [action('help')], [action('signOut')]);
		for (const item of existing.filter(item => !(item instanceof Separator) && item.id !== 'signOut')) { assert.ok(combined.includes(item), item.id); }
		assert.strictEqual(combined.find(item => item.id === 'settings'), settings);
		assert.strictEqual(combined.filter(item => item.id === 'settings').length, 1);
		assert.strictEqual(combined.filter(item => item.id === 'signOut').length, 1);
		assert.ok(combined.includes(themes));
		assert.ok(combined.every((item, index) => !(item instanceof Separator) || (index > 0 && index < combined.length - 1 && !(combined[index - 1] instanceof Separator))));
	});

	test('shows account identity and billing, and retains all Editor options', async () => {
		const fixture = await setup({ editorMode: true });
		assert.match(fixture.button.getAttribute('aria-label')!, /Nihal Kodukula, Builder plan/);
		assert.strictEqual(fixture.button.querySelector('.backboard-account-avatar')?.textContent, 'NK');
		fixture.menu.toggle();
		assert.deepStrictEqual(labels(fixture.host), ['Usage', 'Billing', 'API Keys', 'Settings', 'Command Palette…', 'Profiles', 'Extensions', 'Keyboard Shortcuts', 'Snippets', 'Tasks', 'Themes', 'Check for Updates…', 'Help', 'Sign out']);
		assert.strictEqual(fixture.host.querySelector('.backboard-account-menu-header .backboard-account-name')?.textContent, 'Nihal Kodukula');
		assert.strictEqual(fixture.refreshes, 1);
		assert.ok(fixture.host.querySelector('.backboard-account-action-icon.codicon-question'));
		assert.ok(fixture.host.querySelector('.backboard-account-action-icon.codicon-sign-out'));
	});

	test('opens once inside an Editor activity item and supports Escape and arrow keys', async () => {
		const fixture = await setup({ editorMode: true });
		fixture.host.addEventListener('mousedown', () => fixture.menu.toggle());
		fixture.button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		fixture.button.click();
		assert.strictEqual(fixture.opened, 1);
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'true');
		fixture.host.querySelector('.monaco-action-bar')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 27 }));
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(document.activeElement, fixture.button);
		fixture.button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp', keyCode: 38 }));
		assert.strictEqual(fixture.opened, 2);
	});

	test('Simple mode uses its built-in Usage view and closes full-window pages before Billing', async () => {
		let usage = 0;
		let beforeOpen = 0;
		const fixture = await setup({ openUsage: async () => { usage++; }, beforeOpen: async () => { beforeOpen++; } });
		fixture.menu.toggle();
		assert.deepStrictEqual(labels(fixture.host), ['Usage', 'Billing', 'API Keys', 'Settings', 'Check for Updates…', 'Help', 'Sign out']);
		await activate(fixture.host, 'Usage');
		assert.strictEqual(usage, 1);
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
		fixture.menu.toggle();
		await activate(fixture.host, 'Billing');
		assert.deepStrictEqual(fixture.executed, ['backboard.openBilling']);
		assert.strictEqual(beforeOpen, 1);
	});

	test('keeps native Editor submenus open until a child action runs', async () => {
		const fixture = await setup({ editorMode: true });
		fixture.menu.toggle();
		await activate(fixture.host, 'Profiles');
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'true');
		assert.ok(fixture.host.querySelector('.monaco-submenu'));
		await activate(fixture.host, 'profile');
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
	});

	test('surfaces command failures after the popup has closed', async () => {
		const failure = new Error('Could not open Billing');
		const fixture = await setup({}, true, false, async () => { throw failure; });
		fixture.menu.toggle();
		await activate(fixture.host, 'Billing');
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
		assert.deepStrictEqual(fixture.errors, [failure]);
	});

	test('updates plan and identity, clears the account on sign out, and offers sign in', async () => {
		const fixture = await setup();
		fixture.menu.toggle();
		fixture.billing.status = { ...fixture.billing.status, plan: { ...fixture.billing.status.plan!, plan_name: 'SCALE' } };
		fixture.billingChanged.fire();
		assert.strictEqual(fixture.host.querySelector('.backboard-account-menu-header .backboard-account-subtitle')?.textContent, 'Scale plan');
		fixture.setSignedIn(false);
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
		assert.doesNotMatch(fixture.button.getAttribute('aria-label')!, /Nihal|Scale/);
		fixture.menu.toggle();
		assert.ok(labels(fixture.host).includes('Sign in to Backboard'));
		assert.ok(!labels(fixture.host).includes('Sign out'));
		await activate(fixture.host, 'Sign in to Backboard');
		assert.deepStrictEqual(fixture.executed, ['backboard.signIn']);
		await fixture.files.writeFile(fixture.config, VSBuffer.fromString(JSON.stringify({ oauth: { user_name: 'Erin Test' } })));
		fixture.setSignedIn(true);
		await timeout(0);
		assert.match(fixture.button.getAttribute('aria-label')!, /Erin Test/);
	});

	test('connected provider users can sign in to Backboard or sign out', async () => {
		const fixture = await setup({}, false, true);
		assert.match(fixture.button.getAttribute('aria-label')!, /Connected subscriptions/);
		fixture.menu.toggle();
		assert.ok(labels(fixture.host).includes('Sign in to Backboard'));
		assert.ok(labels(fixture.host).includes('Sign out'));
	});

	test('dismisses on outside click and window blur', async () => {
		const fixture = await setup();
		fixture.menu.toggle();
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
		fixture.menu.toggle();
		window.dispatchEvent(new window.Event('blur'));
		assert.strictEqual(fixture.button.getAttribute('aria-expanded'), 'false');
	});

	test('uses Unicode-aware initials and a signed-out fallback', () => {
		assert.strictEqual(backboardAccountInitials('Nihal Kodukula'), 'NK');
		assert.strictEqual(backboardAccountInitials(' Erin  Test '), 'ET');
		assert.strictEqual(backboardAccountInitials('😀 Test'), '😀T');
		assert.strictEqual(backboardAccountInitials(''), 'B');
	});
});
