/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { homedir } from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { delimiter, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { createSchema } from '../../common/agentHostSchema.js';
import { AgentSession, AgentSignal, GITHUB_COPILOT_PROTECTED_RESOURCE, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, type AgentProvider } from '../../common/agentService.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { ChatInputResponseKind, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, TurnState, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type ResponsePart, type ToolCallResult, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';

/**
 * Locate an `opencode` binary on PATH. OpenCode is subscription-native only:
 * there is no SDK distribution, so the user's own install (the CLI they ran
 * `opencode auth login` with — the t3code model) is the only spawn source.
 */
export function findOpenCodeOnPath(): string | undefined {
	const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
	// Scan well-known user install dirs after PATH — the GUI app's
	// login-shell PATH often misses them (see findCodexOnPath).
	const dirs = [
		...(process.env.PATH?.split(delimiter) ?? []),
		join(homedir(), '.local', 'bin'),
		join(homedir(), 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
	];
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// keep scanning
			}
		}
	}
	return undefined;
}

/**
 * Static bootstrap model catalog shown before the server's own `/provider`
 * responds. These are the always-connected OpenCode Zen free models; the live
 * per-account list (which grows with every `opencode auth login`) replaces
 * this at first connection.
 */
const FALLBACK_OPENCODE_MODELS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
	{ id: 'opencode/big-pickle', name: 'Big Pickle' },
	{ id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
	{ id: 'opencode/mimo-v2.5-free', name: 'MiMo V2.5 Free' },
	{ id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
];

/** Matches the server's readiness line, e.g. `opencode server listening on http://127.0.0.1:14096`. */
const SERVER_READY_RE = /listening on\s+(https?:\/\/\S+)/;

const SERVER_START_TIMEOUT_MS = 30_000;

/** Session config schema: OpenCode drives everything server-side; nothing is configurable yet. */
const opencodeSessionConfigSchema = createSchema({});

// #region OpenCode wire types (hand-rolled: opencode has no published TS protocol)

interface IOcModel {
	readonly id: string;
	readonly name?: string;
	readonly attachment?: boolean;
	readonly limit?: { readonly context?: number };
}

interface IOcProvider {
	readonly id: string;
	readonly name?: string;
	readonly models: Record<string, IOcModel>;
}

interface IOcProviderList {
	readonly all: readonly IOcProvider[];
	readonly connected: readonly string[];
}

interface IOcSessionInfo {
	readonly id: string;
	readonly title?: string;
	readonly directory?: string;
	readonly time?: { readonly created?: number; readonly updated?: number };
}

interface IOcToolState {
	readonly status: 'pending' | 'running' | 'completed' | 'error';
	readonly input?: Record<string, unknown>;
	readonly output?: string;
	readonly error?: string;
}

interface IOcPart {
	readonly id: string;
	readonly messageID: string;
	readonly sessionID?: string;
	readonly type: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish' | string;
	readonly text?: string;
	readonly tool?: string;
	readonly callID?: string;
	readonly state?: IOcToolState;
	readonly tokens?: { readonly input?: number; readonly output?: number; readonly reasoning?: number; readonly cache?: { readonly read?: number; readonly write?: number } };
	readonly time?: { readonly start?: number; readonly end?: number };
}

interface IOcMessageInfo {
	readonly id: string;
	readonly role: 'user' | 'assistant' | string;
	readonly sessionID: string;
}

interface IOcMessageWithParts {
	readonly info: IOcMessageInfo;
	readonly parts: readonly IOcPart[];
}

interface IOcEvent {
	readonly type: string;
	readonly properties: {
		readonly sessionID?: string;
		readonly info?: IOcSessionInfo & IOcMessageInfo;
		readonly part?: IOcPart;
		readonly messageID?: string;
		readonly partID?: string;
		readonly field?: string;
		readonly delta?: string;
		// permission.asked
		readonly id?: string;
		readonly permission?: string;
		readonly patterns?: readonly string[];
		readonly metadata?: Record<string, unknown>;
		readonly tool?: { readonly messageID: string; readonly callID: string };
		// session.error
		readonly error?: { readonly message?: string } | string;
	};
}

// #endregion

interface IOpenCodeServer {
	readonly baseUrl: string;
	readonly authHeader: string;
	readonly child: ChildProcess;
}

type ServerState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'starting'; readonly promise: Promise<IOpenCodeServer> }
	| ({ readonly kind: 'ready' } & IOpenCodeServer);

/** Tracks a streamed markdown/reasoning response part so late `part.updated` snapshots only emit the unseen suffix. */
interface IPartTracker {
	readonly kind: 'text' | 'reasoning';
	emittedLength: number;
}

interface IToolTracker {
	readonly toolName: string;
	started: boolean;
	readyFired: boolean;
	completed: boolean;
	/** Set when a `permission.asked` interposed — the ready card is then owned by the approval flow. */
	awaitingApproval: boolean;
}

interface IOpenCodeSession {
	readonly sessionUri: URI;
	readonly rawId: string;
	workingDirectory: URI;
	ocSessionId: string | undefined;
	model: ModelSelection | undefined;
	disposed: boolean;
	materializePromise: Promise<void> | undefined;
	activeTurnId: string | undefined;
	cancelRequested: boolean;
	title: string | undefined;
	readonly startTime: number;
	modifiedTime: number;
	/** Assistant message ids for the current turn — parts of other roles are echoes of our own prompt. */
	readonly assistantMessageIds: Set<string>;
	/** partID → tracker for text/reasoning parts of the current turn. */
	readonly parts: Map<string, IPartTracker>;
	/** Deltas that arrived before the introducing `message.part.updated`; flushed on registration. */
	readonly pendingPartDeltas: Map<string, string[]>;
	/** callID → tracker for tool parts of the current turn. */
	readonly tools: Map<string, IToolTracker>;
	readonly pendingApprovals: PendingRequestRegistry<'accept' | 'decline'>;
}

/**
 * OpenCode agent provider. Subscription-native from day one: spawns the
 * user's own `opencode` CLI as a local HTTP server (`opencode serve`) and
 * drives it over its REST + SSE surface. Auth comes entirely from the
 * user's `opencode auth login` state (~/.local/share/opencode/auth.json);
 * the always-connected OpenCode Zen provider supplies free models even
 * before any login.
 */
export class OpenCodeAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = 'opencode';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, IOpenCodeSession>();
	/** One SSE stream per distinct working directory (opencode scopes /event by project). */
	private readonly _eventStreams = new Map<string, AbortController>();
	private _server: ServerState = { kind: 'idle' };

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._models.set(this._fallbackModels(), undefined);
	}

	// #region Auth

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [GITHUB_COPILOT_PROTECTED_RESOURCE];
	}

	async authenticate(resource: string, _token: string): Promise<boolean> {
		// OpenCode is subscription-native: model traffic authenticates via the
		// user's own `opencode auth login`. The workbench's GitHub token is
		// accepted for the protected-resources contract but never used.
		return resource === GITHUB_COPILOT_PROTECTED_RESOURCE.resource;
	}

	// #endregion

	// #region Models

	private _fallbackModels(): IAgentModelInfo[] {
		return FALLBACK_OPENCODE_MODELS.map((m): IAgentModelInfo => ({
			provider: this.id,
			id: m.id,
			name: m.name,
			supportsVision: false,
			_meta: { description: localize('opencode.model.zen', "OpenCode Zen") },
		}));
	}

	/**
	 * Replace the catalog with every model of every *connected* provider.
	 * Providers connect through `opencode auth login`, so this list grows as
	 * the user links subscriptions; OpenCode Zen is always connected and
	 * anchors the free tier. Non-Zen (user-linked) providers sort first.
	 */
	private async _refreshModels(server: IOpenCodeServer): Promise<void> {
		try {
			const providers = await this._request<IOcProviderList>(server, 'GET', '/provider');
			const connected = new Set(providers.connected);
			const linked: IAgentModelInfo[] = [];
			const zen: IAgentModelInfo[] = [];
			for (const provider of providers.all) {
				if (!connected.has(provider.id)) {
					continue;
				}
				for (const model of Object.values(provider.models)) {
					const info: IAgentModelInfo = {
						provider: this.id,
						id: `${provider.id}/${model.id}`,
						name: model.name || model.id,
						supportsVision: !!model.attachment,
						...(model.limit?.context ? { maxContextWindow: model.limit.context } : {}),
						_meta: { description: provider.name ?? provider.id },
					};
					(provider.id === 'opencode' ? zen : linked).push(info);
				}
			}
			const models = [...linked, ...zen];
			if (models.length) {
				this._models.set(models, undefined);
				this._logService.info(`[OpenCode] Models refreshed. Connected providers: ${providers.connected.join(', ')} (${models.length} models)`);
			}
		} catch (err) {
			this._logService.warn(`[OpenCode] /provider failed; keeping fallback catalog: ${toMessage(err)}`);
		}
	}

	private _defaultModel(): ModelSelection | undefined {
		const first = this._models.get()[0];
		return first ? { id: first.id } : undefined;
	}

	// #endregion

	// #region Server lifecycle

	private _ensureServer(): Promise<IOpenCodeServer> {
		if (this._server.kind === 'ready') {
			return Promise.resolve(this._server);
		}
		if (this._server.kind === 'starting') {
			return this._server.promise;
		}
		const promise = this._startServer().then(server => {
			this._server = { kind: 'ready', ...server };
			return server;
		}).catch(err => {
			this._server = { kind: 'idle' };
			throw err;
		});
		this._server = { kind: 'starting', promise };
		return promise;
	}

	private async _startServer(): Promise<IOpenCodeServer> {
		const binaryPath = findOpenCodeOnPath();
		if (!binaryPath) {
			throw new Error(`OpenCode CLI not found: install it (npm install -g opencode-ai) so 'opencode' is on PATH.`);
		}
		const port = await findFreePort();
		const password = generateUuid();
		// OPENCODE_CONFIG_CONTENT keeps the server independent of the user's
		// opencode.json (themes, MCP servers, keybinds — irrelevant and
		// potentially breaking here); auth state lives in auth.json and is
		// unaffected. The password closes the otherwise-unsecured local port.
		const env: NodeJS.ProcessEnv = {
			...process.env,
			OPENCODE_CONFIG_CONTENT: '{}',
			OPENCODE_SERVER_PASSWORD: password,
		};
		const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`];
		this._logService.info(`[OpenCode] spawning ${binaryPath} ${args.join(' ')}`);
		const child = spawn(binaryPath, args, { env, cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', chunk => this._logService.info(`[OpenCode stderr] ${String(chunk).trimEnd()}`));
		child.on('exit', (code, signal) => {
			this._logService.warn(`[OpenCode] server exited code=${code} signal=${signal}`);
			this._handleServerLost();
		});

		const baseUrl = await new Promise<string>((resolve, reject) => {
			let buffer = '';
			const timeout = setTimeout(() => {
				try { child.kill('SIGKILL'); } catch { /* already dead */ }
				reject(new Error(`OpenCode server did not become ready within ${SERVER_START_TIMEOUT_MS}ms`));
			}, SERVER_START_TIMEOUT_MS);
			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', (chunk: string) => {
				this._logService.trace(`[OpenCode stdout] ${chunk.trimEnd()}`);
				buffer += chunk;
				const match = SERVER_READY_RE.exec(buffer);
				if (match) {
					clearTimeout(timeout);
					resolve(match[1]);
				}
			});
			child.once('exit', () => {
				clearTimeout(timeout);
				reject(new Error('OpenCode server exited during startup'));
			});
		});

		const server: IOpenCodeServer = {
			baseUrl,
			authHeader: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
			child,
		};
		this._logService.info(`[OpenCode] server ready at ${baseUrl}`);
		void this._refreshModels(server);
		return server;
	}

	private _handleServerLost(): void {
		this._server = { kind: 'idle' };
		for (const controller of this._eventStreams.values()) {
			controller.abort();
		}
		this._eventStreams.clear();
		for (const session of this._sessions.values()) {
			session.ocSessionId = undefined;
			session.materializePromise = undefined;
			session.pendingApprovals.denyAll('decline');
			if (session.activeTurnId) {
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId: session.activeTurnId,
					error: { errorType: 'OpenCodeServerLost', message: localize('opencode.serverLost', "The OpenCode server terminated unexpectedly.") },
				});
				this._fire(session.sessionUri, { type: ActionType.ChatTurnComplete, turnId: session.activeTurnId });
				session.activeTurnId = undefined;
			}
		}
	}

	// #endregion

	// #region HTTP + SSE

	private async _request<T>(server: IOpenCodeServer, method: 'GET' | 'POST', path: string, directory?: URI, body?: unknown): Promise<T> {
		const url = new globalThis.URL(server.baseUrl + path);
		if (directory) {
			url.searchParams.set('directory', directory.fsPath);
		}
		const response = await globalThis.fetch(url, {
			method,
			headers: {
				'Authorization': server.authHeader,
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`OpenCode ${method} ${path} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
		}
		if (response.status === 204) {
			return undefined as T;
		}
		const raw = await response.text();
		return (raw ? JSON.parse(raw) : undefined) as T;
	}

	/**
	 * Open (once per distinct directory) the server's SSE feed. OpenCode
	 * scopes `/event` to the project of the given directory, so sessions in
	 * different folders need their own streams. Events are routed to
	 * sessions by `properties.sessionID`.
	 */
	private _ensureEventStream(server: IOpenCodeServer, directory: URI): void {
		const key = directory.fsPath;
		if (this._eventStreams.has(key)) {
			return;
		}
		const controller = new AbortController();
		this._eventStreams.set(key, controller);
		void this._runEventStream(server, directory, controller).catch(err => {
			if (!controller.signal.aborted) {
				this._logService.error(`[OpenCode] event stream for ${key} failed: ${toMessage(err)}`);
				this._eventStreams.delete(key);
			}
		});
	}

	private async _runEventStream(server: IOpenCodeServer, directory: URI, controller: AbortController): Promise<void> {
		const url = new globalThis.URL(server.baseUrl + '/event');
		url.searchParams.set('directory', directory.fsPath);
		const response = await globalThis.fetch(url, {
			headers: { 'Authorization': server.authHeader, 'Accept': 'text/event-stream' },
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`OpenCode /event failed: HTTP ${response.status}`);
		}
		this._logService.info(`[OpenCode] event stream open for ${directory.fsPath}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				try {
					const event = JSON.parse(line.slice(5)) as IOcEvent;
					this._logService.trace(`[OpenCode] event ${event.type} session=${event.properties?.sessionID ?? '-'}`);
					this._handleEvent(event);
				} catch (err) {
					this._logService.warn(`[OpenCode] bad event payload: ${toMessage(err)}`);
				}
			}
		}
	}

	// #endregion

	// #region Event mapping

	private _sessionByOcId(ocSessionId: string | undefined): IOpenCodeSession | undefined {
		if (!ocSessionId) {
			return undefined;
		}
		for (const session of this._sessions.values()) {
			if (session.ocSessionId === ocSessionId) {
				return session;
			}
		}
		return undefined;
	}

	private _handleEvent(event: IOcEvent): void {
		const props = event.properties;
		const session = this._sessionByOcId(props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID);
		if (!session || session.disposed) {
			return;
		}
		switch (event.type) {
			case 'message.updated':
				if (props.info?.role === 'assistant') {
					session.assistantMessageIds.add(props.info.id);
				}
				break;
			case 'message.part.updated':
				if (props.part) {
					this._handlePartUpdated(session, props.part);
				}
				break;
			case 'message.part.delta':
				this._handlePartDelta(session, props.messageID, props.partID, props.delta ?? '');
				break;
			case 'session.updated': {
				const title = props.info?.title;
				if (title && title !== session.title && !title.startsWith('New session')) {
					session.title = title;
					this._fire(session.sessionUri, { type: ActionType.SessionTitleChanged, title });
				}
				session.modifiedTime = Date.now();
				break;
			}
			case 'session.idle':
				this._completeTurn(session);
				break;
			case 'session.error': {
				const message = typeof props.error === 'string' ? props.error : props.error?.message ?? localize('opencode.unknownError', "Unknown OpenCode error");
				if (session.activeTurnId) {
					this._fire(session.sessionUri, { type: ActionType.ChatError, turnId: session.activeTurnId, error: { errorType: 'OpenCodeSessionError', message } });
				}
				this._completeTurn(session);
				break;
			}
			case 'permission.asked':
				this._handlePermissionAsked(session, event);
				break;
		}
	}

	private _handlePartUpdated(session: IOpenCodeSession, part: IOcPart): void {
		const turnId = session.activeTurnId;
		if (!turnId || !session.assistantMessageIds.has(part.messageID)) {
			return;
		}
		if (part.type === 'text' || part.type === 'reasoning') {
			const kind = part.type === 'text' ? 'text' : 'reasoning';
			let tracker = session.parts.get(part.id);
			if (!tracker) {
				tracker = { kind, emittedLength: 0 };
				session.parts.set(part.id, tracker);
				this._fire(session.sessionUri, {
					type: ActionType.ChatResponsePart,
					turnId,
					part: kind === 'text'
						? { kind: ResponsePartKind.Markdown, id: part.id, content: '' }
						: { kind: ResponsePartKind.Reasoning, id: part.id, content: '' },
				});
				const buffered = session.pendingPartDeltas.get(part.id);
				if (buffered) {
					session.pendingPartDeltas.delete(part.id);
					for (const delta of buffered) {
						this._emitPartDelta(session, turnId, part.id, tracker, delta);
					}
				}
			}
			// Snapshot updates carry the full accumulated text; emit only what
			// deltas have not already covered (handles non-streaming providers).
			const text = part.text ?? '';
			if (text.length > tracker.emittedLength) {
				this._emitPartDelta(session, turnId, part.id, tracker, text.slice(tracker.emittedLength));
			}
			return;
		}
		if (part.type === 'tool' && part.callID) {
			this._handleToolPart(session, turnId, part);
			return;
		}
		if (part.type === 'step-finish' && part.tokens) {
			const usage: UsageInfo = {
				inputTokens: part.tokens.input,
				outputTokens: part.tokens.output,
				cacheReadTokens: part.tokens.cache?.read,
			};
			this._fire(session.sessionUri, { type: ActionType.ChatUsage, turnId, usage });
		}
	}

	private _emitPartDelta(session: IOpenCodeSession, turnId: string, partId: string, tracker: IPartTracker, content: string): void {
		if (!content) {
			return;
		}
		tracker.emittedLength += content.length;
		this._fire(session.sessionUri, tracker.kind === 'text'
			? { type: ActionType.ChatDelta, turnId, partId, content }
			: { type: ActionType.ChatReasoning, turnId, partId, content });
	}

	private _handlePartDelta(session: IOpenCodeSession, messageID: string | undefined, partID: string | undefined, delta: string): void {
		const turnId = session.activeTurnId;
		if (!turnId || !partID || !messageID || !session.assistantMessageIds.has(messageID)) {
			return;
		}
		const tracker = session.parts.get(partID);
		if (!tracker) {
			// Delta raced ahead of its introducing part.updated — buffer it.
			const buffered = session.pendingPartDeltas.get(partID);
			if (buffered) {
				buffered.push(delta);
			} else {
				session.pendingPartDeltas.set(partID, [delta]);
			}
			return;
		}
		this._emitPartDelta(session, turnId, partID, tracker, delta);
	}

	private _handleToolPart(session: IOpenCodeSession, turnId: string, part: IOcPart): void {
		const callId = part.callID!;
		const toolName = part.tool ?? 'tool';
		let tracker = session.tools.get(callId);
		if (!tracker) {
			tracker = { toolName, started: false, readyFired: false, completed: false, awaitingApproval: false };
			session.tools.set(callId, tracker);
		}
		if (!tracker.started) {
			tracker.started = true;
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallStart,
				turnId,
				toolCallId: callId,
				toolName,
				displayName: toolName,
				...(toolKindFor(toolName) ? { _meta: { toolKind: toolKindFor(toolName) } } : {}),
			});
		}
		const status = part.state?.status;
		if (status === 'running' && !tracker.readyFired && !tracker.awaitingApproval) {
			tracker.readyFired = true;
			const invocation = invocationMessageFor(toolName, part.state?.input);
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallDelta,
				turnId,
				toolCallId: callId,
				content: invocation,
			});
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallReady,
				turnId,
				toolCallId: callId,
				invocationMessage: invocation,
				toolInput: invocation,
				// OpenCode executes its own tools; approvals surface separately
				// via `permission.asked`, so plain running tools never prompt.
				confirmed: ToolCallConfirmationReason.NotNeeded,
				...(toolKindFor(toolName) ? { _meta: { toolKind: toolKindFor(toolName) } } : {}),
			});
		}
		if ((status === 'completed' || status === 'error') && !tracker.completed) {
			tracker.completed = true;
			if (!tracker.readyFired) {
				// Tool jumped straight to a terminal state (or approval was
				// rejected) — ensure the card leaves the pending state.
				tracker.readyFired = true;
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: callId,
					invocationMessage: invocationMessageFor(toolName, part.state?.input),
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
			}
			const success = status === 'completed';
			const output = success ? part.state?.output : (part.state?.error ?? part.state?.output);
			const result: ToolCallResult = {
				success,
				pastTenseMessage: success
					? localize('opencode.toolRan', "Ran {0}", toolName)
					: localize('opencode.toolFailed', "{0} failed", toolName),
				...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
				...(success ? {} : { error: { message: output ?? 'Tool failed' } }),
			};
			this._fire(session.sessionUri, { type: ActionType.ChatToolCallComplete, turnId, toolCallId: callId, result });
		}
	}

	private _handlePermissionAsked(session: IOpenCodeSession, event: IOcEvent): void {
		const props = event.properties;
		const permissionId = props.id;
		const callId = props.tool?.callID;
		const turnId = session.activeTurnId;
		if (!permissionId || !turnId) {
			return;
		}
		// Anchor the approval card on the tool call when there is one;
		// otherwise mint a standalone id so bare permissions still render.
		const anchorId = callId ?? `opencode-permission-${permissionId}`;
		const tracker = callId ? session.tools.get(callId) : undefined;
		if (tracker) {
			tracker.awaitingApproval = true;
			tracker.readyFired = true;
		}
		const command = typeof props.metadata?.command === 'string' ? props.metadata.command : undefined;
		const invocation = command ?? props.patterns?.join(', ') ?? props.permission ?? 'permission';
		const confirmationTitle = localize('opencode.permissionTitle', "OpenCode wants to use {0}", props.permission ?? 'a tool');
		void (async () => {
			const decision = await session.pendingApprovals.registerAndFire(anchorId, () => {
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: anchorId,
					invocationMessage: invocation,
					toolInput: invocation,
					confirmationTitle,
					...(command ? { _meta: { toolKind: 'terminal' } } : {}),
				});
			});
			const server = this._server.kind === 'ready' ? this._server : undefined;
			if (!server || session.disposed || !session.ocSessionId) {
				return;
			}
			try {
				await this._request(server, 'POST', `/session/${session.ocSessionId}/permissions/${permissionId}`, session.workingDirectory, {
					response: decision === 'accept' ? 'once' : 'reject',
				});
			} catch (err) {
				this._logService.error(`[OpenCode] permission reply failed: ${toMessage(err)}`);
			}
		})();
	}

	private _completeTurn(session: IOpenCodeSession): void {
		const turnId = session.activeTurnId;
		if (!turnId) {
			return;
		}
		session.activeTurnId = undefined;
		session.modifiedTime = Date.now();
		session.parts.clear();
		session.pendingPartDeltas.clear();
		session.tools.clear();
		session.assistantMessageIds.clear();
		session.pendingApprovals.denyAll('decline');
		const cancelled = session.cancelRequested;
		session.cancelRequested = false;
		this._fire(session.sessionUri, cancelled
			? { type: ActionType.ChatTurnCancelled, turnId }
			: { type: ActionType.ChatTurnComplete, turnId });
	}

	// #endregion

	// #region IAgent — sessions

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('opencodeAgent.displayName', "OpenCode"),
			description: localize('opencodeAgent.description', "OpenCode agent backed by the user's own opencode CLI"),
		};
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		if (!config?.workingDirectory) {
			throw new Error('OpenCode sessions require a working directory');
		}
		const rawId = config.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = config.session ?? AgentSession.uri(this.id, rawId);
		const session: IOpenCodeSession = {
			sessionUri,
			rawId,
			workingDirectory: config.workingDirectory,
			ocSessionId: undefined,
			model: config.model,
			disposed: false,
			materializePromise: undefined,
			activeTurnId: undefined,
			cancelRequested: false,
			title: undefined,
			startTime: Date.now(),
			modifiedTime: Date.now(),
			assistantMessageIds: new Set(),
			parts: new Map(),
			pendingPartDeltas: new Map(),
			tools: new Map(),
			pendingApprovals: new PendingRequestRegistry<'accept' | 'decline'>(),
		};
		this._sessions.set(rawId, session);
		// Prewarm: materialize immediately (spawns the server, creates the
		// opencode session, opens the event stream, refreshes the model
		// catalog). Mirrors codex's prewarm — the sessions window swaps the
		// new-chat composer to the real session when materialization is
		// announced, so deferring this to first send would leave the visible
		// widget bound to the provisional placeholder.
		void this._materialize(session).catch(err => this._logService.warn(`[OpenCode] prewarm failed (retried at first send): ${toMessage(err)}`));
		return { session: sessionUri, workingDirectory: config.workingDirectory, provisional: true };
	}

	private _materialize(session: IOpenCodeSession): Promise<void> {
		if (session.ocSessionId) {
			return Promise.resolve();
		}
		if (session.materializePromise) {
			return session.materializePromise;
		}
		const promise = (async () => {
			const server = await this._ensureServer();
			const info = await this._request<IOcSessionInfo>(server, 'POST', '/session', session.workingDirectory, {});
			session.ocSessionId = info.id;
			this._ensureEventStream(server, session.workingDirectory);
			this._onDidMaterializeSession.fire({
				session: session.sessionUri,
				workingDirectory: session.workingDirectory,
				project: undefined,
			});
			this._logService.info(`[OpenCode] materialized session=${session.rawId} ocSession=${info.id}`);
		})().catch(err => {
			session.materializePromise = undefined;
			throw err;
		});
		session.materializePromise = promise;
		return promise;
	}

	async sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session || session.disposed) {
			// The workbench has already dispatched ChatTurnStarted for this
			// send — throwing alone would leave that turn spinning forever.
			// Close it out with a visible error before rejecting.
			if (turnId) {
				this._fire(sessionUri, {
					type: ActionType.ChatError,
					turnId,
					error: { errorType: 'OpenCodeUnknownSession', message: localize('opencode.unknownSession', "This OpenCode session is no longer available. Start a new chat to continue.") },
				});
				this._fire(sessionUri, { type: ActionType.ChatTurnComplete, turnId });
			}
			throw new Error(`Unknown OpenCode session: ${sessionUri.toString()}`);
		}
		if (attachments?.length) {
			this._logService.warn(`[OpenCode] ${attachments.length} attachment(s) dropped — not supported yet`);
		}
		const effectiveTurnId = turnId ?? generateUuid();
		session.activeTurnId = effectiveTurnId;
		session.cancelRequested = false;
		try {
			await this._materialize(session);
			const model = session.model ?? this._defaultModel();
			if (!model) {
				throw new Error('No OpenCode model available');
			}
			const slash = model.id.indexOf('/');
			if (slash <= 0) {
				throw new Error(`Malformed OpenCode model id '${model.id}' (expected provider/model)`);
			}
			const server = await this._ensureServer();
			await this._request(server, 'POST', `/session/${session.ocSessionId}/prompt_async`, session.workingDirectory, {
				model: { providerID: model.id.slice(0, slash), modelID: model.id.slice(slash + 1) },
				agent: 'build',
				parts: [{ type: 'text', text: prompt }],
			});
			this._logService.info(`[OpenCode] prompt accepted session=${session.ocSessionId} turn=${effectiveTurnId} model=${model.id}`);
		} catch (err) {
			const message = toMessage(err);
			this._logService.error(`[OpenCode] sendMessage failed: ${message}`);
			this._fire(session.sessionUri, { type: ActionType.ChatError, turnId: effectiveTurnId, error: { errorType: 'OpenCodeSendFailed', message } });
			this._fire(session.sessionUri, { type: ActionType.ChatTurnComplete, turnId: effectiveTurnId });
			session.activeTurnId = undefined;
		}
	}

	async abortSession(sessionUri: URI): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session || session.disposed || !session.ocSessionId || this._server.kind !== 'ready') {
			return;
		}
		session.cancelRequested = true;
		try {
			await this._request(this._server, 'POST', `/session/${session.ocSessionId}/abort`, session.workingDirectory);
		} catch (err) {
			this._logService.warn(`[OpenCode] abort failed: ${toMessage(err)}`);
		}
	}

	async disposeSession(sessionUri: URI): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session) {
			return;
		}
		session.disposed = true;
		session.pendingApprovals.denyAll('decline');
		this._sessions.delete(session.rawId);
	}

	async changeModel(sessionUri: URI, model: ModelSelection): Promise<void> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (session) {
			session.model = model;
		}
	}

	async getSessionMessages(sessionUri: URI): Promise<readonly Turn[]> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session || !session.ocSessionId || this._server.kind !== 'ready') {
			return [];
		}
		const messages = await this._request<readonly IOcMessageWithParts[]>(this._server, 'GET', `/session/${session.ocSessionId}/message`, session.workingDirectory);
		const turns: Turn[] = [];
		let current: { id: string; text: string; responseParts: ResponsePart[]; usage: UsageInfo | undefined } | undefined;
		const flush = () => {
			if (current) {
				turns.push({
					id: current.id,
					message: { text: current.text, origin: { kind: MessageKind.User } },
					responseParts: current.responseParts,
					usage: current.usage,
					state: TurnState.Complete,
				});
				current = undefined;
			}
		};
		for (const message of messages) {
			if (message.info.role === 'user') {
				flush();
				const text = message.parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
				current = { id: message.info.id, text, responseParts: [], usage: undefined };
			} else if (message.info.role === 'assistant' && current) {
				for (const part of message.parts) {
					if (part.type === 'text' && part.text) {
						current.responseParts.push({ kind: ResponsePartKind.Markdown, id: part.id, content: part.text });
					} else if (part.type === 'reasoning' && part.text) {
						current.responseParts.push({ kind: ResponsePartKind.Reasoning, id: part.id, content: part.text });
					} else if (part.type === 'step-finish' && part.tokens) {
						current.usage = {
							inputTokens: part.tokens.input,
							outputTokens: part.tokens.output,
							cacheReadTokens: part.tokens.cache?.read,
						};
					}
				}
			}
		}
		flush();
		return turns;
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		// In-memory only for now: OpenCode's own on-disk sessions are not yet
		// re-surfaced across agent-host restarts. Provisional (not yet
		// materialized) sessions are excluded — announcing them here would
		// duplicate the workbench's own provisional entry.
		return [...this._sessions.values()].filter(s => !s.disposed && s.ocSessionId).map(s => ({
			session: s.sessionUri,
			startTime: s.startTime,
			modifiedTime: s.modifiedTime,
			summary: s.title,
			workingDirectory: s.workingDirectory,
		}));
	}

	async getSessionMetadata(sessionUri: URI): Promise<IAgentSessionMetadata | undefined> {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session) {
			return undefined;
		}
		return {
			session: session.sessionUri,
			startTime: session.startTime,
			modifiedTime: session.modifiedTime,
			summary: session.title,
			workingDirectory: session.workingDirectory,
		};
	}

	// #endregion

	// #region IAgent — config, permissions, plumbing

	resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({ schema: opencodeSessionConfigSchema.toProtocol(), values: {} });
	}

	sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const session of this._sessions.values()) {
			if (session.pendingApprovals.respond(requestId, approved ? 'accept' : 'decline')) {
				return;
			}
		}
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// OpenCode has no structured user-input requests today.
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(_session: URI, _clientId: string | undefined, _tools: ToolDefinition[]): void {
		// Client tools are not routed into opencode yet.
	}

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void {
		// No client tools — nothing to complete.
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
		// No customizations surfaced yet.
	}

	async shutdown(): Promise<void> {
		this._teardown();
	}

	override dispose(): void {
		this._teardown();
		super.dispose();
	}

	private _teardown(): void {
		for (const controller of this._eventStreams.values()) {
			controller.abort();
		}
		this._eventStreams.clear();
		for (const session of this._sessions.values()) {
			session.pendingApprovals.denyAll('decline');
		}
		this._sessions.clear();
		if (this._server.kind === 'ready') {
			try { this._server.child.kill(); } catch { /* already dead */ }
		}
		this._server = { kind: 'idle' };
	}

	// #endregion

	private _fire(sessionUri: URI, action: SessionAction | ChatAction): void {
		this._onDidSessionProgress.fire({ kind: 'action', session: sessionUri, action });
	}
}

/** VS Code tool-kind hint for the richer tool cards. */
function toolKindFor(tool: string): string | undefined {
	switch (tool) {
		case 'bash': return 'terminal';
		case 'glob':
		case 'grep':
		case 'list': return 'search';
		default: return undefined;
	}
}

function invocationMessageFor(tool: string, input: Record<string, unknown> | undefined): string {
	if (input) {
		const command = input['command'];
		if (typeof command === 'string') {
			return command;
		}
		const filePath = input['filePath'] ?? input['path'];
		if (typeof filePath === 'string') {
			return `${tool}: ${filePath}`;
		}
		const pattern = input['pattern'];
		if (typeof pattern === 'string') {
			return `${tool}: ${pattern}`;
		}
	}
	return tool;
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function findFreePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Could not determine free port')));
			}
		});
	});
}
