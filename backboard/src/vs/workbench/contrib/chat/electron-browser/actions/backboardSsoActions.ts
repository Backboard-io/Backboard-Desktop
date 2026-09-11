/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, getConfigValueInTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatEntitlementContextKeys, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IOnboardingService } from '../../../welcomeOnboarding/common/onboardingService.js';
import { BackboardAuthContextKeys, backboardConfigResource, clearBackboardCredentials, hasBackboardCredentials, isBackboardProduct } from '../../common/backboardAuth.js';

const backboardCategory = localize2('backboard.category', "Backboard");

export function registerBackboardSsoActions(): void {
	registerAction2(class BackboardSignInAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.signIn',
				title: localize2('backboard.signIn', "Backboard: Sign In"),
				category: backboardCategory,
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): Promise<boolean> {
			return accessor.get(IOnboardingService).showSignIn();
		}
	});

	registerAction2(class BackboardBrowserSignInAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.signInWithBrowser',
				title: localize2('backboard.signInWithBrowser', "Sign In with Browser"),
				category: backboardCategory,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<boolean> {
			return Boolean(await accessor.get(ICommandService).executeCommand<boolean>('backboard.extension.signIn'));
		}
	});

	registerAction2(class BackboardSignOutAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.signOut',
				title: localize2('backboard.signOut', "Sign Out"),
				category: backboardCategory,
				f1: true,
				menu: [{ id: MenuId.GlobalActivity, group: '7_update', order: 2, when: BackboardAuthContextKeys.enabled }],
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const fileService = accessor.get(IFileService);
			const pathService = accessor.get(IPathService);
			const contextKeyService = accessor.get(IContextKeyService);
			const agentHostService = accessor.get(IAgentHostService);
			const configurationService = accessor.get(IConfigurationService);
			const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
			const key = 'backboard.apiKey';
			const values = configurationService.inspect<string>(key);
			for (const target of [ConfigurationTarget.APPLICATION, ConfigurationTarget.USER_LOCAL, ConfigurationTarget.USER_REMOTE, ConfigurationTarget.WORKSPACE, ConfigurationTarget.MEMORY]) {
				if (getConfigValueInTarget(values, target) !== undefined) {
					await configurationService.updateValue(key, undefined, target);
				}
			}
			for (const folder of folders) {
				if (configurationService.inspect<string>(key, { resource: folder.uri }).workspaceFolderValue !== undefined) {
					await configurationService.updateValue(key, undefined, { resource: folder.uri }, ConfigurationTarget.WORKSPACE_FOLDER);
				}
			}
			await clearBackboardCredentials(fileService, await backboardConfigResource(pathService));
			BackboardAuthContextKeys.signedIn.bindTo(contextKeyService).set(false);
			await agentHostService.restartAgentHost();
		}
	});

	registerAction2(class BackboardDeleteAccountAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.deleteAccount',
				title: localize2('backboard.deleteAccount', "Delete Account"),
				category: backboardCategory,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IOpenerService).open(URI.parse('https://app.backboard.io'), { openExternal: true });
		}
	});

	MenuRegistry.appendMenuItem(MenuId.TitleBar, {
		command: {
			id: 'backboard.signIn',
			title: localize2('backboard.signIn.short', "Sign in"),
			icon: ThemeIcon.fromId('backboard-logo'),
		},
		group: 'navigation',
		order: 0,
		when: ContextKeyExpr.and(
			BackboardAuthContextKeys.enabled,
			BackboardAuthContextKeys.signedIn.negate()
		),
	});
}

export class BackboardCredentialsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardCredentials';

	private readonly signedInKey: IContextKey<boolean>;

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, 'backboard.signIn', (action, options) => new BackboardSignInTitleBarEntry(action, options)));

		this.signedInKey = BackboardAuthContextKeys.signedIn.bindTo(this.contextKeyService);
		if (isBackboardProduct()) {
			BackboardAuthContextKeys.enabled.bindTo(this.contextKeyService).set(true);
			this.signedInKey.set(false);
			this.watchBackboardCredentials().catch(error => this.logService.error(`[Backboard] Failed to check credentials: ${error instanceof Error ? error.message : String(error)}`));
		} else {
			BackboardAuthContextKeys.enabled.bindTo(this.contextKeyService).set(false);
			this.signedInKey.set(true);
		}
	}

	/**
	 * Keeps `backboard.signedIn` in sync with the credentials on disk for the
	 * lifetime of the window, so every auth gate (session view, chat panes,
	 * agents welcome) appears when the user signs out and disappears when a
	 * sign-in lands — including sign-ins performed in another window, which
	 * only communicate through the shared config file.
	 */
	private async watchBackboardCredentials(): Promise<void> {
		const configResource = await backboardConfigResource(this.pathService);
		const watcher = this._register(this.fileService.createWatcher(configResource, { recursive: false, excludes: [] }));
		this._register(watcher.onDidChange(() => {
			this.updateSignedInState(configResource).catch(error => this.logService.error(`[Backboard] Failed to refresh credentials state: ${error instanceof Error ? error.message : String(error)}`));
		}));
		await this.updateSignedInState(configResource);
	}

	private async updateSignedInState(configResource: URI): Promise<void> {
		const signedIn = await hasBackboardCredentials(this.fileService, configResource);
		if (signedIn === this.signedInKey.get()) {
			return;
		}
		this.signedInKey.set(signedIn);
		if (signedIn) {
			markBackboardChatReady(this.chatEntitlementService, this.contextKeyService);
			this.logService.info(`[Backboard] Credentials found in ${configResource.fsPath}; chat setup marked ready.`);
		} else {
			this.logService.info(`[Backboard] Credentials removed from ${configResource.fsPath}; auth gates enabled.`);
		}
	}
}

class BackboardSignInTitleBarEntry extends BaseActionViewItem {

	private label: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
	) {
		super(undefined, action, options);
	}

	public override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('backboard-titlebar-sign-in');
		container.setAttribute('role', 'button');
		container.setAttribute('aria-label', this.action.label);

		const content = dom.append(container, dom.$('.backboard-titlebar-sign-in-button'));
		const logo = dom.append(content, dom.$('span.backboard-titlebar-sign-in-logo.codicon.codicon-backboard-logo'));
		logo.setAttribute('aria-hidden', 'true');

		this.label = dom.append(content, dom.$('span.backboard-titlebar-sign-in-label'));
		this.label.textContent = this.action.label;
	}

	protected override updateLabel(): void {
		if (this.label) {
			this.label.textContent = this.action.label;
		}
		if (this.element) {
			this.element.setAttribute('aria-label', this.action.label);
		}
	}

	protected override updateEnabled(): void {
		if (this.element) {
			this.element.classList.toggle('disabled', !this.action.enabled);
		}
	}
}

function markBackboardChatReady(chatEntitlementService: IChatEntitlementService, contextKeyService: IContextKeyService): void {
	chatEntitlementService.markSetupCompleted();
	BackboardAuthContextKeys.enabled.bindTo(contextKeyService).set(true);
	BackboardAuthContextKeys.signedIn.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Setup.completed.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Setup.installed.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Setup.hidden.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.disabled.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.disabledInWorkspace.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.untrusted.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.later.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.registered.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.canSignUp.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planFree.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planEdu.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planPro.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planProPlus.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planMax.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planEnterprise.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planBusiness.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Entitlement.organisations.bindTo(contextKeyService).set(['backboard']);
	ChatEntitlementContextKeys.Entitlement.sku.bindTo(contextKeyService).set('backboard');
}
