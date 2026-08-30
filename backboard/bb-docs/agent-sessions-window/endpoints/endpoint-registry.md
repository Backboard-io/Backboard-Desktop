# Agent Sessions Window Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/agent-sessions-window/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `workbench.action.agenticSignOut` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.action.agenticSignIn` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.action.openSettings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.view.extension.copilot-chat` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chatDebug/browser/chatDebug.contribution.ts` |
| `workbench.sessions.panel.chatDebugContainer` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chatDebug/browser/chatDebug.contribution.ts` |
| `workbench.sessions.auxiliaryBar.filesContainer` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `sessions.files.action.syncChanges` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `sessions.files.action.collapseExplorerFolders` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `workbench.action.toggleWindowAlwaysOnTop` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutActions.ts` |
| `backboard.installAvailableUpdate` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutActions.ts` |
| `workbench.action.agentSessions.openChangesView` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/changes/browser/changesViewActions.ts` |
| `workbench.action.chat.branchChatSession` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/branchChatSessionAction.ts` |
| `workbench.action.agentSessions.runScriptPrimary` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `workbench.action.agentSessions.configureDefaultRunAction` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `workbench.action.agentSessions.generateRunAction` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `chat.enableAdditionalUsage` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chat/vscode-node/chatQuota.contribution.ts` |
| `chat.utilityModel` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatInputNotification/vscode-node/byokUtilityModel.contribution.ts` |
| `chat.utilitySmallModel` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatInputNotification/vscode-node/byokUtilityModel.contribution.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | onStartupFinished, onLanguageModelChat:copilot, onUri, onFileSystem:ccreq, onFileSystem:ccsettings |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | 141 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | 4 entries |
| `contributes.views` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | context-inspector |
| `contributes.viewsContainers` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | activitybar |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | editor/title, editor/title/context, explorer/context, editor/context, chat/editor/inlineGutter, chat/input/editing/sessionToolbar, agents/changes/actions/primary, agents/change/inline |
| `contributes.keybindings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | 4 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/package.json` | 2 entries |

## Endpoint Flow

```text
UI gesture or extension activation
    |
    v
Command/action/menu/view contribution
    |
    v
Service, controller, provider, or extension host boundary
    |
    v
State update, editor update, terminal/process work, webview message, or filesystem/network operation
    |
    v
User-visible result, cancellation, notification, marker, log, or disabled affordance
```

## Endpoint Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AgentFeedbackKind, AgentFeedbackState, IAgentFeedback, IAgentFeedbackAddedEvent, IAgentFeedbackChangeEvent, IAgentFeedbackConvertedEvent, IAgentFeedbackNavigationBearing, IAgentFeedbackReplyAddedEvent, IAgentFeedbackService, IAgentFeedbackSubmittedEvent, INavigableSessionComment } from './agentFeedbackService.js';
import { IAgentFeedbackContext } from './agentFeedbackEditorUtils.js';
import { ICodeReviewSuggestion } from '../../codeReview/browser/codeReviewService.js';

/**
 * No-op implementation of {@link IAgentFeedbackService} used on web,
 * where the full agent feedback UI (editor overlay, hover, attachments)
 * is not wired up. The changes view model still depends on the service
 * being registered, so we expose a service that reports no feedback.
 */
class NullAgentFeedbackService extends Disposable implements IAgentFeedbackService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeFeedback = this._register(new Emitter<IAgentFeedbackChangeEvent>()).event;
	readonly onDidChangeNavigation = this._register(new Emitter<URI>()).event;
	readonly onDidAddFeedback = this._register(new Emitter<IAgentFeedbackAddedEvent>()).event;
	readonly onDidConvertFeedback = this._register(new Emitter<IAgentFeedbackConvertedEvent>()).event;
	readonly onDidAddReply = this._register(new Emitter<IAgentFeedbackReplyAddedEvent>()).event;
	readonly onDidSubmitFeedback = this._register(new Emitter<IAgentFeedbackSubmittedEvent>()).event;

	addFeedback(sessionResource: URI, resourceUri: URI, range: IRange, text: string, _suggestion?: ICodeReviewSuggestion, _context?: IAgentFeedbackContext, _sourcePRReviewCommentId?: string, _kind?: AgentFeedbackKind, state: AgentFeedbackState = AgentFeedbackState.Accepted): IAgentFeedback {
		return {
			id: '',
			text,
			resourceUri,
			range,
			sessionResource,
			kind: AgentFeedbackKind.UserReview,
			state,
		};
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/agentHost/node/agentHostChangesetOperationContributionService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/agentHost/node/agentHostChangesetOperationContributionService.ts
import { parseChangesetUri } from '../common/changesetUri.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';
import { AHP_SESSION_NOT_FOUND, JsonRpcErrorCodes, ProtocolError } from '../common/state/sessionProtocol.js';
import { ActionType } from '../common/state/sessionActions.js';
import { ChangesetOperationScope, ChangesetOperationStatus, ChangesetOperationTargetKind, readSessionGitState, type ChangesetOperation, type ErrorInfo, type ISessionGitState } from '../common/state/sessionState.js';
import type { IChangesetOperationContribution, IChangesetOperationContributionService, IChangesetOperationContext, IChangesetOperationHandler, IChangesetOperationRegistry } from '../common/changesetOperation.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import { AgentHostSessionGitStateService } from './agentHostSessionGitStateService.js';

export class AgentHostChangesetOperationContributionService extends Disposable implements IChangesetOperationContributionService {

	private readonly _handlerRegistrations = this._register(new DisposableMap<IChangesetOperationContribution>());
	private readonly _changesetOperationHandlers = new Map<string, IChangesetOperationHandler>();
	private readonly _inFlightOperations = new Map<string, Promise<InvokeChangesetOperationResult>>();
	private readonly _registry: IChangesetOperationRegistry;

	constructor(
		private readonly _stateManager: AgentHostStateManager,
		private readonly _sessionGitStateService: AgentHostSessionGitStateService,
	) {
		super();
		this._registry = {
			registerChangesetOperationHandler: (operationId, handler) => this._registerChangesetOperationHandler(operationId, handler),
			onDidChangeOperations: (sessionKey, changeset) => this.updateOperations(sessionKey, [changeset]),
			refreshSessionGitState: (sessionKey, changeset) => this._refreshSessionGitStateAndOperations(sessionKey, changeset),
		};
	}

	registerContribution(contribution: IChangesetOperationContribution): IDisposable {
		if (this._handlerRegistrations.has(contribution)) {
			throw new Error('Changeset operation contribution already registered');
		}
		this._handlerRegistrations.set(contribution, contribution.registerHandlers(this._registry));
		return toDisposable(() => {
			this._handlerRegistrations.deleteAndDispose(contribution);
			contribution.dispose();
		});
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts
import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { createDecorator, IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { getClaudeSlashCommandRegistry, IClaudeSlashCommandHandler } from './slashCommands/claudeSlashCommandRegistry';

export interface IClaudeSlashCommandRequest {
	readonly prompt: string;
	readonly command: string | undefined;
}

// Import all slash command handlers to trigger self-registration
import './slashCommands/index';

export interface IClaudeSlashCommandResult {
	handled: boolean;
	result?: vscode.ChatResult;
}

export interface IClaudeSlashCommandService {
	readonly _serviceBrand: undefined;

	/**
	 * Try to handle a slash command from the user's request.
	 *
	 * Checks `request.command` first (VS Code slash command), then falls back to
	 * parsing a `/command` pattern from `request.prompt`.
	 *
	 * @param request - The user's request containing prompt and optional command
	 * @param stream - Response stream for sending messages to the chat
	 * @param token - Cancellation token
	 * @returns Object indicating whether the command was handled and the result
	 */
	tryHandleCommand(
		request: IClaudeSlashCommandRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { ClaudeSlashCommandService, IClaudeSlashCommandRequest } from '../claudeSlashCommandService';
import { IClaudeSlashCommandHandler, IClaudeSlashCommandHandlerCtor } from '../slashCommands/claudeSlashCommandRegistry';

// Wire test handler ctors through the registry so the service populates its cache naturally
const mockGetRegistry = vi.fn<() => readonly IClaudeSlashCommandHandlerCtor[]>().mockReturnValue([]);
vi.mock('../slashCommands/claudeSlashCommandRegistry', async importOriginal => {
	const actual = await importOriginal<typeof import('../slashCommands/claudeSlashCommandRegistry')>();
	return { ...actual, getClaudeSlashCommandRegistry: () => mockGetRegistry() };
});

class TestHooksHandler implements IClaudeSlashCommandHandler {
	static handleSpy = vi.fn<IClaudeSlashCommandHandler['handle']>().mockResolvedValue({});
	readonly commandName = 'hooks';
	readonly description = 'Test hooks handler';

	handle(args: string, stream: vscode.ChatResponseStream | undefined, token: CancellationToken): Promise<vscode.ChatResult | void> {
		return TestHooksHandler.handleSpy(args, stream, token);
	}
}

class TestMemoryHandler implements IClaudeSlashCommandHandler {
	static handleSpy = vi.fn<IClaudeSlashCommandHandler['handle']>().mockResolvedValue({});
	readonly commandName = 'memory';
	readonly description = 'Test memory handler';

	handle(args: string, stream: vscode.ChatResponseStream | undefined, token: CancellationToken): Promise<vscode.ChatResult | void> {
		return TestMemoryHandler.handleSpy(args, stream, token);
	}
}

function makeRequest(prompt: string, command?: string): IClaudeSlashCommandRequest {
```

