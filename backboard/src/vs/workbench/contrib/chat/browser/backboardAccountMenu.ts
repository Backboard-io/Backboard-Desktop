/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Menu } from '../../../../base/browser/ui/menu/menu.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { ActionRunner, IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { getActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { defaultMenuStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IBackboardBillingService } from '../../backboardBilling/common/backboardBilling.js';
import { BackboardAuthContextKeys, BackboardAuthGateContextKeys, IBackboardAuthService } from '../common/backboardAuth.js';
import { IBackboardUserInfo, resolveBackboardUserInfo } from './backboardUserInfo.js';
import './media/backboardAccountMenu.css';

export interface IBackboardAccountMenuOptions {
	readonly editorMode?: boolean;
	readonly openUsage?: () => Promise<void>;
	readonly beforeOpen?: () => Promise<unknown>;
}

export function backboardAccountInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return parts.length > 1 ? (Array.from(parts[0])[0] + Array.from(parts[parts.length - 1])[0]).toUpperCase()
		: parts.length ? Array.from(parts[0]).slice(0, 2).join('').toUpperCase() : 'B';
}

/** Promote account actions without dropping any of the Editor's existing commands or submenus. */
export function combineBackboardAccountActions(primary: IAction[], existing: IAction[], help: IAction[], authentication: IAction[]): IAction[] {
	const promoted = new Set([...primary, ...authentication].map(action => action.id));
	const remaining = existing.filter(action => !promoted.has(action.id));
	// Keep native command arguments, preconditions, and checked states when moving
	// an existing Editor entry into the account section.
	const groups: IAction[] = [...primary.map(action => existing.find(item => item.id === action.id) ?? action), new Separator(), ...remaining];
	if (help.length) { groups.push(new Separator(), new SubmenuAction('backboard.account.help', localize('accountHelp', "Help"), help, ThemeIcon.asClassName(Codicon.question))); }
	groups.push(new Separator(), ...authentication);
	return groups.filter((action, index) => !(action instanceof Separator) || (index > 0 && !(groups[index - 1] instanceof Separator)))
		.filter((action, index, actions) => !(action instanceof Separator) || index < actions.length - 1);
}

/** Shared bottom-left account control for the Simple rail and the Editor activity bar. */
export class BackboardAccountMenu extends Disposable {
	private button: HTMLButtonElement | undefined;
	private avatar: HTMLElement | undefined;
	private label: HTMLElement | undefined;
	private subtitle: HTMLElement | undefined;
	private headerName: HTMLElement | undefined;
	private headerSubtitle: HTMLElement | undefined;
	private headerAvatar: HTMLElement | undefined;
	private view: IOpenContextView | undefined;
	private info: IBackboardUserInfo = {};
	private revision = 0;
	private readonly runner = this._register(new ActionRunner());

	constructor(
		private readonly options: IBackboardAccountMenuOptions,
		@ICommandService private readonly commands: ICommandService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IFileService private readonly files: IFileService,
		@IPathService private readonly paths: IPathService,
		@IRequestService private readonly requests: IRequestService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
		@IBackboardBillingService private readonly billing: IBackboardBillingService,
		@IBackboardAuthService auth: IBackboardAuthService,
	) {
		super();
		this._register(toDisposable(() => this.close()));
		this._register(this.contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(BackboardAuthGateContextKeys)) { this.close(); void this.refreshIdentity(true); }
		}));
		this._register(this.commands.onDidExecuteCommand(event => {
			if (['backboard.signIn', 'backboard.signOut', 'backboard.extension.signIn', 'backboard.extension.signOut'].includes(event.commandId)) {
				this.close(); void this.refreshIdentity(true);
			}
		}));
		this._register(billing.onDidChange(() => this.updatePresentation()));
		this._register(this.runner.onDidRun(event => { if (event.error) { this.notifications.error(event.error); } }));
		void auth.refresh().then(() => this.refreshIdentity()).catch(error => this.log.warn('[Backboard] Could not refresh account menu identity.', error));
	}

	render(parent: HTMLElement, compact = true): HTMLButtonElement {
		const button = this.button = DOM.append(parent, DOM.$<HTMLButtonElement>('button.backboard-account-button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }));
		button.classList.toggle('compact', compact);
		this.avatar = DOM.append(button, DOM.$('span.backboard-account-avatar', { 'aria-hidden': 'true' }));
		const text = DOM.append(button, DOM.$('span.backboard-account-text'));
		this.label = DOM.append(text, DOM.$('span.backboard-account-name'));
		this.subtitle = DOM.append(text, DOM.$('span.backboard-account-subtitle'));
		const chevron = DOM.append(button, DOM.$('span.backboard-account-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronUp));
		chevron.setAttribute('aria-hidden', 'true');
		// The Editor activity bar also handles mouse-down and key-up on its items.
		// Isolate this real button so one interaction cannot toggle the menu twice.
		this._register(DOM.addDisposableListener(button, DOM.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_UP, event => event.stopPropagation()));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, event => { event.stopPropagation(); this.toggle(); }));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); if (!this.view) { this.toggle(); } }
		}));
		this.updatePresentation();
		return button;
	}

	focus(): void { this.button?.focus(); }

	private signedIn(): boolean { return this.contextKeys.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) === true; }
	private alternative(): boolean { return this.contextKeys.getContextKeyValue<boolean>(BackboardAuthContextKeys.alternativeConfigured.key) === true; }

	private async refreshIdentity(clear = false): Promise<void> {
		const revision = ++this.revision;
		if (clear || !this.signedIn()) { this.info = {}; }
		this.updatePresentation();
		if (!this.signedIn()) { return; }
		try {
			const info = await resolveBackboardUserInfo(this.files, this.paths, this.requests, this.log);
			if (revision !== this.revision || this._store.isDisposed || !this.signedIn()) { return; }
			this.info = info;
			this.updatePresentation();
		} catch { this.log.warn('[Backboard] Could not resolve account menu identity.'); }
	}

	private updatePresentation(): void {
		const signedIn = this.signedIn();
		const name = signedIn ? this.info.name ?? this.info.email ?? localize('backboardAccountName', "Backboard account") : localize('backboardAccountSignedOut', "Backboard Desktop");
		const plan = signedIn && !this.billing.needsSignIn ? this.billing.status?.plan?.plan_name : undefined;
		const subtitle = signedIn ? plan ? `${plan.charAt(0)}${plan.slice(1).toLowerCase()} plan` : this.info.email ?? localize('backboardAccountConnected', "Signed in to Backboard")
			: this.alternative() ? localize('backboardSubscriptionsConnected', "Connected subscriptions") : localize('backboardAccountSignInHint', "Sign in to Backboard");
		for (const node of [this.avatar, this.headerAvatar]) { if (node) { node.textContent = signedIn ? backboardAccountInitials(name) : 'B'; } }
		for (const node of [this.label, this.headerName]) { if (node) { node.textContent = name; } }
		for (const node of [this.subtitle, this.headerSubtitle]) { if (node) { node.textContent = subtitle; } }
		if (this.button) { this.button.title = `${name} · ${subtitle}`; this.button.setAttribute('aria-label', `${name}, ${subtitle}. Open account menu`); }
	}

	private menuActions(id: MenuId): IAction[] {
		const menu = this.menus.createMenu(id, this.contextKeys);
		try { return getActionBarActions(menu.getActions({ renderShortTitle: true })).secondary; }
		finally { menu.dispose(); }
	}

	private actions(): IAction[] {
		const action = (id: string, label: string, icon: ThemeIcon, run?: () => Promise<unknown>) => toAction({
			id, label, class: ThemeIcon.asClassName(icon), run: run ?? (async () => { await this.options.beforeOpen?.(); await this.commands.executeCommand(id); }),
		});
		const primary = [
			action('backboard.openUsage', localize('backboardAccountUsage', "Usage"), Codicon.dashboard, this.options.openUsage),
			action('backboard.openBilling', localize('backboardAccountBilling', "Billing"), Codicon.creditCard),
			action('backboard.openApiKeys', localize('backboardAccountApiKeys', "API Keys"), Codicon.key),
			action('workbench.action.openSettings', localize('backboardAccountSettings', "Settings"), Codicon.settingsGear),
		];
		const existing = this.menuActions(MenuId.GlobalActivity);
		const authentication: IAction[] = [];
		if (!this.signedIn()) { authentication.push(action('backboard.signIn', localize('backboardAccountSignIn', "Sign in to Backboard"), Codicon.signIn)); }
		if (this.signedIn() || this.alternative()) { authentication.push(action('backboard.signOut', localize('backboardAccountSignOut', "Sign out"), Codicon.signOut)); }
		return combineBackboardAccountActions(primary,
			this.options.editorMode ? existing : existing.filter(item => item.id.startsWith('update.') || item.id === 'backboard.signOut'),
			this.menuActions(MenuId.MenubarHelpMenu), authentication);
	}

	toggle(): void {
		if (this.view) { this.close(); return; }
		if (!this.button) { return; }
		void this.refreshIdentity();
		void this.billing.refresh();
		let menu: Menu | undefined;
		this.button.setAttribute('aria-expanded', 'true');
		this.button.classList.add('menu-visible');
		this.view = this.contextView.showContextView({
			getAnchor: () => this.button!, anchorPosition: AnchorPosition.ABOVE, anchorAlignment: AnchorAlignment.LEFT,
			focus: () => menu?.focus(true),
			onHide: () => {
				this.view = undefined;
				this.button?.setAttribute('aria-expanded', 'false'); this.button?.classList.remove('menu-visible');
				this.headerName = this.headerSubtitle = this.headerAvatar = undefined;
			},
			render: container => {
				const store = new DisposableStore();
				const panel = DOM.append(container, DOM.$('.backboard-account-menu'));
				store.add(toDisposable(() => panel.remove()));
				const header = DOM.append(panel, DOM.$('.backboard-account-menu-header'));
				this.headerAvatar = DOM.append(header, DOM.$('span.backboard-account-avatar', { 'aria-hidden': 'true' }));
				const identity = DOM.append(header, DOM.$('.backboard-account-text'));
				this.headerName = DOM.append(identity, DOM.$('span.backboard-account-name'));
				this.headerSubtitle = DOM.append(identity, DOM.$('span.backboard-account-subtitle'));
				this.updatePresentation();
				store.add(this.runner.onWillRun(() => this.close()));
				const actions = this.actions();
				menu = store.add(new Menu(DOM.append(panel, DOM.$('.backboard-account-menu-actions')), actions, {
					actionRunner: this.runner, ariaLabel: localize('backboardAccountMenuLabel', "Backboard account"),
					getKeyBinding: action => this.keybindings.lookupKeybinding(action.id),
				}, { ...defaultMenuStyles, shadowColor: undefined, borderColor: undefined }));
				// Native Menu preserves shortcuts, checked states, and submenu navigation.
				// Add visual icons without replacing its action view items or their behavior.
				const icons: Record<string, ThemeIcon> = {
					'backboard.openUsage': Codicon.dashboard, 'backboard.openBilling': Codicon.creditCard,
					'backboard.openApiKeys': Codicon.key, 'workbench.action.openSettings': Codicon.settingsGear,
					'backboard.account.help': Codicon.question, 'backboard.signIn': Codicon.signIn, 'backboard.signOut': Codicon.signOut,
				};
				const entries = actions.filter(action => !(action instanceof Separator));
				menu.getContainer().querySelectorAll('.action-menu-item').forEach((item, index) => {
					const icon = icons[entries[index]?.id];
					if (icon) {
						const node = DOM.$('span.backboard-account-action-icon', { 'aria-hidden': 'true' });
						node.classList.add(...ThemeIcon.asClassNameArray(icon));
						item.prepend(node);
					}
				});
				store.add(menu.onDidCancel(() => this.close(true)));
				store.add(DOM.addDisposableListener(DOM.getWindow(container), DOM.EventType.MOUSE_DOWN, event => {
					const target = event.target as Node | null;
					if (target && !container.contains(target) && !this.button?.contains(target)) { this.close(); }
				}, true));
				store.add(DOM.addDisposableListener(DOM.getWindow(container), DOM.EventType.BLUR, () => this.close()));
				return store;
			},
		});
	}

	private close(restoreFocus = false): void {
		this.view?.close();
		if (restoreFocus) { this.focus(); }
	}
}
