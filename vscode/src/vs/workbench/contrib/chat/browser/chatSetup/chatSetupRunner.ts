/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSetup.css';
import { $ } from '../../../../../base/browser/dom.js';
import { IButton } from '../../../../../base/browser/ui/button/button.js';
import { Dialog, DialogContentsAlignment } from '../../../../../base/browser/ui/dialog/dialog.js';
import { coalesce } from '../../../../../base/common/arrays.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { createWorkbenchDialogOptions } from '../../../../browser/parts/dialogs/dialog.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService, TelemetryLevel } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ChatEntitlement, ChatEntitlementContext, ChatEntitlementService, IChatEntitlementService, isProUser } from '../../../../services/chat/common/chatEntitlementService.js';
import { IChatWidgetService } from '../chat.js';
import { ChatSetupController } from './chatSetupController.js';
import { IChatSetupResult, ChatSetupAnonymous, InstallChatEvent, InstallChatClassification, ChatSetupStrategy, ChatSetupResultValue } from './chatSetup.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IFileService, FileOperationResult, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';

const defaultChat = {
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' } },
	chatRefreshTokenCommand: product.defaultChatAgent?.chatRefreshTokenCommand ?? ''
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBackboardEnv(env: string | undefined): string {
	switch ((env || 'prod').trim().toLowerCase()) {
		case '':
			return 'prod';
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (env || 'prod').trim().toLowerCase();
	}
}

function getBackboardEnvKeys(config: Record<string, unknown>): Record<string, string> {
	const envKeys = config.env_keys;
	if (!isObjectRecord(envKeys)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const [env, apiKey] of Object.entries(envKeys)) {
		if (typeof apiKey === 'string') {
			result[normalizeBackboardEnv(env)] = apiKey;
		}
	}
	return result;
}

export class ChatSetup {

	private static instance: ChatSetup | undefined = undefined;
	static getInstance(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): ChatSetup {
		let instance = ChatSetup.instance;
		if (!instance) {
			instance = ChatSetup.instance = instantiationService.invokeFunction(accessor => {
				return new ChatSetup(context, controller, accessor.get(ITelemetryService), accessor.get(IWorkbenchLayoutService), accessor.get(IKeybindingService), accessor.get(IChatEntitlementService) as ChatEntitlementService, accessor.get(ILogService), accessor.get(IChatWidgetService), accessor.get(IWorkspaceTrustRequestService), accessor.get(IMarkdownRendererService), accessor.get(IDefaultAccountService), accessor.get(IHostService), accessor.get(IFileService), accessor.get(IPathService), accessor.get(INotificationService));
			});
		}

		return instance;
	}

	private pendingRun: Promise<IChatSetupResult> | undefined = undefined;

	private skipDialogOnce = false;

	private constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IChatEntitlementService private readonly chatEntitlementService: ChatEntitlementService,
		@ILogService private readonly logService: ILogService,
		@IChatWidgetService private readonly widgetService: IChatWidgetService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IHostService private readonly hostService: IHostService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	skipDialog(): void {
		this.skipDialogOnce = true;
	}

	async run(options?: { disableChatViewReveal?: boolean; forceSignInDialog?: boolean; additionalScopes?: readonly string[]; forceAnonymous?: ChatSetupAnonymous; dialogIcon?: ThemeIcon; dialogTitle?: string; setupStrategy?: ChatSetupStrategy; disableCloseButton?: boolean; onSignInStarted?: () => void }): Promise<IChatSetupResult> {
		if (this.pendingRun) {
			return this.pendingRun;
		}

		this.pendingRun = this.doRun(options);

		try {
			return await this.pendingRun;
		} finally {
			this.pendingRun = undefined;
		}
	}

	private async doRun(options?: { disableChatViewReveal?: boolean; forceSignInDialog?: boolean; additionalScopes?: readonly string[]; forceAnonymous?: ChatSetupAnonymous; dialogIcon?: ThemeIcon; dialogTitle?: string; setupStrategy?: ChatSetupStrategy; disableCloseButton?: boolean; onSignInStarted?: () => void }): Promise<IChatSetupResult> {
		this.context.update({ later: false });

		const dialogSkipped = this.skipDialogOnce;
		this.skipDialogOnce = false;

		if (this.layoutService.mainContainer.classList.contains('agent-sessions-workbench')) {
			this.logService.info('[chat setup] Skipping VS Code/GitHub chat setup in Backboard agents window.');
			this.context.update({ completed: true });
			return { success: true, dialogSkipped };
		}

		const trusted = await this.workspaceTrustRequestService.requestWorkspaceTrust({
			message: localize('chatWorkspaceTrust', "AI features are currently only supported in trusted workspaces.")
		});
		if (!trusted) {
			this.context.update({ later: true });
			this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotTrusted', installDuration: 0, signUpErrorCode: undefined, provider: undefined });

			return { dialogSkipped, success: undefined /* canceled */ };
		}

		let setupStrategy: ChatSetupStrategy;
		if (options?.setupStrategy !== undefined) {
			setupStrategy = options.setupStrategy; // caller provided a specific strategy, skip dialog
		} else if (!options?.forceSignInDialog && (dialogSkipped || isProUser(this.chatEntitlementService.entitlement) || this.chatEntitlementService.entitlement === ChatEntitlement.Free)) {
			setupStrategy = ChatSetupStrategy.DefaultSetup; // existing pro/free users setup without a dialog
		} else if (options?.forceAnonymous === ChatSetupAnonymous.EnabledWithoutDialog) {
			setupStrategy = ChatSetupStrategy.DefaultSetup; // anonymous setup without a dialog
		} else {
			setupStrategy = await this.showDialog(options);
		}

		if (setupStrategy === ChatSetupStrategy.DefaultSetup && this.defaultAccountService.getDefaultAccountAuthenticationProvider().enterprise) {
			setupStrategy = ChatSetupStrategy.SetupWithEnterpriseProvider; // users with a configured provider go through provider setup
		}

		const startsChatSetup = setupStrategy !== ChatSetupStrategy.Canceled && setupStrategy !== ChatSetupStrategy.SetupWithBackboardProvider && setupStrategy !== ChatSetupStrategy.SetupWithBackboardApiKey;
		if (startsChatSetup) {
			options?.onSignInStarted?.();
		}

		if (startsChatSetup && !options?.disableChatViewReveal) {
			// Show the chat view now to better indicate progress
			// while installing the extension or returning from sign in
			this.widgetService.revealWidget();
		}

		let success: ChatSetupResultValue = undefined;
		try {
			switch (setupStrategy) {
				case ChatSetupStrategy.SetupWithEnterpriseProvider:
					success = await this.controller.value.setupWithProvider({ useEnterpriseProvider: true, useSocialProvider: undefined, additionalScopes: options?.additionalScopes, forceAnonymous: options?.forceAnonymous });
					break;
				case ChatSetupStrategy.SetupWithoutEnterpriseProvider:
					success = await this.controller.value.setupWithProvider({ useEnterpriseProvider: false, useSocialProvider: undefined, additionalScopes: options?.additionalScopes, forceAnonymous: options?.forceAnonymous });
					break;
				case ChatSetupStrategy.SetupWithAppleProvider:
					success = await this.controller.value.setupWithProvider({ useEnterpriseProvider: false, useSocialProvider: 'apple', additionalScopes: options?.additionalScopes, forceAnonymous: options?.forceAnonymous });
					break;
				case ChatSetupStrategy.SetupWithGoogleProvider:
					success = await this.controller.value.setupWithProvider({ useEnterpriseProvider: false, useSocialProvider: 'google', additionalScopes: options?.additionalScopes, forceAnonymous: options?.forceAnonymous });
					break;
				case ChatSetupStrategy.DefaultSetup:
					success = await this.controller.value.setup({ ...options, forceAnonymous: options?.forceAnonymous });
					break;
				case ChatSetupStrategy.SetupWithBackboardApiKey:
					success = await this.showBackboardApiKeyDialog();
					break;
				case ChatSetupStrategy.SetupWithBackboardProvider:
					break;
				case ChatSetupStrategy.Canceled:
					this.context.update({ later: true });
					this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedMaybeLater', installDuration: 0, signUpErrorCode: undefined, provider: undefined });
					break;
			}
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
			success = false;
		}

		if (success) {
			this.context.update({ completed: true });
		}

		return { success, dialogSkipped };
	}

	private async showDialog(options?: { forceSignInDialog?: boolean; forceAnonymous?: ChatSetupAnonymous; dialogIcon?: ThemeIcon; dialogTitle?: string; disableCloseButton?: boolean; onSignInStarted?: () => void }): Promise<ChatSetupStrategy> {
		const disposables = new DisposableStore();

		const buttons = this.getButtons(options);

		const dialog = disposables.add(new Dialog(
			this.layoutService.activeContainer,
			this.getDialogTitle(options),
			buttons.map(button => button[0]),
			createWorkbenchDialogOptions({
				type: 'none',
				extraClasses: ['chat-setup-dialog', 'backboard-signin-dialog'],
				detail: ' ', // workaround allowing us to render the message in large
				icon: options?.dialogIcon,
				alignment: DialogContentsAlignment.Vertical,
				cancelId: buttons.length,
				disableCloseButton: options?.disableCloseButton ?? false,
				renderFooter: footer => footer.appendChild(this.createDialogFooter(disposables, options)),
				buttonOptions: buttons.map(button => button[2])
			}, this.keybindingService, this.layoutService, this.hostService)
		));

		const { button } = await dialog.show();
		disposables.dispose();

		return buttons[button]?.[1] ?? ChatSetupStrategy.Canceled;
	}

	private getButtons(options?: { forceSignInDialog?: boolean; forceAnonymous?: ChatSetupAnonymous }): Array<[string, ChatSetupStrategy, { styleButton?: (button: IButton) => void } | undefined]> {
		type ContinueWithButton = [string, ChatSetupStrategy, { styleButton?: (button: IButton) => void } | undefined];
		const styleButton = (...classes: string[]) => ({ styleButton: (button: IButton) => button.element.classList.add(...classes) });

		let buttons: Array<ContinueWithButton>;
		if (!options?.forceAnonymous && (this.context.state.entitlement === ChatEntitlement.Unknown || options?.forceSignInDialog)) {
			const defaultProviderButton: ContinueWithButton = [localize('continueWith', "Continue with {0}", defaultChat.provider.default.name), ChatSetupStrategy.SetupWithoutEnterpriseProvider, styleButton('continue-button', 'default')];
			const backboardProviderButton: ContinueWithButton = [localize('continueWithBackboard', "Continue with Backboard"), ChatSetupStrategy.SetupWithBackboardProvider, styleButton('continue-button', 'backboard')];
			const apiKeyButton: ContinueWithButton = [localize('continueWithApiKey', "Continue with API Key"), ChatSetupStrategy.SetupWithBackboardApiKey, styleButton('continue-button', 'api-key')];

			buttons = coalesce([
				defaultProviderButton,
				backboardProviderButton,
				apiKeyButton
			]);
		} else {
			buttons = [[localize('setupAIButton', "Use AI Features"), ChatSetupStrategy.DefaultSetup, undefined]];
		}

		return buttons;
	}

	private getDialogTitle(options?: { forceSignInDialog?: boolean; forceAnonymous?: ChatSetupAnonymous; dialogTitle?: string }): string {
		if (options?.dialogTitle) {
			return options.dialogTitle;
		}

		if (this.chatEntitlementService.anonymous) {
			if (options?.forceAnonymous) {
				return localize('startUsing', "Start using AI Features");
			} else {
				return localize('enableMore', "Enable more AI features");
			}
		}

		if (this.context.state.entitlement === ChatEntitlement.Unknown || options?.forceSignInDialog) {
			return localize('signIn', "Sign in to Backboard");
		}

		return localize('startUsing', "Start using AI Features");
	}

	private createDialogFooter(disposables: DisposableStore, options?: { forceAnonymous?: ChatSetupAnonymous }): HTMLElement {
		const element = $('.chat-setup-dialog-footer');

		let footer: string;
		if (options?.forceAnonymous || this.telemetryService.telemetryLevel === TelemetryLevel.NONE) {
			footer = localize('backboardSettingsAnonymous', "Choose a sign-in method for Backboard. API keys are stored locally in ~/.backboard_ide/config.json.");
		} else {
			footer = localize('backboardSettings', "Choose a sign-in method for Backboard. GitHub sign-in continues through GitHub; API keys are stored locally in ~/.backboard_ide/config.json.");
		}
		element.appendChild($('p', undefined, disposables.add(this.markdownRendererService.render(new MarkdownString(footer, { isTrusted: true }))).element));

		return element;
	}

	private async showBackboardApiKeyDialog(): Promise<ChatSetupResultValue> {
		const disposables = new DisposableStore();
		const dialog = disposables.add(new Dialog(
			this.layoutService.activeContainer,
			localize('backboardApiKey.title', "Use a Backboard API Key"),
			[
				localize('backboardApiKey.save', "Save API Key")
			],
			createWorkbenchDialogOptions({
				type: 'none',
				extraClasses: ['chat-setup-dialog', 'backboard-signin-dialog', 'backboard-api-key-dialog'],
				detail: localize('backboardApiKey.detail', "Enter your Backboard API key to use Backboard in this IDE."),
				alignment: DialogContentsAlignment.Vertical,
				cancelId: 1,
				inputs: [{
					placeholder: localize('backboardApiKey.placeholder', "Backboard API key"),
					type: 'password'
				}],
				renderFooter: footer => {
					footer.appendChild($('p.chat-setup-dialog-footer', undefined, localize('backboardApiKey.footer', "Stored in ~/.backboard_ide/config.json.")));
				}
			}, this.keybindingService, this.layoutService, this.hostService)
		));

		const { button, values } = await dialog.show();
		disposables.dispose();

		if (button !== 0) {
			return undefined;
		}

		const apiKey = values?.[0]?.trim();
		if (!apiKey) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('backboardApiKey.empty', "Enter a Backboard API key before saving.")
			});
			return undefined;
		}

		try {
			await this.saveBackboardApiKey(apiKey);
			return true;
		} catch (error) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('backboardApiKey.error', "Failed to save the Backboard API key: {0}", toErrorMessage(error))
			});
			return false;
		}
	}

	private async readBackboardConfigJson(configResource: URI): Promise<Record<string, unknown>> {
		try {
			const content = await this.fileService.readFile(configResource);
			const parsed: unknown = JSON.parse(content.value.toString());
			return isObjectRecord(parsed) ? parsed : {};
		} catch (error) {
			if (error instanceof SyntaxError || (error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND)) {
				return {};
			}
			throw error;
		}
	}

	private async saveBackboardApiKey(apiKey: string): Promise<void> {
		const home = this.pathService.userHome({ preferLocal: true });
		const configDir = URI.joinPath(home, '.backboard_ide');
		const configResource = URI.joinPath(configDir, 'config.json');
		const config = await this.readBackboardConfigJson(configResource);
		const env = normalizeBackboardEnv(typeof config.env === 'string' ? config.env : undefined);
		const envKeys = getBackboardEnvKeys(config);
		envKeys[env] = apiKey;

		await this.fileService.createFolder(configDir);
		await this.fileService.writeFile(configResource, VSBuffer.fromString(`${JSON.stringify({
			...config,
			env,
			api_key: apiKey,
			env_keys: envKeys
		}, undefined, '\t')}\n`), { atomic: { postfix: '.vsctmp' } });
	}
}

//#endregion

export function refreshTokens(commandService: ICommandService): void {
	// ugly, but we need to signal to the extension that entitlements changed
	commandService.executeCommand(defaultChat.chatRefreshTokenCommand);
}
