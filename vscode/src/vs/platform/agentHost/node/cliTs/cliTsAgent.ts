/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, MessageAttachmentKind, MessageKind, ResponsePartKind, SessionStatus, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputAnswer, type ChatInputQuestion, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type SessionInputAnswer, type SessionInputResponseKind, type ToolCallResult, type ToolResultContent, type Turn } from '../../common/state/sessionState.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { FileEditTracker } from '../shared/fileEditTracker.js';
import type { IReference } from '../../../../base/common/lifecycle.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { BACKBOARD_ACCESS_MANUAL, BACKBOARD_MODE_PLAN, BUNDLED_BACKBOARD_MODELS, backboardModelInfos, bridgeConfig, createBackboardTurnSettings, fallbackModel, isBridgeModel, resolveBackboardSessionConfig } from './backboardRuntimeShared.js';

/** cli-ts tool name excluded from the turn when Web Search is toggled off. */
const CLI_TS_WEB_SEARCH_TOOL_NAME = 'WebSearch';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { CliTsServeProcess } from './cliTsProcess.js';
import type { CliTsAgentEvent, CliTsFileAttachment, CliTsPermissionPolicy, CliTsTurnStatus } from './cliTsProtocol.js';

const CLI_TS_STORE_VERSION = 1;

/**
 * One ordered, restorable piece of a completed turn's response. Markdown and
 * reasoning content accumulates during the live turn (hence mutable); tool
 * parts capture the compact completion facts needed to rebuild a real
 * completed tool-call pill (not the full result detail, which can be huge).
 */
type CliTsStoredPart =
	| { readonly kind: 'markdown'; content: string }
	| { readonly kind: 'reasoning'; content: string }
	| { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly inputSummary?: string; readonly title?: string; readonly failed?: boolean };

interface CliTsStoredTurn {
	readonly prompt: string;
	readonly response: string;
	readonly failed?: boolean;
	/** Legacy compact per-tool summaries; read for sessions stored before `parts`. */
	readonly tools?: readonly string[];
	/** Ordered rich parts for full-fidelity history restore. */
	readonly parts?: readonly CliTsStoredPart[];
}

interface CliTsStoredSession {
	readonly id: string;
	readonly title?: string;
	readonly cwd?: string;
	readonly createdAt: number;
	readonly modifiedAt: number;
	readonly threadId?: string;
	readonly turns: CliTsStoredTurn[];
}

interface CliTsTurnState {
	readonly turnId: string;
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
	/** In-flight async tool completions (file-edit diff builds), awaited before turn end. */
	readonly pendingCompletions: Promise<void>[];
	reasoningPartId?: string;
	didCreateReasoningPart?: boolean;
	reasoningText: string;
	didCreateStatusPart?: boolean;
	lastProgressMessage?: string;
	/** Last phase-status label shown in the pre-content progress line (dedupes re-fires). */
	lastStatusLabel?: string;
	responseText: string;
	failed?: boolean;
}

interface CliTsSession {
	readonly sessionUri: URI;
	readonly sessionId: string;
	readonly createdAt: number;
	modifiedAt: number;
	workingDirectory?: URI;
	model?: ModelSelection;
	config?: Record<string, unknown>;
	title?: string;
	threadId?: string;
	materialized: boolean;
	disposed: boolean;
	proc?: CliTsServeProcess;
	turn?: CliTsTurnState;
	/** Lazily-opened file-edit tracker + its session DB reference. */
	fileEdits?: { tracker: FileEditTracker; dbRef: IReference<ISessionDatabase> };
	/** cli-ts permission id per pending toolCallId (answered via respondToPermissionRequest). */
	readonly pendingPermissions: Map<string, string>;
	/** Pending cli-ts AskUser request ids (answered via respondToUserInputRequest). */
	readonly pendingInputs: Set<string>;
	readonly storedTurns: CliTsStoredTurn[];
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
	 * Starts as the compiled-in bundled list, immediately overlaid with the
	 * disk-cached list from the previous run (see constructor), and finally
	 * replaced with the backend's live list once a serve process is up. The
	 * picker therefore shows real models at window start instead of waiting
	 * out a network round-trip.
	 */
	private readonly _models = observableValue<readonly IAgentModelInfo[]>('cliTsModels', backboardModelInfos(BUNDLED_BACKBOARD_MODELS));
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, CliTsSession>();
	private _modelsRefreshed = false;
	private _rgDir: Promise<string | undefined> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._hydrateModelsFromCache();
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
				this._models.set(backboardModelInfos(models, BUNDLED_BACKBOARD_MODELS), undefined);
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

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('cliTsAgent.displayName', "Backboard"),
			description: localize('cliTsAgent.description', "Backboard agent backed by the cli-ts runtime"),
		};
	}

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		if (config.fork) {
			throw new Error('Backboard sessions do not support forking yet');
		}
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = config.session ?? AgentSession.uri(this.id, sessionId);
		const existing = this._sessions.get(sessionId);
		if (existing) {
			existing.workingDirectory = config.workingDirectory ?? existing.workingDirectory;
			existing.model = config.model ?? existing.model;
			existing.config = { ...(existing.config ?? {}), ...(config.config ?? {}) };
			return { session: sessionUri, workingDirectory: existing.workingDirectory, provisional: !existing.materialized };
		}
		const restored = config.session ? this._readStore().find(entry => entry.id === sessionId) : undefined;
		const session = this._createSessionEntry(sessionUri, restored);
		session.workingDirectory = config.workingDirectory ?? session.workingDirectory;
		session.model = config.model ?? session.model;
		session.config = config.config ?? session.config;
		this._sessions.set(sessionId, session);
		// Eagerly boot the serve process and pre-resolve the base assistant now,
		// while the composer is open and before the user's first message, so the
		// process spawn (~0.2s) and the first-ever assistant resolution (~1.4s)
		// happen during think-time instead of on the critical path to first
		// token. Best-effort and idempotent; sendMessage still ensures the
		// process if this was skipped.
		if (session.workingDirectory) {
			void this._prewarm(session);
		}
		return {
			session: sessionUri,
			workingDirectory: session.workingDirectory,
			project: session.workingDirectory ? { uri: session.workingDirectory, displayName: path.basename(session.workingDirectory.fsPath) } : undefined,
			provisional: !session.materialized,
		};
	}

	/**
	 * Spawns the serve process, fires a `warmup` op so the base assistant is
	 * resolved (and disk-cached) before the first message, and kicks off the
	 * model-list refresh in parallel — so the model picker shows the backend's
	 * real list while the composer is still open instead of only after the
	 * first submit. Best-effort.
	 */
	private async _prewarm(session: CliTsSession): Promise<void> {
		if (session.disposed || session.proc?.isRunning) {
			return;
		}
		try {
			const rgDir = await this._resolveRgDir();
			const proc = this._ensureProcess(session, rgDir);
			proc.notify({ op: 'warmup' });
			this._refreshModelsOnce(session);
		} catch (error) {
			this._logService.info(`[cli-ts] pre-warm skipped for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return resolveBackboardSessionConfig(params.config);
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const session = this._session(sessionUri);
		const effectiveTurnId = turnId ?? generateUuid();
		this._materialize(session);
		session.modifiedAt = Date.now();
		session.title ??= firstPromptLine(prompt);
		const prepared = prepareSubmitAttachments(prompt, attachments);

		const rgDir = await this._resolveRgDir();
		const proc = this._ensureProcess(session, rgDir);
		const storedConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		const settings = createBackboardTurnSettings(storedConfig, session.config, session.model);
		const permission: CliTsPermissionPolicy = settings.accessMode === BACKBOARD_ACCESS_MANUAL ? 'default' : 'autoApprove';
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
		const turn: CliTsTurnState = {
			turnId: effectiveTurnId,
			messageParts: new Map(),
			streamedText: new Map(),
			startedToolCalls: new Set(),
			confirmedToolCalls: new Set(),
			childToolLines: new Map(),
			toolSummaries: [],
			storedParts: [],
			storedTextParts: new Map(),
			toolInputs: new Map(),
			pendingCompletions: [],
			responseText: '',
			reasoningText: '',
		};
		session.turn = turn;
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
		this._logService.info(`[cli-ts] turn_start session=${session.sessionId} model=${settings.provider}/${settings.model} permission=${permission} cwd=${session.workingDirectory?.fsPath ?? '(missing)'}`);

		try {
			const record = await proc.request({
				op: 'submit',
				requestId: proc.nextRequestId(),
				prompt: prepared.prompt,
				// Resume the persisted backend thread so a fresh serve process
				// (window reload, crash, binary update) keeps the conversation's
				// memory. serve only adopts it while it has no thread binding.
				...(session.threadId ? { threadId: session.threadId } : {}),
				model: `${settings.provider}/${settings.model}`,
				permission,
				// Always send the semantic state. In particular, `off` must reach the
				// persistent serve process so a previous turn's thinking config is reset.
				thinking: settings.intensity,
				excludeReasoning: !settings.showReasoning,
				// Sent unconditionally so the persistent serve process resets
				// these when a toggle is turned back off between turns.
				memory: settings.memory,
				computerUse: settings.computerUse,
				browserUse: settings.browserUse,
				notify: settings.notifications,
				imageGeneration: settings.imageGeneration,
				excludedTools,
				...(prepared.files.length ? { files: prepared.files } : {}),
			});
			const status = (record.payload as { status?: CliTsTurnStatus } | undefined)?.status;
			if (status === 'failed' && !turn.failed) {
				turn.failed = true;
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId: effectiveTurnId,
					error: { errorType: 'BackboardSendFailed', message: localize('cliTsAgent.turnFailed', "The Backboard agent reported a failed turn.") },
				});
			}
			this._refreshModelsOnce(session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			turn.failed = true;
			this._fire(session.sessionUri, {
				type: ActionType.ChatError,
				turnId: effectiveTurnId,
				error: { errorType: 'BackboardSendFailed', message },
			});
		} finally {
			// Let in-flight file-edit diff builds finish so their
			// ChatToolCallComplete actions land before the turn is marked done.
			await Promise.allSettled(turn.pendingCompletions);
			session.storedTurns.push({
				prompt,
				response: turn.responseText,
				failed: turn.failed,
				...(turn.toolSummaries.length ? { tools: turn.toolSummaries } : {}),
				...(turn.storedParts.length ? { parts: turn.storedParts } : {}),
			});
			session.modifiedAt = Date.now();
			this._writeStore();
			session.turn = undefined;
			session.pendingPermissions.clear();
			session.pendingInputs.clear();
			this._fire(session.sessionUri, { type: ActionType.ChatTurnComplete, turnId: effectiveTurnId });
		}
	}

	async getSessionMessages(sessionUri: URI): Promise<readonly Turn[]> {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		const turns = session?.storedTurns ?? this._readStore().find(entry => entry.id === sessionId)?.turns ?? [];
		return turns.map((turn, index) => storedTurnToProtocolTurn(sessionId, index, turn));
	}

	async disposeSession(sessionUri: URI): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		if (session) {
			session.disposed = true;
			session.proc?.dispose();
			session.proc = undefined;
			session.fileEdits?.dbRef.dispose();
			session.fileEdits = undefined;
		}
		this._sessions.delete(sessionId);
	}

	async abortSession(sessionUri: URI): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session) {
			return;
		}
		session.proc?.notify({ op: 'cancel' });
		session.pendingPermissions.clear();
		session.pendingInputs.clear();
	}

	setPendingMessages(sessionUri: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		if (!steeringMessage?.message.text) {
			return;
		}
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session?.proc?.isRunning) {
			return;
		}
		// Forward the steering message; cli-ts interrupts the active turn and
		// front-queues it. Signal consumption so the host clears the pending slot.
		session.proc.notify({ op: 'steer', prompt: steeringMessage.message.text });
		this._onDidSessionProgress.fire({
			kind: 'steering_consumed',
			session: sessionUri,
			id: steeringMessage.id,
		});
	}

	async changeModel(sessionUri: URI, model: ModelSelection): Promise<void> {
		const session = this._session(sessionUri);
		session.model = model;
		if (session.proc?.isRunning && model.id) {
			session.proc.notify({ op: 'setModel', model: model.id });
		}
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const session of this._sessions.values()) {
			const permissionId = session.pendingPermissions.get(requestId);
			if (permissionId) {
				session.pendingPermissions.delete(requestId);
				if (approved) {
					session.turn?.confirmedToolCalls.add(requestId);
				}
				session.proc?.notify({ op: 'respondPermission', id: permissionId, decision: approved ? 'approve' : 'deny' });
				return;
			}
		}
		this._logService.warn(`[cli-ts] No pending tool approval found for ${requestId}`);
	}

	respondToUserInputRequest(requestId: string, response: SessionInputResponseKind, answers?: Record<string, SessionInputAnswer>): void {
		for (const session of this._sessions.values()) {
			if (session.pendingInputs.delete(requestId)) {
				const answer = response === ChatInputResponseKind.Accept ? inputAnswerText(answers) : '';
				session.proc?.notify({ op: 'respondInput', id: requestId, answer });
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
				project: session.workingDirectory ? { uri: session.workingDirectory, displayName: path.basename(session.workingDirectory.fsPath) } : undefined,
			}));
		const seen = new Set(inMemory.map(entry => AgentSession.id(entry.session)));
		const restored = this._readStore()
			.filter(entry => !seen.has(entry.id))
			.map(entry => {
				const workingDirectory = entry.cwd ? URI.file(entry.cwd) : undefined;
				return {
					session: AgentSession.uri(this.id, entry.id),
					startTime: entry.createdAt,
					modifiedTime: entry.modifiedAt,
					summary: entry.title,
					status: SessionStatus.Idle,
					workingDirectory,
					project: workingDirectory ? { uri: workingDirectory, displayName: path.basename(workingDirectory.fsPath) } : undefined,
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

	setClientTools(_session: URI, _clientId: string | undefined, tools: ToolDefinition[]): void {
		// cli-ts owns tool execution; client-contributed tools are not routed
		// through this provider. Log so mismatched expectations are visible.
		if (tools.length > 0) {
			this._logService.info(`[cli-ts] Ignoring ${tools.length} client tool(s); the cli-ts runtime executes its own tools.`);
		}
	}

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void {
		// No client tools are dispatched by this provider (see setClientTools).
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
	}

	async shutdown(): Promise<void> {
		for (const session of this._sessions.values()) {
			session.proc?.dispose();
			session.proc = undefined;
		}
		this._sessions.clear();
	}

	override dispose(): void {
		for (const session of this._sessions.values()) {
			session.proc?.dispose();
		}
		this._sessions.clear();
		super.dispose();
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
		return {
			sessionUri,
			sessionId: AgentSession.id(sessionUri),
			createdAt: restored?.createdAt ?? Date.now(),
			modifiedAt: restored?.modifiedAt ?? Date.now(),
			workingDirectory: restored?.cwd ? URI.file(restored.cwd) : undefined,
			title: restored?.title,
			threadId: restored?.threadId,
			materialized: !!restored,
			disposed: false,
			pendingPermissions: new Map(),
			pendingInputs: new Set(),
			storedTurns: [...(restored?.turns ?? [])],
		};
	}

	private _materialize(session: CliTsSession): void {
		if (session.materialized) {
			return;
		}
		session.materialized = true;
		this._onDidMaterializeSession.fire({
			session: session.sessionUri,
			workingDirectory: session.workingDirectory,
			project: session.workingDirectory ? { uri: session.workingDirectory, displayName: path.basename(session.workingDirectory.fsPath) } : undefined,
		});
	}

	private _ensureProcess(session: CliTsSession, rgDir?: string): CliTsServeProcess {
		if (session.proc?.isRunning) {
			return session.proc;
		}
		session.proc?.dispose();
		const proc = new CliTsServeProcess(this._logService, {
			workingDirectory: session.workingDirectory?.fsPath,
			extraPathDirs: rgDir ? [rgDir] : undefined,
			onEvent: event => this._handleAgentEvent(session, event),
			onExit: () => {
				session.pendingPermissions.clear();
				session.pendingInputs.clear();
			},
		});
		session.proc = proc;
		return proc;
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

	private _refreshModelsOnce(session: CliTsSession): void {
		if (this._modelsRefreshed || !session.proc?.isRunning) {
			return;
		}
		this._modelsRefreshed = true;
		const proc = session.proc;
		proc.request({ op: 'listModels', requestId: proc.nextRequestId() }).then(record => {
			const payload = record.payload as { models?: unknown[] } | undefined;
			const models = (payload?.models ?? []).filter(isBridgeModel);
			if (models.length) {
				// The bundled snapshot acts as a floor so a partial live result
				// (e.g. one upstream provider erroring) never shrinks the picker.
				const infos = backboardModelInfos(models, BUNDLED_BACKBOARD_MODELS);
				this._models.set(infos.length ? infos : [fallbackModel()], undefined);
				// Persist for instant hydration on the next window start.
				this._persistModelsCache(models);
			}
		}).catch(error => {
			this._modelsRefreshed = false;
			this._logService.warn(`[cli-ts] Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	// ---- event translation ---------------------------------------------------

	private _fire(session: URI, action: SessionAction | ChatAction): void {
		this._onDidSessionProgress.fire({ kind: 'action', session, action });
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
	private _fireStatus(session: CliTsSession, turn: CliTsTurnState, label: string): void {
		if (turn.lastStatusLabel === label) {
			return;
		}
		turn.lastStatusLabel = label;
		this._fire(session.sessionUri, {
			type: ActionType.ChatResponsePart,
			turnId: turn.turnId,
			part: { kind: ResponsePartKind.SystemNotification, content: label },
		});
	}

	private _handleAgentEvent(session: CliTsSession, event: CliTsAgentEvent): void {
		const turn = session.turn;
		if (!turn) {
			return;
		}
		const turnId = turn.turnId;
		switch (event.type) {
			case 'session:created':
				if (event.threadId) {
					session.threadId = event.threadId;
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
				this._fireStatus(session, turn, label);
				return;
			}
			case 'assistant:delta': {
				if (!event.text || !event.messageId) {
					return;
				}
				const partId = this._ensureMarkdownPart(session, turn, event.messageId);
				turn.streamedText.set(event.messageId, (turn.streamedText.get(event.messageId) ?? '') + event.text);
				turn.responseText += event.text;
				const storedDelta = turn.storedTextParts.get(partId);
				if (storedDelta) {
					storedDelta.content += event.text;
				}
				this._fire(session.sessionUri, { type: ActionType.ChatDelta, turnId, partId, content: event.text });
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
				const partId = this._ensureMarkdownPart(session, turn, event.messageId);
				const remainder = event.text.startsWith(streamed) ? event.text.slice(streamed.length) : event.text;
				if (remainder) {
					turn.streamedText.set(event.messageId, streamed + remainder);
					turn.responseText += remainder;
					const storedRemainder = turn.storedTextParts.get(partId);
					if (storedRemainder) {
						storedRemainder.content += remainder;
					}
					this._fire(session.sessionUri, { type: ActionType.ChatDelta, turnId, partId, content: remainder });
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
					this._fire(session.sessionUri, {
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
				this._fire(session.sessionUri, {
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
				for (const call of event.calls ?? []) {
					turn.toolInputs.set(call.id, { name: call.name, input: call.input });
				}
				return;
			case 'tool:discarded': {
				if (!event.toolCallId || !event.name || !turn.startedToolCalls.has(event.toolCallId)) {
					return;
				}
				// Backboard's early tool events are advisory. If the final
				// tool_submit_required frame omits one, close its speculative card
				// instead of leaving a permanent spinner behind.
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.toolCallId,
					invocationMessage: toolDisplayName(event.name),
					toolInput: '',
					_meta: { source: 'cli-ts' },
				});
				this._fire(session.sessionUri, {
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
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary);
				return;
			}
			case 'tool:start': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary);
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: event.toolCallId,
					invocationMessage: toolInvocationMessage(event.name, event.inputSummary),
					toolInput: event.inputSummary,
					confirmed: turn.confirmedToolCalls.has(event.toolCallId) ? ToolCallConfirmationReason.UserAction : ToolCallConfirmationReason.NotNeeded,
					_meta: { source: 'cli-ts' },
				});
				return;
			}
			case 'tool:progress': {
				if (!event.toolCallId || event.data === undefined) {
					return;
				}
				const text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
				this._fire(session.sessionUri, {
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
				this._fire(session.sessionUri, {
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
				this._ensureToolCallStart(session, turn, toolCallId, name, event.inputSummary);
				turn.toolSummaries.push(`${toolDisplayName(name)}${event.title ? ` — ${event.title}` : ''}`);
				turn.storedParts.push({
					kind: 'tool',
					id: toolCallId,
					name,
					...(event.inputSummary ? { inputSummary: event.inputSummary } : {}),
					...(event.title ? { title: event.title } : {}),
				});
				const text = [event.title, event.detail].filter(part => !!part).join('\n');
				const fileEdits = Array.isArray(event.fileEdits) ? event.fileEdits : [];
				const completion = (async (): Promise<void> => {
					const content: ToolResultContent[] = text ? [{ type: ToolResultContentType.Text, text }] : [];
					if (fileEdits.length) {
						const edits = await this._buildFileEditContents(session, turn, toolCallId, name, fileEdits);
						content.push(...edits);
					}
					this._fire(session.sessionUri, {
						type: ActionType.ChatToolCallComplete,
						turnId,
						toolCallId,
						result: {
							success: true,
							pastTenseMessage: event.title ?? localize('cliTsAgent.toolFinished', "{0} finished", toolDisplayName(name)),
							content: content.length ? content : undefined,
						},
					});
				})();
				turn.pendingCompletions.push(completion);
				return;
			}
			case 'tool:error': {
				if (!event.toolCallId || !event.name) {
					return;
				}
				this._ensureToolCallStart(session, turn, event.toolCallId, event.name, event.inputSummary);
				turn.storedParts.push({
					kind: 'tool',
					id: event.toolCallId,
					name: event.name,
					failed: true,
					...(event.inputSummary ? { inputSummary: event.inputSummary } : {}),
					...(event.error ? { title: event.error.slice(0, 200) } : {}),
				});
				const message = event.error ?? localize('cliTsAgent.toolFailedNoDetail', "The tool call failed.");
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: event.toolCallId,
					result: {
						success: false,
						pastTenseMessage: localize('cliTsAgent.toolFailed', "{0} failed", toolDisplayName(event.name)),
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				return;
			}
			case 'permission:request': {
				const request = event.request;
				if (!request?.id || !request.toolCallId || !request.name) {
					return;
				}
				this._ensureToolCallStart(session, turn, request.toolCallId, request.name, request.inputSummary);
				session.pendingPermissions.set(request.toolCallId, request.id);
				this._onDidSessionProgress.fire({
					kind: 'pending_confirmation',
					session: session.sessionUri,
					permissionKind: 'write',
					state: {
						status: ToolCallStatus.PendingConfirmation,
						toolCallId: request.toolCallId,
						toolName: request.name,
						displayName: toolDisplayName(request.name),
						invocationMessage: toolInvocationMessage(request.name, request.inputSummary),
						toolInput: request.inputSummary,
						confirmationTitle: localize('cliTsAgent.confirmationTitle', "Allow Backboard to use {0}?", toolDisplayName(request.name)),
						_meta: { source: 'cli-ts' },
					},
				});
				return;
			}
			case 'input:request': {
				const request = event.request;
				if (!request?.id || !request.question) {
					return;
				}
				session.pendingInputs.add(request.id);
				const options = request.options ?? [];
				const question: ChatInputQuestion = options.length
					? {
						id: 'answer',
						kind: ChatInputQuestionKind.SingleSelect,
						message: request.question,
						required: true,
						options: options.map(option => ({ id: option, label: option })),
						allowFreeformInput: true,
					}
					: {
						id: 'answer',
						kind: ChatInputQuestionKind.Text,
						message: request.question,
						required: true,
					};
				this._fire(session.sessionUri, {
					type: ActionType.ChatInputRequested,
					request: { id: request.id, message: request.question, questions: [question] },
				});
				return;
			}
			case 'usage': {
				const usage = event.usage;
				if (!usage) {
					return;
				}
				this._fire(session.sessionUri, {
					type: ActionType.ChatUsage,
					turnId,
					usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model },
				});
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
				this._fire(session.sessionUri, {
					type: ActionType.ChatResponsePart,
					turnId,
					part: { kind: ResponsePartKind.SystemNotification, content: localize('cliTsAgent.warning', "Backboard: {0}", event.message) },
				});
				return;
			}
			case 'run:error': {
				turn.failed = true;
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId,
					error: { errorType: 'BackboardError', message: event.error ?? localize('cliTsAgent.requestFailed', "Backboard request failed.") },
				});
				return;
			}
			default:
				return;
		}
	}

	private _ensureMarkdownPart(session: CliTsSession, turn: CliTsTurnState, messageId: string): string {
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
		});
		return partId;
	}

	private _ensureToolCallStart(session: CliTsSession, turn: CliTsTurnState, toolCallId: string, toolName: string, inputSummary?: string): void {
		if (turn.startedToolCalls.has(toolCallId)) {
			return;
		}
		turn.startedToolCalls.add(toolCallId);
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallStart,
			turnId: turn.turnId,
			toolCallId,
			toolName,
			displayName: toolDisplayName(toolName),
			_meta: { source: 'cli-ts' },
		});
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallDelta,
			turnId: turn.turnId,
			toolCallId,
			content: inputSummary ?? '',
		});
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

	private _readStore(): CliTsStoredSession[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this._storePath(), 'utf8'));
			if (!parsed || typeof parsed !== 'object' || (parsed as { version?: number }).version !== CLI_TS_STORE_VERSION) {
				return [];
			}
			const sessions = (parsed as { sessions?: unknown }).sessions;
			return Array.isArray(sessions) ? sessions as CliTsStoredSession[] : [];
		} catch {
			return [];
		}
	}

	private _writeStore(): void {
		try {
			const persisted = this._readStore().filter(entry => !this._sessions.has(entry.id));
			const inMemory: CliTsStoredSession[] = [...this._sessions.values()]
				.filter(session => session.materialized)
				.map(session => ({
					id: session.sessionId,
					title: session.title,
					cwd: session.workingDirectory?.fsPath,
					createdAt: session.createdAt,
					modifiedAt: session.modifiedAt,
					threadId: session.threadId,
					turns: session.storedTurns,
				}));
			const storePath = this._storePath();
			fs.mkdirSync(path.dirname(storePath), { recursive: true });
			fs.writeFileSync(storePath, `${JSON.stringify({ version: CLI_TS_STORE_VERSION, sessions: [...inMemory, ...persisted] }, undefined, '\t')}\n`, 'utf8');
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to persist session store: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

// ---- helpers -----------------------------------------------------------------

function firstPromptLine(prompt: string): string {
	const line = prompt.split('\n', 1)[0]?.trim() ?? '';
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** `apply_patch` → `Apply Patch`, `mcp__linear__create_issue` → `linear: create issue`. */
function toolDisplayName(toolName: string): string {
	if (toolName.startsWith('mcp__')) {
		const [, server, ...rest] = toolName.split('__');
		return `${server}: ${rest.join(' ').replaceAll('_', ' ')}`;
	}
	return toolName.split('_').map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
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

function inputAnswerText(answers?: Record<string, SessionInputAnswer>): string {
	const answer: ChatInputAnswer | undefined = answers?.['answer'] ?? (answers ? Object.values(answers)[0] : undefined);
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
			} else {
				const displayName = toolDisplayName(part.name);
				responseParts.push({
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						status: ToolCallStatus.Completed,
						toolCallId: part.id,
						toolName: part.name,
						displayName,
						invocationMessage: toolInvocationMessage(part.name, part.inputSummary),
						toolInput: part.inputSummary,
						confirmed: ToolCallConfirmationReason.NotNeeded,
						success: !part.failed,
						pastTenseMessage: part.title ?? (part.failed
							? localize('cliTsAgent.toolFailed', "{0} failed", displayName)
							: localize('cliTsAgent.toolFinished', "{0} finished", displayName)),
						...(part.title ? { content: [{ type: ToolResultContentType.Text, text: part.title }] } : {}),
						...(part.failed && part.title ? { error: { message: part.title } } : {}),
						_meta: { source: 'cli-ts' },
					},
				});
			}
		}
	} else {
		// Legacy store (pre-`parts`): compact bullet summaries + response text.
		if (turn.tools?.length) {
			responseParts.push({
				kind: ResponsePartKind.Markdown,
				id: `${sessionId}-${index}-tools`,
				content: turn.tools.map(tool => `- ${tool}`).join('\n'),
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
		id: `${sessionId}-${index}`,
		message: {
			text: turn.prompt,
			origin: { kind: MessageKind.User },
		},
		responseParts,
		usage: undefined,
		state: turn.failed ? TurnState.Error : TurnState.Complete,
	};
}
