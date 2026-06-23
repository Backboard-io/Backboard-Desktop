# Composer And Chat Chrome Flow

## Flow Diagram

```text
Backboard composer
    |
    +--> keeps web, image, voice, stop, send
    L--> removes visible usage button from composer action map

Chat input/title/browser chrome
    |
    +--> BackboardUsageMetricsAction removed from ChatInputStatus menu
    +--> sign-in action no longer placed in BrowserActionsToolbar
    L--> chat title control CSS tightens tab and close-button behavior
```

## Source Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTitleControl.css`

## Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

interface BridgeEvent {
	readonly type: string;
	readonly requestId: string;
	readonly sessionId?: string;
	readonly message?: string;
	readonly text?: string;
	readonly models?: BridgeModel[];
	readonly tools?: unknown[];
	readonly toolCalls?: unknown[];
	readonly threadId?: string;
	readonly runId?: string;
	readonly stopReason?: string;
	readonly usage?: unknown;
	readonly chunk?: unknown;
	readonly assistantId?: string;
	readonly output?: unknown;
	readonly status?: string;
	readonly name?: string;
	readonly data?: unknown;
}

interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly displayName?: string;
	readonly contextLimit?: number;
	readonly supportsThinking?: boolean;
	readonly pricing?: string;
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly inputPricePerMillion?: number;
	readonly outputPricePerMillion?: number;
	readonly inputCostPer1mTokens?: number;
	readonly outputCostPer1mTokens?: number;
	readonly promptPrice?: number;
	readonly completionPrice?: number;
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts
import { assertType } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getModeNameForTelemetry, buildCustomAgentHandoffsInfo, getHandoffId, IChatMode, IChatModeService, IChatModes } from '../../common/chatModes.js';
import { chatVariableLeader } from '../../common/requestParser/chatParserTypes.js';
import { ChatStopCancellationNoopClassification, ChatStopCancellationNoopEvent, ChatStopCancellationNoopEventName, IChatService } from '../../common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ILanguageModelChatMetadata } from '../../common/languageModels.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { isInClaudeAgentsFolder } from '../../common/promptSyntax/config/promptFileLocations.js';
import { IChatSessionsService, localChatSessionType } from '../../common/chatSessionsService.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { getAgentSessionProvider, AgentSessionProviders, AgentSessionTarget } from '../agentSessions/agentSessions.js';
import { getEditingSessionContext } from '../chatEditing/chatEditingActions.js';
import { ctxHasEditorModification, ctxHasRequestInProgress, ctxIsGlobalEditingSession } from '../chatEditing/chatEditingEditorContextKeys.js';
import { ACTION_ID_NEW_CHAT, CHAT_CATEGORY, clearChatSessionPreservingType, handleCurrentEditingSession, handleModeSwitch } from './chatActions.js';
import { CreateRemoteAgentJobAction } from './chatContinueInAction.js';

export interface IVoiceChatExecuteActionContext {
	readonly disableTimeout?: boolean;
}

export interface IChatExecuteActionContext {
	widget?: IChatWidget;
	inputValue?: string;
	voice?: IVoiceChatExecuteActionContext;
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts
import Severity from '../../../../../base/common/severity.js';
import { equalsIgnoreCase } from '../../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { GitHubPaths, IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ToggleTitleBarConfigAction } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ChatEntitlement, ChatEntitlementContext, ChatEntitlementRequests, ChatEntitlementService, IChatEntitlementService, isProUser } from '../../../../services/chat/common/chatEntitlementService.js';
import { EnablementState, IWorkbenchExtensionEnablementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { ExtensionUrlHandlerOverrideRegistry, IExtensionUrlHandlerOverride } from '../../../../services/extensions/browser/extensionUrlHandler.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IExtension, IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { CHAT_CATEGORY, CHAT_SETUP_ACTION_ID, CHAT_SETUP_SUPPORT_ANONYMOUS_ACTION_ID } from '../actions/chatActions.js';
import { ChatViewContainerId, IChatWidget, IChatWidgetService } from '../chat.js';
import { ChatInputNotificationSeverity, IChatInputNotificationService } from '../widget/input/chatInputNotificationService.js';
import { chatViewsWelcomeRegistry } from '../viewsWelcome/chatViewsWelcome.js';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTitleControl.css

```css
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTitleControl.css
.chat-viewpane {

	.chat-view-title-container {
		display: none;
		cursor: pointer;
		flex-shrink: 0;
		height: 26px;
		border-bottom: 1px solid var(--vscode-panel-border);
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));

		.chat-view-title-inner {
			display: flex;
			align-items: center;
			gap: 0;
			height: 100%;
			width: 100%;
			padding: 0;
			box-sizing: border-box;
		}

		.chat-view-title-tabs {
			display: flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 1 1 auto;
			overflow-x: auto;
			overflow-y: hidden;
			height: 100%;
			padding-left: 0;
			overscroll-behavior-x: contain;
			scroll-behavior: smooth;
			scrollbar-width: none;
			mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent);
			-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 96px), transparent);
		}

		.chat-view-title-tabs::-webkit-scrollbar {
			display: none;
		}

		.chat-view-title-tab {
			display: flex;
			align-items: center;
```

