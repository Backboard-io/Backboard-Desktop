/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAgentCliSetupService, CHATGPT_SUBSCRIPTION_SETUP_ID, CLAUDE_SUBSCRIPTION_SETUP_ID } from '../../browser/agentSessions/agentCliSetup.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatEntitlementContextKeys, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { BackboardAuthContextKeys, IBackboardAuthService } from '../../common/backboardAuth.js';


const backboardCategory = localize2('backboard.category', "Backboard");

export function registerBackboardSsoActions(): void {
	if (!isWindows) {
		registerAction2(class BackboardSubscriptionSetupAction extends Action2 {
			constructor() { super({ id: 'backboard.setupSubscription', title: localize2('backboard.setupSubscription', "Set Up Subscription"), category: backboardCategory, f1: true }); }
			override async run(accessor: ServicesAccessor): Promise<void> {
				const setup = accessor.get(IAgentCliSetupService);
				const choice = await accessor.get(IQuickInputService).pick([
					{ label: 'ChatGPT', id: CHATGPT_SUBSCRIPTION_SETUP_ID },
					{ label: 'Claude', id: CLAUDE_SUBSCRIPTION_SETUP_ID },
				], { title: localize('backboard.byos.title', "Bring Your Own Subscription"), placeHolder: localize('backboard.byos.choose', "Choose a subscription") });
				if (choice) { await setup.beginSetup(choice.id); }
			}
		});
	}
	registerAction2(class BackboardSignInAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.signIn',
				title: localize2('backboard.signIn', "Backboard: Sign In"),
				category: backboardCategory,
				f1: true,
			});
		}

		/**
		 * Delegates to the built-in Backboard extension, which signs in with the
		 * OAuth device authorization grant (RFC 8628): open the verification page
		 * in the browser and poll the token endpoint until the user approves. No
		 * localhost redirect or callback server is involved.
		 */
		override async run(accessor: ServicesAccessor): Promise<boolean> {
			return Boolean(await accessor.get(ICommandService).executeCommand<boolean>('backboard.extension.signIn'));
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

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IBackboardAuthService authService: IBackboardAuthService,
		@ILogService logService: ILogService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, 'backboard.signIn', (action, options) => new BackboardSignInTitleBarEntry(action, options)));
		const markReady = (): void => {
			if (contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.enabled.key) !== true) { return; }
			if (contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) === true
				|| contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.alternativeConfigured.key) === true) {
				markBackboardChatReady(chatEntitlementService, contextKeyService);
			}
		};
		this._register(contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set([BackboardAuthContextKeys.signedIn.key, BackboardAuthContextKeys.alternativeConfigured.key]))) {
				markReady();
			}
		}));
		void authService.refresh().then(markReady, error => logService.error('[Backboard] Failed to check credentials', error));
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
