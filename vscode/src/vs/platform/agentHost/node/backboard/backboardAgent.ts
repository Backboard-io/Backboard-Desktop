/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { AgentSession, AgentSignal, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { ActionType, type SessionAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type SessionInputAnswer, type SessionInputResponseKind, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

const DEFAULT_PROVIDER = 'aws-bedrock';
const DEFAULT_MODEL = 'anthropic.claude-sonnet-4-6';
const DEFAULT_MODEL_ID = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
const BACKBOARD_MODEL_CACHE_VERSION = 2;
const HIDDEN_MODEL_PROVIDERS = new Set(['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics']);
const SANDBOX_PROVIDER_ORDER = new Map<string, number>([
	['aws-bedrock', 0],
	['anthropic', 1],
	['openai', 2],
	['google', 3],
	['xai', 4],
	['x-ai', 4],
	['cohere', 5],
	['cerebras', 6],
	['mistral', 7],
	['deepseek', 8],
	['openrouter', 9],
	['lmstudio', 10],
	['lm-studio', 10],
	['ollama', 11],
]);
const BACKBOARD_MCP_CONFIG_KEY = 'mcpCalls';
const BACKBOARD_INTENSITY_CONFIG_KEY = 'intensity';
const BACKBOARD_MEMORY_CONFIG_KEY = 'memoryMode';
const BACKBOARD_WEB_SEARCH_CONFIG_KEY = 'webSearch';
const BACKBOARD_IMAGE_CONFIG_KEY = 'imageGeneration';
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'target', '.next', '.turbo']);

interface BridgeEvent {
	readonly type: string;
	readonly requestId: string;
	readonly sessionId?: string;
	readonly message?: string;
	readonly text?: string;
	readonly models?: BridgeModel[];
	readonly toolCalls?: unknown[];
	readonly threadId?: string;
	readonly runId?: string;
	readonly tools?: unknown[];
	readonly status?: string;
	readonly output?: unknown;
	readonly data?: unknown;
	readonly stopReason?: string;
	readonly usage?: unknown;
	readonly chunk?: unknown;
}

interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly model_type?: string;
	readonly displayName?: string;
	readonly contextLimit?: number;
	readonly supportsVision?: boolean;
	readonly inputPricePerMillion?: number;
	readonly outputPricePerMillion?: number;
	readonly inputCostPer1mTokens?: number;
	readonly outputCostPer1mTokens?: number;
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly promptPrice?: number;
	readonly completionPrice?: number;
}

interface PendingBridgeRequest {
	readonly events?: BridgeEvent[];
	readonly onEvent?: (event: BridgeEvent) => void | Promise<void>;
	readonly resolve: (events: BridgeEvent[]) => void;
	readonly reject: (error: Error) => void;
}

interface BridgeRequestHandle {
	readonly requestId: string;
	readonly promise: Promise<BridgeEvent[]>;
}

interface BackboardSession {
	readonly sessionUri: URI;
	readonly sessionId: string;
	readonly createdAt: number;
	workingDirectory?: URI;
	model?: ModelSelection;
	config?: Record<string, unknown>;
	title?: string;
	modifiedAt: number;
	materialized: boolean;
	currentRequestId?: string;
	disposed: boolean;
}

interface ToolResultRequest {
	readonly threadId: string;
	readonly runId: string;
	readonly toolCalls: readonly unknown[];
}

interface ParsedToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

export interface BackboardTurnSettings {
	readonly provider: string;
	readonly model: string;
	readonly mode: string;
	readonly intensity: string;
	readonly memoryMode: string;
	readonly webSearch: string;
	readonly imageGeneration: string;
	readonly mcpCalls?: string[];
	readonly config: Record<string, unknown>;
}

export class BackboardAgent extends Disposable implements IAgent {
	readonly id = 'backboard';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('backboardModels', [fallbackModel()]);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _bridge: BackboardBridgeProcess;
	private readonly _sessions = new Map<string, BackboardSession>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
		this._bridge = this._register(new BackboardBridgeProcess(_logService));
		this._refreshModels();
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('backboardAgent.displayName', "Backboard"),
			description: localize('backboardAgent.description', "Backboard agent backed by the Rust bridge"),
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
			existing.model = normalizeBackboardModelSelection(config.model) ?? existing.model;
			existing.config = normalizeBackboardConfig(config.config, existing.config);
			return { session: sessionUri, workingDirectory: existing.workingDirectory, provisional: !existing.materialized };
		}

		const session: BackboardSession = {
			sessionUri,
			sessionId,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
			workingDirectory: config.workingDirectory,
			model: normalizeBackboardModelSelection(config.model),
			config: normalizeBackboardConfig(config.config),
			materialized: false,
			disposed: false,
		};
		this._sessions.set(sessionId, session);
		return { session: sessionUri, workingDirectory: config.workingDirectory, provisional: true };
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return resolveBackboardSessionConfig(params.config);
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(sessionUri: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const session = this._session(sessionUri);
		const effectiveTurnId = turnId ?? generateUuid();
		await this._materialize(session);

		const partId = generateUuid();
		const responseState = { didCreatePart: false };
		const bridgeSessionId = `sandbox:${session.sessionId}`;
		session.modifiedAt = Date.now();

		try {
			const settings = this._turnSettings(session);
			const firstToolRequests: ToolResultRequest[] = [];
			const seenToolRequests = new Set<string>();
			const handle = this._bridge.send('sendPrompt', bridgeSessionId, {
				content: prompt,
				workspace: session.workingDirectory?.fsPath,
				provider: settings.provider,
				model: settings.model,
				mode: settings.mode,
				intensity: settings.intensity,
				memoryMode: settings.memoryMode,
				webSearch: settings.webSearch,
				imageGeneration: settings.imageGeneration === 'auto' ? 'auto' : undefined,
				mcpCalls: settings.mcpCalls,
				config: settings.config,
			}, event => this._handleBridgeEvent(session, effectiveTurnId, partId, responseState, firstToolRequests, seenToolRequests, event));
			session.currentRequestId = handle.requestId;
			await handle.promise;

			let nextToolRequest = firstToolRequests.shift();
			while (nextToolRequest) {
				const toolOutputs = await this._executeToolCalls(session, effectiveTurnId, nextToolRequest.toolCalls, settings.mode);
				const continuationToolRequests: ToolResultRequest[] = [];
				const continuation = this._bridge.send('submitToolResult', bridgeSessionId, {
					threadId: nextToolRequest.threadId,
					runId: nextToolRequest.runId,
					toolOutputs,
					config: settings.config,
				}, event => this._handleBridgeEvent(session, effectiveTurnId, partId, responseState, continuationToolRequests, seenToolRequests, event));
				session.currentRequestId = continuation.requestId;
				await continuation.promise;
				nextToolRequest = continuationToolRequests.shift();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isDuplicateToolOutputError(message)) {
				this._logService.info(`[Backboard] Suppressed duplicate tool-output submission error: ${message}`);
			} else {
				this._fire(session.sessionUri, {
					type: ActionType.SessionError,
					turnId: effectiveTurnId,
					error: { errorType: 'BackboardSendFailed', message },
				});
			}
		} finally {
			session.currentRequestId = undefined;
			this._fire(session.sessionUri, { type: ActionType.SessionTurnComplete, turnId: effectiveTurnId });
		}
	}

	async getSessionMessages(_session: URI): Promise<readonly Turn[]> {
		return [];
	}

	async disposeSession(sessionUri: URI): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		if (session?.currentRequestId) {
			this._bridge.cancel(`sandbox:${session.sessionId}`, session.currentRequestId);
		}
		if (session) {
			session.disposed = true;
		}
		this._sessions.delete(sessionId);
	}

	async abortSession(sessionUri: URI): Promise<void> {
		const session = this._session(sessionUri);
		if (session.currentRequestId) {
			this._bridge.cancel(`sandbox:${session.sessionId}`, session.currentRequestId);
		}
	}

	async changeModel(sessionUri: URI, model: ModelSelection): Promise<void> {
		this._session(sessionUri).model = normalizeBackboardModelSelection(model);
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
	}

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void {
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [...this._sessions.values()]
			.filter(session => session.materialized && !session.disposed)
			.map(session => ({
				session: session.sessionUri,
				startTime: session.createdAt,
				modifiedTime: session.modifiedAt,
				summary: session.title,
				model: session.model,
				workingDirectory: session.workingDirectory,
				project: session.workingDirectory ? { uri: session.workingDirectory, displayName: path.basename(session.workingDirectory.fsPath) } : undefined,
			}));
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		return true;
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(_session: URI, _clientId: string | undefined, _tools: ToolDefinition[]): void {
	}

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void {
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
	}

	async shutdown(): Promise<void> {
		for (const session of this._sessions.values()) {
			if (session.currentRequestId) {
				this._bridge.cancel(`sandbox:${session.sessionId}`, session.currentRequestId);
			}
		}
		this._sessions.clear();
	}

	private async _materialize(session: BackboardSession): Promise<void> {
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

	private _session(sessionUri: URI): BackboardSession {
		const session = this._sessions.get(AgentSession.id(sessionUri));
		if (!session || session.disposed) {
			throw new Error(`Backboard session not found: ${sessionUri.toString()}`);
		}
		return session;
	}

	private _fire(session: URI, action: SessionAction): void {
		this._onDidSessionProgress.fire({ kind: 'action', session, action });
	}

	private _turnSettings(session: BackboardSession): BackboardTurnSettings {
		const storedConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		return createBackboardTurnSettings(storedConfig, session.config, session.model);
	}

	private _handleBridgeEvent(
		session: BackboardSession,
		turnId: string,
		partId: string,
		responseState: { didCreatePart: boolean },
		toolRequests: ToolResultRequest[],
		seenToolRequests: Set<string>,
		event: BridgeEvent,
	): void {
		switch (event.type) {
			case 'assistantTextDelta':
				if (!event.text) {
					return;
				}
				const visibleText = visibleAssistantTextDelta(event.text);
				if (!visibleText) {
					return;
				}
				if (!responseState.didCreatePart) {
					responseState.didCreatePart = true;
					this._fire(session.sessionUri, {
						type: ActionType.SessionResponsePart,
						turnId,
						part: { kind: ResponsePartKind.Markdown, id: partId, content: '' },
					});
				}
				this._fire(session.sessionUri, { type: ActionType.SessionDelta, turnId, partId, content: visibleText });
				return;
			case 'toolRequested':
				if (event.threadId && event.runId && event.toolCalls?.length) {
					const request = { threadId: event.threadId, runId: event.runId, toolCalls: event.toolCalls };
					const key = toolResultRequestKey(request);
					if (!seenToolRequests.has(key)) {
						seenToolRequests.add(key);
						toolRequests.push(request);
					} else {
						this._logService.info(`[Backboard] Skipping duplicate tool result request runId=${event.runId}`);
					}
				}
				return;
			case 'error':
				if (isDuplicateToolOutputError(event.message)) {
					this._logService.info(`[Backboard] Suppressed duplicate tool-output submission error: ${event.message}`);
					return;
				}
				this._fire(session.sessionUri, {
					type: ActionType.SessionError,
					turnId,
					error: { errorType: 'BackboardError', message: event.message ?? 'Backboard request failed.' },
				});
				return;
		}
	}

	private async _executeToolCalls(session: BackboardSession, turnId: string, toolCalls: readonly unknown[], mode: string): Promise<unknown[]> {
		const outputs: unknown[] = [];
		for (const rawCall of toolCalls) {
			const call = parseToolCall(rawCall);
			const toolInput = safeJson(call.args);
			this._fire(session.sessionUri, {
				type: ActionType.SessionToolCallStart,
				turnId,
				toolCallId: call.id,
				toolName: call.name,
				displayName: displayToolName(call.name),
				_meta: { toolKind: toolKind(call.name) },
			});
			this._fire(session.sessionUri, {
				type: ActionType.SessionToolCallDelta,
				turnId,
				toolCallId: call.id,
				content: toolInput,
			});

			const allowed = mode === 'free' || isReadOnlyTool(call.name);
			this._fire(session.sessionUri, {
				type: ActionType.SessionToolCallReady,
				turnId,
				toolCallId: call.id,
				invocationMessage: describeToolInvocation(call),
				toolInput,
				confirmed: allowed ? ToolCallConfirmationReason.NotNeeded : undefined,
				_meta: { toolKind: toolKind(call.name) },
			});

				if (!allowed) {
					const message = 'Tool call requires approval. Switch this Sandbox session to Full Access to allow write tools automatically.';
					this._fire(session.sessionUri, {
					type: ActionType.SessionToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: false,
						pastTenseMessage: `Skipped ${displayToolName(call.name)}`,
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				outputs.push(toolOutput(call.id, { success: false, content: message }));
				continue;
			}

			try {
				const result = await executeBackboardTool(this._bridge, session.workingDirectory?.fsPath, call);
				this._fire(session.sessionUri, {
					type: ActionType.SessionToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: true,
						pastTenseMessage: completedToolMessage(call),
						content: result ? [{ type: ToolResultContentType.Text, text: result }] : undefined,
					},
				});
				outputs.push(toolOutput(call.id, { success: true, content: result }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this._fire(session.sessionUri, {
					type: ActionType.SessionToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: false,
						pastTenseMessage: `Tried ${displayToolName(call.name)}`,
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				outputs.push(toolOutput(call.id, { success: false, content: message }));
			}
		}
		return outputs;
	}

	private _refreshModels(): void {
		this._bridge.send('listModels', undefined, { config: bridgeConfig() }, undefined).promise.then(events => {
			const bridgeModels = events.find(event => event.type === 'models')?.models ?? [];
			const mergedModels = mergeBridgeModels(bridgeModels, this._readCachedModels());
			const models = mergedModels
				.filter(isVisibleBridgeModel)
				.concat(supplementalBridgeModels(mergedModels))
				.sort(compareBridgeModels)
				.map(toAgentModelInfo);
			this._models.set(models.length ? models : [fallbackModel()], undefined);
		}).catch(error => {
			this._logService.warn(`[Backboard] Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
			this._models.set([fallbackModel()], undefined);
		});
	}

	private _readCachedModels(): BridgeModel[] {
		const cachePath = path.join(this._environmentService.appSettingsHome.fsPath, 'globalStorage', 'backboard.backboard', 'models.json');
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
			const env = isObjectRecord(parsed) && typeof parsed.env === 'string' ? parsed.env : undefined;
			if (!isObjectRecord(parsed)
				|| parsed.version !== BACKBOARD_MODEL_CACHE_VERSION
				|| env !== currentBackboardEnv()
				|| !Array.isArray(parsed.models)) {
				return [];
			}
			return parsed.models.filter(isBridgeModel).filter(isVisibleBridgeModel);
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return [];
			}
			this._logService.warn(`[Backboard] Failed to read cached models: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}
}

class BackboardBridgeProcess extends Disposable {
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingBridgeRequest>();

	constructor(
		private readonly _logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		this.child?.kill();
		this.child = undefined;
		for (const pending of this.pending.values()) {
			pending.reject(new Error('Backboard bridge disposed.'));
		}
		this.pending.clear();
		super.dispose();
	}

	send(command: string, sessionId: string | undefined, params: unknown, onEvent?: (event: BridgeEvent) => void | Promise<void>): BridgeRequestHandle {
		const requestId = generateUuid();
		const child = this._ensureProcess(sessionId);
		const promise = new Promise<BridgeEvent[]>((resolve, reject) => {
			this.pending.set(requestId, { events: onEvent ? undefined : [], onEvent, resolve, reject });
		});
		child.stdin.write(`${JSON.stringify({ requestId, command, sessionId, params })}\n`);
		return { requestId, promise };
	}

	cancel(sessionId: string | undefined, requestId: string): void {
		this.child?.stdin.write(`${JSON.stringify({ requestId: generateUuid(), command: 'cancel', sessionId, params: { requestId } })}\n`);
	}

	async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const events = await this.send('runTool', undefined, { name, args }, undefined).promise;
		const result = [...events].reverse().find(event => event.type === 'toolFinished' && event.status === 'finished');
		return result?.output ?? { success: false, error: `Rust tool ${name} did not return output.` };
	}

	private _ensureProcess(sessionId: string | undefined): ChildProcessWithoutNullStreams {
		if (this.child && !this.child.killed) {
			return this.child;
		}
		const bridgePath = this._resolveBridgePath();
		if (!fs.existsSync(bridgePath)) {
			throw new Error(`Backboard bridge binary not found at ${bridgePath}. Build it with: npm --prefix extensions/backboard run build-bridge`);
		}
		const cwd = os.homedir();
		this._logService.info(`[Backboard] Starting bridge at ${bridgePath} cwd=${cwd} session=${sessionId ?? '(none)'}`);
		this.child = spawn(bridgePath, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		readline.createInterface({ input: this.child.stdout }).on('line', line => this._handleLine(line));
		this.child.stderr.on('data', chunk => this._logService.info(`[Backboard bridge] ${String(chunk).trimEnd()}`));
		this.child.on('exit', (code, signal) => {
			this._logService.warn(`[Backboard] bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
			for (const pending of this.pending.values()) {
				pending.reject(new Error('Backboard bridge exited.'));
			}
			this.pending.clear();
			this.child = undefined;
		});
		return this.child;
	}

	private _resolveBridgePath(): string {
		const executable = process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge';
		const configured = process.env.BACKBOARD_BRIDGE_PATH?.trim() || process.env.VSCODE_BACKBOARD_BRIDGE_PATH?.trim();
		if (configured) {
			return configured;
		}
		const appRoot = dirname(FileAccess.asFileUri('').fsPath);
		const candidates = [
			join(appRoot, 'extensions', 'backboard', 'bin', executable),
			join(appRoot, 'extensions', 'backboard', 'rust', 'target', 'debug', executable),
			path.join(process.cwd(), 'extensions', 'backboard', 'bin', executable),
			path.join(process.cwd(), 'extensions', 'backboard', 'rust', 'target', 'debug', executable),
		];
		return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[1];
	}

	private _handleLine(line: string): void {
		let event: BridgeEvent;
		try {
			event = JSON.parse(line) as BridgeEvent;
		} catch {
			this._logService.info(`[Backboard bridge] ${line}`);
			return;
		}
		const pending = this.pending.get(event.requestId);
		if (!pending) {
			return;
		}
		void pending.onEvent?.(event);
		pending.events?.push(event);
		if (event.type === 'done') {
			this.pending.delete(event.requestId);
			pending.resolve(pending.events ?? [event]);
		}
	}
}

function toolResultRequestKey(request: ToolResultRequest): string {
	return `${request.threadId}:${request.runId}:${request.toolCalls.map(toolCallIdentity).join(',')}`;
}

function toolCallIdentity(raw: unknown): string {
	const value = isObjectRecord(raw) ? raw : {};
	return firstStringProperty(value, ['id', 'tool_call_id', 'toolCallId', 'call_id', 'callId'])
		?? compactJson(raw);
}

function visibleAssistantTextDelta(text: string): string | undefined {
	const rawTranscriptIndex = text.search(/\[Called [A-Za-z0-9_.-]+ with parameters:/);
	if (rawTranscriptIndex === -1) {
		return text;
	}
	const prefix = text.slice(0, rawTranscriptIndex).trimEnd();
	return prefix ? `${prefix}\n` : undefined;
}

function isDuplicateToolOutputError(message: string | undefined): boolean {
	return typeof message === 'string'
		&& message.includes('Tool outputs for run ID')
		&& message.includes('were already submitted');
}

function normalizeBackboardModelSelection(model: ModelSelection | undefined): ModelSelection | undefined {
	if (!model) {
		return undefined;
	}
	const parsed = parseModelSelection(model);
	if (!parsed) {
		return model;
	}
	return { ...model, id: `${parsed.provider}/${parsed.model}` };
}

function parseModelSelection(model: ModelSelection | undefined): { provider: string; model: string } | undefined {
	const id = model?.id;
	if (!id) {
		return undefined;
	}
	const slash = id.indexOf('/');
	if (slash > 0 && slash < id.length - 1) {
		return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
	}
	return { provider: DEFAULT_PROVIDER, model: id };
}

function toAgentModelInfo(model: BridgeModel): IAgentModelInfo {
	const id = `${model.provider}/${model.name}`;
	const inputCost = model.inputPricePerMillion ?? model.inputCostPer1mTokens ?? model.inputPrice ?? model.promptPrice;
	const outputCost = model.outputPricePerMillion ?? model.outputCostPer1mTokens ?? model.outputPrice ?? model.completionPrice;
	return {
		provider: 'backboard',
		id,
		name: model.displayName || model.name,
		maxContextWindow: typeof model.contextLimit === 'number' ? model.contextLimit : undefined,
		supportsVision: model.supportsVision ?? false,
		_meta: {
			upstreamProvider: normalizeProviderKey(model.provider),
			upstreamProviderLabel: providerLabel(model.provider),
			...(typeof inputCost === 'number' ? { inputCost } : {}),
			...(typeof outputCost === 'number' ? { outputCost } : {}),
		},
	};
}

function fallbackModel(): IAgentModelInfo {
	return {
		provider: 'backboard',
		id: DEFAULT_MODEL_ID,
		name: 'Claude Sonnet 4.6',
		supportsVision: true,
	};
}

function isVisibleBridgeModel(model: BridgeModel): boolean {
	const provider = normalizeProviderKey(model.provider);
	const modelType = model.modelType ?? model.model_type;
	return !!provider
		&& !!model.name?.trim()
		&& !HIDDEN_MODEL_PROVIDERS.has(provider)
		&& (!modelType || modelType.trim().toLowerCase() === 'llm');
}

function isBridgeModel(value: unknown): value is BridgeModel {
	return isObjectRecord(value)
		&& typeof value.provider === 'string'
		&& value.provider.trim().length > 0
		&& typeof value.name === 'string'
		&& value.name.trim().length > 0;
}

function mergeBridgeModels(...modelSets: readonly (readonly BridgeModel[])[]): BridgeModel[] {
	const byId = new Map<string, BridgeModel>();
	for (const models of modelSets) {
		for (const model of models) {
			const key = `${normalizeProviderKey(model.provider)}/${model.name}`;
			if (!byId.has(key)) {
				byId.set(key, model);
			}
		}
	}
	return [...byId.values()];
}

function compareBridgeModels(a: BridgeModel, b: BridgeModel): number {
	const aId = `${normalizeProviderKey(a.provider)}/${a.name}`;
	const bId = `${normalizeProviderKey(b.provider)}/${b.name}`;
	if (aId === DEFAULT_MODEL_ID) {
		return -1;
	}
	if (bId === DEFAULT_MODEL_ID) {
		return 1;
	}
	const providerDelta = (SANDBOX_PROVIDER_ORDER.get(normalizeProviderKey(a.provider)) ?? 99)
		- (SANDBOX_PROVIDER_ORDER.get(normalizeProviderKey(b.provider)) ?? 99);
	if (providerDelta !== 0) {
		return providerDelta;
	}
	return a.name.localeCompare(b.name);
}

function normalizeProviderKey(provider: string | undefined): string {
	const value = provider?.trim().toLowerCase().replace(/[\s_]+/g, '-') ?? '';
	if (value.includes('openrouter') || value.includes('open-router')) {
		return 'openrouter';
	}
	if (value.includes('bedrock') || value.includes('amazon') || value === 'aws') {
		return 'aws-bedrock';
	}
	if (value === 'google-ai' || value === 'googleai') {
		return 'google-ai';
	}
	if (value === 'open-ai') {
		return 'openai';
	}
	if (value === 'open-ai-compatible' || value === 'openai-compat') {
		return 'openai-compatible';
	}
	if (value === 'xai') {
		return 'xai';
	}
	if (value === 'x-ai' || value === 'x.ai') {
		return 'xai';
	}
	if (value === 'lmstudio') {
		return 'lm-studio';
	}
	return value;
}

function providerLabel(provider: string | undefined): string {
	switch (normalizeProviderKey(provider)) {
		case 'aws-bedrock':
			return 'AWS Bedrock';
		case 'anthropic':
			return 'Anthropic';
		case 'cerebras':
			return 'Cerebras';
		case 'cohere':
			return 'Cohere';
		case 'deepseek':
			return 'DeepSeek';
		case 'google':
		case 'google-ai':
			return 'Google';
		case 'lm-studio':
			return 'LM Studio';
		case 'mistral':
			return 'Mistral';
		case 'ollama':
			return 'Ollama';
		case 'openai':
			return 'OpenAI';
		case 'openai-compatible':
			return 'OpenAI Compatible';
		case 'openrouter':
			return 'OpenRouter';
		case 'xai':
			return 'xAI';
		default:
			return provider?.trim() || 'Backboard';
	}
}

function supplementalBridgeModels(models: readonly BridgeModel[]): BridgeModel[] {
	if (models.some(model => normalizeProviderKey(model.provider) === 'openrouter')) {
		return [];
	}
	return [{ provider: 'openrouter', name: 'openai/gpt-5-chat', displayName: 'GPT-5 Chat', modelType: 'llm' }];
}

function normalizeBackboardEnv(env: unknown): string {
	switch ((typeof env === 'string' ? env : 'prod').trim().toLowerCase()) {
		case '':
			return 'prod';
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (typeof env === 'string' ? env : 'prod').trim().toLowerCase();
	}
}

function currentBackboardEnv(): string {
	return normalizeBackboardEnv(bridgeConfig().env);
}

function isFileNotFoundError(error: unknown): boolean {
	return isObjectRecord(error) && error.code === 'ENOENT';
}

function resolveBackboardSessionConfig(rawConfig: Record<string, unknown> | undefined): ResolveSessionConfigResult {
	const values = normalizeBackboardConfig(rawConfig);
	return {
			schema: {
				type: 'object',
				properties: {
					[SessionConfigKey.Mode]: {
						type: 'string',
						title: localize('backboard.config.mode.title', "Mode"),
						description: localize('backboard.config.mode.description', "Controls how Backboard uses tools and applies changes."),
						default: 'free',
						enum: ['agent', 'ask', 'manual', 'free'],
						enumLabels: [
							localize('backboard.config.mode.agent', "Agent"),
							localize('backboard.config.mode.ask', "Ask"),
							localize('backboard.config.mode.manual', "Manual"),
							localize('backboard.config.mode.free', "Full Access"),
						],
						enumDescriptions: [
							localize('backboard.config.mode.agent.description', "Use Backboard's normal agent workflow."),
							localize('backboard.config.mode.ask.description', "Prefer answers before changes."),
							localize('backboard.config.mode.manual.description', "Require manual approval for write tools."),
							localize('backboard.config.mode.free.description', "Allow tool calls without additional approval."),
						],
						sessionMutable: true,
					},
					[BACKBOARD_INTENSITY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.intensity.title', "Reasoning"),
						description: localize('backboard.config.intensity.description', "Controls how much reasoning Backboard uses."),
						default: 'fast',
						enum: ['fast', 'balanced', 'deep'],
						enumLabels: [
							localize('backboard.config.intensity.fast', "Fast"),
							localize('backboard.config.intensity.balanced', "Balanced"),
							localize('backboard.config.intensity.deep', "Deep"),
						],
						sessionMutable: true,
					},
					[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.web.title', "Web"),
						description: localize('backboard.config.web.description', "Controls web search for this Sandbox session."),
						default: 'off',
						enum: ['off', 'Auto'],
						enumLabels: [
							localize('backboard.config.web.off', "Web Off"),
							localize('backboard.config.web.auto', "Auto"),
						],
						sessionMutable: true,
					},
					[BACKBOARD_IMAGE_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.image.title', "Image"),
						description: localize('backboard.config.image.description', "Controls image generation for this Sandbox session."),
						default: 'off',
						enum: ['off', 'auto'],
						enumLabels: [
							localize('backboard.config.image.off', "Image Off"),
							localize('backboard.config.image.auto', "Auto"),
						],
						sessionMutable: true,
					},
					[BACKBOARD_MCP_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.mcp.title', "MCP"),
						description: localize('backboard.config.mcp.description', "Choose which connected MCP tools Backboard can call."),
						default: 'off',
						enum: ['off', 'figma', 'notion', 'google', 'figma,notion', 'figma,google', 'notion,google', 'all'],
						enumLabels: [
							localize('backboard.config.mcp.off', "MCP Off"),
							localize('backboard.config.mcp.figma', "Figma"),
							localize('backboard.config.mcp.notion', "Notion"),
							localize('backboard.config.mcp.google', "Google"),
							localize('backboard.config.mcp.figmaNotion', "Figma + Notion"),
							localize('backboard.config.mcp.figmaGoogle', "Figma + Google"),
							localize('backboard.config.mcp.notionGoogle', "Notion + Google"),
							localize('backboard.config.mcp.all', "All MCP"),
						],
						sessionMutable: true,
					},
					[BACKBOARD_MEMORY_CONFIG_KEY]: {
						type: 'string',
						title: localize('backboard.config.memory.title', "Memory"),
						description: localize('backboard.config.memory.description', "Controls Backboard memory behavior."),
						default: 'Auto',
						enum: ['Auto', 'Readonly', 'off', 'ProAuto', 'ProReadonly'],
						enumLabels: [
							localize('backboard.config.memory.auto', "Memory Lite"),
							localize('backboard.config.memory.readonly', "Read Only"),
							localize('backboard.config.memory.off', "Memory Off"),
							localize('backboard.config.memory.proAuto', "Memory Pro"),
							localize('backboard.config.memory.proReadonly', "Pro Read Only"),
						],
						sessionMutable: true,
					},
				},
			},
		values,
	};
}

function normalizeBackboardConfig(rawConfig: Record<string, unknown> | undefined, fallback?: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...(fallback ?? {}), ...(rawConfig ?? {}) };
	return {
		[SessionConfigKey.Mode]: normalizeBackboardMode(merged[SessionConfigKey.Mode]),
		[BACKBOARD_INTENSITY_CONFIG_KEY]: oneOf(merged[BACKBOARD_INTENSITY_CONFIG_KEY], ['fast', 'balanced', 'deep'], 'fast'),
		[BACKBOARD_MCP_CONFIG_KEY]: oneOf(merged[BACKBOARD_MCP_CONFIG_KEY], ['off', 'figma', 'notion', 'google', 'figma,notion', 'figma,google', 'notion,google', 'all'], 'off'),
		[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: normalizeWebSearchMode(merged[BACKBOARD_WEB_SEARCH_CONFIG_KEY]),
		[BACKBOARD_MEMORY_CONFIG_KEY]: normalizeMemoryMode(merged[BACKBOARD_MEMORY_CONFIG_KEY]),
		[BACKBOARD_IMAGE_CONFIG_KEY]: oneOf(merged[BACKBOARD_IMAGE_CONFIG_KEY], ['off', 'auto'], 'off'),
	};
}

export function createBackboardTurnSettings(
	storedConfig: Record<string, unknown> | undefined,
	sessionConfig: Record<string, unknown> | undefined,
	model: ModelSelection | undefined,
): BackboardTurnSettings {
	const values = normalizeBackboardConfig(storedConfig, sessionConfig);
	const parsedModel = parseModelSelection(model) ?? parseModelSelection({ id: DEFAULT_MODEL_ID })!;
	const mcpValue = stringConfigValue(values, BACKBOARD_MCP_CONFIG_KEY, 'off');
	return {
		provider: parsedModel.provider,
		model: parsedModel.model,
		mode: bridgeModeFromConfig(values),
		intensity: stringConfigValue(values, BACKBOARD_INTENSITY_CONFIG_KEY, 'fast'),
		memoryMode: stringConfigValue(values, BACKBOARD_MEMORY_CONFIG_KEY, 'Auto'),
		webSearch: stringConfigValue(values, BACKBOARD_WEB_SEARCH_CONFIG_KEY, 'off'),
		imageGeneration: stringConfigValue(values, BACKBOARD_IMAGE_CONFIG_KEY, 'off'),
		mcpCalls: mcpCallsFromConfig(mcpValue),
		config: bridgeConfig(),
	};
}

function normalizeBackboardMode(value: unknown): string {
	if (value === 'interactive') {
		return 'agent';
	}
	if (value === 'plan') {
		return 'manual';
	}
	return oneOf(value, ['agent', 'ask', 'manual', 'free'], 'free');
}

function normalizeWebSearchMode(value: unknown): string {
	if (value === 'on') {
		return 'Auto';
	}
	return oneOf(value, ['off', 'Auto'], 'off');
}

function normalizeMemoryMode(value: unknown): string {
	if (value === 'Off') {
		return 'off';
	}
	return oneOf(value, ['Auto', 'Readonly', 'off', 'ProAuto', 'ProReadonly'], 'Auto');
}

function oneOf(value: unknown, values: readonly string[], fallback: string): string {
	return typeof value === 'string' && values.includes(value) ? value : fallback;
}

function stringConfigValue(config: Record<string, unknown>, key: string, fallback: string): string {
	const value = config[key];
	return typeof value === 'string' && value ? value : fallback;
}

function bridgeModeFromConfig(config: Record<string, unknown>): string {
	return stringConfigValue(config, SessionConfigKey.Mode, 'free');
}

function mcpCallsFromConfig(value: string): string[] | undefined {
	if (value === 'all') {
		return ['figma', 'notion', 'google'];
	}
	const allowed = new Set(['figma', 'notion', 'google']);
	const enabled = value.split(',')
		.map(part => part.trim())
		.filter((part): part is 'figma' | 'notion' | 'google' => allowed.has(part));
	return enabled.length ? [...new Set(enabled)] : undefined;
}

function bridgeConfig(): Record<string, unknown> {
	const apiUrl = process.env.BACKBOARD_API_URL || process.env.VSCODE_BACKBOARD_API_URL;
	const apiKey = process.env.BACKBOARD_API_KEY || process.env.VSCODE_BACKBOARD_API_KEY;
	return {
		env: process.env.BACKBOARD_ENV || process.env.VSCODE_BACKBOARD_ENV || 'prod',
		...(apiUrl ? { apiUrl } : {}),
		...(apiKey ? { apiKey } : {}),
	};
}

async function executeBackboardTool(bridge: BackboardBridgeProcess, rootPath: string | undefined, call: ParsedToolCall): Promise<string> {
	switch (call.name) {
		case 'read_file':
			return readFileTool(rootPath, call.args);
		case 'list_dir':
			return listDirTool(rootPath, call.args);
		case 'glob':
			return globTool(rootPath, call.args);
		case 'grep':
			return grepTool(rootPath, call.args);
		case 'codebase_search':
			return codebaseSearchTool(rootPath, call.args);
		case 'web_search':
		case 'web_fetch':
		case 'computer':
			return compactJson(await bridge.runTool(call.name, call.args));
		case 'write':
		case 'write_file':
		case 'create_file':
		case 'overwrite_file':
			return writeFileTool(rootPath, call.args);
		case 'edit':
		case 'edit_file':
		case 'search_replace':
			return editFileTool(rootPath, call.args);
		case 'delete_file':
			return deleteFileTool(rootPath, call.args);
		case 'create_directory':
			return createDirectoryTool(rootPath, call.args);
		case 'bash':
		case 'run_terminal_cmd':
			return runShellTool(rootPath, call.args);
		case 'run_code':
		case 'repl':
			return runCodeTool(rootPath, call.args);
		case 'todo_write':
			return `Todo list updated: ${compactJson(call.args.todos ?? [])}`;
		case 'sleep':
			return sleepTool(call.args);
		case 'task':
			return `Sub-task requested: ${stringArg(call.args, 'prompt', 'description')}\n\nParallel sub-agent execution is not available in Sandbox yet.`;
		case 'enter_plan_mode':
			return `Plan mode requested: ${stringArg(call.args, 'reason')}`;
		case 'exit_plan_mode':
			return `Plan proposed:\n${stringArg(call.args, 'plan')}`;
		case 'persistence_decide':
			return `Persistence decision: ${compactJson(call.args)}`;
		default:
			throw new Error(`Unsupported tool: ${call.name}`);
	}
}

async function readFileTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	const text = await fs.promises.readFile(file, 'utf8');
	const offset = numberArg(args, 'offset');
	const limit = numberArg(args, 'limit');
	if (!offset && !limit) {
		return text;
	}
	const lines = text.split(/\r?\n/);
	const start = Math.max((offset ?? 1) - 1, 0);
	const end = limit ? start + limit : lines.length;
	return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
}

async function listDirTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const dir = resolveWorkspacePath(rootPath, stringArg(args, 'path', 'relative_workspace_path', 'target_directory', 'targetDirectory') || '.');
	const entries = await fs.promises.readdir(dir, { withFileTypes: true });
	return entries
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
		.join('\n');
}

async function globTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const root = workspaceRoot(rootPath);
	const base = stringArg(args, 'target_directory');
	const pattern = path.posix.join(base?.replace(/\\/g, '/') || '', stringArg(args, 'pattern') || '**/*');
	const regex = globToRegExp(pattern);
	const files = await walkFiles(root, 800);
	return files
		.map(file => relativePath(root, file))
		.filter(file => regex.test(file))
		.slice(0, 300)
		.join('\n');
}

async function grepTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const pattern = stringArg(args, 'pattern');
	if (!pattern) {
		throw new Error('grep requires pattern');
	}
	const root = workspaceRoot(rootPath);
	const include = stringArg(args, 'glob', 'include') || '**/*';
	const subPath = stringArg(args, 'path');
	const fullPattern = path.posix.join(subPath?.replace(/\\/g, '/') || '', include);
	const includeRegex = globToRegExp(fullPattern);
	const flags = boolArg(args, 'case_insensitive') ? 'i' : '';
	const regex = new RegExp(pattern, flags);
	const outputMode = stringArg(args, 'output_mode') || 'content';
	const files = await walkFiles(root, 800);
	const matches: string[] = [];
	let count = 0;
	for (const file of files) {
		const rel = relativePath(root, file);
		if (!includeRegex.test(rel) || !(await isTextFile(file))) {
			continue;
		}
		const text = await fs.promises.readFile(file, 'utf8');
		const lines = text.split(/\r?\n/);
		let fileMatched = false;
		for (let index = 0; index < lines.length; index++) {
			if (!regex.test(lines[index])) {
				continue;
			}
			count++;
			fileMatched = true;
			if (outputMode === 'content') {
				matches.push(`${rel}:${index + 1}: ${lines[index]}`);
				if (matches.length >= 100) {
					return matches.join('\n');
				}
			}
		}
		if (outputMode === 'files_with_matches' && fileMatched) {
			matches.push(rel);
		}
	}
	return outputMode === 'count' ? String(count) : matches.join('\n');
}

async function codebaseSearchTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const query = stringArg(args, 'query');
	if (!query) {
		throw new Error('codebase_search requires query');
	}
	const root = workspaceRoot(rootPath);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const limit = numberArg(args, 'num_results') ?? 15;
	const files = await walkFiles(root, 800);
	const scored: { path: string; score: number; preview: string }[] = [];
	for (const file of files) {
		if (!(await isTextFile(file))) {
			continue;
		}
		const text = await fs.promises.readFile(file, 'utf8');
		const lower = text.toLowerCase();
		const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
		if (score <= 0) {
			continue;
		}
		const preview = text.split(/\r?\n/).find(line => terms.some(term => line.toLowerCase().includes(term)))?.trim().slice(0, 240) ?? '';
		scored.push({ path: relativePath(root, file), score, preview });
	}
	return scored
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map(item => `${item.path}: ${item.preview}`)
		.join('\n');
}

async function writeFileTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(file, content, 'utf8');
	return `Wrote ${relativePath(workspaceRoot(rootPath), file)}`;
}

async function editFileTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	const oldText = stringArg(args, 'old_string', 'oldString', 'oldText');
	const newText = stringArg(args, 'new_string', 'newString', 'newText');
	const source = await fs.promises.readFile(file, 'utf8');
	if (!source.includes(oldText)) {
		throw new Error(`Target text not found in ${relativePath(workspaceRoot(rootPath), file)}`);
	}
	const replaceAll = boolArg(args, 'replace_all', 'replaceAll');
	const edited = replaceAll ? source.split(oldText).join(newText) : source.replace(oldText, newText);
	await fs.promises.writeFile(file, edited, 'utf8');
	return `Edited ${relativePath(workspaceRoot(rootPath), file)}`;
}

async function deleteFileTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	await fs.promises.rm(file, { force: true, recursive: false });
	return `Deleted ${relativePath(workspaceRoot(rootPath), file)}`;
}

async function createDirectoryTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const dir = resolveWorkspacePath(rootPath, stringArg(args, 'path', 'dir_path', 'dirPath', 'target_directory', 'targetDirectory'));
	await fs.promises.mkdir(dir, { recursive: true });
	return `Created ${relativePath(workspaceRoot(rootPath), dir)}`;
}

async function runShellTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const command = stringArg(args, 'command', 'cmd');
	if (!command) {
		throw new Error('shell tool requires command');
	}
	const cwd = resolveShellCwd(rootPath, stringArg(args, 'working_directory', 'cwd'));
	const timeout = numberArg(args, 'timeout_ms', 'timeout') ?? 120_000;
	const isBackground = boolArg(args, 'is_background');
	if (isBackground) {
		const child = spawn(command, [], { cwd, shell: true, env: process.env, detached: true, stdio: 'ignore' });
		child.unref();
		return `Started background command: ${command}`;
	}
	return new Promise<string>(resolve => {
		let output = '';
		let settled = false;
		const child = spawn(command, [], { cwd, shell: true, env: process.env });
		const append = (chunk: Buffer | string) => {
			if (output.length < 1024 * 1024) {
				output += chunk.toString();
			}
		};
		const finish = (suffix = '') => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(`${output}${suffix}`);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(`\n[Command timed out after ${Math.round(timeout / 1000)}s]\n`);
		}, timeout);
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', error => finish(`\n[Command failed: ${error.message}]\n`));
		child.on('close', (code, signal) => {
			if (code === 0 || code === null && !signal) {
				finish();
			} else {
				finish(`\n[Command exited ${signal ? `with signal ${signal}` : `with code ${code}`}]\n`);
			}
		});
	});
}

async function runCodeTool(rootPath: string | undefined, args: Record<string, unknown>): Promise<string> {
	const code = stringArg(args, 'code');
	if (!code) {
		throw new Error('run_code/repl requires code');
	}
	const language = (stringArg(args, 'language') || 'python').toLowerCase();
	if (language === 'shell') {
		return runShellTool(rootPath, { ...args, command: code });
	}
	const command = language === 'node' || language === 'typescript'
		? `node -e ${shellQuote(code)}`
		: `python3 -c ${shellQuote(code)}`;
	return runShellTool(rootPath, { ...args, command });
}

async function sleepTool(args: Record<string, unknown>): Promise<string> {
	const seconds = Math.max(0, numberArg(args, 'seconds') ?? 1);
	await new Promise(resolve => setTimeout(resolve, seconds * 1000));
	return `Waited ${seconds} second(s).`;
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		if (files.length >= limit) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= limit || IGNORED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(fullPath);
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	};
	await visit(root);
	return files;
}

async function isTextFile(file: string): Promise<boolean> {
	const stat = await fs.promises.stat(file);
	if (stat.size > 512_000) {
		return false;
	}
	const fd = await fs.promises.open(file, 'r');
	try {
		const buffer = Buffer.alloc(Math.min(stat.size, 1024));
		const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
		return !buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await fd.close();
	}
}

function resolveWorkspacePath(rootPath: string | undefined, rawPath: string): string {
	const root = workspaceRoot(rootPath);
	const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
	const relative = path.relative(root, resolved);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Path is outside the workspace: ${rawPath}`);
	}
	return resolved;
}

function resolveShellCwd(rootPath: string | undefined, rawCwd: string | undefined): string {
	if (!rawCwd) {
		return workspaceRoot(rootPath);
	}
	return resolveWorkspacePath(rootPath, rawCwd);
}

function workspaceRoot(rootPath: string | undefined): string {
	return path.resolve(rootPath || process.cwd());
}

function relativePath(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
	let source = '^';
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		const next = normalized[index + 1];
		if (char === '*' && next === '*') {
			source += '.*';
			index++;
		} else if (char === '*') {
			source += '[^/]*';
		} else if (char === '?') {
			source += '[^/]';
		} else {
			source += escapeRegExp(char);
		}
	}
	return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function parseToolCall(raw: unknown): ParsedToolCall {
	const value = isObjectRecord(raw) ? raw : {};
	const fn = isObjectRecord(value.function) ? value.function : {};
	const rawArgs = firstPresent(fn, ['arguments', 'args', 'parameters', 'input'])
		?? firstPresent(value, ['arguments', 'args', 'parameters', 'input'])
		?? {};
	return {
		id: firstStringProperty(value, ['id', 'tool_call_id', 'toolCallId', 'call_id', 'callId']) ?? `call_${generateUuid()}`,
		name: firstStringProperty(fn, ['name'])
			?? firstStringProperty(value, ['name', 'tool_name', 'toolName', 'function_name', 'functionName'])
			?? 'unknown',
		args: parseToolArgs(rawArgs),
	};
}

function parseToolArgs(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(text);
			return isObjectRecord(parsed) ? parsed : { input: parsed };
		} catch {
			return { input: text };
		}
	}
	return isObjectRecord(value) ? value : {};
}

function firstPresent(source: Record<string, unknown>, names: readonly string[]): unknown {
	for (const name of names) {
		if (source[name] !== undefined) {
			return source[name];
		}
	}
	return undefined;
}

function firstStringProperty(source: Record<string, unknown>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = source[name];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function filePathArg(args: Record<string, unknown>): string {
	return stringArg(args, 'path', 'file_path', 'filePath', 'target_file', 'targetFile');
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'string') {
			return value;
		}
	}
	return '';
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'number') {
			return value;
		}
		if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function boolArg(args: Record<string, unknown>, ...names: string[]): boolean {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'boolean') {
			return value;
		}
		if (typeof value === 'string') {
			return value === 'true';
		}
	}
	return false;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReadOnlyTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search', 'web_search', 'web_fetch'].includes(name);
}

function displayToolName(name: string): string {
	return name.split('_').map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ');
}

function toolKind(name: string): string {
	if (name === 'bash' || name === 'run_terminal_cmd' || name === 'run_code' || name === 'repl') {
		return 'terminal';
	}
	if (name.includes('file') || name === 'write' || name === 'edit') {
		return 'file';
	}
	if (name.startsWith('web_')) {
		return 'search';
	}
	return 'tool';
}

function describeToolInvocation(call: ParsedToolCall): string {
	const command = stringArg(call.args, 'command', 'cmd');
	if (command) {
		return command;
	}
	const file = stringArg(call.args, 'path', 'file_path', 'filePath', 'target_file', 'targetFile');
	if (file) {
		return `${displayToolName(call.name)} ${file}`;
	}
	return displayToolName(call.name);
}

function completedToolMessage(call: ParsedToolCall): string {
	return `${displayToolName(call.name)} completed`;
}

function toolOutput(toolCallId: string, output: unknown): unknown {
	return { tool_call_id: toolCallId, toolCallId, output: JSON.stringify(output) };
}

function compactJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
