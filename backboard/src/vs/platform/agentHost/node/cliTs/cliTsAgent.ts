/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentRewindRequest, IAgentRewindBuffer, IAgentRewindResult } from '../../common/agentRewind.js';
import { isBackboardProviderAvailable } from '../../common/backboardSubscriptions.js';
import { isWindows } from '../../../../base/common/platform.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal, IAgent, IAgentCommandResult, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { buildSubagentSessionUri, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, FileEditKind, MessageAttachmentKind, MessageKind, parseSubagentSessionUri, ResponsePartKind, SessionStatus, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallContributorKind, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputQuestion, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type SessionInputAnswer, type SessionInputResponseKind, type ToolCallResult, type ToolResultContent, type ToolResultFileEditContent, type Turn } from '../../common/state/sessionState.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { IAgentHostCheckpointService } from '../../common/agentHostCheckpointService.js';
import { type IFileEditRecord, ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { buildSessionDbUri, FileEditTracker } from '../shared/fileEditTracker.js';
import { isClaudeLoggedIn } from '../shared/agentLoginProbes.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostGitService, META_DIFF_BASE_BRANCH } from '../agentHostGitService.js';
import { BACKBOARD_ACCESS_FULL, BACKBOARD_ACCESS_MANUAL, BACKBOARD_MODE_PLAN, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS, backboardModelInfos, backboardMultitaskSystemContext, bridgeConfig, createBackboardTurnSettings, fallbackModel, isBridgeModel, resolveBackboardSessionConfig } from './backboardRuntimeShared.js';

/** cli-ts tool name excluded from the turn when Web Search is toggled off. */
const CLI_TS_WEB_SEARCH_TOOL_NAME = 'WebSearch';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { CliTsServeProcess, runCliTsCommand } from './cliTsProcess.js';
import type { CliTsRecord, CliTsAgentEvent, CliTsClientToolDefinition, CliTsClientToolResultContent, CliTsClientToolResultPayload, CliTsFileAttachment, CliTsPermissionMode, CliTsTurnStatus, CliTsWorkerIntegrationChange, CliTsWorkerIntegrationSnapshot, CliTsWorkerState } from './cliTsProtocol.js';

const CLI_TS_STORE_VERSION = 1;
const CHATGPT_SUBSCRIPTION_PROVIDER = 'openai-subscription';
const CHATGPT_SUBSCRIPTION_LOGIN_COMMAND = 'chatgptSubscription.login';
const CLAUDE_SUBSCRIPTION_PROVIDER = 'anthropic-subscription';
const CLAUDE_SUBSCRIPTION_LOGIN_COMMAND = 'claudeSubscription.login';
const CLAUDE_SUBSCRIPTION_ENABLE_COMMAND = 'claudeSubscription.enable';
const CLI_TS_META_WORKTREE_BRANCH = 'backboard.worktree.branchName';
const CLI_TS_META_WORKTREE_PATH = 'backboard.worktree.path';
const CLI_TS_META_WORKTREE_REPOSITORY_ROOT = 'backboard.worktree.repositoryRoot';

function jwtExpiration(token: string): number | undefined {
	const encoded = token.split('.')[1];
	if (!encoded) {
		return undefined;
	}
	try {
		const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: unknown };
		return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/** Whether Backboard can use or refresh its configured ChatGPT login. */
export function hasUsableChatGptSubscriptionLogin(homeDir = os.homedir(), now = Date.now()): boolean {
	try {
		const envAuthFile = process.env['BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE']?.trim();
		let configuredAuthFile = '';
		try {
			const config = JSON.parse(fs.readFileSync(path.join(homeDir, '.backboard_ide', 'subscriptions.json'), 'utf8')) as { chatgptSubscriptionAuthFile?: unknown };
			configuredAuthFile = typeof config.chatgptSubscriptionAuthFile === 'string' ? config.chatgptSubscriptionAuthFile.trim() : '';
		} catch {
			// An explicit env override remains usable on a fresh install with no config.
		}
		const authFile = envAuthFile || configuredAuthFile;
		if (!authFile) {
			return false;
		}
		const auth = JSON.parse(fs.readFileSync(authFile, 'utf8')) as { tokens?: { access_token?: unknown; refresh_token?: unknown } };
		const accessToken = auth.tokens?.access_token;
		if (typeof accessToken !== 'string' || !accessToken) {
			return false;
		}
		const expiresAt = jwtExpiration(accessToken);
		return expiresAt === undefined || expiresAt > now || (typeof auth.tokens?.refresh_token === 'string' && !!auth.tokens.refresh_token);
	} catch {
		return false;
	}
}

export function isChatGptSubscriptionModel(modelId: string | undefined): boolean {
	return modelId?.startsWith(`${CHATGPT_SUBSCRIPTION_PROVIDER}/`) ?? false;
}

/** Publishes connection state without exposing any ChatGPT credential data. */
export function withChatGptSubscriptionConnectionState(
	models: readonly IAgentModelInfo[],
	connected: boolean,
): IAgentModelInfo[] {
	return models.map(model => isChatGptSubscriptionModel(model.id)
		? { ...model, _meta: { ...model._meta, chatGptSubscriptionConnected: connected } }
		: model);
}

export function isClaudeSubscriptionModel(modelId: string | undefined): boolean {
	return modelId?.startsWith(`${CLAUDE_SUBSCRIPTION_PROVIDER}/`) ?? false;
}

function providerFromModelId(modelId: string | undefined): string | undefined {
	if (!modelId) {
		return undefined;
	}
	const separator = modelId.indexOf('/');
	return separator > 0 ? modelId.slice(0, separator).trim().toLowerCase() : undefined;
}

/**
 * Provider threads are backend-native and cannot be resumed by a different
 * provider. Subscription prefixes remain authoritative even after restoring a
 * session whose previous picker selection is no longer available.
 */
export function requiresProviderThreadHandoff(threadId: string | undefined, previousModelId: string | undefined, nextModelId: string | undefined): boolean {
	if (!threadId) {
		return false;
	}
	const nextProvider = providerFromModelId(nextModelId);
	if (!nextProvider) {
		return false;
	}
	const threadProvider = threadId.startsWith('claude_sub_')
		? CLAUDE_SUBSCRIPTION_PROVIDER
		: threadId.startsWith('sub_')
			? CHATGPT_SUBSCRIPTION_PROVIDER
			: undefined;
	if (threadProvider) {
		return threadProvider !== nextProvider;
	}
	const previousProvider = providerFromModelId(previousModelId);
	if (previousProvider) {
		return previousProvider !== nextProvider;
	}
	// Backboard and BYOK threads never use a subscription prefix, so a restored
	// unprefixed thread cannot be adopted by either subscription transport.
	return nextProvider === CHATGPT_SUBSCRIPTION_PROVIDER || nextProvider === CLAUDE_SUBSCRIPTION_PROVIDER;
}

/** Fail fast when Claude Code's renewable first-party login is unavailable. */
export async function assertUsableClaudeSubscriptionLogin(
	probe: () => Promise<boolean> = isClaudeLoggedIn,
): Promise<void> {
	if (!await probe()) {
		throw new Error(localize(
			'cliTsAgent.claudeSubscription.loginRequired',
			"Claude sign-in expired or is missing. Open the model selector, choose Claude, then select Connect or Reconnect Claude.",
		));
	}
}

/** Publishes connection state without exposing any Claude credential data. */
export function withClaudeSubscriptionConnectionState(
	models: readonly IAgentModelInfo[],
	connected: boolean,
): IAgentModelInfo[] {
	return models.map(model => isClaudeSubscriptionModel(model.id)
		? { ...model, _meta: { ...model._meta, claudeSubscriptionConnected: connected } }
		: model);
}

function withSubscriptionConnectionStates(
	models: readonly IAgentModelInfo[],
	chatGptConnected: boolean,
	claudeConnected: boolean,
): IAgentModelInfo[] {
	return withClaudeSubscriptionConnectionState(
		withChatGptSubscriptionConnectionState(models, chatGptConnected),
		claudeConnected,
	);
}

/**
 * One ordered, restorable piece of a completed turn's response. Markdown and
 * reasoning content accumulates during the live turn (hence mutable); tool
 * parts capture the compact completion facts needed to rebuild a real
 * completed tool-call pill. Execute keeps both its compact CLI detail and the
 * complete bounded terminal transcript used by the IDE terminal card.
 */
type CliTsWorkerWorkspace = NonNullable<CliTsAgentEvent['workspace']>;

type CliTsBackboardToolKind = 'read' | 'grep' | 'glob' | 'fetchUrl' | 'webSearch' | 'todo' | 'computer' | 'browser' | 'findSkill' | 'findMcp';

interface CliTsToolUiState {
	readonly kind: CliTsBackboardToolKind;
	readonly input?: Record<string, unknown>;
	readonly result?: Record<string, unknown>;
}

interface CliTsMutationBatch {
	readonly id: string;
	readonly expectedFileCount: number;
}

type CliTsStoredPart =
	| { readonly kind: 'markdown'; content: string }
	| { readonly kind: 'reasoning'; content: string }
	| { readonly kind: 'tool'; readonly input?: unknown; readonly result?: unknown; readonly id: string; readonly name: string; readonly inputSummary?: string; readonly terminalCommand?: string; readonly title?: string; readonly detail?: string; readonly terminalOutput?: CliTsTerminalOutput; readonly toolUi?: CliTsToolUiState; readonly mutationBatch?: CliTsMutationBatch; readonly failed?: boolean; readonly workspace?: CliTsWorkerWorkspace; readonly worker?: CliTsWorkerState; readonly agentName?: string; fileEdits?: readonly ToolResultFileEditContent[] };

type CliTsTerminalOutput = NonNullable<CliTsAgentEvent['terminalOutput']>;
type CliTsTurnError = Pick<NonNullable<Turn['error']>, 'errorType' | 'message'>;

interface CliTsStoredTurn {
	readonly id?: string;
	readonly attachments?: readonly MessageAttachment[];
	readonly usage?: Turn['usage'];
	readonly prompt: string;
	readonly response: string;
	readonly failed?: boolean;
	/** The same compact error shown live, without stack traces or provider payloads. */
	readonly error?: CliTsTurnError;
	/** Legacy compact per-tool summaries; read for sessions stored before `parts`. */
	readonly tools?: readonly string[];
	/** Ordered rich parts for full-fidelity history restore. */
	readonly parts?: readonly CliTsStoredPart[];
}

interface CliTsRuntimeFileEdit {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolInput: unknown;
	readonly title?: string;
	readonly detail?: string;
	readonly edits: readonly { readonly path: string; readonly before: string; readonly after: string }[];
}

interface CliTsRuntimeSubagentRecovery {
	readonly turn: CliTsStoredTurn;
	readonly fileEdits: readonly CliTsRuntimeFileEdit[];
	/** Private worker checkout identity recovered beside the raw child JSONL. */
	readonly pathMapping?: CliTsRuntimePathMapping;
	readonly isolatedWorkspace?: boolean;
	readonly workerIntegrationStatus?: string;
	readonly workspaceRevision?: number;
	readonly integrationChanges?: readonly CliTsWorkerIntegrationChange[];
}

interface CliTsRuntimePathMapping {
	readonly workerRoot: string;
	readonly coordinatorRoot: string;
}

interface CliTsRewindState {
	activeCount: number;
	headBackupId?: string;
	headBuffers?: readonly IAgentRewindBuffer[];
	headPaths?: readonly string[];
	pending?: { transactionId: string; targetCount: number; previousCount: number; paths: readonly string[]; buffers?: readonly IAgentRewindBuffer[] };
	editorRefresh?: IAgentRewindResult;
	last?: { transactionId: string; previousCount: number; paths: readonly string[] };
}

interface CliTsStoredSession {
	readonly rewind?: CliTsRewindState;
	readonly id: string;
	readonly title?: string;
	readonly cwd?: string;
	/** Original folder selected by the user when `cwd` is an isolated worktree. */
	readonly sourceCwd?: string;
	readonly worktree?: {
		readonly path: string;
		readonly repositoryRoot: string;
		readonly branchName: string;
		readonly baseBranch: string;
	};
	readonly createdAt: number;
	readonly modifiedAt: number;
	/** False when the first turn was interrupted before workspace setup completed. */
	readonly materialized?: boolean;
	readonly threadId?: string;
	/** System-prompt handoff used until the fork creates its own backend thread. */
	readonly forkContext?: string;
	/** Prior provider transcript retained in every prompt after a backend handoff. */
	readonly providerHandoffContext?: string;
	readonly turns: CliTsStoredTurn[];
	/** Child conversations keyed by the parent Agent tool call id. */
	readonly subagents?: Readonly<Record<string, readonly CliTsStoredTurn[]>>;
}

interface CliTsSubagentTurnState {
	readonly prompt: string;
	readonly name?: string;
	readonly turn: CliTsTurnState;
	completion?: Promise<void>;
}

type CliTsSubagentCompletionStatus = Extract<CliTsTurnStatus, 'completed' | 'failed' | 'cancelled'>;

const subagentUiProjectionIntervalMs = 100;

interface CliTsWorkerProjectionState {
	lastEmittedAt: number;
	workspace: CliTsWorkerWorkspace;
	timer?: ReturnType<typeof setTimeout>;
}

interface CliTsWorktree {
	readonly path: URI;
	readonly repositoryRoot: URI;
	readonly branchName: string;
	readonly baseBranch: string;
}

interface CliTsTurnState {
	usage?: Turn['usage'];
	readonly turnId: string;
	/** Exact user prompt retained while the turn is still in flight. */
	readonly prompt: string;
	/** Markdown part id per cli-ts messageId, created lazily on first delta. */
	readonly messageParts: Map<string, string>;
	/** Accumulated streamed text per cli-ts messageId (finalization dedupe). */
	readonly streamedText: Map<string, string>;
	/** Tool calls already announced via ChatToolCallStart. */
	readonly startedToolCalls: Set<string>;
	/** Tool calls that went through an interactive permission request. */
	readonly confirmedToolCalls: Set<string>;
	/** Child-tool activity lines per parent `Agent` tool call (sub-agent nesting). */
	readonly childToolLines: Map<string, Map<string, string>>;
	/** Compact tool summaries recorded for history restore. */
	readonly toolSummaries: string[];
	/** Ordered rich parts recorded for full-fidelity history restore. */
	readonly storedParts: CliTsStoredPart[];
	/** Accumulating markdown/reasoning stored parts, keyed by protocol part id. */
	readonly storedTextParts: Map<string, { content: string }>;
	/** Structured tool inputs captured from `tool:requested`, keyed by call id. */
	readonly toolInputs: Map<string, { name: string; input: unknown }>;
	/** Final display summaries captured before result events omit their inputs. */
	readonly toolInputSummaries: Map<string, string>;
	/** One stable provider-response mutation batch per direct write call. */
	readonly mutationBatches: Map<string, CliTsMutationBatch>;
	/** Provisional shared batch used while a provider is still streaming mutation inputs. */
	pendingMutationBatch?: CliTsMutationBatch;
	/** Bounded native-UI inputs/results keyed by tool call id. */
	readonly toolUi: Map<string, CliTsToolUiState>;
	/** Incremental terminal transcript per running Execute call. */
	readonly terminalOutputs: Map<string, string>;
	/** In-flight async tool completions (file-edit diff builds), awaited before turn end. */
	readonly pendingCompletions: Promise<void>[];
	/** Spawn returns a handle immediately; its UI invocation follows the worker lifecycle. */
	deferredSubagentCompletions?: Map<string, (status: CliTsSubagentCompletionStatus) => void>;
	/** Live child conversations keyed by their parent Agent tool call id. */
	readonly subagentTurns: Map<string, CliTsSubagentTurnState>;
	/** Latest isolated-workspace state per parent Agent tool call. */
	readonly workerWorkspaces: Map<string, CliTsWorkerWorkspace>;
	/** Task revisions are independent of the workspace backend's revision. */
	workerStates?: Map<string, CliTsWorkerState>;
	/** child_end received before an isolated AgentSpawn workspace is authoritative. */
	readonly pendingSubagentEndStatuses: Map<string, CliTsSubagentCompletionStatus>;
	reasoningPartId?: string;
	didCreateReasoningPart?: boolean;
	reasoningText: string;
	didCreateStatusPart?: boolean;
	lastProgressMessage?: string;
	/** Last phase-status label shown in the pre-content progress line (dedupes re-fires). */
	lastStatusLabel?: string;
	responseText: string;
	failed?: boolean;
	error?: CliTsTurnError;
}

interface CliTsSession {
	rewind?: CliTsRewindState;
	readonly sessionUri: URI;
	readonly sessionId: string;
	readonly createdAt: number;
	modifiedAt: number;
	workingDirectory?: URI;
	sourceWorkingDirectory?: URI;
	worktree?: CliTsWorktree;
	model?: ModelSelection;
	config?: Record<string, unknown>;
	title?: string;
	threadId?: string;
	forkContext?: string;
	providerHandoffContext?: string;
	pendingProviderHandoff?: boolean;
	materialized: boolean;
	disposed: boolean;
	archived?: boolean;
	proc?: CliTsServeProcess;
	turn?: CliTsTurnState;
	/**
	 * Parent turns that still own a detached child after their provider turn has
	 * completed. Tool-call ids are session-unique, so lifecycle events can use
	 * this map instead of accidentally attaching to whichever turn is active now.
	 */
	subagentTurnOwners: Map<string, CliTsTurnState>;
	/** Prevents duplicate late lifecycle records from falling through to a newer turn. */
	completedSubagentToolCallIds: Set<string>;
	/** Lazily-opened file-edit tracker + its session DB reference. */
	fileEdits?: { tracker: FileEditTracker; dbRef: IReference<ISessionDatabase> };
	/** New-session baseline capture, awaited before the first tool can mutate the workspace. */
	baselineCapture?: Promise<void>;
	materializing?: Promise<void>;
	restoringWorktree?: Promise<void>;
	/** Serializes turns with archive/unarchive worktree lifecycle operations. */
	sendQueue?: Promise<void>;
	/** Set by Stop while no serve process exists yet; prevents post-materialization submit. */
	cancelBeforeSubmit?: boolean;
	/** Client tools pushed by the active IDE client via {@link CliTsAgent.setClientTools}. */
	clientTools?: { readonly clientId: string; readonly tools: readonly ToolDefinition[] };
	/** Whether the current turn runs with Full Access (client tool calls auto-confirm). */
	turnAutoApproves?: boolean;
	/** Client tool calls forwarded to the IDE and awaiting a result. */
	readonly pendingClientToolCalls: Set<string>;
	/** Public R-CLI AskUser request ids and their ordered IDE question ids. */
	readonly pendingInputs: Map<string, readonly string[]>;
	readonly storedTurns: CliTsStoredTurn[];
	readonly storedSubagentTurns: Map<string, CliTsStoredTurn[]>;
}

function createTurnState(turnId: string, prompt: string): CliTsTurnState {
	return {
		turnId,
		prompt,
		messageParts: new Map(),
		streamedText: new Map(),
		startedToolCalls: new Set(),
		confirmedToolCalls: new Set(),
		childToolLines: new Map(),
		toolSummaries: [],
		storedParts: [],
		storedTextParts: new Map(),
		toolInputs: new Map(),
		toolInputSummaries: new Map(),
		mutationBatches: new Map(),
		toolUi: new Map(),
		terminalOutputs: new Map(),
		pendingCompletions: [],
		subagentTurns: new Map(),
		workerWorkspaces: new Map(),
		pendingSubagentEndStatuses: new Map(),
		responseText: '',
		reasoningText: '',
	};
}

/**
 * Backboard provider backed by the cli-ts serve process (`backboard-cli-ts
 * --serve`) instead of the legacy Rust bridge. cli-ts owns the agent loop and
 * executes its own tools in the session's working directory; this class is a
 * translator: control ops out (submit/cancel/respond*), `AgentEvent` records
 * in, protocol actions/signals up to the {@link IAgentService}.
 *
 * Registered under the same provider id as the Rust bridge agent so session
 * URIs stay stable across the `chat.agentHost.backboardRuntime` switch; the
 * two are never registered together.
 */
export class CliTsAgent extends Disposable implements IAgent {
	readonly id = 'backboard';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	/**
	 * Hydrates the previous live Backboard API result from disk,
	 * and refreshes from the backend once a serve process is up. API catalog
	 * providers such as OpenRouter are never supplemented from a compiled list.
	 */
	private readonly _models = observableValue<readonly IAgentModelInfo[]>(
		'cliTsModels',
		withSubscriptionConnectionStates(
			backboardModelInfos(BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS),
			false,
			false,
		),
	);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, CliTsSession>();
	/** Full historical child turns recovered from cli-ts's per-agent event logs. */
	private readonly _runtimeSubagentTurnCache = new Map<string, Promise<CliTsRuntimeSubagentRecovery | undefined>>();
	private readonly _runtimeWorkerStateCache = new Map<string, CliTsWorkerState>();
	/** Coalesces worker lifecycle projection without delaying durable runtime state. */
	private readonly _workerProjectionStates = new WeakMap<CliTsTurnState, Map<string, CliTsWorkerProjectionState>>();
	private _modelsRefreshed = false;
	private _modelRefreshPromise: Promise<void> | undefined;
	private readonly _modelRefreshProcess = this._register(new MutableDisposable<CliTsServeProcess>());
	private _rgDir: Promise<string | undefined> | undefined;
	private _chatGptSubscriptionLoginPromise: Promise<void> | undefined;
	private _claudeSubscriptionEnablePromise: Promise<void> | undefined;
	private _claudeSubscriptionConnected = false;
	private _claudeSubscriptionStatusRevision = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
	) {
		super();
		this._hydrateModelsFromCache();
		void this._refreshClaudeSubscriptionConnectionState();
	}

	private _modelsCachePath(): string {
		return path.join(os.homedir(), '.backboard_ide', 'models-cache.json');
	}

	private _currentApiUrl(): string {
		const apiUrl = bridgeConfig().apiUrl;
		return typeof apiUrl === 'string' ? apiUrl : '';
	}

	/**
	 * Seeds the model observable with the list fetched on a previous run so
	 * the picker is populated instantly at window start. The cache is keyed
	 * by API URL — a backend switch falls back to the bundled list until the
	 * live refresh lands.
	 */
	private _hydrateModelsFromCache(): void {
		try {
			const raw = JSON.parse(fs.readFileSync(this._modelsCachePath(), 'utf8')) as { apiUrl?: string; models?: unknown[] };
			if ((raw.apiUrl ?? '') !== this._currentApiUrl()) {
				return;
			}
			const models = (Array.isArray(raw.models) ? raw.models : []).filter(isBridgeModel);
			if (models.length) {
				this._models.set(withSubscriptionConnectionStates(
					backboardModelInfos(models, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS),
					false,
					this._claudeSubscriptionConnected,
				), undefined);
			}
		} catch {
			// First run or unreadable cache — the bundled fallback stays.
		}
	}

	private _persistModelsCache(models: readonly unknown[]): void {
		try {
			fs.mkdirSync(path.dirname(this._modelsCachePath()), { recursive: true });
			fs.writeFileSync(this._modelsCachePath(), `${JSON.stringify({ apiUrl: this._currentApiUrl(), models }, null, '\t')}\n`, 'utf8');
		} catch (error) {
			this._logService.info(`[cli-ts] could not persist models cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Lazily opens the session database and creates the {@link FileEditTracker}
	 * used to persist before/after content of file-edit tools so the UI can
	 * render diff pills. Returns `undefined` when the database can't be opened
	 * (tracking is best-effort; the tool result still renders as text).
	 */
	private _fileEditTracker(session: CliTsSession): FileEditTracker | undefined {
		if (session.fileEdits) {
			return session.fileEdits.tracker;
		}
		try {
			const dbRef = this._sessionDataService.openDatabase(session.sessionUri);
			const tracker = this._instantiationService.createInstance(FileEditTracker, session.sessionUri.toString(), dbRef.object);
			session.fileEdits = { tracker, dbRef };
			return tracker;
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to open session database for file edit tracking: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private async _captureSessionBaseline(session: CliTsSession): Promise<void> {
		try {
			await this._checkpointService.captureBaseline(session.sessionUri, session.workingDirectory);
		} catch (error) {
			// Non-git workspaces and capture failures retain the explicit file-edit
			// aggregation path; baseline capture must never block a turn.
			this._logService.warn(`[cli-ts] Baseline checkpoint capture failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('cliTsAgent.displayName', "Backboard"),
			description: localize('cliTsAgent.description', "Backboard agent backed by the cli-ts runtime"),
		};
	}

	async executeCommand(command: string, _windows = isWindows): Promise<IAgentCommandResult> {
		if (command.startsWith('chatgptSubscription.') || command.startsWith('claudeSubscription.')) {
			throw new Error(localize('cliTsAgent.subscriptions.unavailable', "Subscriptions are currently unavailable. Use Backboard or an API key."));
		}
		switch (command) {
			case 'models.refresh':
				this._modelRefreshPromise ??= this._refreshModelCatalog().finally(() => { this._modelRefreshPromise = undefined; });
				await this._modelRefreshPromise;
				return { message: localize('cliTsAgent.modelsOnly.refreshed', "Models refreshed.") };
			case CHATGPT_SUBSCRIPTION_LOGIN_COMMAND:
				await this._ensureChatGptSubscriptionLogin(true);
				return {
					message: localize('cliTsAgent.chatGptSubscription.connected', "ChatGPT subscription connected to the Backboard harness."),
				};
			case CLAUDE_SUBSCRIPTION_LOGIN_COMMAND:
				throw new Error(localize(
					'cliTsAgent.claudeSubscription.interactiveLoginRequired',
					"Claude sign-in requires an interactive terminal. Open the model selector, choose Claude, then select Connect or Reconnect Claude.",
				));
			case 'claudeSubscription.check':
				await this._refreshClaudeSubscriptionConnectionState();
				return { message: '', requiresSignIn: !this._claudeSubscriptionConnected };
			case CLAUDE_SUBSCRIPTION_ENABLE_COMMAND:
				await this._enableClaudeSubscription();
				return {
					message: localize('cliTsAgent.claudeSubscription.connected', "Claude subscription connected to the Backboard harness."),
				};
			default:
				throw new Error(`Unsupported Backboard command: ${command}`);
		}
	}

	private async _ensureChatGptSubscriptionLogin(force: boolean): Promise<void> {
		if (!isBackboardProviderAvailable(CHATGPT_SUBSCRIPTION_PROVIDER)) {
			throw new Error(localize('cliTsAgent.subscriptions.unavailable', "Subscriptions are currently unavailable. Use Backboard or an API key."));
		}
		if (!force && hasUsableChatGptSubscriptionLogin()) {
			return;
		}
		this._chatGptSubscriptionLoginPromise ??= runCliTsCommand(this._logService, ['subscription', 'login'])
			.then(() => {
				this._models.set(withChatGptSubscriptionConnectionState(this._models.get(), true), undefined);
				this._modelsRefreshed = false;
			})
			.finally(() => {
				this._chatGptSubscriptionLoginPromise = undefined;
			});
		await this._chatGptSubscriptionLoginPromise;
	}

	private async _enableClaudeSubscription(): Promise<void> {
		await this._requireClaudeSubscriptionLogin();
		this._claudeSubscriptionEnablePromise ??= runCliTsCommand(this._logService, ['claude-subscription', 'enable'])
			.then(() => {
				this._setClaudeSubscriptionConnectionState(true);
				this._modelsRefreshed = false;
			})
			.finally(() => {
				this._claudeSubscriptionEnablePromise = undefined;
			});
		await this._claudeSubscriptionEnablePromise;
	}

	private async _requireClaudeSubscriptionLogin(): Promise<void> {
		if (!isBackboardProviderAvailable(CLAUDE_SUBSCRIPTION_PROVIDER)) {
			throw new Error(localize('cliTsAgent.subscriptions.unavailable', "Subscriptions are currently unavailable. Use Backboard or an API key."));
		}
		try {
			await assertUsableClaudeSubscriptionLogin();
			this._setClaudeSubscriptionConnectionState(true);
		} catch (error) {
			this._setClaudeSubscriptionConnectionState(false);
			throw error;
		}
	}

	private async _refreshClaudeSubscriptionConnectionState(probe: () => Promise<boolean> = async () => false): Promise<void> {
		const revision = ++this._claudeSubscriptionStatusRevision;
		const connected = await probe();
		if (revision === this._claudeSubscriptionStatusRevision) {
			this._setClaudeSubscriptionConnectionState(connected);
		}
	}

	private _setClaudeSubscriptionConnectionState(connected: boolean): void {
		this._claudeSubscriptionStatusRevision++;
		this._claudeSubscriptionConnected = connected;
		this._models.set(withClaudeSubscriptionConnectionState(this._models.get(), connected), undefined);
	}

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = config.session ?? AgentSession.uri(this.id, sessionId);
		const existing = this._sessions.get(sessionId);
		if (existing) {
			if (config.workingDirectory) {
				existing.sourceWorkingDirectory ??= config.workingDirectory;
				if (!existing.worktree) {
					existing.workingDirectory = config.workingDirectory;
				}
			}
			existing.model = config.model ?? existing.model;
			existing.config = { ...(existing.config ?? {}), ...(config.config ?? {}) };
			await this._ensureRestoredWorktree(existing);
			const workingDirectory = existing.materialized
				? existing.workingDirectory
				: existing.sourceWorkingDirectory ?? existing.workingDirectory;
			return {
				session: sessionUri,
				workingDirectory,
				project: this._projectForSession(existing),
				provisional: !existing.materialized,
			};
		}
		const storedSessions = this._readStore();
		const sourceSessionId = config.fork ? AgentSession.id(config.fork.session) : undefined;
		const sourceSession = sourceSessionId ? this._sessions.get(sourceSessionId) : undefined;
		const sourceStoredSession = sourceSessionId ? storedSessions.find(entry => entry.id === sourceSessionId) : undefined;
		const sourceTurns = sourceSession?.storedTurns ?? sourceStoredSession?.turns;
		if (config.fork && !sourceTurns) {
			throw new Error(`Cannot fork missing Backboard session: ${config.fork.session.toString()}`);
		}
		const forkedTurns = config.fork
			? cloneStoredTurns(sourceTurns!.slice(0, config.fork.turnIndex + 1))
			: undefined;
		const sourceTitle = sourceSession?.title ?? sourceStoredSession?.title;
		const forkedTitlePrefix = localize('cliTsAgent.forkedTitlePrefix', "Forked: ");
		const restored = forkedTurns ? {
			id: sessionId,
			title: sourceTitle
				? (sourceTitle.startsWith(forkedTitlePrefix) ? sourceTitle : `${forkedTitlePrefix}${sourceTitle}`)
				: localize('cliTsAgent.forkedTitle', "Forked Session"),
			cwd: sourceSession?.sourceWorkingDirectory?.fsPath ?? sourceSession?.workingDirectory?.fsPath ?? sourceStoredSession?.sourceCwd ?? sourceStoredSession?.cwd,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
			forkContext: buildForkConversationContext(forkedTurns),
			turns: forkedTurns,
		} satisfies CliTsStoredSession : config.session ? storedSessions.find(entry => entry.id === sessionId) : undefined;
		const session = this._createSessionEntry(sessionUri, restored);
		if (config.workingDirectory) {
			session.sourceWorkingDirectory = config.workingDirectory;
			if (!session.worktree) {
				session.workingDirectory = config.workingDirectory;
			}
		}
		session.model = config.model ?? sourceSession?.model ?? session.model;
		session.config = config.config ?? sourceSession?.config ?? session.config;
		if (forkedTurns) {
			// A fork copies conversation history, not the source session's checkout.
			// It must materialize its own folder/worktree on the first new turn.
			session.materialized = false;
			session.worktree = undefined;
		}
		this._sessions.set(sessionId, session);
		await this._ensureRestoredWorktree(session);
		if (forkedTurns) {
			this._writeStore();
		}
		// Durable sessions retain their serve process. The first provisional
		// session also starts one short-lived catalog refresh so model-specific
		// options (notably OpenRouter upstreams) exist before the first send.
		// `_modelsRefreshed` ensures subsequent provisional composers do not fan
		// out extra processes or requests.
		const configuredIsolation = session.config?.[SessionConfigKey.Isolation]
			?? this._configurationService.getSessionConfigValues(session.sessionUri.toString())?.[SessionConfigKey.Isolation];
		// A provisional worktree session will immediately discard a process started
		// against the source checkout. Skip that wasted startup; folder sessions can
		// still prewarm the model catalog while their composer is open.
		const canPrewarm = session.materialized || configuredIsolation !== 'worktree';
		if (session.workingDirectory && canPrewarm && (session.materialized || !this._modelsRefreshed)) {
			void this._prewarm(session);
		}
		const initialWorkingDirectory = session.materialized
			? session.workingDirectory
			: session.sourceWorkingDirectory ?? session.workingDirectory;
		return {
			session: sessionUri,
			workingDirectory: initialWorkingDirectory,
			project: this._projectForSession(session),
			provisional: !session.materialized,
		};
	}

	/**
	 * Spawns the serve process and kicks off the model-list refresh — so startup
	 * and the backend connection happen while the composer is open, and the
	 * picker shows the backend's real list before the first submit. Best-effort.
	 */
	private async _prewarm(session: CliTsSession): Promise<void> {
		if (session.disposed || session.proc?.isRunning) {
			return;
		}
		try {
			const rgDir = await this._resolveRgDir();
			// Stop can arrive while the asynchronous runtime lookup is in flight.
			// Re-check after that await so a provisional-session prewarm cannot start
			// a serve process behind a cancelled first send.
			if (session.disposed || session.cancelBeforeSubmit || session.proc?.isRunning) {
				return;
			}
			const proc = this._ensureProcess(session, rgDir);
			proc.start();
			const refresh = this._refreshModelsOnce(session);
			if (!session.materialized && refresh) {
				void refresh.finally(() => {
					if (!session.materialized && session.proc === proc) {
						proc.dispose();
						session.proc = undefined;
					}
				});
			}
		} catch (error) {
			this._logService.info(`[cli-ts] pre-warm skipped for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		const repository = params.workingDirectory ? await this._getGitInfo(params.workingDirectory) : undefined;
		return resolveBackboardSessionConfig(params.config, repository);
	}

	private async _getGitInfo(workingDirectory: URI): Promise<{ currentBranch: string; defaultBranch: string } | undefined> {
		if (!await this._gitService.isInsideWorkTree(workingDirectory)) {
			return undefined;
		}
		const currentBranch = await this._gitService.getCurrentBranch(workingDirectory) ?? 'HEAD';
		const defaultBranch = await this._gitService.getDefaultBranch(workingDirectory) ?? currentBranch;
		return { currentBranch, defaultBranch };
	}

	async sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		if (params.property !== SessionConfigKey.Branch || !params.workingDirectory) {
			return { items: [] };
		}
		const branches = await this._gitService.getBranches(params.workingDirectory, { query: params.query, limit: 200 });
		return { items: branches.map(branch => ({ value: branch, label: branch })) };
	}

	sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const session = this._session(sessionUri);
		return this._queueSessionOperation(session, () => this._sendMessage(session, prompt, attachments, turnId));
	}

	async rewindSession(sessionUri: URI, request: AgentRewindRequest): Promise<IAgentRewindResult> {
		const session = this._session(sessionUri);
		if (request.operation === 'prepare' || request.operation === 'recover') {
			await this.abortSession(sessionUri);
		}
		return this._queueSessionOperation(session, async () => {
			const empty: IAgentRewindResult = { transactionId: '', status: 'prepared', paths: [], buffers: [], activeCount: session.rewind?.activeCount ?? session.storedTurns.length };
			if (request.operation === 'resume') {
				return session.rewind?.editorRefresh ?? empty;
			}
			if (request.operation === 'acknowledge') {
				if (session.rewind?.editorRefresh?.transactionId === request.transactionId) {
					session.rewind.editorRefresh = undefined;
					this._writeStore(undefined, true);
				}
				return empty;
			}
			if (request.operation === 'inspectRecovery') {
				const recovery = session.rewind?.pending ?? session.rewind?.last;
				if (!recovery) {
					throw new Error(localize('cliTsAgent.archivedRewindBackups', "No active rewind backup. Archived backups are in {0}", path.join(this._runtimeSessionsRoot(), session.sessionId, 'checkpoints', 'editor-rewind-backups')));
				}
				return { ...empty, transactionId: recovery.transactionId, paths: recovery.paths };
			}
			const proc = this._ensureProcess(session, await this._resolveRgDir());
			if (request.operation === 'prepare') {
				if (session.rewind?.pending || session.rewind?.editorRefresh) {
					throw new Error(localize('cliTsAgent.pendingRewind', "Finish or recover the pending rewind first."));
				}
				const targetCount = request.retainedTurnId === undefined ? 0 : session.storedTurns.findIndex((turn, index) => (turn.id ?? `${session.sessionId}-${index}`) === request.retainedTurnId) + 1;
				if (request.retainedTurnId !== undefined && targetCount === 0) {
					throw new Error(localize('cliTsAgent.checkpointUnavailable', "Checkpoint unavailable."));
				}
				const turnIds = session.storedTurns.slice(targetCount).map(turn => {
					if (!turn.id) {
						throw new Error(localize('cliTsAgent.legacyCheckpoint', "This older conversation has no durable request checkpoints."));
					}
					return turn.id;
				});
				const transactionId = generateUuid();
				const record = await proc.request({ op: 'prepareRewind', requestId: proc.nextRequestId(), transactionId, turnIds,
					baseCheckpointId: session.rewind?.headBackupId });
				const result = this._rewindResult(record.payload);
				session.rewind ??= { activeCount: session.storedTurns.length };
				session.rewind.pending = { transactionId, targetCount, previousCount: session.rewind.activeCount, paths: result.paths };
				this._writeStore(undefined, true);
				return { ...result, activeCount: session.rewind.activeCount };
			}
			if (request.operation === 'recover') {
				return this._recoverRewind(session, request.transactionId);
			}
			const pending = session.rewind?.pending;
			if (!pending || pending.transactionId !== request.transactionId) {
				if (session.rewind?.last?.transactionId === request.transactionId) {
					const record = await proc.request({ op: 'commitRewind', requestId: proc.nextRequestId(), transactionId: request.transactionId, buffers: [] });
					return session.rewind.editorRefresh ?? { ...this._rewindResult(record.payload), buffers: session.rewind.activeCount === session.storedTurns.length ? session.rewind.headBuffers ?? [] : [], activeCount: session.rewind.activeCount };
				}
				throw new Error(localize('cliTsAgent.checkpointChanged', "The prepared checkpoint has changed."));
			}
			pending.buffers = request.buffers;
			// Persist intent before telling the CLI to write any files.
			this._writeStore(undefined, true);
			return this._commitRewind(session);
		});
	}

	private _rewindResult(payload: unknown): IAgentRewindResult {
		if (!payload || typeof payload !== 'object') {
			throw new Error(localize('cliTsAgent.missingRestoreResult', "Missing file restoration result."));
		}
		const result = payload as IAgentRewindResult;
		if (!Array.isArray(result.paths) || typeof result.transactionId !== 'string' || !Array.isArray(result.buffers)) {
			throw new Error(localize('cliTsAgent.invalidRestoreResult', "Invalid file restoration result."));
		}
		return result;
	}

	private async _commitRewind(session: CliTsSession): Promise<IAgentRewindResult> {
		const state = session.rewind!;
		const pending = state.pending!;
		const proc = this._ensureProcess(session, await this._resolveRgDir());
		const record = await proc.request({ op: 'commitRewind', requestId: proc.nextRequestId(), transactionId: pending.transactionId, buffers: pending.buffers ?? [] });
		const result = this._rewindResult(record.payload);
		if (result.status !== 'committed') {
			throw new Error(localize('cliTsAgent.restoreIncomplete', "File restoration did not complete."));
		}
		const previousHeadPaths = new Set(state.headPaths);
		state.headBuffers = [...state.headBuffers ?? [], ...pending.buffers?.filter(buffer => !previousHeadPaths.has(buffer.path)) ?? []];
		state.headPaths = [...new Set([...previousHeadPaths, ...result.paths])];
		state.headBackupId = result.headBackupId ?? result.backupId;
		state.activeCount = pending.targetCount;
		state.last = { transactionId: pending.transactionId, previousCount: pending.previousCount, paths: result.paths };
		state.pending = undefined;
		state.editorRefresh = { ...result, activeCount: state.activeCount, buffers: state.activeCount === session.storedTurns.length ? state.headBuffers ?? [] : [] };
		this._resetRewoundProvider(session);
		this._writeStore(undefined, true);
		return state.editorRefresh;
	}

	private async _recoverRewind(session: CliTsSession, transactionId?: string): Promise<IAgentRewindResult> {
		const state = session.rewind;
		const recovery = state?.pending ?? state?.last;
		if (!state || !recovery || (transactionId && transactionId !== recovery.transactionId)) {
			throw new Error(localize('cliTsAgent.noRewindBackup', "No rewind backup is available for this conversation."));
		}
		const proc = this._ensureProcess(session, await this._resolveRgDir());
		const record = await proc.request({ op: 'recoverRewind', requestId: proc.nextRequestId(), transactionId: recovery.transactionId });
		const result = this._rewindResult(record.payload);
		state.activeCount = recovery.previousCount;
		state.pending = undefined;
		state.last = { transactionId: recovery.transactionId, previousCount: recovery.previousCount, paths: result.paths };
		state.editorRefresh = { ...result, activeCount: state.activeCount };
		this._resetRewoundProvider(session);
		this._writeStore(undefined, true);
		return state.editorRefresh;
	}

	private _resetRewoundProvider(session: CliTsSession): void {
		const retained = session.storedTurns.slice(0, session.rewind?.activeCount ?? session.storedTurns.length);
		session.threadId = undefined;
		session.providerHandoffContext = undefined;
		session.pendingProviderHandoff = false;
		session.forkContext = retained.length ? buildForkConversationContext(retained) : undefined;
		// A fresh process cannot accidentally reuse a provider's discarded tail.
		session.proc?.dispose();
		session.proc = undefined;
	}

	async truncateSession(sessionUri: URI, turnId?: string): Promise<void> {
		const session = this._session(sessionUri);
		return this._queueSessionOperation(session, async () => {
			const count = turnId === undefined ? 0 : session.storedTurns.findIndex((turn, index) => (turn.id ?? `${session.sessionId}-${index}`) === turnId) + 1;
			if (turnId !== undefined && count === 0) {
				throw new Error(localize('cliTsAgent.unknownBoundary', "Unknown conversation boundary."));
			}
			if (session.rewind?.pending || session.rewind?.editorRefresh) {
				throw new Error(localize('cliTsAgent.restorationPending', "File restoration is still pending."));
			}
			if (count >= session.storedTurns.length) {
				return;
			}
			if (!session.rewind || session.rewind.activeCount !== count) {
				// Editing a message also needs an explicit successful file restore.
				throw new Error(localize('cliTsAgent.restoreBeforeContinue', "Restore the message checkpoint before continuing."));
			}
			// Keep the discarded tail in the durable recovery journal on the host.
			this._archiveRewindBranch(session);
			session.storedTurns.splice(count);
			session.rewind = undefined;
			this._writeStore(undefined, true);
		});
	}

	private _archiveRewindBranch(session: CliTsSession): void {
		const directory = path.join(path.dirname(this._storePath()), 'rewind-history', session.sessionId);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(directory, `${generateUuid()}.json`), JSON.stringify({ rewind: session.rewind, turns: session.storedTurns }), { mode: 0o600 });
	}

	private _queueSessionOperation<T>(session: CliTsSession, operation: () => Promise<T>): Promise<T> {
		const queued = (session.sendQueue ?? Promise.resolve())
			.catch(() => undefined)
			.then(operation);
		const tracked = queued.then(() => {}, () => {}).finally(() => {
			if (session.sendQueue === tracked) {
				session.sendQueue = undefined;
			}
		});
		session.sendQueue = tracked;
		return queued;
	}

	private async _sendMessage(session: CliTsSession, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		if (session.disposed) {
			throw new Error(`Cannot send to disposed Backboard session: ${session.sessionUri.toString()}`);
		}
		if (session.archived) {
			throw new Error(`Cannot send to archived Backboard session: ${session.sessionUri.toString()}`);
		}
		if (session.pendingProviderHandoff) {
			this._prepareProviderHandoff(session, session.model?.id);
		}
		if (session.rewind?.pending) {
			if (session.rewind.pending.buffers) await this._commitRewind(session);
			else throw new Error(localize('cliTsAgent.rewindBeforeSend', "Finish or recover the pending file rewind before sending."));
		}
		if (session.rewind?.editorRefresh) {
			throw new Error(localize('cliTsAgent.editorRecoveryBeforeSend', "Finish recovering the editor buffers before sending."));
		}
		if (session.rewind) {
			this._archiveRewindBranch(session);
			session.storedTurns.splice(session.rewind.activeCount);
			session.rewind = undefined;
		}
		const effectiveTurnId = turnId ?? generateUuid();
		session.cancelBeforeSubmit = false;
		session.modifiedAt = Date.now();
		session.title ??= firstPromptLine(prompt);
		const prepared = prepareSubmitAttachments(prompt, attachments);
		const storedConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		const settings = createBackboardTurnSettings(storedConfig, session.config, session.model);
		const systemContext = backboardMultitaskSystemContext(settings.rawMode);
		// Default maps to the R-CLI's `auto` tier (file edits and safe commands
		// run unprompted; dangerous commands and outward-facing tools still
		// ask), so only Full Access bypasses approvals entirely.
		const permission: CliTsPermissionMode = settings.accessMode === BACKBOARD_ACCESS_MANUAL
			? 'manual'
			: settings.accessMode === BACKBOARD_ACCESS_FULL
				? 'bypass'
				: 'auto';
		// Client tool calls surface their confirmation through the workbench
		// invocation; under Full Access they are stamped auto-approved instead.
		session.turnAutoApproves = permission === 'bypass';
		// Build the per-turn tool exclusion list. Plan mode hides write-class
		// tools from the model entirely (on top of gating); the Web Search
		// toggle removes the built-in web search tool when disabled. The list
		// is sent on every turn (even when empty) so the persistent serve
		// process resets prior-turn exclusions when a toggle is turned back on.
		const excludedTools: string[] = [];
		if (settings.rawMode === BACKBOARD_MODE_PLAN) {
			excludedTools.push('Write', 'Edit', 'ApplyPatch', 'Execute');
		}
		if (!settings.webSearch) {
			excludedTools.push(CLI_TS_WEB_SEARCH_TOOL_NAME);
		}
		const turn = createTurnState(effectiveTurnId, prompt);
		session.turn = turn;
		// Write the prompt before any asynchronous workspace or runtime startup.
		// A forced quit during first-turn materialization must still leave a
		// catalog entry that can be reopened and retried.
		this._writeStore();
		// Fill the send→first-token gap with an instant status line so the turn
		// feels responsive the moment the user hits send — well before the model
		// streams its first token. It starts at "Preparing…" and is upgraded to
		// "Working…" by the backend's own pipeline phases (see the `turn:status`
		// handler), giving truthful, visibly-changing progress instead of a
		// static placeholder. The adapter renders it as an ephemeral
		// `progressMessage` (shimmering spinner) that auto-hides the instant any
		// real content — markdown, reasoning, or a tool call — arrives. Fired
		// synchronously before the submit round-trip; the active turn already
		// exists (ChatTurnStarted was reduced before sendMessage), so it renders
		// on the first frame.
		this._fireStatus(session, turn, localize('cliTsAgent.status.preparing', "Preparing…"));
		try {
			if (!isBackboardProviderAvailable(settings.provider)) {
				throw new Error(localize('cliTsAgent.subscriptions.unavailable', "Subscriptions are currently unavailable. Use Backboard or an API key."));
			}
			// Resolve folder/worktree isolation from the latest live config before
			// starting a process or capturing the session baseline. The checkpoint
			// baseline is immutable once recorded, so capturing the provisional source
			// folder first would permanently break diffs for a later worktree choice.
			await this._ensureRestoredWorktree(session);
			await this._materialize(session, prompt, storedConfig);
			if (session.disposed) {
				throw new Error(localize('cliTsAgent.sessionDisposedDuringMaterialization', "The Backboard session was deleted before it finished starting."));
			}
			if (session.cancelBeforeSubmit) {
				return;
			}
			await session.baselineCapture;
			const rgDir = await this._resolveRgDir();
			const proc = this._ensureProcess(session, rgDir);
			if (session.cancelBeforeSubmit) {
				return;
			}
			this._logService.info(`[cli-ts] turn_start session=${session.sessionId} model=${settings.provider}/${settings.model} permission=${permission} cwd=${session.workingDirectory?.fsPath ?? '(missing)'}`);
			const inheritedConversationContext = [
				session.providerHandoffContext,
				!session.threadId ? session.forkContext : undefined,
			].filter((value): value is string => !!value).join('\n\n') || undefined;
			const record = await proc.request({
				op: 'submit',
				turnId: effectiveTurnId,
				requestId: proc.nextRequestId(),
				prompt: prepared.prompt,
				...(inheritedConversationContext ? { forkContext: inheritedConversationContext } : {}),
				...(systemContext ? { systemContext } : {}),
				// Resume the persisted backend thread so a fresh serve process
				// (window reload, crash, binary update) keeps the conversation's
				// memory. serve only adopts it while it has no thread binding.
				...(session.threadId ? { threadId: session.threadId } : {}),
				model: `${settings.provider}/${settings.model}`,
				permission,
				// Always send the semantic state. In particular, `off` must reach the
				// persistent serve process so a previous turn's thinking config is reset.
				thinking: settings.intensity,
				// Sent unconditionally so the persistent serve process resets
				// these when a toggle is turned back off between turns.
				memory: settings.memory,
				computerUse: settings.computerUse,
				browserUse: settings.browserUse,
				notify: settings.notifications,
				imageGeneration: settings.imageGeneration,
				openRouterProvider: settings.openRouterProvider,
				excludedTools,
				// Advertise IDE-executed tools (integrated browser, tasks, …).
				// Omitting the field clears previously registered client tools.
				...(session.clientTools ? { clientTools: session.clientTools.tools.map(clientToolDefinitionToWire) } : {}),
				...(prepared.files.length ? { files: prepared.files } : {}),
			});
			const payload = record.payload as { status?: CliTsTurnStatus; threadId?: string | null } | undefined;
			const status = payload?.status;
			if (payload?.threadId) {
				session.threadId = payload.threadId;
			}
			if (session.threadId) {
				session.forkContext = undefined;
			}
			if (status === 'failed' && !turn.error) {
				turn.failed = true;
				turn.error = { errorType: 'BackboardSendFailed', message: localize('cliTsAgent.turnFailed', "The Backboard agent reported a failed turn.") };
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId: effectiveTurnId,
					error: turn.error,
				});
			}
			this._refreshModelsOnce(session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			turn.failed = true;
			// A terminal serve rejection may follow the more useful run:error.
			// Keep that original failure in both the live row and durable history.
			if (!turn.error) {
				turn.error = { errorType: 'BackboardSendFailed', message: message.trim() ? message : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId: effectiveTurnId,
					error: turn.error,
				});
			}
		} finally {
			// A provider-turn boundary only closes blocking Agent children. Detached
			// AgentSpawn workers retain their session owner across both normal completion
			// and Stop; cli-ts emits their lifecycle-only terminal edge after its durable
			// task/workspace result settles. Disposal is the sole fallback that cannot
			// receive a later event because the serve process is being released.
			this._cancelUnfinishedSubagents(session, turn, session.disposed);
			// Let in-flight file-edit diff builds finish so their
			// ChatToolCallComplete actions land before the turn is marked done.
			await Promise.allSettled(turn.pendingCompletions);
			session.storedTurns.push({
				id: effectiveTurnId,
				attachments,
				usage: turn.usage,
				prompt,
				response: turn.responseText || (session.disposed
					? localize('cliTsAgent.interruptedTurn', "This response was interrupted when Backboard closed.")
					: ''),
				failed: turn.failed,
				...(turn.error ? { error: turn.error } : {}),
				...(turn.toolSummaries.length ? { tools: turn.toolSummaries } : {}),
				...(turn.storedParts.length ? { parts: turn.storedParts } : {}),
			});
			session.modifiedAt = Date.now();
			session.turn = undefined;
			session.cancelBeforeSubmit = false;
			session.pendingInputs.clear();
			this._writeStore();
			session.pendingClientToolCalls.clear();
			this._fire(session.sessionUri, { type: ActionType.ChatTurnComplete, turnId: effectiveTurnId });
		}
	}

	async getSessionMessages(sessionUri: URI): Promise<readonly Turn[]> {
		const parsedSubagent = parseSubagentSessionUri(sessionUri.toString());
		const rootSessionUri = parsedSubagent ? URI.parse(parsedSubagent.parentSession.toString()) : sessionUri;
		const sessionId = AgentSession.id(rootSessionUri);
		const session = this._session(rootSessionUri);
		if (session.rewind?.pending) {
			await this._queueSessionOperation(session, async () => {
				if (session.rewind?.pending?.buffers) {
					try { await this._commitRewind(session); }
					catch { await this._recoverRewind(session); }
				} else if (session.rewind?.pending) await this._recoverRewind(session);
			});
		}
		const stored = this._readStore().find(entry => entry.id === sessionId);
		const runtimeWorkers = await this._readRuntimeWorkerStates(sessionId);
		const parentTurns = (session?.storedTurns ?? stored?.turns ?? []).map(turn => ({ ...turn,
			...(turn.parts ? { parts: turn.parts.map(part => {
				const worker = part.kind === 'tool' ? runtimeWorkers.get(part.id) : undefined;
				if (part.kind !== 'tool' || !worker || (part.worker && part.worker.revision >= worker.revision)) {
					return part;
				}
				const status = cliTsWorkerCompletionStatus(worker);
				return { ...part, worker, workspace: workspaceFromWorker(worker), ...(status ? { failed: status !== 'completed' } : {}) };
			}) } : {}) }));
		const storedChildTurns = parsedSubagent
			? session?.storedSubagentTurns?.get(parsedSubagent.toolCallId) ?? stored?.subagents?.[parsedSubagent.toolCallId]
			: undefined;
		let turns: readonly CliTsStoredTurn[] = parentTurns;
		let allowFileEdits = true;
		if (parsedSubagent) {
			const worker = subagentWorkerFromTurns(parentTurns, parsedSubagent.toolCallId)
				?? (session ? this._resolveSubagentOwner(session, parsedSubagent.toolCallId)?.workerStates?.get(parsedSubagent.toolCallId) : undefined);
			const workspace = subagentWorkspaceFromTurns(parentTurns, parsedSubagent.toolCallId)
				?? (session ? this._resolveSubagentOwner(session, parsedSubagent.toolCallId)?.workerWorkspaces?.get(parsedSubagent.toolCallId) : undefined);
			const summaryFallback = fallbackSubagentTurns(parentTurns, parsedSubagent.toolCallId);
			// The compact parent stream drops rich child results. The child's own
			// durable stream retains reasoning, output, titles, and exact writes.
			const ownsChild = !!storedChildTurns?.length || summaryFallback.length > 0;
			const runtimeRecovery = ownsChild
				? await this._readRuntimeSubagentRecovery(sessionId, parsedSubagent.toolCallId)
				: undefined;
			allowFileEdits = !worker && workspace?.revision === undefined && runtimeRecovery?.workspaceRevision === undefined && cliTsWorkerEditsAreIntegrated(workspace, runtimeRecovery);
			if (runtimeRecovery) {
				const projectedRecovery = projectRuntimeSubagentRecovery(runtimeRecovery, runtimeRecovery.pathMapping
					?? runtimePathMapping(workspace?.worktreePath, session?.workingDirectory?.fsPath ?? stored?.cwd));
				if (allowFileEdits) {
					await this._persistRuntimeRecoveryFileEdits(rootSessionUri, projectedRecovery);
				}
				turns = [allowFileEdits ? runtimeRecoveryTurnWithFileEdits(rootSessionUri.toString(), projectedRecovery) : projectedRecovery.turn];
			} else {
				turns = storedChildTurns?.length ? storedChildTurns : summaryFallback;
			}
			// The private model can finish successfully before integration fails.
			// Reopening the archive must retain the workspace's terminal outcome.
			const workerStatus = worker ? cliTsWorkerCompletionStatus(worker) : runtimeRecovery?.workerIntegrationStatus === 'integrated'
				? 'completed'
				: workspace ? cliTsWorkspaceCompletionStatus(workspace) : undefined;
			if (workerStatus) {
				turns = turns.map(turn => ({ ...turn, failed: workerStatus !== 'completed',
					...(worker?.error || worker?.persistenceError ? { error: { errorType: 'BackboardSubagentFailed', message: worker.error ?? worker.persistenceError! } } : {}) }));
			}
		}
		// Earlier builds may have persisted proposed worktree edits as coordinator
		// diffs. Do not rehydrate those records until integration is authoritative.
		turns = allowFileEdits ? await this._restoreStoredFileEdits(rootSessionUri, turns) : turns.map(withoutStoredFileEdits);
		const turnIdPrefix = parsedSubagent ? `${sessionId}-subagent-${parsedSubagent.toolCallId}` : sessionId;
		return turns.map((turn, index) => ({ ...storedTurnToProtocolTurn(turnIdPrefix, index, turn),
			...(!parsedSubagent && session.rewind ? { usage: { ...turn.usage, _meta: { ...turn.usage?._meta, backboardActiveCount: session.rewind.activeCount, backboardContextUsage: { source: 'backboard-api' } } } } : {}),
		}));
	}

	/**
	 * Reattaches persisted session-database edit records to restored tool calls.
	 * The compact JSON chat store intentionally does not duplicate before/after
	 * file contents; those blobs already live in the per-session database. This
	 * lookup keeps reopened parent and subagent chats as rich as their live view,
	 * while a missing/legacy database simply degrades to the tool transcript.
	 */
	private async _restoreStoredFileEdits(sessionUri: URI, turns: readonly CliTsStoredTurn[]): Promise<readonly CliTsStoredTurn[]> {
		const toolIds = new Set<string>();
		for (const turn of turns) {
			for (const part of turn.parts ?? []) {
				if (part.kind === 'tool' && !part.fileEdits?.length) {
					toolIds.add(part.id);
				}
			}
		}
		if (toolIds.size === 0) {
			return turns;
		}

		let dbRef: IReference<ISessionDatabase> | undefined;
		try {
			dbRef = this._sessionDataService.openDatabase(sessionUri);
			const records = await dbRef.object.getFileEdits([...toolIds]);
			if (records.length === 0) {
				return turns;
			}
			const byToolCall = new Map<string, ToolResultFileEditContent[]>();
			for (const record of records) {
				let edits = byToolCall.get(record.toolCallId);
				if (!edits) {
					edits = [];
					byToolCall.set(record.toolCallId, edits);
				}
				edits.push(storedFileEditContent(sessionUri.toString(), record));
			}
			return turns.map(turn => ({
				...turn,
				...(turn.parts ? {
					parts: turn.parts.map(part => part.kind === 'tool' && !part.fileEdits?.length && byToolCall.has(part.id)
						? { ...part, fileEdits: byToolCall.get(part.id) }
						: part),
				} : {}),
			}));
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to restore file edits for ${sessionUri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
			return turns;
		} finally {
			dbRef?.dispose();
		}
	}

	async disposeSession(sessionUri: URI): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		let session = this._sessions.get(sessionId);
		const stored = session ? undefined : this._readStore().find(entry => entry.id === sessionId);
		if (!session && stored) {
			// Deletion can be the first operation after an IDE restart. Rehydrate a
			// lightweight session so the stable cli-ts session id can settle and
			// clean its persisted worker worktrees before the catalog entry vanishes.
			session = this._createSessionEntry(sessionUri, stored);
			this._sessions.set(sessionId, session);
		}
		if (session) {
			session.disposed = true;
			session.cancelBeforeSubmit = true;
			await Promise.allSettled([session.materializing, session.restoringWorktree]);
			session.proc?.notify({ op: 'cancel' });
			await session.sendQueue?.catch(() => undefined);
			await this._requestWorkerLifecycle(session, 'deleteWorkers');
			this._releaseSessionRuntime(session);
		}
		const worktree = session?.worktree ?? (stored?.worktree ? {
			path: URI.file(stored.worktree.path),
			repositoryRoot: URI.file(stored.worktree.repositoryRoot),
			branchName: stored.worktree.branchName,
			baseBranch: stored.worktree.baseBranch,
		} : undefined);
		let checkpointsDisposed = true;
		try {
			await this._checkpointService.disposeSessionData(sessionUri, worktree?.repositoryRoot);
		} catch (error) {
			checkpointsDisposed = false;
			this._logService.warn(`[cli-ts] Failed to dispose checkpoint refs for ${sessionId}; retaining its worktree: ${error instanceof Error ? error.message : String(error)}`);
		}
		this._sessions.delete(sessionId);
		this._writeStore(sessionId);
		if (worktree && checkpointsDisposed) {
			await this._removeWorktreeIfClean(sessionId, worktree, 'session deletion');
		}
	}

	async onArchivedChanged(sessionUri: URI, isArchived: boolean): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		let session = this._sessions.get(sessionId);
		if (!session) {
			const stored = this._readStore().find(entry => entry.id === sessionId);
			if (!stored) {
				return;
			}
			session = this._createSessionEntry(sessionUri, stored);
			this._sessions.set(sessionId, session);
		}
		if (session.disposed) {
			return;
		}

		return this._queueSessionOperation(session, async () => {
			if (session.disposed) {
				return;
			}
			session.archived = isArchived;
			const worktree = session.worktree;
			if (isArchived && worktree) {
				try {
					// ChatTurnComplete starts checkpoint capture asynchronously. An
					// idempotent baseline request joins the checkpoint service's
					// per-session sequencer behind that capture before cwd disappears.
					await this._checkpointService.captureBaseline(session.sessionUri, session.workingDirectory);
				} catch (error) {
					this._logService.warn(`[cli-ts] Could not reach the checkpoint barrier while archiving ${sessionId}; retaining its worktree: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}
			}

			if (!isArchived) {
				try {
					if (worktree) {
						await this._ensureRestoredWorktree(session);
						this._logService.info(`[cli-ts] Restored worktree '${worktree.path.fsPath}' after unarchiving ${sessionId}.`);
					}
					const rgDir = await this._resolveRgDir();
					const proc = this._ensureProcess(session, rgDir);
					proc.start();
					await this._requestWorkerLifecycle(session, 'unarchiveWorkers');
				} catch (error) {
					this._logService.warn(`[cli-ts] Failed to restore session worktrees after unarchiving ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			await this._requestWorkerLifecycle(session, 'archiveWorkers');
			// The serve process and file tracker both hold the checkout as their
			// working directory. Release them before an archive removes that path.
			this._releaseSessionRuntime(session);
			if (!worktree) {
				return;
			}

			let branchExists = false;
			try {
				branchExists = await this._gitService.branchExists(worktree.repositoryRoot, worktree.branchName);
			} catch (error) {
				this._logService.warn(`[cli-ts] Could not verify branch '${worktree.branchName}' while archiving ${sessionId}; retaining its worktree: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			if (!branchExists) {
				this._logService.info(`[cli-ts] Retaining worktree '${worktree.path.fsPath}' while archiving ${sessionId} because branch '${worktree.branchName}' is missing.`);
				return;
			}
			await this._removeWorktreeIfClean(sessionId, worktree, 'session archive');
		});
	}

	private async _removeWorktreeIfClean(sessionId: string, worktree: CliTsWorktree, reason: string): Promise<boolean> {
		if (worktree.path.toString() === worktree.repositoryRoot.toString()) {
			this._logService.warn(`[cli-ts] Refusing to remove repository root '${worktree.path.fsPath}' for ${sessionId}`);
			return false;
		}
		try {
			await fs.promises.access(worktree.path.fsPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return true;
			}
			this._logService.warn(`[cli-ts] Could not access worktree '${worktree.path.fsPath}'; retaining it: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		let dirty: boolean;
		try {
			dirty = await this._gitService.hasUncommittedChanges(worktree.path);
		} catch (error) {
			this._logService.warn(`[cli-ts] Could not verify worktree cleanliness for '${worktree.path.fsPath}'; retaining it: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		if (dirty) {
			this._logService.info(`[cli-ts] Retaining worktree '${worktree.path.fsPath}' after ${reason} because it has uncommitted changes.`);
			return false;
		}
		try {
			await this._gitService.removeWorktree(worktree.repositoryRoot, worktree.path);
			this._logService.info(`[cli-ts] Removed worktree '${worktree.path.fsPath}' after ${reason}.`);
			return true;
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to remove worktree '${worktree.path.fsPath}' after ${reason}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async abortSession(sessionUri: URI): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session) {
			return;
		}
		session.cancelBeforeSubmit = true;
		session.proc?.notify({ op: 'cancel' });
		session.fileEdits?.tracker.discardAllEdits();
		session.pendingInputs.clear();
		session.pendingClientToolCalls.clear();
	}

	setPendingMessages(sessionUri: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		if (!steeringMessage?.message.text) {
			return;
		}
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session?.proc?.isRunning) {
			return;
		}
		const pendingInput = [...session.pendingInputs.entries()].at(-1);
		if (pendingInput) {
			const [requestId, questionIds] = pendingInput;
			// The main composer is also a valid free-form AskUser input. Resolve the
			// pending request directly instead of using `steer`, which deliberately
			// cancels the active turn. The matching ChatInputCompleted action clears
			// `pendingInputs` and records the answer in the carousel.
			session.proc.notify({ op: 'respondInput', id: requestId, answers: questionIds.map(() => steeringMessage.message.text) });
			this._onDidSessionProgress.fire({
				kind: 'steering_consumed',
				session: sessionUri,
				id: steeringMessage.id,
			});
			return;
		}
		// Forward the steering message; cli-ts interrupts the active turn and
		// front-queues it. Signal consumption so the host clears the pending slot.
		const storedConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		const settings = createBackboardTurnSettings(storedConfig, session.config, session.model);
		const systemContext = backboardMultitaskSystemContext(settings.rawMode);
		session.proc.notify({ op: 'steer', prompt: steeringMessage.message.text, ...(systemContext ? { systemContext } : {}) });
		this._onDidSessionProgress.fire({
			kind: 'steering_consumed',
			session: sessionUri,
			id: steeringMessage.id,
		});
	}

	async changeModel(sessionUri: URI, model: ModelSelection): Promise<void> {
		if (!isBackboardProviderAvailable(providerFromModelId(model.id) ?? '')) {
			throw new Error(localize('cliTsAgent.subscriptions.unavailable', "Subscriptions are currently unavailable. Use Backboard or an API key."));
		}
		const session = this._session(sessionUri);
		const previousModelId = session.model?.id;
		session.model = model;
		if (isChatGptSubscriptionModel(model.id)) {
			await this._ensureChatGptSubscriptionLogin(false);
		} else if (isClaudeSubscriptionModel(model.id)) {
			await this._requireClaudeSubscriptionLogin();
		}
		const previousProvider = providerFromModelId(previousModelId);
		const nextProvider = providerFromModelId(model.id);
		const providerChanged = !!previousProvider && !!nextProvider && previousProvider !== nextProvider;
		if (session.turn && providerChanged) {
			// Let the in-flight provider finish cleanly. sendMessage is sequenced
			// behind it and performs the handoff before the next request starts.
			session.pendingProviderHandoff = true;
			this._logService.info(`[cli-ts] deferred provider handoff until the active turn completes session=${session.sessionId} from=${previousModelId} to=${model.id}`);
			return;
		}
		if (requiresProviderThreadHandoff(session.threadId, previousModelId, model.id)) {
			this._prepareProviderHandoff(session, model.id, previousModelId);
			return;
		}
		if (session.proc?.isRunning && model.id) {
			session.proc.notify({ op: 'setModel', model: model.id });
		}
	}

	private _prepareProviderHandoff(session: CliTsSession, nextModelId: string | undefined, previousModelId?: string): void {
		session.pendingProviderHandoff = false;
		if (!session.threadId) {
			return;
		}
		// A remote thread belongs to the backend that created it. Preserve the
		// visible IDE conversation, but start a fresh remote thread and seed every
		// new-provider prompt with the completed transcript. Restarting the serve
		// process also clears R-CLI's in-memory copy of the old provider thread id.
		session.providerHandoffContext = buildProviderHandoffConversationContext(session.storedTurns);
		session.forkContext = undefined;
		session.threadId = undefined;
		session.proc?.dispose();
		session.proc = undefined;
		session.modifiedAt = Date.now();
		this._writeStore();
		this._logService.info(`[cli-ts] prepared provider handoff session=${session.sessionId} from=${previousModelId ?? '(bound provider thread)'} to=${nextModelId ?? '(selected provider)'}`);
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		// The only registrations on this channel are client tool calls the
		// workbench declined pre-execution: it dispatches no completion for
		// those, so unpark the serve process with a denial result here.
		if (!approved) {
			for (const session of this._sessions.values()) {
				if (session.pendingClientToolCalls.delete(requestId)) {
					session.proc?.notify({ op: 'clientToolResult', id: requestId, error: 'The user declined this tool call.' });
					return;
				}
			}
		}
		this._logService.info(`[cli-ts] Ignoring permission response for ${requestId} (approved=${approved})`);
	}

	respondToUserInputRequest(requestId: string, response: SessionInputResponseKind, answers?: Record<string, SessionInputAnswer>): void {
		for (const session of this._sessions.values()) {
			const questionIds = session.pendingInputs.get(requestId);
			if (questionIds) {
				session.pendingInputs.delete(requestId);
				const inputAnswers = response === ChatInputResponseKind.Accept
					? questionIds.map(questionId => inputAnswerText(answers?.[questionId]))
					: [];
				session.proc?.notify({ op: 'respondInput', id: requestId, answers: inputAnswers });
				return;
			}
		}
		this._logService.warn(`[cli-ts] No pending input request found for ${requestId}`);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const inMemory = [...this._sessions.values()]
			.filter(session => session.materialized && !session.disposed)
			.map(session => ({
				session: session.sessionUri,
				startTime: session.createdAt,
				modifiedTime: session.modifiedAt,
				summary: session.title,
				status: session.turn ? SessionStatus.InProgress : SessionStatus.Idle,
				model: session.model,
				workingDirectory: session.workingDirectory,
				project: this._projectForSession(session),
			}));
		const seen = new Set(inMemory.map(entry => AgentSession.id(entry.session)));
		const restored = this._readStore()
			.filter(entry => !seen.has(entry.id))
			.map(entry => {
				const workingDirectory = entry.cwd
					? URI.file(entry.cwd)
					: entry.worktree?.path ? URI.file(entry.worktree.path) : undefined;
				const projectDirectory = entry.sourceCwd
					? URI.file(entry.sourceCwd)
					: entry.worktree?.repositoryRoot ? URI.file(entry.worktree.repositoryRoot) : workingDirectory;
				return {
					session: AgentSession.uri(this.id, entry.id),
					startTime: entry.createdAt,
					modifiedTime: entry.modifiedAt,
					summary: entry.title,
					status: SessionStatus.Idle,
					workingDirectory,
					project: projectDirectory ? { uri: projectDirectory, displayName: path.basename(projectDirectory.fsPath) } : undefined,
				};
			});
		return [...inMemory, ...restored].sort((left, right) => right.modifiedTime - left.modifiedTime);
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		return true;
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(session: URI, clientId: string | undefined, tools: ToolDefinition[]): void {
		const entry = this._sessions.get(AgentSession.id(session));
		if (!entry || entry.disposed) {
			return;
		}
		if (!clientId || tools.length === 0) {
			// An empty push clears the previous client's tools (client hand-off).
			entry.clientTools = undefined;
			return;
		}
		entry.clientTools = { clientId, tools: [...tools] };
		this._logService.info(`[cli-ts] Registered ${tools.length} client tool(s) for session ${entry.sessionId}; they are advertised on the next turn.`);
	}

	onClientToolCallComplete(sessionUri: URI, toolCallId: string, result: ToolCallResult): void {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		// Every server-side tool completion also flows through here; only
		// answer calls this provider actually forwarded to the IDE.
		if (!session?.pendingClientToolCalls.delete(toolCallId)) {
			return;
		}
		if (!session.proc?.isRunning) {
			return;
		}
		session.proc.notify({ op: 'clientToolResult', id: toolCallId, result: clientToolResultToWire(result) });
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
	}

	async shutdown(): Promise<void> {
		const sessions = [...this._sessions.values()];
		for (const session of sessions) {
			session.disposed = true;
			session.cancelBeforeSubmit = true;
		}
		await Promise.allSettled(sessions.flatMap(session => [session.materializing, session.restoringWorktree]));
		for (const session of sessions) {
			this._releaseSessionRuntime(session);
		}
		await Promise.allSettled(sessions.map(session => session.sendQueue));
		for (const session of sessions) {
			if (!session.materialized && session.worktree) {
				let checkpointsDisposed = true;
				try {
					await this._checkpointService.disposeSessionData(session.sessionUri, session.worktree.repositoryRoot);
				} catch {
					checkpointsDisposed = false;
				}
				if (checkpointsDisposed) {
					await this._removeWorktreeIfClean(session.sessionId, session.worktree, 'cancelled startup');
				}
			}
		}
		this._sessions.clear();
	}

	override dispose(): void {
		for (const session of this._sessions.values()) {
			session.disposed = true;
			session.cancelBeforeSubmit = true;
			this._releaseSessionRuntime(session);
		}
		this._sessions.clear();
		super.dispose();
	}

	private _releaseSessionRuntime(session: CliTsSession): void {
		session.proc?.dispose();
		session.proc = undefined;
		session.fileEdits?.tracker.dispose();
		session.fileEdits?.dbRef.dispose();
		session.fileEdits = undefined;
		session.pendingInputs?.clear();
	}

	// ---- session plumbing ---------------------------------------------------

	private _session(sessionUri: URI): CliTsSession {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		if (session && !session.disposed) {
			return session;
		}
		if (session?.disposed) {
			throw new Error(`Backboard session was disposed: ${sessionUri.toString()}`);
		}
		const restored = this._readStore().find(entry => entry.id === sessionId);
		const recreated = this._createSessionEntry(sessionUri, restored);
		this._sessions.set(sessionId, recreated);
		this._logService.warn(`[cli-ts] Recreated missing session from URI ${sessionUri.toString()}`);
		return recreated;
	}

	private _createSessionEntry(sessionUri: URI, restored?: CliTsStoredSession): CliTsSession {
		const worktree = restored?.worktree ? {
			path: URI.file(restored.worktree.path),
			repositoryRoot: URI.file(restored.worktree.repositoryRoot),
			branchName: restored.worktree.branchName,
			baseBranch: restored.worktree.baseBranch,
		} : undefined;
		const workingDirectory = restored?.cwd ? URI.file(restored.cwd) : worktree?.path;
		const sourceWorkingDirectory = restored?.sourceCwd
			? URI.file(restored.sourceCwd)
			: worktree?.repositoryRoot ?? workingDirectory;
		return {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			createdAt: restored?.createdAt ?? Date.now(),
			modifiedAt: restored?.modifiedAt ?? Date.now(),
			workingDirectory,
			sourceWorkingDirectory,
			worktree,
			rewind: restored?.rewind,
			title: restored?.title,
			threadId: restored?.threadId,
			forkContext: restored?.forkContext,
			providerHandoffContext: restored?.providerHandoffContext,
			materialized: !!restored && restored.materialized !== false,
			disposed: false,
			pendingClientToolCalls: new Set(),
			pendingInputs: new Map(),
			subagentTurnOwners: new Map(),
			completedSubagentToolCallIds: new Set(),
			storedTurns: [...(restored?.turns ?? [])],
			storedSubagentTurns: new Map(Object.entries(restored?.subagents ?? {}).map(([toolCallId, turns]) => [toolCallId, cloneStoredTurns(turns)])),
		};
	}

	private _projectForSession(session: CliTsSession): { uri: URI; displayName: string } | undefined {
		const directory = session.sourceWorkingDirectory ?? session.workingDirectory;
		return directory ? { uri: directory, displayName: path.basename(directory.fsPath) } : undefined;
	}

	private _ensureRestoredWorktree(session: CliTsSession): Promise<void> {
		if (!session.materialized || !session.worktree) {
			return Promise.resolve();
		}
		if (session.restoringWorktree) {
			return session.restoringWorktree;
		}
		const restoring = this._doEnsureRestoredWorktree(session).finally(() => {
			if (session.restoringWorktree === restoring) {
				session.restoringWorktree = undefined;
			}
		});
		session.restoringWorktree = restoring;
		return restoring;
	}

	private async _doEnsureRestoredWorktree(session: CliTsSession): Promise<void> {
		this._throwIfDisposed(session);
		const worktree = session.worktree;
		if (!worktree) {
			return;
		}
		let pathExists = true;
		try {
			await fs.promises.access(worktree.path.fsPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			pathExists = false;
		}
		const worktreeRoots = await this._gitService.getWorktreeRoots(worktree.repositoryRoot);
		this._throwIfDisposed(session);
		let registered = worktreeRoots.some(root => root.toString() === worktree.path.toString());
		if (pathExists && !registered) {
			throw new Error(localize('cliTsAgent.worktreePathOccupied', "The saved Backboard worktree path exists but is no longer registered with Git: {0}", worktree.path.fsPath));
		}
		if (!pathExists) {
			if (registered) {
				await this._gitService.removeWorktree(worktree.repositoryRoot, worktree.path);
				this._throwIfDisposed(session);
				registered = false;
			}
			const branchExists = await this._gitService.branchExists(worktree.repositoryRoot, worktree.branchName);
			this._throwIfDisposed(session);
			if (!branchExists) {
				throw new Error(localize('cliTsAgent.worktreeBranchMissing', "The isolated branch '{0}' no longer exists. Restore it or start a new Backboard session.", worktree.branchName));
			}
			await fs.promises.mkdir(path.dirname(worktree.path.fsPath), { recursive: true });
			this._throwIfDisposed(session);
			await this._gitService.addExistingWorktree(worktree.repositoryRoot, worktree.path, worktree.branchName);
			this._throwIfDisposed(session);
			registered = true;
		}
		if (!registered) {
			return;
		}

		const configuredWorkingDirectory = session.workingDirectory ?? worktree.path;
		const relativeWorkingDirectory = path.relative(worktree.path.fsPath, configuredWorkingDirectory.fsPath);
		const isInsideWorktree = relativeWorkingDirectory !== '..'
			&& !relativeWorkingDirectory.startsWith(`..${path.sep}`)
			&& !path.isAbsolute(relativeWorkingDirectory);
		let workingDirectory = isInsideWorktree ? configuredWorkingDirectory : worktree.path;
		try {
			await fs.promises.access(workingDirectory.fsPath);
		} catch {
			workingDirectory = worktree.path;
		}
		if (session.workingDirectory?.toString() !== workingDirectory.toString()) {
			session.workingDirectory = workingDirectory;
			this._writeStore();
		}
	}

	private async _getWorktreeRepositoryInfo(sourceWorkingDirectory: URI): Promise<{ repositoryRoot: URI; sourceRepositoryRoot: URI } | undefined> {
		const sourceRepositoryRoot = await this._gitService.getRepositoryRoot(sourceWorkingDirectory);
		if (!sourceRepositoryRoot) {
			return undefined;
		}
		let worktreeRoots: URI[] = [];
		try {
			worktreeRoots = await this._gitService.getWorktreeRoots(sourceWorkingDirectory);
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to locate the primary Git worktree for ${sourceWorkingDirectory.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { repositoryRoot: worktreeRoots[0] ?? sourceRepositoryRoot, sourceRepositoryRoot };
	}

	private _materialize(session: CliTsSession, prompt: string, liveConfig?: Record<string, unknown>): Promise<void> {
		if (session.materialized) {
			return Promise.resolve();
		}
		if (session.materializing) {
			return session.materializing;
		}
		const tracked = this._doMaterialize(session, prompt, liveConfig).finally(() => {
			if (session.materializing === tracked) {
				session.materializing = undefined;
			}
		});
		session.materializing = tracked;
		return tracked;
	}

	private async _doMaterialize(session: CliTsSession, prompt: string, liveConfig?: Record<string, unknown>): Promise<void> {
		this._throwIfDisposed(session);
		const sourceWorkingDirectory = session.sourceWorkingDirectory ?? session.workingDirectory;
		if (!sourceWorkingDirectory) {
			throw new Error(localize('cliTsAgent.missingWorkingDirectory', "Select a working folder before starting a Backboard session."));
		}
		session.sourceWorkingDirectory = sourceWorkingDirectory;

		const config = { ...(session.config ?? {}), ...(liveConfig ?? {}) };
		const configuredIsolation = config[SessionConfigKey.Isolation];
		let repository: { repositoryRoot: URI; sourceRepositoryRoot: URI } | undefined;
		// Direct folder mutation is the fast default. A worktree is created only
		// when the user explicitly selected isolation for this top-level session;
		// subagents keep their own hidden application-owned worktrees.
		const isolation = configuredIsolation === 'worktree' ? 'worktree' : 'folder';
		this._throwIfDisposed(session);

		if (isolation === 'worktree') {
			repository ??= await this._getWorktreeRepositoryInfo(sourceWorkingDirectory);
			this._throwIfDisposed(session);
			if (!repository) {
				throw new Error(localize('cliTsAgent.worktreeRequiresGit', "Worktree isolation requires the selected folder to be inside a Git repository."));
			}
			const { repositoryRoot, sourceRepositoryRoot } = repository;
			const currentBranch = await this._gitService.getCurrentBranch(sourceWorkingDirectory) ?? 'HEAD';
			const baseBranch = typeof config[SessionConfigKey.Branch] === 'string' && config[SessionConfigKey.Branch]
				? config[SessionConfigKey.Branch] as string
				: await this._gitService.getDefaultBranch(sourceWorkingDirectory) ?? currentBranch;
			this._throwIfDisposed(session);
			const branchName = getBackboardWorktreeBranchName(session.sessionId, getBackboardBranchNameHintFromMessage(prompt));
			const worktreesRoot = getBackboardWorktreesRoot(repositoryRoot);
			const worktreePath = URI.joinPath(worktreesRoot, branchName.replace(/\//g, '-'));
			await fs.promises.mkdir(worktreesRoot.fsPath, { recursive: true });
			this._throwIfDisposed(session);
			await this._createOrReuseWorktree(repositoryRoot, worktreePath, branchName, baseBranch);
			const relativeSourcePath = path.relative(sourceRepositoryRoot.fsPath, sourceWorkingDirectory.fsPath);
			const worktreeWorkingDirectory = relativeSourcePath
				&& relativeSourcePath !== '..'
				&& !relativeSourcePath.startsWith(`..${path.sep}`)
				&& !path.isAbsolute(relativeSourcePath)
				? URI.file(path.join(worktreePath.fsPath, relativeSourcePath))
				: worktreePath;
			let finalWorkingDirectory = worktreeWorkingDirectory;
			if (worktreeWorkingDirectory.toString() !== worktreePath.toString()) {
				try {
					await fs.promises.access(worktreeWorkingDirectory.fsPath);
				} catch {
					finalWorkingDirectory = worktreePath;
					this._logService.info(`[cli-ts] Selected subfolder is absent on ${baseBranch}; using the isolated repository root instead.`);
				}
			}

			// A session may have been prewarmed while the composer still pointed at
			// the source folder. Never reuse that process after switching cwd.
			session.proc?.dispose();
			session.proc = undefined;
			session.worktree = { path: worktreePath, repositoryRoot, branchName, baseBranch };
			session.workingDirectory = finalWorkingDirectory;
			this._throwIfDisposed(session);
			try {
				await this._writeWorktreeMetadata(session.sessionUri, session.worktree);
			} catch (error) {
				this._logService.warn(`[cli-ts] Failed to persist worktree metadata for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			}
			this._throwIfDisposed(session);
		} else {
			session.worktree = undefined;
			session.workingDirectory = sourceWorkingDirectory;
		}

		// The baseline belongs to the final cwd and must exist before cli-ts can
		// execute a write tool. Capture is idempotent in the checkpoint service.
		session.baselineCapture ??= this._captureSessionBaseline(session);
		await session.baselineCapture;
		this._throwIfDisposed(session);
		session.materialized = true;
		this._writeStore();
		this._onDidMaterializeSession.fire({
			session: session.sessionUri,
			workingDirectory: session.workingDirectory,
			project: this._projectForSession(session),
		});
	}

	private _throwIfDisposed(session: CliTsSession): void {
		if (session.disposed) {
			throw new Error(`Cannot materialize disposed Backboard session: ${session.sessionUri.toString()}`);
		}
	}

	private async _createOrReuseWorktree(repositoryRoot: URI, worktreePath: URI, branchName: string, baseBranch: string): Promise<void> {
		const isRegistered = async (): Promise<boolean> => (await this._gitService.getWorktreeRoots(repositoryRoot))
			.some(root => root.toString() === worktreePath.toString());
		const pathExists = async (): Promise<boolean> => {
			try {
				await fs.promises.access(worktreePath.fsPath);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return false;
				}
				throw error;
			}
		};
		const reuseRegistered = async (): Promise<boolean> => {
			if (!await isRegistered()) {
				return false;
			}
			if (!await pathExists()) {
				// Prune a stale registration left by an interrupted checkout. The
				// branch is preserved, then the path below is recreated from it.
				await this._gitService.removeWorktree(repositoryRoot, worktreePath);
				return false;
			}
			if (await this._gitService.hasUncommittedChanges(worktreePath)) {
				throw new Error(`A previous Backboard startup left changes in '${worktreePath.fsPath}'. The worktree was retained for recovery.`);
			}
			this._logService.info(`[cli-ts] Reusing existing clean worktree '${worktreePath.fsPath}' for branch ${branchName}.`);
			return true;
		};

		if (await reuseRegistered()) {
			return;
		}
		if (await this._gitService.branchExists(repositoryRoot, branchName)) {
			if (await pathExists()) {
				throw new Error(`Cannot restore Backboard branch '${branchName}' because '${worktreePath.fsPath}' already exists outside Git's worktree registry.`);
			}
			await this._gitService.addExistingWorktree(repositoryRoot, worktreePath, branchName);
			return;
		}

		try {
			await this._gitService.addWorktree(repositoryRoot, worktreePath, branchName, baseBranch);
		} catch (error) {
			// `git worktree add` can fail after creating the branch or registering
			// the checkout (for example, a checkout filter failure). Reuse it only
			// when Git reports a complete, clean worktree; otherwise retain it and
			// surface a recoverable error instead of colliding forever on retry.
			if (await reuseRegistered()) {
				return;
			}
			if (await this._gitService.branchExists(repositoryRoot, branchName) && !await pathExists()) {
				try {
					await this._gitService.addExistingWorktree(repositoryRoot, worktreePath, branchName);
					return;
				} catch {
					// Preserve the original add failure below; it explains the root cause.
				}
			}
			throw error;
		}
	}

	private async _writeWorktreeMetadata(sessionUri: URI, worktree: CliTsWorktree): Promise<void> {
		const dbRef = this._sessionDataService.openDatabase(sessionUri);
		try {
			await Promise.all([
				dbRef.object.setMetadata(CLI_TS_META_WORKTREE_BRANCH, worktree.branchName),
				dbRef.object.setMetadata(CLI_TS_META_WORKTREE_PATH, worktree.path.toString()),
				dbRef.object.setMetadata(CLI_TS_META_WORKTREE_REPOSITORY_ROOT, worktree.repositoryRoot.toString()),
				dbRef.object.setMetadata(META_DIFF_BASE_BRANCH, worktree.baseBranch),
			]);
		} finally {
			dbRef.dispose();
		}
	}

	private _ensureProcess(session: CliTsSession, rgDir?: string, workingDirectory = session.workingDirectory): CliTsServeProcess {
		if (session.proc?.isRunning && !session.proc.isInvocationStale) {
			return session.proc;
		}
		if (session.proc?.isInvocationStale) {
			this._logService.info(`[cli-ts] restarting session ${session.sessionId} because the CLI executable changed on disk.`);
		}
		session.proc?.dispose();
		const proc = new CliTsServeProcess(this._logService, {
			sessionId: session.sessionId,
			workingDirectory: workingDirectory?.fsPath,
			extraPathDirs: rgDir ? [rgDir] : undefined,
			onEvent: event => this._handleAgentEvent(session, event),
			onExit: () => {
				session.pendingInputs.clear();
			},
		});
		session.proc = proc;
		return proc;
	}

	private async _requestWorkerLifecycle(session: CliTsSession, op: 'archiveWorkers' | 'unarchiveWorkers' | 'deleteWorkers'): Promise<void> {
		let proc = session.proc;
		try {
			if (!proc?.isRunning) {
				// Archive/delete may be the first host operation after restart. The
				// original coordinator worktree can already be absent, but the source
				// repository is sufficient for cli-ts to open the stable workers.json.
				const lifecycleCwd = [session.workingDirectory, session.sourceWorkingDirectory]
					.find(candidate => candidate && fs.existsSync(candidate.fsPath));
				if (!lifecycleCwd) {
					this._logService.warn(`[cli-ts] Cannot ${op} for ${session.sessionId}: neither the coordinator nor source workspace exists. Worker metadata was retained.`);
					return;
				}
				const rgDir = await this._resolveRgDir();
				proc = this._ensureProcess(session, rgDir, lifecycleCwd);
				proc.start();
			}
			const record = await proc.request({ op, requestId: proc.nextRequestId() });
			const payload = record.payload as { preservedWorktrees?: readonly string[] } | undefined;
			if (payload?.preservedWorktrees?.length) {
				this._logService.warn(`[cli-ts] ${op} preserved worker worktrees for ${session.sessionId}: ${payload.preservedWorktrees.join(', ')}`);
			}
		} catch (error) {
			this._logService.warn(`[cli-ts] Worker lifecycle operation ${op} failed for ${session.sessionId}; preserved worker worktrees may require manual cleanup: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Resolves the directory of VS Code's bundled ripgrep once, so cli-ts's
	 * Grep/Glob tools find `rg` even when it is not on the user's PATH.
	 */
	private async _resolveRgDir(): Promise<string | undefined> {
		this._rgDir ??= rgDiskPath().then(rgPath => path.dirname(rgPath), error => {
			this._logService.warn(`[cli-ts] Could not resolve bundled ripgrep: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		return this._rgDir;
	}

	private async _refreshModelCatalog(): Promise<void> {
		await this._refreshClaudeSubscriptionConnectionState();
		this._models.set(withChatGptSubscriptionConnectionState(this._models.get(), false), undefined);
		// A short-lived catalog process reads current credentials and avoids touching
		// the provider routers or processes owned by running conversations.
		const proc = new CliTsServeProcess(this._logService, { onEvent: () => { } });
		this._modelRefreshProcess.value = proc;
		try {
			const record = await raceTimeout(proc.request({ op: 'listModels', requestId: proc.nextRequestId() }), 30_000);
			if (!record) {
				throw new Error(localize('cliTsAgent.models.timeout', "Refreshing models timed out. Try again."));
			}
			if (!this._applyModelCatalog(record)) {
				throw new Error(localize('cliTsAgent.models.empty', "No models were returned. The previous catalog has been kept."));
			}
			this._modelsRefreshed = true;
		} finally {
			this._modelRefreshProcess.clear();
		}
	}

	private _refreshModelsOnce(session: CliTsSession): Promise<void> | undefined {
		if (this._modelsRefreshed || !session.proc?.isRunning) {
			return undefined;
		}
		this._modelsRefreshed = true;
		const proc = session.proc;
		return proc.request({ op: 'listModels', requestId: proc.nextRequestId() }).then(record => {
			this._applyModelCatalog(record);
		}).catch(error => {
			this._modelsRefreshed = false;
			this._logService.warn(`[cli-ts] Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private _applyModelCatalog(record: CliTsRecord): boolean {
		const payload = record.payload as { models?: unknown[] } | undefined;
		const models = (Array.isArray(payload?.models) ? payload.models : []).filter(isBridgeModel);
		if (models.length) {
			// The Backboard API is authoritative for catalog providers. Only the
			// Release filtering applies to both live and bundled catalog entries.
			const infos = withSubscriptionConnectionStates(
				backboardModelInfos(models, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS),
				false,
				this._claudeSubscriptionConnected,
			);
			this._models.set(infos.length ? infos : [fallbackModel()], undefined);
			// Persist for instant hydration on the next window start.
			this._persistModelsCache(models);
			return true;
		}
		return false;
	}

	// ---- event translation ---------------------------------------------------

	private _fire(session: URI, action: SessionAction | ChatAction, parentToolCallId?: string): void {
		this._onDidSessionProgress.fire({ kind: 'action', session, action, ...(parentToolCallId ? { parentToolCallId } : {}) });
	}

	/**
	 * Updates the pre-content progress line with a truthful, backend-derived
	 * phase label ("Preparing…" → "Working…"). Rendered as an ephemeral
	 * `progressMessage`: the latest supersedes the previous, and the line
	 * auto-hides the instant real content (markdown, reasoning, or a tool call)
	 * starts streaming. Deduped so an unchanged phase never re-renders.
	 * Deliberately does NOT set `didCreateStatusPart`, so a genuine
	 * `system:warning` can still take over the line.
	 */
	private _fireStatus(session: CliTsSession, turn: CliTsTurnState, label: string, parentToolCallId?: string): void {
		if (turn.lastStatusLabel === label) {
			return;
		}
		turn.lastStatusLabel = label;
		this._fire(session.sessionUri, {
			type: ActionType.ChatResponsePart,
			turnId: turn.turnId,
			part: { kind: ResponsePartKind.SystemNotification, content: label },
		}, parentToolCallId);
	}

	/**
	 * Finalizes a child exactly once. `agent:child_end` is the primary signal,
	 * while the parent Agent tool result/error calls this as a delivery-loss
	 * fallback so a child chat can never remain indefinitely active.
	 */
	private _completeSubagentTurn(session: CliTsSession, parentTurn: CliTsTurnState, toolCallId: string, status: CliTsSubagentCompletionStatus): void {
		const child = parentTurn.subagentTurns.get(toolCallId);
		if (!child || child.completion) {
			return;
		}
		child.turn.failed = status !== 'completed';
		child.completion = (async (): Promise<void> => {
			try {
				await Promise.allSettled(child.turn.pendingCompletions);
				let storedTurn: CliTsStoredTurn = {
					prompt: child.prompt,
					response: child.turn.responseText,
					failed: child.turn.failed,
					...(child.turn.error ? { error: child.turn.error } : {}),
					...(child.turn.toolSummaries.length ? { tools: child.turn.toolSummaries } : {}),
					...(child.turn.storedParts.length ? { parts: child.turn.storedParts } : {}),
				};
				// Restored/legacy session-shaped callers may predate the explicit
				// `sessionId` field. The URI remains the canonical identity, and using
				// it here also keeps late child completion scoped to its actual parent.
				const runtimeSessionId = session.sessionId || AgentSession.id(session.sessionUri);
				// Opening a running child may have cached a partial archive. Its terminal
				// edge follows the runtime's durable flush and must read that final state.
				this._runtimeSubagentTurnCache.delete(`${runtimeSessionId}\0${toolCallId}`);
				const runtimeRecovery = await this._readRuntimeSubagentRecovery(runtimeSessionId, toolCallId);
				const workspace = parentTurn.workerWorkspaces?.get(toolCallId);
				const allowFileEdits = cliTsWorkerEditsAreIntegrated(workspace, runtimeRecovery);
				const integrationChanges = workspace?.integrationChanges ?? runtimeRecovery?.integrationChanges;
				const modernWorker = parentTurn.workerStates?.has(toolCallId) || workspace?.revision !== undefined || runtimeRecovery?.workspaceRevision !== undefined;
				if (runtimeRecovery) {
					const projectedRecovery = projectRuntimeSubagentRecovery(runtimeRecovery, runtimeRecovery.pathMapping
						?? runtimePathMapping(workspace?.worktreePath, session.workingDirectory?.fsPath));
					if (allowFileEdits && !modernWorker) {
						await this._attachRuntimeRecoveryFileEdits(session, child.turn, projectedRecovery, toolCallId);
						if (integrationChanges === undefined && (workspace?.status === 'Integrated' || runtimeRecovery.workerIntegrationStatus === 'integrated')) {
							await this._publishWorkerIntegrationEdits(session, parentTurn, toolCallId, projectedRecovery);
						}
					}
					storedTurn = { ...projectedRecovery.turn, failed: child.turn.failed, ...(child.turn.error ? { error: child.turn.error } : {}) };
				}
				if (allowFileEdits && integrationChanges !== undefined) {
					await this._publishWorkerIntegrationEdits(session, parentTurn, toolCallId, undefined, integrationChanges);
				}
				if (modernWorker && integrationChanges === undefined && (workspace?.integrationStatus === 'integrated' || runtimeRecovery?.workerIntegrationStatus === 'integrated')) {
					this._fire(session.sessionUri, { type: ActionType.ChatResponsePart, turnId: parentTurn.turnId, part: { kind: ResponsePartKind.SystemNotification, content: localize('cliTsAgent.workerReviewMissing', "Worker changes were integrated, but an exact coordinator review snapshot is unavailable.") } });
				}
				if (!allowFileEdits || modernWorker) {
					storedTurn = withoutStoredFileEdits(storedTurn);
				}
				if (status === 'failed' && !storedTurn.error) {
					storedTurn = { ...storedTurn, error: { errorType: 'BackboardSubagentFailed', message: localize('cliTsAgent.subagentFailed', "The Backboard subagent reported a failed turn.") } };
				}
				session.storedSubagentTurns.set(toolCallId, [storedTurn]);
				// Public child progress omits the final text. Publish the durable
				// archive's answer before completing a live, otherwise empty child chat.
				if (!child.turn.responseText.trim() && storedTurn.response.trim()) {
					this._handleMappedAgentEvent(session, { type: 'assistant:message', messageId: `${toolCallId}-recovered-final`, text: storedTurn.response }, child.turn, toolCallId);
				}
				parentTurn.deferredSubagentCompletions?.get(toolCallId)?.(status);
				parentTurn.deferredSubagentCompletions?.delete(toolCallId);
				if (status === 'cancelled') {
					this._fire(session.sessionUri, {
						type: ActionType.ChatTurnCancelled,
						turnId: child.turn.turnId,
					}, toolCallId);
				} else if (status === 'failed') {
					this._fire(session.sessionUri, {
						type: ActionType.ChatError,
						turnId: child.turn.turnId,
						error: storedTurn.error ?? { errorType: 'BackboardSubagentFailed', message: localize('cliTsAgent.subagentFailed', "The Backboard subagent reported a failed turn.") },
					}, toolCallId);
				} else {
					this._fire(session.sessionUri, {
						type: ActionType.ChatTurnComplete,
						turnId: child.turn.turnId,
					}, toolCallId);
				}
				this._onDidSessionProgress.fire({
					kind: 'subagent_completed',
					session: session.sessionUri,
					toolCallId,
				});
				// A detached worker can finish after _sendMessage has already persisted
				// and released its parent turn. Flush this lifecycle boundary here so
				// reopening either the parent or child never depends on another message.
				session.modifiedAt = Date.now();
				this._writeStore();
			} finally {
				if (session.subagentTurnOwners?.get(toolCallId) === parentTurn) {
					session.subagentTurnOwners.delete(toolCallId);
				}
				(session.completedSubagentToolCallIds ??= new Set()).add(toolCallId);
			}
		})();
		parentTurn.pendingCompletions.push(child.completion);
	}

	private _cancelUnfinishedSubagents(session: CliTsSession, parentTurn: CliTsTurnState, includeDetached: boolean): void {
		for (const [toolCallId, child] of parentTurn.subagentTurns) {
			if (child.completion) {
				continue;
			}
			const toolName = parentTurn.toolInputs.get(toolCallId)?.name;
			if (!includeDetached && toolName && isCliTsDetachedSubagentTool(toolName)) {
				continue;
			}
			this._completeSubagentTurn(session, parentTurn, toolCallId, 'cancelled');
		}
	}

	/**
	 * Starts a child transcript even when the runtime omits its optional
	 * `agent:child_start` envelope. Public cli-ts builds still emit the parent
	 * Subagent tool and child-tool events, which is enough to keep a complete,
	 * reopenable conversation instead of restoring an empty child session.
	 */
	private _ensureSubagentTurn(session: CliTsSession, parentTurn: CliTsTurnState, toolCallId: string, prompt: string, childTurnId?: string, agentName?: string): CliTsSubagentTurnState {
		const existing = parentTurn.subagentTurns.get(toolCallId);
		if (existing) {
			if (!existing.completion) {
				(session.subagentTurnOwners ??= new Map()).set(toolCallId, parentTurn);
			}
			return existing;
		}
		const name = validSubagentName(agentName) ?? subagentDisplayName(parentTurn, toolCallId);
		const child = { prompt, name, turn: createTurnState(childTurnId ?? generateUuid(), prompt) };
		parentTurn.subagentTurns.set(toolCallId, child);
		(session.subagentTurnOwners ??= new Map()).set(toolCallId, parentTurn);
		const description = firstPromptLine(prompt);
		this._onDidSessionProgress.fire({
			kind: 'subagent_started',
			session: session.sessionUri,
			toolCallId,
			agentName: name ?? 'worker',
			agentDisplayName: name ?? localize('cliTsAgent.subagentName', "Subagent"),
			agentDescription: description,
			prompt,
		});
		this._fire(session.sessionUri, {
			type: ActionType.ChatTurnStarted,
			turnId: child.turn.turnId,
			message: { text: prompt, origin: { kind: MessageKind.User } },
		}, toolCallId);
		return child;
	}

	private _resolveSubagentOwner(session: CliTsSession, toolCallId: string): CliTsTurnState | undefined {
		const owner = session.subagentTurnOwners?.get(toolCallId);
		if (owner) {
			return owner;
		}
		// Duplicate status/end records can trail the terminal child event. Never
		// reinterpret those as a child belonging to a newer provider turn.
		if (session.completedSubagentToolCallIds?.has(toolCallId)) {
			return undefined;
		}
		return session.turn;
	}

	private _handleAgentEvent(session: CliTsSession, event: CliTsAgentEvent): void {
		// Performance records are already durable in the cli-ts event stream. They
		// must never become transcript parts or child-session activity.
		if (event.type === 'performance:timing') {
			this._logService.trace(`[performance:timing] ${JSON.stringify({ phase: event.phase, durationMs: event.durationMs, toolCallId: event.toolCallId, workerId: event.workerId, fileCount: event.fileCount })}`);
			return;
		}
		switch (event.type) {
			case 'agent:worker_update': {
				const worker = event.worker;
				const toolCallId = event.agentToolCallId;
				if (!toolCallId || !worker || worker.sessionId !== (session.sessionId || AgentSession.id(session.sessionUri))
					|| !Number.isSafeInteger(worker.revision) || worker.revision < 1) {
					return;
				}
				if (!session.subagentTurnOwners?.has(toolCallId) && this._updateRestoredWorker(session, toolCallId, worker)) {
					return;
				}
				const turn = this._resolveSubagentOwner(session, toolCallId);
				if (!turn) {
					return;
				}
				const states = turn.workerStates ??= new Map();
				const previous = states.get(toolCallId);
				if (previous && (previous.handle !== worker.handle || worker.revision <= previous.revision)) {
					this._logService.trace(`[cli-ts] Ignoring stale worker projection ${toolCallId} revision ${worker.revision}.`);
					return;
				}
				states.set(toolCallId, worker);
				this._runtimeWorkerStateCache.set(`${worker.sessionId}\0${worker.handle}`, worker);
				if (event.parentBatchToolCallId && !turn.startedToolCalls.has(toolCallId)) {
					this._startBatchWorkerRow(session, turn, toolCallId, worker);
				}
				const child = this._ensureSubagentTurn(session, turn, toolCallId, worker.prompt, undefined, worker.name);
				if (worker.error || worker.persistenceError) {
					child.turn.error = { errorType: 'BackboardSubagentFailed', message: worker.error ?? worker.persistenceError! };
				}
				this._updateSubagentWorkspace(session, turn, toolCallId, workspaceFromWorker(worker), true);
				const terminalStatus = cliTsWorkerCompletionStatus(worker);
				if (terminalStatus) {
					this._completeSubagentTurn(session, turn, toolCallId, terminalStatus);
				}
				return;
			}
			case 'agent:child_start': {
				if (!event.agentToolCallId || event.prompt === undefined) {
					return;
				}
				const turn = this._resolveSubagentOwner(session, event.agentToolCallId);
				if (!turn) {
					return;
				}
				this._ensureSubagentTurn(session, turn, event.agentToolCallId, event.prompt, event.childSessionId, event.agentName ?? event.workspace?.name);
				if (event.workspace && !turn.workerStates?.has(event.agentToolCallId)) {
					this._updateSubagentWorkspace(session, turn, event.agentToolCallId, event.workspace);
				}
				return;
			}
			case 'agent:child_status': {
				if (!event.agentToolCallId || !event.workspace) {
					return;
				}
				const turn = this._resolveSubagentOwner(session, event.agentToolCallId);
				if (!turn) {
					return;
				}
				if (turn.workerStates?.has(event.agentToolCallId)) {
					return;
				}
				this._ensureSubagentTurn(session, turn, event.agentToolCallId, subagentPrompt(turn, event.agentToolCallId), undefined, event.workspace.name);
				const workspace = this._updateSubagentWorkspace(session, turn, event.agentToolCallId, event.workspace);
				const pendingStatus = cliTsPendingSubagentEndStatuses(turn).get(event.agentToolCallId);
				const authoritativeStatus = cliTsWorkspaceCompletionStatus(workspace);
				if (pendingStatus && authoritativeStatus) {
					cliTsPendingSubagentEndStatuses(turn).delete(event.agentToolCallId);
					this._completeSubagentTurn(session, turn, event.agentToolCallId, authoritativeStatus);
				}
				return;
			}
			case 'agent:child_event': {
				if (!event.agentToolCallId || !event.event) {
					return;
				}
				const turn = this._resolveSubagentOwner(session, event.agentToolCallId);
				if (!turn) {
					return;
				}
				const child = turn.subagentTurns.get(event.agentToolCallId);
				if (!child || child.completion) {
					return;
				}
				this._handleMappedAgentEvent(session, event.event, child.turn, event.agentToolCallId);
				return;
			}
			case 'agent:child_end': {
				if (!event.agentToolCallId) {
					return;
				}
				const turn = this._resolveSubagentOwner(session, event.agentToolCallId);
				if (!turn) {
					return;
				}
				const status = event.status === 'completed' || event.status === 'cancelled' ? event.status : 'failed';
				const authoritativeWorker = turn.workerStates?.get(event.agentToolCallId);
				if (authoritativeWorker) {
					const terminalStatus = cliTsWorkerCompletionStatus(authoritativeWorker);
					if (terminalStatus) {
						this._completeSubagentTurn(session, turn, event.agentToolCallId, terminalStatus);
					}
					return;
				}
				const toolName = turn.toolInputs.get(event.agentToolCallId)?.name;
				const workspace = turn.workerWorkspaces?.get(event.agentToolCallId);
				const authoritativeStatus = workspace ? cliTsWorkspaceCompletionStatus(workspace) : undefined;
				if (toolName && isCliTsDetachedSubagentTool(toolName) && workspace && !authoritativeStatus) {
					// AgentSpawn's private model turn ends before durable capture and
					// integration settle. Keep the child active until the lifecycle-only
					// terminal workspace projection arrives; this lets an integrated result
					// win a concurrent Stop instead of sealing the row as Cancelled.
					cliTsPendingSubagentEndStatuses(turn).set(event.agentToolCallId, status);
					return;
				}
				this._completeSubagentTurn(session, turn, event.agentToolCallId, authoritativeStatus ?? status);
				return;
			}
		}
		const turn = session.turn;
		if (!turn) {
			return;
		}
		this._handleMappedAgentEvent(session, event, turn);
	}

	/** Reconcile a recovered task without attaching its old handle to a new turn. */
	private _updateRestoredWorker(session: CliTsSession, toolCallId: string, worker: CliTsWorkerState): boolean {
		const previous = subagentWorkerFromTurns(session.storedTurns, toolCallId);
		if (!previous) {
			return false;
		}
		if (previous.handle === worker.handle && worker.revision > previous.revision) {
			const status = cliTsWorkerCompletionStatus(worker);
			for (let index = 0; index < session.storedTurns.length; index++) {
				const stored = session.storedTurns[index];
				if (stored.parts?.some(part => part.kind === 'tool' && part.id === toolCallId)) {
					session.storedTurns[index] = { ...stored, parts: stored.parts.map(part => part.kind === 'tool' && part.id === toolCallId
						? { ...part, worker, workspace: workspaceFromWorker(worker), ...(status ? { failed: status !== 'completed' } : {}) } : part) };
				}
			}
			if (status) {
				const children = session.storedSubagentTurns.get(toolCallId);
				if (children) {
					session.storedSubagentTurns.set(toolCallId, children.map(turn => ({ ...turn, failed: status !== 'completed',
						...(worker.error || worker.persistenceError ? { error: { errorType: 'BackboardSubagentFailed', message: worker.error ?? worker.persistenceError! } } : {}) })));
				}
			}
			session.modifiedAt = Date.now();
			this._writeStore();
		}
		return true;
	}

	/** Batch handles are independent detached children, never a completion of the batch launcher. */
	private _startBatchWorkerRow(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, worker: CliTsWorkerState): void {
		const input = { prompt: worker.prompt, name: worker.name };
		turn.toolInputs.set(toolCallId, { name: 'AgentSpawn', input });
		turn.startedToolCalls.add(toolCallId);
		turn.storedParts.push({ kind: 'tool', id: toolCallId, name: 'AgentSpawn', inputSummary: worker.prompt, agentName: worker.name, worker });
		const metadata = cliTsToolMetadata('AgentSpawn', input);
		this._fire(session.sessionUri, { type: ActionType.ChatToolCallStart, turnId: turn.turnId, toolCallId, toolName: 'AgentSpawn', displayName: worker.name ?? localize('cliTsAgent.subagentName', "Subagent"), _meta: metadata });
		this._fire(session.sessionUri, { type: ActionType.ChatToolCallReady, turnId: turn.turnId, toolCallId, invocationMessage: worker.name ?? localize('cliTsAgent.subagentName', "Subagent"), toolInput: JSON.stringify(input), confirmed: ToolCallConfirmationReason.NotNeeded, _meta: metadata });
		(turn.deferredSubagentCompletions ??= new Map()).set(toolCallId, (status: CliTsSubagentCompletionStatus) => {
			const current = turn.workerStates?.get(toolCallId) ?? worker;
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallComplete, turnId: turn.turnId, toolCallId,
				_meta: { ...metadata, ...workerWorkspaceMetadata(workspaceFromWorker(current)), subagentRevision: current.revision },
				result: { success: status === 'completed', pastTenseMessage: localize('cliTsAgent.workerEnded', "Worker task ended"), ...(status !== 'completed' ? { error: { message: current.error ?? current.persistenceError ?? localize('cliTsAgent.workerFailed', "The worker failed to finish or integrate its changes.") } } : {}), content: [{ type: ToolResultContentType.Subagent, resource: buildSubagentSessionUri(session.sessionUri.toString(), toolCallId), title: current.name ?? localize('cliTsAgent.subagentName', "Subagent"), agentName: current.name ?? 'worker' }] },
			});
		});
	}

	private _updateSubagentWorkspace(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, workspace: CliTsWorkerWorkspace, authoritative = false): CliTsWorkerWorkspace {
		const previous = turn.workerWorkspaces?.get(toolCallId);
		if (!authoritative && previous && (previous.workerId !== workspace.workerId
			|| (previous.revision !== undefined && (workspace.revision === undefined || workspace.revision <= previous.revision)))) {
			return previous;
		}
		// Terminal cleanup intentionally stops publishing the private worktree path.
		// Retain it only in durable hidden metadata so raw child-archive edits can
		// still be projected onto coordinator paths after restart.
		const mergedWorkspace: CliTsWorkerWorkspace = {
			...previous,
			...workspace,
			...(workspace.worktreePath || !previous?.worktreePath ? {} : { worktreePath: previous.worktreePath }),
		};
		turn.workerWorkspaces.set(toolCallId, mergedWorkspace);
		const storedPartIndex = turn.storedParts.findIndex(part => part.kind === 'tool' && part.id === toolCallId);
		if (storedPartIndex >= 0) {
			const storedPart = turn.storedParts[storedPartIndex];
			if (storedPart?.kind === 'tool') {
				const worker = turn.workerStates?.get(toolCallId);
				const terminal = worker ? cliTsWorkerCompletionStatus(worker) : undefined;
				turn.storedParts[storedPartIndex] = { ...storedPart, workspace: mergedWorkspace, ...(worker ? { worker } : {}), ...(terminal ? { failed: terminal !== 'completed' } : {}) };
			}
		}
		let states = this._workerProjectionStates.get(turn);
		if (!states) {
			states = new Map();
			this._workerProjectionStates.set(turn, states);
		}
		let state = states.get(toolCallId);
		if (!state) {
			state = { lastEmittedAt: 0, workspace: mergedWorkspace };
			states.set(toolCallId, state);
		} else {
			state.workspace = mergedWorkspace;
		}

		const terminal = mergedWorkspace.status !== 'Queued' && mergedWorkspace.status !== 'Running' && mergedWorkspace.status !== 'Integrating';
		const elapsed = Date.now() - state.lastEmittedAt;
		if (terminal || state.lastEmittedAt === 0 || elapsed >= subagentUiProjectionIntervalMs) {
			if (state.timer) {
				clearTimeout(state.timer);
				state.timer = undefined;
			}
			this._emitSubagentWorkspace(session, turn, toolCallId, state);
		} else if (!state.timer) {
			state.timer = setTimeout(() => {
				state!.timer = undefined;
				this._emitSubagentWorkspace(session, turn, toolCallId, state!);
			}, subagentUiProjectionIntervalMs - elapsed);
		}
		if (terminal && session.turn !== turn) {
			// Terminal status is an important detached lifecycle boundary. Persist
			// the owning historical response even if child_end is delayed or lost.
			session.modifiedAt = Date.now();
			this._writeStore();
		}
		return mergedWorkspace;
	}

	private _emitSubagentWorkspace(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, state: CliTsWorkerProjectionState): void {
		const projectionStartedAt = performance.now();
		state.lastEmittedAt = Date.now();
		const workspace = state.workspace;
		const lines = turn.childToolLines.get(toolCallId);
		const activity = lines ? [...lines.values()] : [];
		activity.unshift(workerWorkspaceStatusLine(workspace));
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallContentChanged,
			turnId: turn.turnId,
			toolCallId,
			content: [{ type: ToolResultContentType.Text, text: activity.join('\n') }],
			_meta: {
				...cliTsToolMetadata('Agent', turn.toolInputs.get(toolCallId)?.input),
				...workerWorkspaceMetadata(workspace),
				...(turn.workerStates?.get(toolCallId) ? { subagentRevision: turn.workerStates.get(toolCallId)!.revision } : {}),
			},
		});
		this._logService.trace(`[performance:timing] ${JSON.stringify({ phase: 'ui_event_projection', durationMs: Math.max(0, performance.now() - projectionStartedAt), toolCallId, workerId: workspace.workerId })}`);
	}

	private _handleMappedAgentEvent(session: CliTsSession, event: CliTsAgentEvent, turn: CliTsTurnState, parentToolCallId?: string): void {
		// Older in-memory turn shapes predate native tool UI data.
		const toolUiByCall = (turn as { readonly toolUi?: Map<string, CliTsToolUiState> }).toolUi;
		if (event.toolCallId) {
			const toolUi = cliTsToolUiState(event.toolUi);
			if (toolUi && toolUiByCall) {
				toolUiByCall.set(event.toolCallId, mergeCliTsToolUiState(toolUiByCall.get(event.toolCallId), toolUi));
			}
		}
		const eventToolName = event.name ?? (event.toolCallId ? turn.toolInputs.get(event.toolCallId)?.name : undefined);
		if (isCliTsToolLifecycleEvent(event.type) && isHiddenCliTsTool(eventToolName)) {
			return;
		}
		const turnId = turn.turnId;
		const fire = (action: SessionAction | ChatAction): void => this._fire(session.sessionUri, action, parentToolCallId);
		switch (event.type) {
			case 'agent:parallel_status':
				if (typeof event.count === 'number' && event.count >= 2) {
					this._fireStatus(session, turn, localize('cliTsAgent.parallelWorkers', "Running {0} workers in parallel", event.count), parentToolCallId);
				}
				return;
			case 'session:created':
				if (event.threadId) {
					session.threadId = event.threadId;
					session.forkContext = undefined;
				}
				return;
			case 'turn:status': {
				// Truthful backend pipeline phase for the silent send→first-token
				// gap. "preparing" = server assembling the run; "generating" =
				// model engaged, first token imminent. Superseded automatically
				// once real content streams.
				const label = event.phase === 'generating'
					? localize('cliTsAgent.status.generating', "Working…")
					: localize('cliTsAgent.status.preparing', "Preparing…");
				this._fireStatus(session, turn, label, parentToolCallId);
				return;
			}
			case 'assistant:delta': {
				if (!event.text || !event.messageId) {
					return;
				}
				const partId = this._ensureMarkdownPart(session, turn, event.messageId, parentToolCallId);
				turn.streamedText.set(event.messageId, (turn.streamedText.get(event.messageId) ?? '') + event.text);
				turn.responseText += event.text;
				const storedDelta = turn.storedTextParts.get(partId);
				if (storedDelta) {
					storedDelta.content += event.text;
				}
				fire({ type: ActionType.ChatDelta, turnId, partId, content: event.text });
				return;
			}
			case 'assistant:message': {
				if (!event.messageId || event.text === undefined) {
					return;
				}
				const streamed = turn.streamedText.get(event.messageId) ?? '';
				if (event.text === streamed) {
					return;
				}
				const partId = this._ensureMarkdownPart(session, turn, event.messageId, parentToolCallId);
				const remainder = event.text.startsWith(streamed) ? event.text.slice(streamed.length) : event.text;
				if (remainder) {
					turn.streamedText.set(event.messageId, streamed + remainder);
					turn.responseText += remainder;
					const storedRemainder = turn.storedTextParts.get(partId);
					if (storedRemainder) {
						storedRemainder.content += remainder;
					}
					fire({ type: ActionType.ChatDelta, turnId, partId, content: remainder });
				}
				return;
			}
			case 'assistant:reasoning': {
				if (!event.text) {
					return;
				}
				if (!turn.reasoningPartId) {
					turn.reasoningPartId = generateUuid();
					turn.didCreateReasoningPart = true;
					const storedReasoning: CliTsStoredPart = { kind: 'reasoning', content: '' };
					turn.storedParts.push(storedReasoning);
					turn.storedTextParts.set(turn.reasoningPartId, storedReasoning);
					fire({
						type: ActionType.ChatResponsePart,
						turnId,
						part: { kind: ResponsePartKind.Reasoning, id: turn.reasoningPartId, content: '' },
					});
				}
				turn.reasoningText += event.text;
				const storedReasoningPart = turn.storedTextParts.get(turn.reasoningPartId);
				if (storedReasoningPart) {
					storedReasoningPart.content += event.text;
				}
				fire({
					type: ActionType.ChatReasoning,
					turnId,
					partId: turn.reasoningPartId,
					content: event.text,
				});
				return;
			}
			case 'tool:requested':
				// A tool round ends the current thinking block; the next
				// reasoning burst starts a fresh part so the UI shows distinct
				// think → act → think steps instead of one merged block.
				turn.reasoningPartId = undefined;
				// Capture structured inputs so file-edit completions can attach
				// diffs and edit-survival telemetry. Per-call events follow.
				const calls = event.calls ?? [];
				const mutationCalls = calls.filter(call => isCliTsMutationTool(call.name));
				if (mutationCalls.length > 0) {
					const provisionalBatch = mutationCalls
						.map(call => cliTsMutationBatches(turn).get(call.id))
						.find((batch): batch is CliTsMutationBatch => !!batch)
						?? turn.pendingMutationBatch;
					const mutationBatch: CliTsMutationBatch = {
						id: provisionalBatch?.id ?? `${turn.turnId}:mutation:${mutationCalls[0].id}`,
						expectedFileCount: cliTsMutationFileCount(mutationCalls),
					};
					for (const call of mutationCalls) {
						cliTsMutationBatches(turn).set(call.id, mutationBatch);
					}
				}
				turn.pendingMutationBatch = undefined;
				for (const call of calls) {
					turn.toolInputs.set(call.id, { name: call.name, input: call.input });
				}
				return;
			case 'tool:discarded':
			case 'tool:retracted': {
				if (!event.toolCallId || !turn.startedToolCalls.has(event.toolCallId)) {
					return;
				}
				const name = event.name ?? turn.toolInputs.get(event.toolCallId)?.name ?? 'Tool';
				// Backboard's early tool events are advisory. If the final
				// tool_submit_required frame omits one, close its speculative card
				// instead of leaving a permanent spinner behind.
				fire({
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.toolCallId,
					invocationMessage: toolDisplayName(name),
					toolInput: '',
					_meta: cliTsToolMetadata(name, turn.toolInputs.get(event.toolCallId)?.input, toolUiByCall?.get(event.toolCallId)?.kind, cliTsMutationBatches(turn).get(event.toolCallId)),
				});
				fire({
					type: ActionType.ChatToolCallConfirmed,
					turnId,
					toolCallId: event.toolCallId,
					approved: false,
					reason: ToolCallCancellationReason.Skipped,
					reasonMessage: localize('cliTsAgent.toolDiscarded', "The model did not include this advisory call in its final tool request."),
				});
				return;
			}
			case 'tool:pending': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				if (!turn.toolInputs.has(event.toolCallId)) {
					turn.toolInputs.set(event.toolCallId, { name: event.name, input: undefined });
				}
				// Write-capable Agent calls cannot start until the provider finalizes the
				// whole tool batch. Do not render an actionable/running worker row from
				// the speculative streamed name; tool:start is the authoritative launch.
				if (isCliTsSubagentLauncherTool(event.name)) {
					return;
				}
				// A large Write payload can spend a long time streaming before the
				// provider emits tool:requested. Give every advisory mutation in that
				// response one provisional batch now so the UI can mount exactly one
				// aggregate loading shell during input generation. tool:requested keeps
				// the id and replaces the provisional count with the authoritative one.
				if (isCliTsMutationTool(event.name) && !cliTsMutationBatches(turn).has(event.toolCallId)) {
					const mutationBatch = turn.pendingMutationBatch ??= {
						id: `${turn.turnId}:mutation:${event.toolCallId}`,
						expectedFileCount: 1,
					};
					cliTsMutationBatches(turn).set(event.toolCallId, mutationBatch);
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary, parentToolCallId);
				return;
			}
			case 'tool:start': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				if (isCliTsSubagentLauncherTool(event.name)) {
					this._ensureSubagentTurn(session, turn, event.toolCallId, subagentPrompt(turn, event.toolCallId, event.inputSummary));
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary, parentToolCallId);
				if (!parentToolCallId && session.clientTools?.tools.some(tool => tool.name === event.name)) {
					// Client tools: the summary here is display-clamped, but the
					// workbench parses `toolInput` as the real parameters. Leave
					// the call streaming; the authoritative Ready (with the full
					// JSON input) follows on `client_tool:call`.
					return;
				}
				fire({
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.toolCallId,
					invocationMessage: toolInvocationMessage(event.name, event.inputSummary),
					toolInput: cliTsReadyToolInput(
						event.inputSummary,
						toolUiByCall?.get(event.toolCallId),
						isCliTsTerminalTool(event.name) ? cliTsTerminalCommand(turn.toolInputs.get(event.toolCallId)?.input) : undefined,
					),
					confirmed: turn.confirmedToolCalls.has(event.toolCallId) ? ToolCallConfirmationReason.UserAction : ToolCallConfirmationReason.NotNeeded,
					_meta: cliTsToolMetadata(event.name, turn.toolInputs.get(event.toolCallId)?.input, toolUiByCall?.get(event.toolCallId)?.kind, cliTsMutationBatches(turn).get(event.toolCallId)),
				});
				return;
			}
			case 'client_tool:call': {
				// The serve process parked a client-tool execution and waits for
				// the IDE to run it. Surface the call with its full JSON input so
				// the workbench's client-tool path invokes the real tool and
				// dispatches ChatToolCallComplete (routed back via
				// onClientToolCallComplete → the clientToolResult op).
				if (!event.toolCallId || !event.name) {
					return;
				}
				const clientTools = session.clientTools;
				if (!clientTools || parentToolCallId) {
					// Not executable here: no registered client, or a sub-agent
					// call (only the root session holds the active-client slot).
					// Answer immediately so the serve process does not park.
					session.proc?.notify({ op: 'clientToolResult', id: event.toolCallId, error: 'No connected IDE client can execute this tool right now.' });
					return;
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, undefined, parentToolCallId);
				session.pendingClientToolCalls.add(event.toolCallId);
				fire({
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.toolCallId,
					invocationMessage: toolInvocationMessage(event.name, undefined),
					toolInput: JSON.stringify(event.input ?? {}),
					confirmed: ToolCallConfirmationReason.NotNeeded,
					_meta: {
						...cliTsToolMetadata(event.name, event.input, undefined, cliTsMutationBatches(turn).get(event.toolCallId)),
						...(session.turnAutoApproves ? { autoApproveBySetting: true } : {}),
					},
				});
				return;
			}
			case 'tool:progress': {
				if (!event.toolCallId || event.data === undefined) {
					return;
				}
				const terminalChunk = cliTsTerminalProgressText(event.data);
				const text = terminalChunk === undefined
					? typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
					: `${turn.terminalOutputs.get(event.toolCallId) ?? ''}${terminalChunk}`;
				if (terminalChunk !== undefined) {
					turn.terminalOutputs.set(event.toolCallId, text);
				}
				fire({
					type: ActionType.ChatToolCallContentChanged,
					turnId,
					toolCallId: event.toolCallId,
					content: [{ type: ToolResultContentType.Text, text }],
				});
				return;
			}
			case 'agent:child_tool_start':
			case 'agent:child_tool_result': {
				// Sub-agent nesting: stream compact child-tool activity into the
				// parent `Agent` tool call's live content.
				const parentId = event.agentToolCallId;
				if (!parentId) {
					return;
				}
				const child = this._ensureSubagentTurn(session, turn, parentId, subagentPrompt(turn, parentId));
				if (event.type === 'agent:child_tool_start' && event.call) {
					child.turn.toolInputs.set(event.call.id, { name: event.call.name, input: event.call.inputSummary });
					this._handleMappedAgentEvent(session, {
						type: 'tool:start',
						toolCallId: event.call.id,
						name: event.call.name,
						inputSummary: event.call.inputSummary,
					}, child.turn, parentId);
				} else if (event.type === 'agent:child_tool_result' && event.childToolCallId) {
					const childToolName = event.name ?? child.turn.toolInputs.get(event.childToolCallId)?.name;
					if (childToolName) {
						this._handleMappedAgentEvent(session, {
							type: event.status === 'error' ? 'tool:error' : 'tool:result',
							toolCallId: event.childToolCallId,
							name: childToolName,
							title: event.title,
							detail: event.detail,
							fileEdits: event.fileEdits,
							error: event.error,
						}, child.turn, parentId);
					}
				}
				let lines = turn.childToolLines.get(parentId);
				if (!lines) {
					lines = new Map();
					turn.childToolLines.set(parentId, lines);
				}
				if (event.type === 'agent:child_tool_start' && event.call) {
					lines.set(event.call.id, `↳ ${toolDisplayName(event.call.name)} ${event.call.inputSummary} — running`);
				} else if (event.type === 'agent:child_tool_result' && event.childToolCallId) {
					const existing = lines.get(event.childToolCallId);
					if (existing) {
						lines.set(event.childToolCallId, existing.replace(/ — (running|done|error)$/, ` — ${event.status === 'error' ? 'error' : 'done'}`));
					}
				}
				fire({
					type: ActionType.ChatToolCallContentChanged,
					turnId,
					toolCallId: parentId,
					content: [{ type: ToolResultContentType.Text, text: [...lines.values()].join('\n') }],
				});
				return;
			}
			case 'todos:updated':
				// The TodoWrite tool's own tool:result already renders the list in
				// its tool part; a separate response part per update would only
				// append duplicates (parts are append-only). Intentionally ignored.
				return;
			case 'tool:result': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				const toolCallId = event.toolCallId;
				const name = event.name;
				const failed = cliTsToolExecutionFailed(event);
				const detachedSubagent = isCliTsDetachedSubagentTool(name);
				const child = isCliTsSubagentLauncherTool(name)
					? this._ensureSubagentTurn(session, turn, toolCallId, subagentPrompt(turn, toolCallId, event.inputSummary))
					: turn.subagentTurns.get(toolCallId);
				if (child && !detachedSubagent && event.detail?.trim()) {
					this._handleMappedAgentEvent(session, {
						type: 'assistant:message',
						messageId: `${toolCallId}-result`,
						text: event.detail,
					}, child.turn, toolCallId);
				}
				if (child && (!detachedSubagent || failed)) {
					this._completeSubagentTurn(session, turn, toolCallId, failed ? 'failed' : 'completed');
				}
				this._ensureToolCallStart(session, turn, toolCallId, name, event.inputSummary, parentToolCallId);
				turn.toolSummaries.push(`${toolDisplayName(name)}${event.title ? ` — ${event.title}` : ''}`);
				const inputSummary = event.inputSummary ?? turn.toolInputSummaries.get(toolCallId);
				const workspace = turn.workerWorkspaces?.get(toolCallId);
				const toolUi = toolUiByCall?.get(toolCallId);
				const terminalCommand = isCliTsTerminalTool(name)
					? cliTsTerminalCommand(turn.toolInputs.get(toolCallId)?.input)
					: undefined;
				const terminalOutput = isCliTsTerminalTool(name)
					? event.terminalOutput ?? terminalOutputFromProgress(turn.terminalOutputs.get(toolCallId))
					: undefined;
				const storedToolPart: Extract<CliTsStoredPart, { kind: 'tool' }> = {
					kind: 'tool',
					input: turn.toolInputs.get(toolCallId)?.input,
					result: event.detail ?? event.title,
					...(failed ? { failed: true } : {}),
					id: toolCallId,
					name,
					...(inputSummary ? { inputSummary } : {}),
					...(terminalCommand !== undefined ? { terminalCommand } : {}),
					...(event.title ? { title: event.title } : {}),
					...((isCliTsTerminalTool(name) || (isCliTsSubagentLauncherTool(name) && !detachedSubagent)) && event.detail ? { detail: event.detail } : {}),
					...(terminalOutput ? { terminalOutput } : {}),
					...(toolUi ? { toolUi } : {}),
					...(cliTsMutationBatches(turn).get(toolCallId) ? { mutationBatch: cliTsMutationBatches(turn).get(toolCallId) } : {}),
					...(workspace ? { workspace } : {}),
					...(turn.workerStates?.get(toolCallId) ? { worker: turn.workerStates.get(toolCallId) } : {}),
					...(subagentDisplayName(turn, toolCallId) ? { agentName: subagentDisplayName(turn, toolCallId) } : {}),
				};
				turn.storedParts.push(storedToolPart);
				const text = terminalOutput?.text ?? cliTsToolResultText(name, event.title, event.detail, inputSummary);
				const owningWorkspace = parentToolCallId
					? this._resolveSubagentOwner(session, parentToolCallId)?.workerWorkspaces?.get(parentToolCallId)
					: undefined;
				const fileEdits = cliTsWorkerEditsAreIntegrated(owningWorkspace) && Array.isArray(event.fileEdits) ? event.fileEdits : [];
				const completion = (async (): Promise<void> => {
					const content: ToolResultContent[] = text ? [{ type: ToolResultContentType.Text, text }] : [];
					if (child) {
						content.unshift({
							type: ToolResultContentType.Subagent,
							resource: buildSubagentSessionUri(session.sessionUri.toString(), toolCallId),
							title: child.name ?? localize('cliTsAgent.subagentName', "Subagent"),
							agentName: child.name ?? 'worker',
							description: firstPromptLine(child.prompt),
						});
					}
					if (fileEdits.length) {
						const edits = await this._buildFileEditContents(session, turn, toolCallId, name, fileEdits);
						storedToolPart.fileEdits = edits.filter((edit): edit is ToolResultFileEditContent => edit.type === ToolResultContentType.FileEdit);
						content.push(...edits);
					}
					const complete = (status?: CliTsSubagentCompletionStatus): void => fire({
						type: ActionType.ChatToolCallComplete,
						turnId,
						toolCallId,
						_meta: {
							...cliTsToolCompletionMetadata(name, terminalOutput, toolUi?.kind, cliTsMutationBatches(turn).get(toolCallId)),
							...(child ? cliTsToolMetadata(name, turn.toolInputs.get(toolCallId)?.input) : {}),
							...(turn.workerWorkspaces?.get(toolCallId) ? workerWorkspaceMetadata(turn.workerWorkspaces.get(toolCallId)!) : {}),
							...(turn.workerStates?.get(toolCallId) ? { subagentRevision: turn.workerStates.get(toolCallId)!.revision } : {}),
						},
						result: {
							success: !failed && (!status || status === 'completed'),
							...((failed || (status && status !== 'completed')) ? { error: { message: status === 'cancelled' ? localize('cliTsAgent.workerCancelled', "The worker was cancelled.") : status === 'failed' ? localize('cliTsAgent.workerFailed', "The worker failed to finish or integrate its changes.") : event.title ?? localize('cliTsAgent.toolFailedNoDetail', "The tool call failed.") } } : {}),
							pastTenseMessage: event.title ?? localize('cliTsAgent.toolFinished', "{0} finished", toolDisplayName(name)),
							content: content.length ? content : undefined,
							...(toolUi?.result ? { structuredContent: { backboardTool: toolUi.result } } : {}),
						},
					});
					if (detachedSubagent && !failed && !session.completedSubagentToolCallIds?.has(toolCallId)) {
						(turn.deferredSubagentCompletions ??= new Map()).set(toolCallId, complete);
						fire({ type: ActionType.ChatToolCallContentChanged, turnId, toolCallId, content });
					} else {
						complete(turn.workerStates?.get(toolCallId) ? cliTsWorkerCompletionStatus(turn.workerStates.get(toolCallId)!) : undefined);
					}
				})();
				turn.pendingCompletions.push(completion);
				return;
			}
			case 'tool:error': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				const child = isCliTsSubagentLauncherTool(event.name)
					? this._ensureSubagentTurn(session, turn, event.toolCallId, subagentPrompt(turn, event.toolCallId, event.inputSummary))
					: turn.subagentTurns.get(event.toolCallId);
				if (child) {
					this._completeSubagentTurn(session, turn, event.toolCallId, 'failed');
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary, parentToolCallId);
				const inputSummary = event.inputSummary ?? turn.toolInputSummaries.get(event.toolCallId);
				const workspace = turn.workerWorkspaces?.get(event.toolCallId);
				const toolUi = toolUiByCall?.get(event.toolCallId);
				const terminalCommand = isCliTsTerminalTool(event.name)
					? cliTsTerminalCommand(turn.toolInputs.get(event.toolCallId)?.input)
					: undefined;
				turn.storedParts.push({
					kind: 'tool',
					id: event.toolCallId,
					name: event.name,
					failed: true,
					...(inputSummary ? { inputSummary } : {}),
					...(terminalCommand !== undefined ? { terminalCommand } : {}),
					...(event.error ? { title: event.error.slice(0, 200) } : {}),
					...(toolUi ? { toolUi } : {}),
					...(cliTsMutationBatches(turn).get(event.toolCallId) ? { mutationBatch: cliTsMutationBatches(turn).get(event.toolCallId) } : {}),
					...(workspace ? { workspace } : {}),
				});
				const message = event.error ?? localize('cliTsAgent.toolFailedNoDetail', "The tool call failed.");
				fire({
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: event.toolCallId,
					_meta: cliTsToolMetadata(event.name, turn.toolInputs.get(event.toolCallId)?.input, toolUi?.kind, cliTsMutationBatches(turn).get(event.toolCallId)),
					result: {
						success: false,
						pastTenseMessage: localize('cliTsAgent.toolFailed', "{0} failed", toolDisplayName(event.name)),
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				return;
			}
			case 'input:request': {
				const request = event.request;
				if (!request?.id) {
					return;
				}
				const specs = request.questions?.length
					? request.questions
					: request.question
						? [{ question: request.question, options: request.options ?? [] }]
						: [];
				if (!specs.length) {
					return;
				}
				const questions: ChatInputQuestion[] = specs.map((spec, index) => {
					const id = `answer-${index}`;
					return spec.options.length
						? {
							id,
							title: spec.header,
							kind: ChatInputQuestionKind.SingleSelect,
							message: spec.question,
							required: true,
							options: spec.options.map(option => ({ id: option, label: option })),
							allowFreeformInput: true,
						}
						: {
							id,
							title: spec.header,
							kind: ChatInputQuestionKind.Text,
							message: spec.question,
							required: true,
						};
				});
				session.pendingInputs.set(request.id, questions.map(question => question.id));
				fire({
					type: ActionType.ChatInputRequested,
					request: { id: request.id, message: specs[0]?.question ?? '', questions },
				});
				return;
			}
			case 'usage': {
				const usage = event.usage;
				if (!usage) {
					return;
				}
				// Backboard's `context_usage` measurement rides the open `_meta`
				// bag (the protocol dir is generated and must not grow fields):
				// `contextTokens` is the thread's measured occupancy — a level
				// with the turn's output included — and `contextLimit` is the
				// window the server applied.
				const meta: Record<string, unknown> = {};
				if (usage.backboardContextUsage?.source === 'backboard-api') {
					meta.backboardContextUsage = usage.backboardContextUsage;
				}
				if (typeof usage.contextTokens === 'number' && Number.isFinite(usage.contextTokens) && usage.contextTokens >= 0) {
					meta.contextTokens = usage.contextTokens;
				}
				if (typeof usage.contextLimit === 'number' && usage.contextLimit > 0) {
					meta.contextLimit = usage.contextLimit;
				}
				turn.usage = {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					model: usage.model,
					...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
				};
				fire({ type: ActionType.ChatUsage, turnId, usage: turn.usage });
				return;
			}
			case 'system:warning': {
				if (!event.message || turn.lastProgressMessage === event.message) {
					return;
				}
				turn.lastProgressMessage = event.message;
				this._logService.info(`[cli-ts progress] ${event.message}`);
				if (turn.didCreateStatusPart) {
					return;
				}
				turn.didCreateStatusPart = true;
				fire({
					type: ActionType.ChatResponsePart,
					turnId,
					part: { kind: ResponsePartKind.SystemNotification, content: localize('cliTsAgent.warning', "Backboard: {0}", event.message) },
				});
				return;
			}
			case 'run:error': {
				turn.failed = true;
				turn.error = { errorType: 'BackboardError', message: event.error?.trim() ? event.error : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
				fire({
					type: ActionType.ChatError,
					turnId,
					error: turn.error,
				});
				return;
			}
			default:
				return;
		}
	}

	private _ensureMarkdownPart(session: CliTsSession, turn: CliTsTurnState, messageId: string, parentToolCallId?: string): string {
		const existing = turn.messageParts.get(messageId);
		if (existing) {
			return existing;
		}
		const partId = generateUuid();
		turn.messageParts.set(messageId, partId);
		const stored: CliTsStoredPart = { kind: 'markdown', content: '' };
		turn.storedParts.push(stored);
		turn.storedTextParts.set(partId, stored);
		this._fire(session.sessionUri, {
			type: ActionType.ChatResponsePart,
			turnId: turn.turnId,
			part: { kind: ResponsePartKind.Markdown, id: partId, content: '' },
		}, parentToolCallId);
		return partId;
	}

	private _ensureToolCallStart(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, toolName: string, inputSummary?: string, parentToolCallId?: string): void {
		if (isHiddenCliTsTool(toolName)) {
			return;
		}
		if (inputSummary && inputSummary !== 'Generating input…') {
			turn.toolInputSummaries.set(toolCallId, inputSummary);
		}
		if (turn.startedToolCalls.has(toolCallId)) {
			return;
		}
		turn.startedToolCalls.add(toolCallId);
		// A tool the active IDE client contributed must be stamped with its
		// contributor on the very first action: the workbench decides between
		// executing the call itself and merely rendering it from this state.
		const clientTools = session.clientTools;
		const isClientTool = !parentToolCallId && !!clientTools?.tools.some(tool => tool.name === toolName);
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallStart,
			turnId: turn.turnId,
			toolCallId,
			toolName,
			displayName: toolDisplayName(toolName),
			...(isClientTool && clientTools ? { contributor: { kind: ToolCallContributorKind.Client, clientId: clientTools.clientId } } : {}),
			_meta: cliTsToolMetadata(toolName, turn.toolInputs.get(toolCallId)?.input, (turn as { readonly toolUi?: Map<string, CliTsToolUiState> }).toolUi?.get(toolCallId)?.kind, cliTsMutationBatches(turn).get(toolCallId)),
		}, parentToolCallId);
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallDelta,
			turnId: turn.turnId,
			toolCallId,
			content: inputSummary ?? '',
			invocationMessage: inputSummary === 'Generating input…'
				? localize('cliTsAgent.toolGeneratingInput', "Generating {0} input…", toolDisplayName(toolName))
				: toolInvocationMessage(toolName, inputSummary),
		}, parentToolCallId);
	}

	/**
	 * Persists cli-ts's before/after file content and returns the resulting
	 * {@link ToolResultFileEditContent} items so the completion carries inline
	 * diffs (rendered as edit pills). Best-effort: a tracker/DB failure yields
	 * no diff content but never fails the turn.
	 */
	private async _buildFileEditContents(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, toolName: string, fileEdits: readonly { path: string; before: string; after: string }[]): Promise<ToolResultContent[]> {
		const tracker = this._fileEditTracker(session);
		if (!tracker) {
			return [];
		}
		const toolInput = turn.toolInputs.get(toolCallId)?.input;
		const modelId = session.model?.id;
		const contents: ToolResultContent[] = [];
		for (const edit of fileEdits) {
			try {
				const content = await tracker.recordExplicitEdit(turn.turnId, toolCallId, edit.path, edit.before, edit.after, toolName, toolInput, modelId);
				if (content) {
					contents.push(content);
				}
			} catch (error) {
				this._logService.warn(`[cli-ts] Failed to record file edit for ${edit.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return contents;
	}

	// ---- persistence ----------------------------------------------------------

	private _storePath(): string {
		return path.join(os.homedir(), '.backboard_ide', 'cli-ts-sessions.json');
	}

	/** Reopen reconciles the durable task manager, never the independent backend revision. */
	private async _readRuntimeWorkerStates(sessionId: string): Promise<ReadonlyMap<string, CliTsWorkerState>> {
		const workers = new Map([...this._runtimeWorkerStateCache.values()].filter(worker => worker.sessionId === sessionId).map(worker => [worker.handle, worker]));
		if (!isSafeRuntimePathSegment(sessionId)) {
			return workers;
		}
		let file: fs.promises.FileHandle | undefined;
		try {
			file = await fs.promises.open(path.join(this._runtimeSessionsRoot(), sessionId, 'agent-tasks.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
				throw new Error('Worker task history exceeds the restore limit.');
			}
			const bytes = Buffer.alloc(stat.size);
			let offset = 0;
			while (offset < bytes.length) {
				const read = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!read.bytesRead) {
					throw new Error('Worker task history ended early.');
				}
				offset += read.bytesRead;
			}
			const parsed = JSON.parse(bytes.toString('utf8')) as { version?: number; tasks?: readonly Partial<CliTsWorkerState>[] };
			if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.length > 10000) {
				throw new Error('Invalid worker task history.');
			}
			for (const task of parsed.tasks) {
				if (!task || task.sessionId !== sessionId || typeof task.handle !== 'string' || !isSafeRuntimePathSegment(task.handle)
					|| typeof task.revision !== 'number' || !Number.isSafeInteger(task.revision) || task.revision < 1
					|| typeof task.prompt !== 'string' || typeof task.createdAt !== 'string' || typeof task.readOnly !== 'boolean'
					|| !task.status || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
					|| !task.executionStatus || !['queued', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.executionStatus)
					|| !task.integrationStatus || !['not_required', 'pending', 'integrating', 'integrated', 'conflict', 'skipped'].includes(task.integrationStatus)) {
					continue;
				}
				const worker: CliTsWorkerState = { handle: task.handle, sessionId, revision: task.revision, prompt: task.prompt, createdAt: task.createdAt,
					readOnly: task.readOnly, status: task.status, executionStatus: task.executionStatus, integrationStatus: task.integrationStatus,
					...(typeof task.turnId === 'string' ? { turnId: task.turnId } : {}),
					...(typeof task.parentBatchToolCallId === 'string' ? { parentBatchToolCallId: task.parentBatchToolCallId } : {}),
					...(typeof task.name === 'string' ? { name: task.name } : {}),
					...(typeof task.startedAt === 'string' ? { startedAt: task.startedAt } : {}),
					...(typeof task.finishedAt === 'string' ? { finishedAt: task.finishedAt } : {}),
					...(typeof task.error === 'string' ? { error: task.error } : {}),
					...(typeof task.persistenceError === 'string' ? { persistenceError: task.persistenceError } : {}),
					...(task.workspace && typeof task.workspace.workerId === 'string' ? { workspace: task.workspace } : {}),
				};
				if (!workers.has(worker.handle) || workers.get(worker.handle)!.revision < worker.revision) {
					workers.set(worker.handle, worker);
					this._runtimeWorkerStateCache.set(`${sessionId}\0${worker.handle}`, worker);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this._logService.trace(`[cli-ts] Worker task history unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			await file?.close();
		}
		return workers;
	}

	private _readRuntimeSubagentRecovery(sessionId: string, toolCallId: string): Promise<CliTsRuntimeSubagentRecovery | undefined> {
		const cacheKey = `${sessionId}\0${toolCallId}`;
		let cached = this._runtimeSubagentTurnCache.get(cacheKey);
		if (!cached) {
			cached = this._findAndReadRuntimeSubagentRecovery(sessionId, toolCallId);
			this._runtimeSubagentTurnCache.set(cacheKey, cached);
			void cached.then(result => {
				// A fallback parent completion can race the runtime's final archive
				// flush. Do not permanently cache that transient miss.
				if (!result) {
					this._runtimeSubagentTurnCache.delete(cacheKey);
				}
			}, () => this._runtimeSubagentTurnCache.delete(cacheKey));
		}
		return cached;
	}

	private async _findAndReadRuntimeSubagentRecovery(sessionId: string, toolCallId: string): Promise<CliTsRuntimeSubagentRecovery | undefined> {
		// Both ids become path segments; reject separators and traversal before
		// touching the runtime archive. Runtime sessions are created with this same
		// stable IDE session id, so direct lookup avoids cross-session first-match
		// recovery when providers reuse ids such as `call_1`.
		if (!isSafeRuntimePathSegment(sessionId) || !isSafeRuntimePathSegment(toolCallId)) {
			return undefined;
		}
		const sessionsRoot = this._runtimeSessionsRoot();
		const agentDirectory = path.join(sessionsRoot, sessionId, 'agents', toolCallId);
		try {
			return await this._readRuntimeSubagentRecoveryFromDirectory(agentDirectory, { sessionId, toolCallId });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this._logService.warn(`[cli-ts] Failed to recover subagent ${toolCallId} for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return undefined;
	}

	private _runtimeSessionsRoot(): string {
		return path.join(os.homedir(), '.backboard_ide', 'cli-ts-sessions', '.backboard', 'sessions');
	}

	private async _readRuntimeSubagentRecoveryFromDirectory(agentDirectory: string, expected?: { readonly sessionId: string; readonly toolCallId: string }): Promise<CliTsRuntimeSubagentRecovery | undefined> {
		const [metaRaw, eventsRaw, workerMetadata] = await Promise.all([
			fs.promises.readFile(path.join(agentDirectory, 'meta.json'), 'utf8'),
			fs.promises.readFile(path.join(agentDirectory, 'client.jsonl'), 'utf8'),
			this._readRuntimeWorkerMetadata(agentDirectory),
		]);
		const meta: unknown = JSON.parse(metaRaw);
		if (expected && (!meta || typeof meta !== 'object'
			|| (meta as { sessionId?: unknown }).sessionId !== expected.sessionId
			|| (meta as { toolCallId?: unknown }).toolCallId !== expected.toolCallId)) {
			this._logService.warn(`[cli-ts] Ignoring mismatched runtime subagent archive for ${expected.sessionId}/${expected.toolCallId}.`);
			return undefined;
		}
		const prompt = meta && typeof meta === 'object' && typeof (meta as { prompt?: unknown }).prompt === 'string'
			? (meta as { prompt: string }).prompt
			: localize('cliTsAgent.subagentFallbackPrompt', "Subagent task");
		const recovery = runtimeSubagentRecoveryFromEvents(prompt, eventsRaw);
		return recovery ? { ...recovery, ...workerMetadata } : undefined;
	}

	private async _readRuntimeWorkerMetadata(agentDirectory: string): Promise<Pick<CliTsRuntimeSubagentRecovery, 'pathMapping' | 'isolatedWorkspace' | 'workerIntegrationStatus' | 'integrationChanges' | 'workspaceRevision'>> {
		try {
			const workerId = path.basename(agentDirectory);
			const sessionDirectory = path.resolve(agentDirectory, '..', '..');
			const parsed = JSON.parse(await fs.promises.readFile(path.join(sessionDirectory, 'workers.json'), 'utf8')) as {
				workers?: readonly { workerId?: unknown; revision?: unknown; parentToolCallId?: unknown; worktreePath?: unknown; coordinatorCwd?: unknown; integrationStatus?: unknown; integrationChanges?: readonly CliTsWorkerIntegrationChange[] }[];
			};
			const worker = parsed.workers?.find(candidate => candidate.workerId === workerId || candidate.parentToolCallId === workerId);
			// Snapshot workers keep their Git repository in private storage. Only
			// coordinatorCwd identifies the user folder where integration lands.
			const pathMapping = runtimePathMapping(
				typeof worker?.worktreePath === 'string' ? worker.worktreePath : undefined,
				typeof worker?.coordinatorCwd === 'string' ? worker.coordinatorCwd : undefined,
			);
			return {
				...(pathMapping ? { pathMapping } : {}),
				isolatedWorkspace: typeof worker?.worktreePath === 'string' && worker.worktreePath.length > 0,
				...(typeof worker?.integrationStatus === 'string' ? { workerIntegrationStatus: worker.integrationStatus } : {}),
				...(typeof worker?.revision === 'number' && Number.isSafeInteger(worker.revision) && worker.revision > 0 ? { workspaceRevision: worker.revision } : {}),
				...(worker?.integrationStatus === 'integrated' && Array.isArray(worker.integrationChanges) ? { integrationChanges: worker.integrationChanges } : {}),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this._logService.trace(`[cli-ts] Runtime worker path metadata unavailable for ${path.basename(agentDirectory)}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return {};
		}
	}

	private async _attachRuntimeRecoveryFileEdits(session: CliTsSession, childTurn: CliTsTurnState, recovery: CliTsRuntimeSubagentRecovery, parentToolCallId: string): Promise<void> {
		for (const recovered of recovery.fileEdits) {
			childTurn.toolInputs.set(recovered.toolCallId, { name: recovered.toolName, input: recovered.toolInput });
			const content = await this._buildFileEditContents(session, childTurn, recovered.toolCallId, recovered.toolName, recovered.edits);
			const fileEdits = content.filter((item): item is ToolResultFileEditContent => item.type === ToolResultContentType.FileEdit);
			const part = recovery.turn.parts?.find(candidate => candidate.kind === 'tool' && candidate.id === recovered.toolCallId);
			if (part?.kind === 'tool') {
				part.fileEdits = fileEdits;
			}
			const text = part?.kind === 'tool' && part.terminalOutput
				? part.terminalOutput.text
				: cliTsToolResultText(recovered.toolName, recovered.title, recovered.detail, part?.kind === 'tool' ? part.inputSummary : undefined);
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallComplete,
				turnId: childTurn.turnId,
				toolCallId: recovered.toolCallId,
				result: {
					success: !(part?.kind === 'tool' && part.failed),
					...(part?.kind === 'tool' && part.failed ? { error: { message: recovered.title ?? localize('cliTsAgent.toolFailedNoDetail', "The tool call failed.") } } : {}),
					pastTenseMessage: recovered.title ?? localize('cliTsAgent.toolFinished', "{0} finished", toolDisplayName(recovered.toolName)),
					content: [...(text ? [{ type: ToolResultContentType.Text as const, text }] : []), ...fileEdits],
				},
			}, parentToolCallId);
		}
	}

	/** Verifies coordinator snapshots before publishing a review or touching its database. */
	private async _buildWorkerIntegrationContents(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, changes: readonly CliTsWorkerIntegrationChange[]): Promise<ToolResultContent[]> {
		const tracker = this._fileEditTracker(session);
		if (!tracker) {
			return [];
		}
		const sessionId = session.sessionId || AgentSession.id(session.sessionUri);
		if (!isSafeRuntimePathSegment(sessionId) || !session.workingDirectory || changes.length > 1000) {
			throw new Error('Invalid integration snapshot scope.');
		}
		const sessionDirectory = path.join(this._runtimeSessionsRoot(), sessionId);
		const blobsDirectory = path.join(sessionDirectory, 'worker-integrations', 'blobs');
		const realSessionDirectory = await fs.promises.realpath(sessionDirectory);
		if (await fs.promises.realpath(blobsDirectory) !== path.join(realSessionDirectory, 'worker-integrations', 'blobs')) {
			throw new Error('Integration snapshots are outside their session.');
		}
		const paths = new Set<string>();
		let totalBytes = 0;
		for (const change of changes) {
			const relative = path.relative(session.workingDirectory.fsPath, change.filePath);
			if ((!change.before && !change.after) || !path.isAbsolute(change.filePath) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || paths.has(change.filePath)) {
				throw new Error('Invalid coordinator path in integration snapshots.');
			}
			paths.add(change.filePath);
			for (const snapshot of [change.before, change.after]) {
				if (snapshot) {
					totalBytes += snapshot.byteLength;
				}
			}
		}
		if (!Number.isSafeInteger(totalBytes) || totalBytes > 256 * 1024 * 1024) {
			throw new Error('Integration snapshots exceed the review limit.');
		}
		// Validate every blob before recording any edit; corrupted or incomplete
		// exact records must never silently fall back to a worker's proposed bytes.
		const snapshots: { filePath: string; before?: Uint8Array; after?: Uint8Array }[] = [];
		for (const change of changes) {
			snapshots.push({ filePath: change.filePath,
				before: change.before ? await this._readWorkerIntegrationSnapshot(blobsDirectory, change.before) : undefined,
				after: change.after ? await this._readWorkerIntegrationSnapshot(blobsDirectory, change.after) : undefined });
		}
		const content: ToolResultContent[] = [];
		for (const snapshot of snapshots) {
			const edit = await tracker.recordExplicitSnapshot(turn.turnId, toolCallId, snapshot.filePath, snapshot.before, snapshot.after, session.model?.id);
			if (edit) {
				content.push(edit);
			}
		}
		return content;
	}

	private async _readWorkerIntegrationSnapshot(blobsDirectory: string, snapshot: CliTsWorkerIntegrationSnapshot): Promise<Uint8Array> {
		if (!/^[a-f0-9]{64}$/.test(snapshot.sha256) || snapshot.contentPath !== path.join(blobsDirectory, snapshot.sha256)
			|| !Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 0 || snapshot.byteLength > 64 * 1024 * 1024) {
			throw new Error('Invalid integration snapshot reference.');
		}
		const file = await fs.promises.open(snapshot.contentPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size !== snapshot.byteLength) {
				throw new Error('Integration snapshot length does not match its record.');
			}
			const bytes = Buffer.alloc(snapshot.byteLength);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!bytesRead) {
					throw new Error('Integration snapshot ended early.');
				}
				offset += bytesRead;
			}
			if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) {
				throw new Error('Integration snapshot hash does not match its record.');
			}
			return bytes;
		} finally {
			await file.close();
		}
	}

	/** Reports a completed integration, without replaying the already completed child tools. */
	private async _publishWorkerIntegrationEdits(session: CliTsSession, parentTurn: CliTsTurnState, workerToolCallId: string, recovery?: CliTsRuntimeSubagentRecovery, integrationChanges?: readonly CliTsWorkerIntegrationChange[]): Promise<void> {
		const toolCallId = `worker-integration:${workerToolCallId}`;
		if (parentTurn.startedToolCalls.has(toolCallId) || parentTurn.storedParts.some(part => part.kind === 'tool' && part.id === toolCallId)) {
			return;
		}
		const byPath = new Map<string, { path: string; before: string; after: string }>();
		for (const tool of recovery?.fileEdits ?? []) {
			for (const edit of tool.edits) {
				const previous = byPath.get(edit.path);
				byPath.set(edit.path, { ...edit, before: previous?.before ?? edit.before });
			}
		}
		const edits = [...byPath.values()].filter(edit => edit.before !== edit.after);
		if (integrationChanges === undefined ? !edits.length : !integrationChanges.length) {
			return;
		}
		const name = 'apply_worker_changes';
		parentTurn.startedToolCalls.add(toolCallId);
		let content: ToolResultContent[];
		try {
			content = integrationChanges === undefined
				? await this._buildFileEditContents(session, parentTurn, toolCallId, name, edits)
				: await this._buildWorkerIntegrationContents(session, parentTurn, toolCallId, integrationChanges);
		} catch (error) {
			parentTurn.startedToolCalls.delete(toolCallId);
			this._logService.warn(`[cli-ts] Worker integration review unavailable: ${error instanceof Error ? error.message : String(error)}`);
			this._fire(session.sessionUri, { type: ActionType.ChatResponsePart, turnId: parentTurn.turnId, part: { kind: ResponsePartKind.SystemNotification, content: localize('cliTsAgent.workerReviewUnavailable', "Worker changes were integrated, but their saved review snapshots could not be verified.") } });
			return;
		}
		const fileEdits = content.filter((item): item is ToolResultFileEditContent => item.type === ToolResultContentType.FileEdit);
		if (!fileEdits.length) {
			parentTurn.startedToolCalls.delete(toolCallId);
			return;
		}
		const title = localize('cliTsAgent.workerChangesApplied', "Applied worker changes");
		parentTurn.storedParts.push({ kind: 'tool', id: toolCallId, name, title, fileEdits });
		parentTurn.toolSummaries.push(title);
		// This is a report of the integration already performed by cli-ts, never
		// a client-executable tool even if a client registered a matching name.
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallStart,
			turnId: parentTurn.turnId,
			toolCallId,
			toolName: name,
			displayName: localize('cliTsAgent.applyWorkerChanges', "Apply worker changes"),
		});
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallReady,
			turnId: parentTurn.turnId,
			toolCallId,
			invocationMessage: localize('cliTsAgent.applyWorkerChanges', "Apply worker changes"),
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallComplete,
			turnId: parentTurn.turnId,
			toolCallId,
			result: { success: true, pastTenseMessage: title, content: fileEdits },
		});
	}

	/** Backfills exact child writes from cli-ts archives created by older IDE builds. */
	private async _persistRuntimeRecoveryFileEdits(sessionUri: URI, recovery: CliTsRuntimeSubagentRecovery): Promise<void> {
		if (!recovery.fileEdits.length) {
			return;
		}
		let dbRef: IReference<ISessionDatabase> | undefined;
		try {
			dbRef = this._sessionDataService.openDatabase(sessionUri);
			const existing = new Set((await dbRef.object.getFileEdits(recovery.fileEdits.map(edit => edit.toolCallId)))
				.map(edit => `${edit.toolCallId}\0${edit.filePath}`));
			for (const tool of recovery.fileEdits) {
				for (const edit of tool.edits) {
					if (existing.has(`${tool.toolCallId}\0${edit.path}`)) {
						continue;
					}
					await dbRef.object.storeFileEdit({
						turnId: `subagent-${tool.toolCallId}`,
						toolCallId: tool.toolCallId,
						filePath: edit.path,
						kind: edit.before.length === 0 && edit.after.length > 0
							? FileEditKind.Create
							: edit.before.length > 0 && edit.after.length === 0 ? FileEditKind.Delete : FileEditKind.Edit,
						addedLines: undefined,
						removedLines: undefined,
						beforeContent: new TextEncoder().encode(edit.before),
						afterContent: new TextEncoder().encode(edit.after),
					});
				}
			}
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to persist recovered subagent file edits: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			dbRef?.dispose();
		}
	}

	private _readStore(): CliTsStoredSession[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this._storePath(), 'utf8'));
			if (!parsed || typeof parsed !== 'object' || (parsed as { version?: number }).version !== CLI_TS_STORE_VERSION) {
				return [];
			}
			const sessions = (parsed as { sessions?: unknown }).sessions;
			if (!Array.isArray(sessions)) {
				return [];
			}
			return (sessions as CliTsStoredSession[]).map(session => session.turns.length === 0 && session.title
				? {
					...session,
					turns: [{
						prompt: session.title,
						response: localize('cliTsAgent.interruptedTurn', "This response was interrupted when Backboard closed."),
						failed: true,
					}],
				}
				: session);
		} catch {
			return [];
		}
	}

	private _writeStore(excludedSessionId?: string, strict = false): void {
		try {
			const persisted = this._readStore().filter(entry => entry.id !== excludedSessionId && !this._sessions.has(entry.id));
			const inMemory: CliTsStoredSession[] = [...this._sessions.values()]
				.filter(session => (session.materialized || session.storedTurns.length > 0 || !!session.turn) && session.sessionId !== excludedSessionId)
				.map(session => ({
					id: session.sessionId,
					rewind: session.rewind,
					title: session.title,
					cwd: session.workingDirectory?.fsPath,
					sourceCwd: session.sourceWorkingDirectory?.fsPath,
					...(session.worktree ? {
						worktree: {
							path: session.worktree.path.fsPath,
							repositoryRoot: session.worktree.repositoryRoot.fsPath,
							branchName: session.worktree.branchName,
							baseBranch: session.worktree.baseBranch,
						},
					} : {}),
					createdAt: session.createdAt,
					modifiedAt: session.modifiedAt,
					materialized: session.materialized,
					threadId: session.threadId,
					forkContext: session.forkContext,
					providerHandoffContext: session.providerHandoffContext,
					// Persist the active turn as an error-state snapshot. Graceful shutdown
					// replaces it with the final partial response, while a crash or forced
					// quit still leaves a reopenable chat containing the exact prompt.
					turns: session.turn
						? [...session.storedTurns, activeTurnToStoredTurn(session.turn)]
						: session.storedTurns,
					subagents: Object.fromEntries(session.storedSubagentTurns),
				}));
			const storePath = this._storePath();
			fs.mkdirSync(path.dirname(storePath), { recursive: true });
			fs.writeFileSync(`${storePath}.tmp`, `${JSON.stringify({ version: CLI_TS_STORE_VERSION, sessions: [...inMemory, ...persisted] }, undefined, '\t')}\n`, { encoding: 'utf8', mode: 0o600 });
			fs.renameSync(`${storePath}.tmp`, storePath);
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to persist session store: ${error instanceof Error ? error.message : String(error)}`);
			if (strict) {
				throw error;
			}
		}
	}
}

// ---- helpers -----------------------------------------------------------------

/** Maps a protocol {@link ToolDefinition} to the cli-ts serve wire shape. */
function clientToolDefinitionToWire(tool: ToolDefinition): CliTsClientToolDefinition {
	return {
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		...(tool.inputSchema ? { inputSchema: tool.inputSchema as unknown as Record<string, unknown> } : {}),
	};
}

/**
 * Maps a workbench {@link ToolCallResult} to the serve wire payload. Image
 * blocks stay images (the Backboard API routes them through vision); other
 * embedded resources are passed through as opaque base64 resources.
 */
function clientToolResultToWire(result: ToolCallResult): CliTsClientToolResultPayload {
	const content: CliTsClientToolResultContent[] = [];
	for (const part of result.content ?? []) {
		if (part.type === ToolResultContentType.Text) {
			content.push({ type: 'text', text: part.text });
		} else if (part.type === ToolResultContentType.EmbeddedResource) {
			content.push(part.contentType.startsWith('image/')
				? { type: 'image', mimeType: part.contentType, dataBase64: part.data }
				: { type: 'resource', mimeType: part.contentType, dataBase64: part.data });
		}
	}
	return {
		success: result.success,
		...(content.length ? { content } : {}),
		...(result.error?.message ? { error: result.error.message } : {}),
	};
}

function cloneStoredTurns(turns: readonly CliTsStoredTurn[]): CliTsStoredTurn[] {
	return turns.map(turn => ({
		...turn,
		...(turn.tools ? { tools: [...turn.tools] } : {}),
		...(turn.parts ? { parts: cloneStoredParts(turn.parts) } : {}),
	}));
}

function cloneStoredParts(parts: readonly CliTsStoredPart[]): CliTsStoredPart[] {
	return parts.map(part => part.kind === 'tool' && part.fileEdits
		? { ...part, fileEdits: [...part.fileEdits] }
		: { ...part });
}

function activeTurnToStoredTurn(turn: CliTsTurnState): CliTsStoredTurn {
	return {
		id: turn.turnId,
		usage: turn.usage,
		prompt: turn.prompt,
		response: turn.responseText || localize('cliTsAgent.interruptedTurn', "This response was interrupted when Backboard closed."),
		failed: true,
		error: turn.error ?? { errorType: 'BackboardInterrupted', message: localize('cliTsAgent.interruptedTurn', "This response was interrupted when Backboard closed.") },
		...(turn.toolSummaries.length ? { tools: [...turn.toolSummaries] } : {}),
		...(turn.storedParts.length ? { parts: cloneStoredParts(turn.storedParts) } : {}),
	};
}

function buildForkConversationContext(turns: readonly CliTsStoredTurn[]): string {
	return buildConversationHandoffContext(
		turns,
		'This chat was branched from an earlier conversation.',
	);
}

function buildProviderHandoffConversationContext(turns: readonly CliTsStoredTurn[]): string {
	return buildConversationHandoffContext(
		turns,
		'The user changed model providers while keeping this chat.',
	);
}

function buildConversationHandoffContext(turns: readonly CliTsStoredTurn[], reason: string): string {
	const transcript = turns.map(turn => ({
		user: turn.prompt,
		attachments: turn.attachments,
		assistant: turn.response,
		tools: turn.parts?.filter(part => part.kind === 'tool'),
		...(turn.failed ? { responseFailed: true } : {}),
	}));
	return [
		`${reason} Treat the JSON transcript below as authoritative prior user/assistant history, then answer the current user message as the next turn. Do not mention this handoff unless the user asks about it.`,
		'<prior_conversation_json>',
		JSON.stringify(transcript),
		'</prior_conversation_json>',
	].join('\n');
}

function firstPromptLine(prompt: string): string {
	const line = prompt.split('\n', 1)[0]?.trim() ?? '';
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function getBackboardWorktreesRoot(repositoryRoot: URI): URI {
	return URI.joinPath(repositoryRoot, '..', `${path.basename(repositoryRoot.fsPath)}.backboard-worktrees`);
}

export function getBackboardWorktreeBranchName(sessionId: string, branchNameHint: string | undefined): string {
	return `backboard/${branchNameHint ? `${branchNameHint}-${sessionId.substring(0, 8)}` : sessionId}`;
}

export function getBackboardBranchNameHintFromMessage(message: string): string | undefined {
	const words = message
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.filter(word => word.length > 0)
		.slice(0, 8);
	const hint = words.join('-').slice(0, 48).replace(/-+$/g, '');
	return hint || undefined;
}

function validSubagentName(value: unknown): string | undefined {
	if (typeof value !== 'string') { return undefined; }
	const name = value.trim();
	return name.length > 0 && name.length <= 80 && !/[\r\n]/.test(name) ? name : undefined;
}

function subagentDisplayName(turn: CliTsTurnState, toolCallId: string): string | undefined {
	const input = turn.toolInputs.get(toolCallId)?.input;
	return validSubagentName(turn.workerWorkspaces?.get(toolCallId)?.name)
		?? validSubagentName(input && typeof input === 'object' ? (input as { name?: unknown }).name : undefined);
}

function subagentPrompt(turn: CliTsTurnState, toolCallId: string, inputSummary?: string): string {
	const input = turn.toolInputs.get(toolCallId)?.input;
	if (typeof input === 'string' && input.trim()) {
		return input;
	}
	if (input && typeof input === 'object') {
		const prompt = (input as { prompt?: unknown }).prompt;
		if (typeof prompt === 'string' && prompt.trim()) {
			return prompt;
		}
	}
	const summary = inputSummary ?? turn.toolInputSummaries.get(toolCallId);
	return summary && summary !== 'Generating input…'
		? summary
		: localize('cliTsAgent.subagentFallbackPrompt', "Subagent task");
}

/**
 * Older stores predate dedicated child persistence. Rebuild the most useful
 * child conversation available from the parent Subagent tool so opening a
 * historical agent never lands on a blank chat.
 */
function fallbackSubagentTurns(parentTurns: readonly CliTsStoredTurn[], toolCallId: string): readonly CliTsStoredTurn[] {
	for (const parentTurn of parentTurns) {
		const part = parentTurn.parts?.find(candidate => candidate.kind === 'tool'
			&& candidate.id === toolCallId
			&& isCliTsSubagentLauncherTool(candidate.name));
		if (!part || part.kind !== 'tool') {
			continue;
		}
		const prompt = part.inputSummary?.trim() || localize('cliTsAgent.subagentFallbackPrompt', "Subagent task");
		const response = part.detail?.trim()
			|| part.title?.trim()
			|| localize('cliTsAgent.subagentFallbackComplete', "Subagent completed.");
		return [{
			prompt,
			response,
			parts: [{ kind: 'markdown', content: response }],
		}];
	}
	return [];
}

function subagentWorkerFromTurns(parentTurns: readonly CliTsStoredTurn[], toolCallId: string): CliTsWorkerState | undefined {
	for (const turn of [...parentTurns].reverse()) {
		const part = turn.parts?.find(candidate => candidate.kind === 'tool' && candidate.id === toolCallId);
		if (part?.kind === 'tool' && part.worker) {
			return part.worker;
		}
	}
	return undefined;
}

function subagentWorkspaceFromTurns(parentTurns: readonly CliTsStoredTurn[], toolCallId: string): CliTsWorkerWorkspace | undefined {
	for (let turnIndex = parentTurns.length - 1; turnIndex >= 0; turnIndex--) {
		const part = parentTurns[turnIndex].parts?.find(candidate => candidate.kind === 'tool' && candidate.id === toolCallId);
		if (part?.kind === 'tool' && part.workspace) {
			return part.workspace;
		}
	}
	return undefined;
}

/** Private writes are proposals until the durable integration boundary. */
function cliTsWorkerEditsAreIntegrated(workspace: CliTsWorkerWorkspace | undefined, recovery?: CliTsRuntimeSubagentRecovery): boolean {
	if (workspace?.integrationStatus !== undefined) {
		return workspace.integrationStatus === 'integrated' || workspace.integrationStatus === 'not_required';
	}
	if (!workspace?.worktreePath && !recovery?.pathMapping && !recovery?.isolatedWorkspace) {
		return true; // Legacy/shared-workspace workers write directly to the coordinator.
	}
	return workspace?.status === 'Integrated' || recovery?.workerIntegrationStatus === 'integrated';
}

function withoutStoredFileEdits(turn: CliTsStoredTurn): CliTsStoredTurn {
	return {
		...turn,
		...(turn.parts ? { parts: turn.parts.map(part => part.kind === 'tool' ? { ...part, fileEdits: undefined } : part) } : {}),
	};
}

function runtimePathMapping(workerRoot: string | undefined, coordinatorRoot: string | undefined): CliTsRuntimePathMapping | undefined {
	if (!workerRoot?.trim() || !coordinatorRoot?.trim()) {
		return undefined;
	}
	return { workerRoot: path.resolve(workerRoot), coordinatorRoot: path.resolve(coordinatorRoot) };
}

function isSafeRuntimePathSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

/**
 * Projects raw private child-archive paths onto the coordinator checkout. The
 * JSONL stays untouched for recovery; only IDE persistence and transcript data
 * receive the stable path users can actually open after worker cleanup.
 */
function projectRuntimeSubagentRecovery(recovery: CliTsRuntimeSubagentRecovery, mapping: CliTsRuntimePathMapping | undefined): CliTsRuntimeSubagentRecovery {
	if (!mapping) {
		return recovery;
	}
	const workerRoot = path.resolve(mapping.workerRoot);
	const coordinatorRoot = path.resolve(mapping.coordinatorRoot);
	const replaceText = (value: string): string => {
		let projected = value;
		const variants = new Map<string, string>([
			[workerRoot, coordinatorRoot],
			[workerRoot.replaceAll('\\', '/'), coordinatorRoot.replaceAll('\\', '/')],
			[workerRoot.replaceAll('/', '\\'), coordinatorRoot.replaceAll('/', '\\')],
		]);
		for (const [worker, coordinator] of [...variants].sort(([left], [right]) => right.length - left.length)) {
			projected = projected.replaceAll(worker, coordinator);
		}
		return projected;
	};
	const projectFilePath = (value: string): string => {
		const absolute = path.resolve(workerRoot, value);
		const relative = path.relative(workerRoot, absolute);
		const insideWorker = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
		return insideWorker ? path.resolve(coordinatorRoot, relative) : replaceText(value);
	};
	const projectUnknown = (value: unknown): unknown => {
		if (typeof value === 'string') {
			return replaceText(value);
		}
		if (Array.isArray(value)) {
			return value.map(projectUnknown);
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectUnknown(child)]));
		}
		return value;
	};
	const projectPart = (part: CliTsStoredPart): CliTsStoredPart => {
		if (part.kind === 'markdown' || part.kind === 'reasoning') {
			return { ...part, content: replaceText(part.content) };
		}
		return {
			...part,
			...(part.inputSummary ? { inputSummary: replaceText(part.inputSummary) } : {}),
			...(part.terminalCommand !== undefined ? { terminalCommand: replaceText(part.terminalCommand) } : {}),
			...(part.title ? { title: replaceText(part.title) } : {}),
			...(part.detail ? { detail: replaceText(part.detail) } : {}),
			...(part.terminalOutput ? { terminalOutput: { ...part.terminalOutput, text: replaceText(part.terminalOutput.text) } } : {}),
		};
	};
	return {
		...recovery,
		turn: {
			...recovery.turn,
			prompt: replaceText(recovery.turn.prompt),
			response: replaceText(recovery.turn.response),
			...(recovery.turn.tools ? { tools: recovery.turn.tools.map(replaceText) } : {}),
			...(recovery.turn.parts ? { parts: recovery.turn.parts.map(projectPart) } : {}),
		},
		fileEdits: recovery.fileEdits.map(tool => ({
			...tool,
			toolInput: projectUnknown(tool.toolInput),
			...(tool.title ? { title: replaceText(tool.title) } : {}),
			...(tool.detail ? { detail: replaceText(tool.detail) } : {}),
			edits: tool.edits.map(edit => ({ ...edit, path: projectFilePath(edit.path) })),
		})),
		pathMapping: mapping,
	};
}

/**
 * Pins reopened runtime diffs to the freshly projected coordinator records.
 * Older builds may already have persisted a duplicate private-worker path for
 * the same tool call; embedding the authoritative set prevents generic DB
 * hydration from reattaching that stale, deleted checkout.
 */
function runtimeRecoveryTurnWithFileEdits(sessionUri: string, recovery: CliTsRuntimeSubagentRecovery): CliTsStoredTurn {
	const byToolCall = new Map<string, ToolResultFileEditContent[]>();
	for (const tool of recovery.fileEdits) {
		byToolCall.set(tool.toolCallId, tool.edits.map(edit => storedFileEditContent(sessionUri, {
			turnId: `subagent-${tool.toolCallId}`,
			toolCallId: tool.toolCallId,
			filePath: edit.path,
			kind: edit.before.length === 0 && edit.after.length > 0
				? FileEditKind.Create
				: edit.before.length > 0 && edit.after.length === 0 ? FileEditKind.Delete : FileEditKind.Edit,
			addedLines: undefined,
			removedLines: undefined,
		})));
	}
	return {
		...recovery.turn,
		...(recovery.turn.parts ? {
			parts: recovery.turn.parts.map(part => part.kind === 'tool' && byToolCall.has(part.id) && !part.fileEdits?.length
				? { ...part, fileEdits: byToolCall.get(part.id) }
				: part),
		} : {}),
	};
}

/**
 * Converts cli-ts's durable per-agent JSONL stream into the same rich turn
 * shape used by the IDE store. Older IDE builds discarded child turns, but
 * cli-ts retained these event streams, so historical subagent chats can still
 * show their reasoning, messages, tool activity, and final answer.
 */
function runtimeSubagentRecoveryFromEvents(prompt: string, eventsRaw: string): CliTsRuntimeSubagentRecovery | undefined {
	type MarkdownPart = Extract<CliTsStoredPart, { kind: 'markdown' }>;
	type ReasoningPart = Extract<CliTsStoredPart, { kind: 'reasoning' }>;
	type ToolPart = Extract<CliTsStoredPart, { kind: 'tool' }>;
	const parts: CliTsStoredPart[] = [];
	const markdownParts = new Map<string, MarkdownPart>();
	const toolParts = new Map<string, { readonly index: number; readonly part: ToolPart }>();
	const requestedToolNames = new Map<string, string>();
	const requestedToolInputs = new Map<string, unknown>();
	const fileEdits: CliTsRuntimeFileEdit[] = [];
	let activeReasoning: ReasoningPart | undefined;
	let response = '';
	let failed = false;
	let error: CliTsTurnError | undefined;
	let sawTurnEvent = false;

	const ensureMarkdown = (messageId: string): MarkdownPart => {
		let part = markdownParts.get(messageId);
		if (!part) {
			part = { kind: 'markdown', content: '' };
			markdownParts.set(messageId, part);
			parts.push(part);
		}
		return part;
	};
	const updateTool = (event: CliTsAgentEvent, terminal: boolean): void => {
		if (!event.toolCallId) {
			return;
		}
		const current = toolParts.get(event.toolCallId);
		const name = event.name ?? current?.part.name ?? requestedToolNames.get(event.toolCallId) ?? 'Tool';
		const incomingToolUi = cliTsToolUiState(event.toolUi);
		const toolUi = incomingToolUi
			? mergeCliTsToolUiState(current?.part.toolUi, incomingToolUi)
			: current?.part.toolUi;
		const terminalCommand = isCliTsTerminalTool(name)
			? cliTsTerminalCommand(requestedToolInputs.get(event.toolCallId)) ?? current?.part.terminalCommand
			: undefined;
		const next: ToolPart = {
			kind: 'tool',
			id: event.toolCallId,
			name,
			...(event.inputSummary || current?.part.inputSummary ? { inputSummary: event.inputSummary || current?.part.inputSummary } : {}),
			...(terminalCommand !== undefined ? { terminalCommand } : {}),
			...(terminal && event.title ? { title: event.title } : current?.part.title ? { title: current.part.title } : {}),
			...(terminal && event.detail ? { detail: event.detail } : current?.part.detail ? { detail: current.part.detail } : {}),
			...(terminal && event.terminalOutput ? { terminalOutput: event.terminalOutput } : current?.part.terminalOutput ? { terminalOutput: current.part.terminalOutput } : {}),
			...(toolUi ? { toolUi } : {}),
			...((terminal && cliTsToolExecutionFailed(event)) || current?.part.failed ? { failed: true } : {}),
		};
		if (current) {
			parts[current.index] = next;
			toolParts.set(event.toolCallId, { index: current.index, part: next });
		} else {
			const index = parts.push(next) - 1;
			toolParts.set(event.toolCallId, { index, part: next });
		}
	};

	for (const line of eventsRaw.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!value || typeof value !== 'object') {
			continue;
		}
		const payload = (value as { payload?: unknown }).payload;
		if (!payload || typeof payload !== 'object' || typeof (payload as { type?: unknown }).type !== 'string') {
			continue;
		}
		const event = payload as CliTsAgentEvent;
		sawTurnEvent = true;
		switch (event.type) {
			case 'assistant:delta': {
				if (!event.messageId || !event.text) {
					break;
				}
				const part = ensureMarkdown(event.messageId);
				part.content += event.text;
				response += event.text;
				break;
			}
			case 'assistant:message': {
				if (!event.messageId || event.text === undefined) {
					break;
				}
				const part = ensureMarkdown(event.messageId);
				if (event.text === part.content) {
					break;
				}
				const remainder = event.text.startsWith(part.content) ? event.text.slice(part.content.length) : event.text;
				part.content += remainder;
				response += remainder;
				break;
			}
			case 'assistant:reasoning': {
				if (!event.text) {
					break;
				}
				if (!activeReasoning) {
					activeReasoning = { kind: 'reasoning', content: '' };
					parts.push(activeReasoning);
				}
				activeReasoning.content += event.text;
				break;
			}
			case 'tool:requested':
				activeReasoning = undefined;
				for (const call of event.calls ?? []) {
					requestedToolNames.set(call.id, call.name);
					requestedToolInputs.set(call.id, call.input);
				}
				break;
			case 'tool:pending':
			case 'tool:start':
				updateTool(event, false);
				break;
			case 'tool:result':
			case 'tool:error':
				updateTool(event, true);
				if (event.toolCallId && event.fileEdits?.length) {
					fileEdits.push({
						toolCallId: event.toolCallId,
						toolName: event.name ?? requestedToolNames.get(event.toolCallId) ?? 'Tool',
						toolInput: requestedToolInputs.get(event.toolCallId),
						title: event.title,
						detail: event.detail,
						edits: event.fileEdits,
					});
				}
				break;
			case 'run:error':
				failed = true;
				error = { errorType: 'BackboardError', message: event.error?.trim() ? event.error : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
				break;
			case 'turn:end':
				failed = !!error || (event.status !== undefined && event.status !== 'completed');
				break;
		}
	}

	if (!sawTurnEvent || (!parts.length && !error)) {
		return undefined;
	}
	return {
		turn: {
			prompt,
			response,
			...(failed ? { failed: true } : {}),
			...(error ? { error } : {}),
			parts,
		},
		fileEdits,
	};
}

/** `apply_patch` → `Apply Patch`, `mcp__linear__create_issue` → `linear: create issue`. */
function toolDisplayName(toolName: string): string {
	if (toolName.startsWith('mcp__')) {
		const [, server, ...rest] = toolName.split('__');
		return `${server}: ${rest.join(' ').replaceAll('_', ' ')}`;
	}
	return toolName.split('_').map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
}

function isCliTsTerminalTool(toolName: string): boolean {
	return toolName.toLocaleLowerCase() === 'execute';
}

/**
 * `inputSummary` is intentionally abbreviated by cli-ts for the compact tool
 * row. Terminal cards need the actual shell command, however, so recover it
 * from the structured `tool:requested` payload before that information is
 * lost at the protocol boundary.
 */
function cliTsTerminalCommand(input: unknown): string | undefined {
	if (typeof input === 'string') {
		return input;
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const command = (input as { command?: unknown }).command;
	return typeof command === 'string' ? command : undefined;
}

function isCliTsSubagentTool(toolName: string): boolean {
	const normalized = toolName.replace(/[_-]/g, '').toLocaleLowerCase();
	return normalized === 'agent' || normalized === 'subagent';
}

/** A non-blocking worker launcher whose tool result is only a durable handle. */
function isCliTsDetachedSubagentTool(toolName: string): boolean {
	return toolName.replace(/[_-]/g, '').toLocaleLowerCase() === 'agentspawn';
}

/** Tools that own a child session. AgentWait is deliberately excluded. */
function isCliTsSubagentLauncherTool(toolName: string): boolean {
	return isCliTsSubagentTool(toolName) || isCliTsDetachedSubagentTool(toolName);
}

function cliTsToolResultText(toolName: string, title: string | undefined, detail: string | undefined, inputSummary: string | undefined): string {
	if (!isCliTsTerminalTool(toolName)) {
		return [title, detail].filter(part => !!part).join('\n');
	}
	if (!detail) {
		return '';
	}

	// Execute already has structured status and command fields. Keep its result
	// payload to stdout/stderr only so the terminal disclosure does not repeat
	// `Success` and `$ command` inside the output body.
	const command = inputSummary?.trim();
	if (!command) {
		return detail;
	}
	const lines = detail.split(/\r?\n/);
	const firstContentIndex = lines.findIndex(line => !!line.trim());
	if (firstContentIndex >= 0) {
		const promptMatch = /^\s*[$%❯]\s+(.+)$/.exec(lines[firstContentIndex]);
		if (promptMatch?.[1].trim() === command) {
			lines.splice(firstContentIndex, 1);
			while (lines.length && !lines[0].trim()) {
				lines.shift();
			}
		}
	}
	return lines.join('\n');
}

function cliTsTerminalProgressText(data: unknown): string | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const progress = data as { kind?: unknown; text?: unknown };
	return progress.kind === 'terminal-output' && typeof progress.text === 'string'
		? progress.text
		: undefined;
}

function terminalOutputFromProgress(text: string | undefined): CliTsTerminalOutput | undefined {
	return text === undefined ? undefined : { text };
}

const CLI_TS_TOOL_UI_MAX_JSON_CHARS = 512_000;
const CLI_TS_BACKBOARD_TOOL_KINDS = new Set<CliTsBackboardToolKind>([
	'read',
	'grep',
	'glob',
	'fetchUrl',
	'webSearch',
	'todo',
	'computer',
	'browser',
	'findSkill',
	'findMcp',
]);

function cliTsToolUiState(value: unknown): CliTsToolUiState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { kind?: unknown; input?: unknown; result?: unknown };
	if (typeof candidate.kind !== 'string' || !CLI_TS_BACKBOARD_TOOL_KINDS.has(candidate.kind as CliTsBackboardToolKind)) {
		return undefined;
	}
	const input = boundedCliTsToolUiRecord(candidate.input);
	const result = boundedCliTsToolUiRecord(candidate.result);
	return {
		kind: candidate.kind as CliTsBackboardToolKind,
		...(input ? { input } : {}),
		...(result ? { result } : {}),
	};
}

function boundedCliTsToolUiRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	try {
		const serialized = JSON.stringify(value);
		if (serialized.length > CLI_TS_TOOL_UI_MAX_JSON_CHARS) {
			return undefined;
		}
		const parsed = JSON.parse(serialized) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function mergeCliTsToolUiState(existing: CliTsToolUiState | undefined, incoming: CliTsToolUiState): CliTsToolUiState {
	if (!existing || existing.kind !== incoming.kind) {
		return incoming;
	}
	return {
		kind: incoming.kind,
		...(incoming.input ?? existing.input ? { input: incoming.input ?? existing.input } : {}),
		...(incoming.result ?? existing.result ? { result: incoming.result ?? existing.result } : {}),
	};
}

function cliTsReadyToolInput(inputSummary: string | undefined, toolUi: CliTsToolUiState | undefined, terminalCommand?: string): string {
	if (terminalCommand !== undefined) {
		return JSON.stringify({ command: terminalCommand });
	}
	if (!toolUi?.input) {
		return inputSummary ?? '';
	}
	try {
		return JSON.stringify(toolUi.input);
	} catch {
		return inputSummary ?? '';
	}
}

/** Preserve rich results while projecting typed execution failure into live and recovered UI. */
export function cliTsToolExecutionFailed(event: CliTsAgentEvent): boolean {
	const execution = event.execution;
	const exitCode = execution?.exitCode ?? event.terminalOutput?.exitCode;
	return event.type === 'tool:error' || event.status === 'error' || execution?.outcome === 'failure'
		|| execution?.failureCategory !== undefined || execution?.cancelled === true
		|| execution?.timedOut === true || event.terminalOutput?.timedOut === true
		|| (typeof exitCode === 'number' && exitCode !== 0 && execution?.outcome === undefined);
}

function cliTsToolCompletionMetadata(toolName: string, terminalOutput: CliTsTerminalOutput | undefined, backboardToolKind?: CliTsBackboardToolKind, mutationBatch?: CliTsMutationBatch): Record<string, unknown> {
	return {
		...cliTsToolMetadata(toolName, undefined, backboardToolKind, mutationBatch),
		...(terminalOutput?.exitCode !== undefined ? { terminalExitCode: terminalOutput.exitCode } : {}),
		...(terminalOutput?.truncated ? { terminalOutputTruncated: true } : {}),
	};
}

function isHiddenCliTsTool(toolName: string | undefined): boolean {
	return toolName?.replace(/[_-]/g, '').toLocaleLowerCase() === 'askuser';
}

function isCliTsToolLifecycleEvent(eventType: string): boolean {
	return eventType === 'tool:pending'
		|| eventType === 'tool:start'
		|| eventType === 'tool:progress'
		|| eventType === 'tool:result'
		|| eventType === 'tool:error'
		|| eventType === 'tool:discarded'
		|| eventType === 'tool:retracted';
}

function isCliTsMutationTool(toolName: string | undefined): boolean {
	const normalized = toolName?.replace(/[_-]/g, '').toLocaleLowerCase();
	return normalized === 'write'
		|| normalized === 'writefile'
		|| normalized === 'writetofile'
		|| normalized === 'edit'
		|| normalized === 'editfile'
		|| normalized === 'applypatch';
}

function cliTsMutationBatches(turn: CliTsTurnState): Map<string, CliTsMutationBatch> {
	const compatible = turn as unknown as { mutationBatches?: Map<string, CliTsMutationBatch> };
	return compatible.mutationBatches ??= new Map<string, CliTsMutationBatch>();
}

function cliTsPendingSubagentEndStatuses(turn: CliTsTurnState): Map<string, CliTsSubagentCompletionStatus> {
	const compatible = turn as unknown as { pendingSubagentEndStatuses?: Map<string, CliTsSubagentCompletionStatus> };
	return compatible.pendingSubagentEndStatuses ??= new Map<string, CliTsSubagentCompletionStatus>();
}

function cliTsWorkerCompletionStatus(worker: CliTsWorkerState): CliTsSubagentCompletionStatus | undefined {
	if (worker.status === 'queued' || worker.status === 'running') {
		return undefined;
	}
	if (worker.persistenceError) {
		return 'failed';
	}
	if (worker.integrationStatus === 'integrated') {
		return 'completed';
	}
	if (worker.integrationStatus === 'conflict' || worker.executionStatus === 'failed' || worker.executionStatus === 'interrupted') {
		return 'failed';
	}
	if (worker.executionStatus === 'cancelled') {
		return 'cancelled';
	}
	if (worker.executionStatus === 'completed' && worker.integrationStatus === 'not_required') {
		return 'completed';
	}
	if (worker.executionStatus === 'completed' && worker.integrationStatus === 'skipped') {
		return 'failed';
	}
	return undefined;
}

function workspaceFromWorker(worker: CliTsWorkerState): CliTsWorkerWorkspace {
	const terminal = cliTsWorkerCompletionStatus(worker);
	const status: CliTsWorkerWorkspace['status'] = worker.persistenceError ? 'Failed'
		: worker.integrationStatus === 'integrated' && terminal === 'completed' ? 'Integrated'
		: worker.integrationStatus === 'conflict' ? 'Conflict'
			: terminal === 'failed' ? 'Failed' : terminal === 'cancelled' ? 'Cancelled' : terminal === 'completed' ? 'Completed'
				: worker.integrationStatus === 'integrating' || worker.integrationStatus === 'integrated' ? 'Integrating'
					: worker.executionStatus === 'queued' || worker.executionStatus === 'preparing' ? 'Queued' : 'Running';
	return {
		...worker.workspace,
		workerId: worker.workspace?.workerId ?? worker.handle,
		name: worker.name ?? worker.workspace?.name,
		status,
		executionStatus: worker.executionStatus,
		integrationStatus: worker.integrationStatus,
		changedFileCount: worker.workspace?.changedFileCount ?? 0,
		startedAt: worker.startedAt ?? worker.createdAt,
		...(worker.finishedAt ? { finishedAt: worker.finishedAt } : {}),
	};
}

/**
 * Maps durable workspace authority onto the child turn state. A captured write
 * with changes is not final while it is merely waiting to integrate.
 */
function cliTsWorkspaceCompletionStatus(workspace: CliTsWorkerWorkspace): CliTsSubagentCompletionStatus | undefined {
	switch (workspace.status) {
		case 'Integrated':
			return 'completed';
		case 'Conflict':
		case 'Failed':
			return 'failed';
		case 'Cancelled':
			return 'cancelled';
		case 'Completed':
			if (workspace.integrationResult === 'Not integrated') {
				return 'failed';
			}
			return workspace.changedFileCount === 0 ? 'completed' : undefined;
		case 'Running':
		case 'Queued':
		case 'Integrating':
			return undefined;
	}
}

/** Exact when mutation inputs expose paths; unknown calls retain one slot. */
function cliTsMutationFileCount(calls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[]): number {
	const paths = new Set<string>();
	let unknownCalls = 0;
	for (const call of calls) {
		const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : undefined;
		const normalized = call.name.replace(/[_-]/g, '').toLocaleLowerCase();
		if (normalized === 'applypatch') {
			const patch = typeof input?.patch === 'string' ? input.patch : undefined;
			const matches = patch ? Array.from(patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) : [];
			if (matches.length) {
				for (const match of matches) {
					paths.add(match[1].trim());
				}
			} else {
				unknownCalls++;
			}
			continue;
		}
		const filePath = typeof input?.file_path === 'string' ? input.file_path.trim() : '';
		if (filePath) {
			paths.add(filePath);
		} else {
			unknownCalls++;
		}
	}
	return Math.max(1, paths.size + unknownCalls);
}

function cliTsToolMetadata(toolName: string, input?: unknown, backboardToolKind?: CliTsBackboardToolKind, mutationBatch?: CliTsMutationBatch): Record<string, unknown> {
	if (isCliTsTerminalTool(toolName)) {
		return { source: 'cli-ts', toolKind: 'terminal', language: 'shellscript' };
	}
	if (isCliTsSubagentLauncherTool(toolName)) {
		const record = input && typeof input === 'object' ? input as { prompt?: unknown; subagent_type?: unknown; name?: unknown } : undefined;
		const prompt = typeof record?.prompt === 'string' ? record.prompt : undefined;
		const agentName = validSubagentName(record?.name) ?? (record?.subagent_type === 'rlm' ? 'rlm' : 'worker');
		return {
			source: 'cli-ts',
			toolKind: 'subagent',
			subagentAgentName: agentName,
			...(isCliTsDetachedSubagentTool(toolName) ? { subagentDetached: true, subagentTerminalAfterIntegration: true } : {}),
			...(prompt ? { subagentDescription: firstPromptLine(prompt) } : {}),
		};
	}
	return {
		source: 'cli-ts',
		...(backboardToolKind ? { backboardToolKind } : {}),
		...(mutationBatch ? {
			mutationBatchId: mutationBatch.id,
			mutationBatchFileCount: mutationBatch.expectedFileCount,
		} : {}),
	};
}

function workerWorkspaceMetadata(workspace: CliTsWorkerWorkspace): Record<string, unknown> {
	return {
		subagentWorkerId: workspace.workerId,
		...(validSubagentName(workspace.name) ? { subagentAgentName: validSubagentName(workspace.name) } : {}),
		subagentStatus: workspace.status,
		subagentChangedFileCount: workspace.changedFileCount,
		subagentStartedAt: workspace.startedAt,
		...(workspace.finishedAt ? { subagentFinishedAt: workspace.finishedAt } : {}),
		...(workspace.conflictingFiles ? { subagentConflictingFiles: workspace.conflictingFiles } : {}),
	};
}

function workerWorkspaceStatusLine(workspace: CliTsWorkerWorkspace): string {
	switch (workspace.status) {
		case 'Queued':
			return localize('cliTsAgent.workerQueued', "Worker queued");
		case 'Running':
			return localize('cliTsAgent.workerRunning', "Worker running");
		case 'Integrating':
			return localize('cliTsAgent.workerIntegrating', "Integrating worker changes…");
		case 'Integrated':
			return localize('cliTsAgent.workerIntegrated', "Integrated {0} changed files", workspace.changedFileCount);
		case 'Conflict':
			return localize('cliTsAgent.workerConflict', "Worker integration conflict in {0}", workspace.conflictingFiles?.join(', ') ?? 'Git');
		case 'Completed':
			return localize('cliTsAgent.workerCompleted', "Worker completed with {0} changed files", workspace.changedFileCount);
		case 'Failed':
			return localize('cliTsAgent.workerFailed', "Worker failed; recovery data was preserved");
		case 'Cancelled':
			return localize('cliTsAgent.workerCancelled', "Worker cancelled; late integration is disabled");
	}
}

function toolInvocationMessage(toolName: string, inputSummary?: string): string {
	const displayName = toolDisplayName(toolName);
	return inputSummary ? `${displayName}: ${inputSummary}` : displayName;
}

interface PreparedSubmitAttachments {
	readonly prompt: string;
	readonly files: CliTsFileAttachment[];
}

/**
 * Splits IDE message attachments into inline prompt context (text snippets and
 * on-disk file pointers) and binary payloads forwarded on the submit op, which
 * serve persists under the session's attachments dir and points the agent at.
 */
function prepareSubmitAttachments(prompt: string, attachments?: readonly MessageAttachment[]): PreparedSubmitAttachments {
	if (!attachments?.length) {
		return { prompt, files: [] };
	}
	const parts: string[] = [];
	const files: CliTsFileAttachment[] = [];
	for (const attachment of attachments) {
		if (attachment.type === MessageAttachmentKind.Simple && attachment.modelRepresentation) {
			parts.push(`Attached ${attachment.label}:\n${attachment.modelRepresentation}`);
		} else if (attachment.type === MessageAttachmentKind.Resource) {
			try {
				const uri = URI.parse(attachment.uri);
				if (uri.scheme === 'file') {
					parts.push(`Attached file (read it with the Read tool): ${uri.fsPath}`);
				}
			} catch {
				// Ignore unparseable attachment URIs.
			}
		} else if (attachment.type === MessageAttachmentKind.EmbeddedResource) {
			files.push({
				fileName: attachment.label || 'attachment',
				mimeType: attachment.contentType,
				dataBase64: attachment.data,
			});
		}
	}
	return {
		prompt: parts.length ? `${prompt}\n\n${parts.join('\n\n')}` : prompt,
		files,
	};
}

function inputAnswerText(answer?: SessionInputAnswer): string {
	if (!answer || !('value' in answer) || answer.value === undefined) {
		return '';
	}
	const value = answer.value;
	switch (value.kind) {
		case ChatInputAnswerValueKind.Text:
			return value.value;
		case ChatInputAnswerValueKind.Selected:
			return value.freeformValues?.[0] ?? value.value;
		case ChatInputAnswerValueKind.Number:
			return String(value.value);
		case ChatInputAnswerValueKind.Boolean:
			return value.value ? 'yes' : 'no';
		default:
			return '';
	}
}

/** Rebuilds a lightweight file-edit protocol part from persisted DB metadata. */
function storedFileEditContent(sessionUri: string, edit: IFileEditRecord): ToolResultFileEditContent {
	const beforePath = edit.originalPath ?? edit.filePath;
	const afterPath = edit.filePath;
	return {
		type: ToolResultContentType.FileEdit,
		...(edit.kind !== FileEditKind.Create ? {
			before: {
				uri: URI.file(beforePath).toString(),
				content: { uri: buildSessionDbUri(sessionUri, edit.toolCallId, edit.filePath, 'before') },
			},
		} : {}),
		...(edit.kind !== FileEditKind.Delete ? {
			after: {
				uri: URI.file(afterPath).toString(),
				content: { uri: buildSessionDbUri(sessionUri, edit.toolCallId, edit.filePath, 'after') },
			},
		} : {}),
		...(edit.addedLines !== undefined || edit.removedLines !== undefined
			? { diff: { added: edit.addedLines, removed: edit.removedLines } }
			: {}),
	};
}

function storedTurnToProtocolTurn(sessionId: string, index: number, turn: CliTsStoredTurn): Turn {
	const responseParts: Turn['responseParts'] = [];
	if (turn.parts?.length) {
		// Rich store: rebuild the same markdown/reasoning/tool-pill sequence the
		// live turn rendered, in original order.
		for (let p = 0; p < turn.parts.length; p++) {
			const part = turn.parts[p];
			const partId = `${sessionId}-${index}-${p}`;
			if (part.kind === 'markdown') {
				if (part.content) {
					responseParts.push({ kind: ResponsePartKind.Markdown, id: partId, content: part.content });
				}
			} else if (part.kind === 'reasoning') {
				if (part.content) {
					responseParts.push({ kind: ResponsePartKind.Reasoning, id: partId, content: part.content });
				}
			} else if (!isHiddenCliTsTool(part.name)) {
				const displayName = toolDisplayName(part.name);
				const toolUi = cliTsToolUiState(part.toolUi);
				const resultText = part.terminalOutput?.text ?? cliTsToolResultText(part.name, part.title, part.detail, part.inputSummary);
				const content: ToolResultContent[] = [];
				if (resultText) {
					content.push({ type: ToolResultContentType.Text, text: resultText });
				}
				if (part.fileEdits?.length) {
					content.push(...part.fileEdits);
				}
				responseParts.push({
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						status: ToolCallStatus.Completed,
						toolCallId: part.id,
						toolName: part.name,
						displayName,
						invocationMessage: toolInvocationMessage(part.name, part.inputSummary),
						toolInput: cliTsReadyToolInput(part.inputSummary, toolUi, part.terminalCommand),
						confirmed: ToolCallConfirmationReason.NotNeeded,
						success: !part.failed,
						pastTenseMessage: part.title ?? (part.failed
							? localize('cliTsAgent.toolFailed', "{0} failed", displayName)
							: localize('cliTsAgent.toolFinished', "{0} finished", displayName)),
						...(content.length ? { content } : {}),
						...(toolUi?.result ? { structuredContent: { backboardTool: toolUi.result } } : {}),
						...(part.failed && part.title ? { error: { message: part.title } } : {}),
						_meta: {
							...cliTsToolMetadata(part.name, isCliTsSubagentLauncherTool(part.name) && part.inputSummary ? { prompt: part.inputSummary, name: part.agentName } : undefined, toolUi?.kind, part.mutationBatch),
							...(part.terminalOutput?.exitCode !== undefined ? { terminalExitCode: part.terminalOutput.exitCode } : {}),
							...(part.terminalOutput?.truncated ? { terminalOutputTruncated: true } : {}),
						...(part.workspace ? workerWorkspaceMetadata(part.workspace) : {}),
						...(part.worker ? { subagentRevision: part.worker.revision } : {}),
						},
					},
				});
			}
		}
	} else {
		// Legacy store (pre-`parts`): compact bullet summaries + response text.
		const visibleTools = turn.tools?.filter(tool => !/^Ask[ _-]?User(?:\s|—|-|$)/i.test(tool));
		if (visibleTools?.length) {
			responseParts.push({
				kind: ResponsePartKind.Markdown,
				id: `${sessionId}-${index}-tools`,
				content: visibleTools.map(tool => `- ${tool}`).join('\n'),
			});
		}
		if (turn.response) {
			responseParts.push({
				kind: ResponsePartKind.Markdown,
				id: `${sessionId}-${index}-response`,
				content: turn.response,
			});
		}
	}
	return {
		id: turn.id ?? `${sessionId}-${index}`,
		message: {
			text: turn.prompt,
			origin: { kind: MessageKind.User },
		},
		responseParts,
		usage: turn.usage,
		state: turn.failed ? TurnState.Error : TurnState.Complete,
		...(turn.failed ? {
			error: {
				errorType: typeof turn.error?.errorType === 'string' && turn.error.errorType.trim() ? turn.error.errorType : 'BackboardError',
				message: typeof turn.error?.message === 'string' && turn.error.message.trim()
					? turn.error.message
					: localize('cliTsAgent.failedTurnMissingDetails', "This Backboard response failed. The original error details were not saved."),
			},
		} : {}),
	};
}
