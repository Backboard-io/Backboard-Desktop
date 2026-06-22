/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { CancellationError } from '../../../../base/common/errors.js';
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
import { createAgentModelPricingMeta } from '../../common/agentModelPricing.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { getToolOutputText, MessageKind, ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallContributorKind, ToolResultContentType, TurnState, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type SessionInputAnswer, type SessionInputResponseKind, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
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
const BACKBOARD_INTENSITY_CONFIG_KEY = 'intensity';
const BACKBOARD_WEB_SEARCH_CONFIG_KEY = 'webSearch';
const BACKBOARD_IMAGE_CONFIG_KEY = 'imageGeneration';
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'target', '.next', '.turbo']);
const BACKBOARD_TOOL_CACHE_TTL_MS = 10 * 60 * 1000;

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
	readonly stage?: string;
	readonly elapsedMs?: number | string;
	readonly details?: unknown;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly argumentsChars?: number;
	readonly contentLines?: number;
	readonly path?: string;
}

interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly model_type?: string;
	readonly displayName?: string;
	readonly contextLimit?: number;
	readonly supportsVision?: boolean;
	readonly pricing?: string;
	readonly inputPricePerMillion?: number | string;
	readonly outputPricePerMillion?: number | string;
	readonly inputCostPer1mTokens?: number | string;
	readonly outputCostPer1mTokens?: number | string;
	readonly input_cost_per_1m_tokens?: number | string;
	readonly output_cost_per_1m_tokens?: number | string;
	readonly inputPrice?: number | string;
	readonly outputPrice?: number | string;
	readonly input_price?: number | string;
	readonly output_price?: number | string;
	readonly promptPrice?: number | string;
	readonly completionPrice?: number | string;
	readonly promptPricePerMillion?: number | string;
	readonly completionPricePerMillion?: number | string;
	readonly cachePrice?: number | string;
	readonly cache_price?: number | string;
	readonly cacheCost?: number | string;
	readonly cacheCostPer1mTokens?: number | string;
	readonly cachePricePerMillion?: number | string;
	readonly cacheWritePrice?: number | string;
	readonly cache_write_price?: number | string;
	readonly cacheWriteCost?: number | string;
	readonly cacheWriteCostPer1mTokens?: number | string;
	readonly cacheWritePricePerMillion?: number | string;
}

const BUNDLED_BACKBOARD_MODELS: readonly BridgeModel[] = [
	{ provider: 'openrouter', name: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', modelType: 'llm' },
	{ provider: 'openrouter', name: 'openai/gpt-5-chat', displayName: 'GPT-5 Chat', modelType: 'llm' },
	{ provider: 'openrouter', name: 'openai/gpt-5', displayName: 'GPT-5', modelType: 'llm' },
	{ provider: 'openrouter', name: 'openai/gpt-5-mini', displayName: 'GPT-5 Mini', modelType: 'llm' },
	{ provider: 'openrouter', name: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 3, outputPricePerMillion: 15 },
	{ provider: 'openrouter', name: 'anthropic/claude-opus-4.5', displayName: 'Claude Opus 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 5, outputPricePerMillion: 25 },
	{ provider: 'openrouter', name: 'anthropic/claude-haiku-4.5', displayName: 'Claude Haiku 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 1, outputPricePerMillion: 5 },
	{ provider: 'openrouter', name: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', modelType: 'llm' },
	{ provider: 'openrouter', name: 'google/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', modelType: 'llm' },
	{ provider: 'openrouter', name: 'x-ai/grok-4', displayName: 'Grok 4', modelType: 'llm' },
	{ provider: 'openrouter', name: 'mistralai/mistral-large', displayName: 'Mistral Large', modelType: 'llm' },
	{ provider: 'aws-bedrock', name: 'anthropic.claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 3, outputPricePerMillion: 15 },
	{ provider: 'aws-bedrock', name: 'anthropic.claude-opus-4-6', displayName: 'Claude Opus 4.6', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 5, outputPricePerMillion: 25 },
	{ provider: 'aws-bedrock', name: 'anthropic.claude-haiku-4-5', displayName: 'Claude Haiku 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 1, outputPricePerMillion: 5 },
	{ provider: 'openai', name: 'gpt-5', displayName: 'GPT-5', modelType: 'llm' },
	{ provider: 'openai', name: 'gpt-5-mini', displayName: 'GPT-5 Mini', modelType: 'llm' },
	{ provider: 'google', name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', modelType: 'llm' },
	{ provider: 'google', name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', modelType: 'llm' },
	{ provider: 'anthropic', name: 'claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 3, outputPricePerMillion: 15 },
	{ provider: 'anthropic', name: 'claude-opus-4.5', displayName: 'Claude Opus 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 5, outputPricePerMillion: 25 },
	{ provider: 'anthropic', name: 'claude-haiku-4.5', displayName: 'Claude Haiku 4.5', modelType: 'llm', contextLimit: 200000, inputPricePerMillion: 1, outputPricePerMillion: 5 },
];

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

interface CachedBackboardTools {
	readonly expiresAt: number;
	readonly tools?: unknown[];
	readonly pending?: Promise<unknown[] | undefined>;
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
	clientTools?: readonly ToolDefinition[];
	toolsClientId?: string;
	readonly pendingClientToolCalls: PendingRequestRegistry<ToolCallResult>;
	currentRequestId?: string;
	disposed: boolean;
}

interface BackboardPanelPersistedState {
	readonly activeView?: string;
	readonly activeHistoryId?: string;
	readonly promptQueue?: unknown[];
	readonly currentWorkspace?: string;
	readonly historyEntries?: unknown[];
	readonly savedAt?: number;
}

interface BackboardPanelStateStore {
	readonly latest?: BackboardPanelPersistedState;
	readonly byWorkspace?: Record<string, BackboardPanelPersistedState>;
}

interface BackboardPanelThreadFile {
	readonly version?: number;
	readonly source?: string;
	readonly workspace?: string;
	readonly savedAt?: number;
	readonly entry?: unknown;
}

interface BackboardConfigJson {
	readonly env?: unknown;
	readonly api_url?: unknown;
	readonly apiUrl?: unknown;
	readonly api_key?: unknown;
	readonly apiKey?: unknown;
	readonly env_keys?: unknown;
	readonly oauth?: unknown;
}

interface BackboardPanelHistoryEntry {
	readonly id: string;
	readonly title?: string;
	readonly prompt?: string;
	readonly startedAt?: number;
	readonly updatedAt?: number;
	readonly status?: string;
	readonly html?: string;
	readonly outputText?: string;
	readonly toolOutputs?: unknown[];
	readonly messages?: unknown[];
	readonly currentWorkspace?: string;
}

interface BackboardResponseState {
	didCreatePart: boolean;
	didCreateReasoningPart?: boolean;
	reasoningPartId?: string;
	didCreateStatusPart?: boolean;
	streamingToolCalls?: Set<string>;
	lastProgressMessage?: string;
	lastHeartbeatProgressAt?: number;
	pendingText: string;
	assistantText: string;
	toolOutputs: StoredToolOutput[];
	flushHandle?: ReturnType<typeof setTimeout>;
}

interface StoredToolOutput {
	readonly id: string;
	readonly name: string;
	readonly input: string;
	readonly success: boolean;
	readonly output: string;
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

interface BackboardToolDisplay {
	readonly displayName: string;
	readonly invocationMessage: string;
	readonly completedMessage: string;
	readonly failedMessage: string;
	readonly skippedMessage: string;
	readonly toolKind: string;
}

interface PreparedBackboardToolCall {
	readonly call: ParsedToolCall;
	readonly toolInput: string;
	readonly clientTool?: ToolDefinition;
	readonly display: BackboardToolDisplay;
}

export interface BackboardTurnSettings {
	readonly provider: string;
	readonly model: string;
	readonly mode: string;
	readonly intensity: string;
	readonly webSearch: string;
	readonly imageGeneration: string;
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
		this._refreshModels(true);
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

		const restoredEntry = config.session ? await this._panelHistoryEntry(sessionId) : undefined;
		if (restoredEntry) {
			const workingDirectory = config.workingDirectory ?? panelEntryWorkspace(restoredEntry);
			const session: BackboardSession = {
				sessionUri,
				sessionId,
				createdAt: restoredEntry.startedAt ?? Date.now(),
				modifiedAt: restoredEntry.updatedAt ?? restoredEntry.startedAt ?? Date.now(),
				workingDirectory,
				model: normalizeBackboardModelSelection(config.model),
				config: normalizeBackboardConfig(config.config),
				title: restoredEntry.title,
				materialized: true,
				pendingClientToolCalls: new PendingRequestRegistry<ToolCallResult>(),
				disposed: false,
			};
			this._sessions.set(sessionId, session);
			return {
				session: sessionUri,
				workingDirectory,
				project: workingDirectory ? { uri: workingDirectory, displayName: path.basename(workingDirectory.fsPath) } : undefined,
				provisional: false,
			};
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
			pendingClientToolCalls: new PendingRequestRegistry<ToolCallResult>(),
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
		const session = await this._session(sessionUri);
		const turnStartedAt = Date.now();
		const effectiveTurnId = turnId ?? generateUuid();
		await this._materialize(session);

		const partId = generateUuid();
		const responseState: BackboardResponseState = { didCreatePart: false, pendingText: '', assistantText: '', toolOutputs: [] };
		const bridgeSessionId = sandboxBridgeSessionId(session);
		session.modifiedAt = Date.now();
		session.title ??= panelHistoryTitle(prompt);
		let failedMessage: string | undefined;
		let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
		const setHeartbeat = (phase: string): void => {
			if (heartbeatHandle) {
				clearInterval(heartbeatHandle);
			}
			heartbeatHandle = setInterval(() => {
				const elapsedMs = Date.now() - turnStartedAt;
				this._logService.info(`[Backboard latency] ${phase} elapsedMs=${elapsedMs}`);
				if (elapsedMs >= 15000 && (!responseState.lastHeartbeatProgressAt || elapsedMs - responseState.lastHeartbeatProgressAt >= 30000)) {
					responseState.lastHeartbeatProgressAt = elapsedMs;
					this._appendBackboardProgress(session, effectiveTurnId, responseState, localize('backboard.progress.heartbeat.visible', "{0} ({1} elapsed).", phase, formatBackboardElapsed(elapsedMs)));
				}
			}, 5000);
		};
		const clearHeartbeat = (): void => {
			if (heartbeatHandle) {
				clearInterval(heartbeatHandle);
				heartbeatHandle = undefined;
			}
		};

			try {
				void writeSharedBackboardThread(session, prompt, '', undefined, responseState, this._logService, 'running');
				const settings = this._turnSettings(session);
				this._logService.info(`[Backboard latency] turn_start session=${session.sessionId} provider=${settings.provider} model=${settings.model} mode=${settings.mode} intensity=${settings.intensity} web=${settings.webSearch}`);
				this._logService.info(`[Backboard workspace] session=${session.sessionId} workingDirectory=${session.workingDirectory?.fsPath ?? '(missing)'}`);
				this._appendBackboardProgress(session, effectiveTurnId, responseState, localize('backboard.progress.status', "Streaming Backboard response. Tool calls and file writes appear below."));
				if (session.workingDirectory) {
					this._logService.info(`[Backboard workspace] using ${session.workingDirectory.fsPath}`);
				} else {
					this._logService.warn('[Backboard workspace] no workspace folder is attached to this Backboard session');
				}
				const firstToolRequests: ToolResultRequest[] = [];
				const seenToolRequests = new Set<string>();
				const listToolsStartedAt = Date.now();
				this._logService.info('[Backboard progress] Loading Backboard tools.');
				setHeartbeat(localize('backboard.progress.heartbeat.tools', "Still loading Backboard tools"));
				const submitToolsPromise = this._bridge.listTools(settings.mode, settings.config)
					.then(tools => mergeBackboardTools(tools, session.clientTools, settings.mode))
					.catch(() => mergeBackboardTools(undefined, session.clientTools, settings.mode));
				const submitTools = trimBackboardToolsForRequest(await submitToolsPromise, prompt, settings.webSearch, settings.imageGeneration);
				this._logService.info(`[Backboard latency] list_tools_done elapsedMs=${Date.now() - listToolsStartedAt} totalElapsedMs=${Date.now() - turnStartedAt} toolCount=${submitTools?.length ?? 0}`);
				this._logService.info(`[Backboard progress] Sending prompt to Backboard with ${submitTools?.length ?? 0} tools.`);
				setHeartbeat(localize('backboard.progress.heartbeat.response', "Waiting for Backboard response"));
				const sendPromptStartedAt = Date.now();
				const handle = this._bridge.send('sendPrompt', bridgeSessionId, {
					content: prompt,
					workspace: session.workingDirectory?.fsPath,
					provider: settings.provider,
					model: settings.model,
					mode: settings.mode,
					intensity: settings.intensity,
					webSearch: settings.webSearch,
					imageGeneration: settings.imageGeneration === 'auto' ? 'auto' : undefined,
					tools: submitTools,
					config: settings.config,
				}, event => this._handleBridgeEvent(session, effectiveTurnId, partId, responseState, firstToolRequests, seenToolRequests, event));
				session.currentRequestId = handle.requestId;
				await handle.promise;
				clearHeartbeat();
				this._logService.info(`[Backboard latency] send_prompt_done elapsedMs=${Date.now() - sendPromptStartedAt} totalElapsedMs=${Date.now() - turnStartedAt}`);
				this._flushAssistantText(session, effectiveTurnId, partId, responseState);

				let nextToolRequest = firstToolRequests.shift();
				while (nextToolRequest) {
					const toolExecutionStartedAt = Date.now();
					this._logService.info(`[Backboard progress] Running ${nextToolRequest.toolCalls.length} Backboard tool call(s).`);
					setHeartbeat(localize('backboard.progress.heartbeat.localTools', "Still running Backboard tools"));
					const toolOutputs = await this._executeToolCalls(session, effectiveTurnId, nextToolRequest.toolCalls, settings.mode, responseState);
					clearHeartbeat();
					this._logService.info(`[Backboard latency] local_tools_done elapsedMs=${Date.now() - toolExecutionStartedAt} totalElapsedMs=${Date.now() - turnStartedAt} toolCount=${nextToolRequest.toolCalls.length}`);
					const continuationToolRequests: ToolResultRequest[] = [];
					const submitToolStartedAt = Date.now();
					this._logService.info(`[Backboard progress] Submitting ${toolOutputs.length} Backboard tool result(s).`);
					setHeartbeat(localize('backboard.progress.heartbeat.submitTools', "Still submitting Backboard tool results"));
					const continuation = this._bridge.send('submitToolResult', bridgeSessionId, {
						threadId: nextToolRequest.threadId,
						runId: nextToolRequest.runId,
						toolOutputs,
						tools: submitTools,
						workspace: session.workingDirectory?.fsPath,
						provider: settings.provider,
						model: settings.model,
						mode: settings.mode,
						intensity: settings.intensity,
						webSearch: settings.webSearch,
						imageGeneration: settings.imageGeneration === 'auto' ? 'auto' : undefined,
						config: settings.config,
					}, event => this._handleBridgeEvent(session, effectiveTurnId, partId, responseState, continuationToolRequests, seenToolRequests, event));
					session.currentRequestId = continuation.requestId;
					await continuation.promise;
					clearHeartbeat();
					this._logService.info(`[Backboard latency] submit_tool_result_done elapsedMs=${Date.now() - submitToolStartedAt} totalElapsedMs=${Date.now() - turnStartedAt}`);
					this._flushAssistantText(session, effectiveTurnId, partId, responseState);
					nextToolRequest = continuationToolRequests.shift();
				}
		} catch (error) {
			const message = backboardDisplayErrorMessage(error instanceof Error ? error.message : String(error));
			if (isRecoverableToolOutputSubmissionError(message)) {
				this._logService.info(`[Backboard] Suppressed recoverable tool-output submission error: ${message}`);
			} else {
				failedMessage = message;
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId: effectiveTurnId,
					error: { errorType: 'BackboardSendFailed', message },
				});
			}
			} finally {
				clearHeartbeat();
				this._flushAssistantText(session, effectiveTurnId, partId, responseState);
				session.currentRequestId = undefined;
				void writeSharedBackboardThread(session, prompt, responseState.assistantText, failedMessage, responseState, this._logService, failedMessage ? 'error' : 'complete');
				this._fire(session.sessionUri, { type: ActionType.ChatTurnComplete, turnId: effectiveTurnId });
			}
	}

	async getSessionMessages(_session: URI): Promise<readonly Turn[]> {
		const entry = await this._panelHistoryEntry(AgentSession.id(_session));
		return entry ? [panelHistoryEntryToTurn(entry)] : [];
	}

	async disposeSession(sessionUri: URI): Promise<void> {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		if (session?.currentRequestId) {
			this._bridge.cancel(sandboxBridgeSessionId(session), session.currentRequestId);
		}
		if (session) {
			session.disposed = true;
			session.pendingClientToolCalls.rejectAll(new CancellationError());
		}
		this._sessions.delete(sessionId);
	}

	async abortSession(sessionUri: URI): Promise<void> {
		const session = await this._session(sessionUri);
		if (session.currentRequestId) {
			this._bridge.cancel(sandboxBridgeSessionId(session), session.currentRequestId);
		}
		session.pendingClientToolCalls.rejectAll(new CancellationError());
	}

	async changeModel(sessionUri: URI, model: ModelSelection): Promise<void> {
		(await this._session(sessionUri)).model = normalizeBackboardModelSelection(model);
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
	}

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void {
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
				status: session.currentRequestId ? SessionStatus.InProgress : SessionStatus.Idle,
				model: session.model,
				workingDirectory: session.workingDirectory,
				project: session.workingDirectory ? { uri: session.workingDirectory, displayName: path.basename(session.workingDirectory.fsPath) } : undefined,
			}));
		const seen = new Set(inMemory.map(session => AgentSession.id(session.session)));
		const restored = (await this._panelHistoryEntries())
			.filter(entry => !seen.has(entry.id))
			.map(entry => {
				const workingDirectory = panelEntryWorkspace(entry);
				return {
					session: AgentSession.uri(this.id, entry.id),
					startTime: entry.startedAt ?? entry.updatedAt ?? Date.now(),
					modifiedTime: entry.updatedAt ?? entry.startedAt ?? Date.now(),
					summary: entry.title || entry.prompt,
					status: panelEntryStatus(entry),
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

	setClientTools(session: URI, clientId: string | undefined, tools: ToolDefinition[]): void {
		const sessionId = AgentSession.id(session);
		let sess = this._sessions.get(sessionId);
		if (sess?.disposed) {
			return;
		}
		if (!sess) {
			sess = this._createMissingSession(session);
			this._sessions.set(sessionId, sess);
		}
		sess.clientTools = tools.length > 0 ? tools : undefined;
		sess.toolsClientId = sess.clientTools ? clientId : undefined;
		this._logService.info(`[Backboard:${sessionId}] setClientTools clientId=${clientId ?? '(none)'} tools=[${tools.map(tool => tool.name).join(', ') || '(none)'}]`);
	}

	onClientToolCallComplete(session: URI, toolCallId: string, result: ToolCallResult): void {
		const sess = this._sessions.get(AgentSession.id(session));
		sess?.pendingClientToolCalls.respondOrBuffer(toolCallId, result);
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
	}

	setPendingMessages(_session: URI, _steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
	}

	async shutdown(): Promise<void> {
		for (const session of this._sessions.values()) {
			if (session.currentRequestId) {
				this._bridge.cancel(sandboxBridgeSessionId(session), session.currentRequestId);
			}
			session.pendingClientToolCalls.rejectAll(new CancellationError());
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

	private async _session(sessionUri: URI): Promise<BackboardSession> {
		const sessionId = AgentSession.id(sessionUri);
		const session = this._sessions.get(sessionId);
		if (session && !session.disposed) {
			return session;
		}
		if (session?.disposed) {
			throw new Error(`Backboard session was disposed: ${sessionUri.toString()}`);
		}
		const restoredEntry = await this._panelHistoryEntry(sessionId);
		const restoredSession = this._createMissingSession(sessionUri, restoredEntry);
		this._sessions.set(sessionId, restoredSession);
		this._logService.warn(`[Backboard] Recreated missing session from URI ${sessionUri.toString()}`);
		return restoredSession;
	}

	private _createMissingSession(sessionUri: URI, restoredEntry?: BackboardPanelHistoryEntry): BackboardSession {
		const sessionId = AgentSession.id(sessionUri);
		return {
			sessionUri,
			sessionId,
			createdAt: restoredEntry?.startedAt ?? Date.now(),
			modifiedAt: restoredEntry?.updatedAt ?? restoredEntry?.startedAt ?? Date.now(),
			workingDirectory: restoredEntry ? panelEntryWorkspace(restoredEntry) : undefined,
			title: restoredEntry?.title,
			materialized: !!restoredEntry,
			pendingClientToolCalls: new PendingRequestRegistry<ToolCallResult>(),
			disposed: false,
		};
	}

	private _fire(session: URI, action: SessionAction | ChatAction): void {
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
		responseState: BackboardResponseState,
		toolRequests: ToolResultRequest[],
		seenToolRequests: Set<string>,
		event: BridgeEvent,
	): void {
		switch (event.type) {
			case 'trace':
				this._logService.info(`[Backboard latency] bridge_stage=${event.stage ?? '(unknown)'} elapsedMs=${event.elapsedMs ?? '(unknown)'} details=${safeStringifyForLog(event.details)}`);
				{
					const message = backboardTraceProgressMessage(event);
					if (message) {
						this._appendBackboardProgress(session, turnId, responseState, message);
					}
				}
				return;
			case 'progress':
				if (event.message) {
					this._appendBackboardProgress(session, turnId, responseState, event.message);
				}
				return;
			case 'toolCallStreaming':
				this._handleStreamingToolCall(session, turnId, responseState, event);
				return;
			case 'assistantTextDelta':
				if (!event.text) {
					return;
				}
				const visibleText = visibleAssistantTextDelta(event.text);
				if (!visibleText) {
					return;
				}
				responseState.pendingText += visibleText;
				responseState.flushHandle ??= setTimeout(() => this._flushAssistantText(session, turnId, partId, responseState), 16);
				return;
			case 'reasoningDelta':
				if (!event.text) {
					return;
				}
				this._flushAssistantText(session, turnId, partId, responseState);
				this._appendReasoning(session, turnId, responseState, event.text);
				return;
			case 'toolRequested':
				this._flushAssistantText(session, turnId, partId, responseState);
				this._appendBackboardProgress(session, turnId, responseState, localize('backboard.progress.toolRequested', "Backboard requested {0} tool call(s).", event.toolCalls?.length ?? 0));
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
				this._flushAssistantText(session, turnId, partId, responseState);
				this._logService.error(`[Backboard provider error] ${safeStringifyForLog(event)}`);
				if (isRecoverableToolOutputSubmissionError(event.message)) {
					this._logService.info(`[Backboard] Suppressed recoverable tool-output submission error: ${event.message}`);
					return;
				}
				this._fire(session.sessionUri, {
					type: ActionType.ChatError,
					turnId,
					error: { errorType: 'BackboardError', message: backboardDisplayErrorMessage(event.message ?? 'Backboard request failed.') },
				});
				return;
		}
	}

	private _handleStreamingToolCall(session: BackboardSession, turnId: string, responseState: BackboardResponseState, event: BridgeEvent): void {
		const toolCallId = event.toolCallId;
		const toolName = event.toolName;
		if (!toolCallId || !toolName) {
			return;
		}
		const call = { id: toolCallId, name: toolName, args: {} };
		const display = backboardToolDisplay(call);
		responseState.streamingToolCalls ??= new Set<string>();
		if (!responseState.streamingToolCalls.has(toolCallId)) {
			responseState.streamingToolCalls.add(toolCallId);
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallStart,
				turnId,
				toolCallId,
				toolName,
				displayName: display.displayName,
				_meta: { toolKind: display.toolKind, source: 'backboard' },
			});
		}
		this._fire(session.sessionUri, {
			type: ActionType.ChatToolCallDelta,
			turnId,
			toolCallId,
			content: '',
			invocationMessage: streamingToolInvocationMessage(toolName, event.path, event.argumentsChars, event.contentLines),
			_meta: { toolKind: display.toolKind, source: 'backboard' },
		});
	}

	private _flushAssistantText(session: BackboardSession, turnId: string, partId: string, responseState: BackboardResponseState): void {
		if (responseState.flushHandle) {
			clearTimeout(responseState.flushHandle);
			responseState.flushHandle = undefined;
		}
		const content = responseState.pendingText;
		if (!content) {
			return;
		}
		responseState.pendingText = '';
		responseState.assistantText += content;
		if (!responseState.didCreatePart) {
			responseState.didCreatePart = true;
			this._fire(session.sessionUri, {
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Markdown, id: partId, content: '' },
			});
		}
		this._fire(session.sessionUri, { type: ActionType.ChatDelta, turnId, partId, content });
	}

	private _appendBackboardProgress(session: BackboardSession, turnId: string, responseState: BackboardResponseState, message: string): void {
		const normalized = message.trim();
		if (!normalized || responseState.lastProgressMessage === normalized) {
			return;
		}
		responseState.lastProgressMessage = normalized;
		this._logService.info(`[Backboard progress] ${normalized}`);
		if (responseState.didCreateStatusPart && !isBackboardImportantProgress(normalized)) {
			return;
		}
		responseState.didCreateStatusPart = true;
		this._fire(session.sessionUri, {
			type: ActionType.ChatResponsePart,
			turnId,
			part: {
				kind: ResponsePartKind.SystemNotification,
				content: localize('backboard.progress.notification', "Backboard: {0}", truncateBackboardProgressForChat(normalized)),
			},
		});
	}

	private _appendReasoning(session: BackboardSession, turnId: string, responseState: BackboardResponseState, content: string): void {
		responseState.reasoningPartId ??= generateUuid();
		if (!responseState.didCreateReasoningPart) {
			responseState.didCreateReasoningPart = true;
			this._fire(session.sessionUri, {
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Reasoning, id: responseState.reasoningPartId, content: '' },
			});
		}
		this._fire(session.sessionUri, {
			type: ActionType.ChatReasoning,
			turnId,
			partId: responseState.reasoningPartId,
			content,
		});
	}

	private async _executeToolCalls(session: BackboardSession, turnId: string, toolCalls: readonly unknown[], mode: string, responseState: BackboardResponseState): Promise<unknown[]> {
		const preparedCalls = toolCalls.map(rawCall => this._prepareToolCall(session, rawCall));
		if (preparedCalls.length > 1 && preparedCalls.every(prepared => this._canExecuteToolCallInParallel(prepared, mode))) {
			this._logService.info(`[Backboard latency] running_parallel_read_tools count=${preparedCalls.length}`);
			return Promise.all(preparedCalls.map(prepared => this._executePreparedToolCall(session, turnId, prepared, mode, responseState)));
		}
		const outputs: unknown[] = [];
		for (const prepared of preparedCalls) {
			outputs.push(await this._executePreparedToolCall(session, turnId, prepared, mode, responseState));
		}
		return outputs;
	}

	private _prepareToolCall(session: BackboardSession, rawCall: unknown): PreparedBackboardToolCall {
		let call = parseToolCall(rawCall);
		const preparedClientCall = prepareClientToolCall(session, call);
		call = preparedClientCall.call;
		const toolInput = toolInputPreview(call);
		const clientTool = preparedClientCall.clientTool;
		const display = backboardToolDisplay(call, clientTool);
		return { call, toolInput, clientTool, display };
	}

	private _canExecuteToolCallInParallel(prepared: PreparedBackboardToolCall, mode: string): boolean {
		return !prepared.clientTool
			&& (mode === 'free' || isReadOnlyTool(prepared.call.name))
			&& isParallelSafeBackboardTool(prepared.call.name);
	}

	private async _executePreparedToolCall(session: BackboardSession, turnId: string, prepared: PreparedBackboardToolCall, mode: string, responseState: BackboardResponseState): Promise<unknown> {
		const { call, toolInput, clientTool, display } = prepared;
		this._appendBackboardProgress(session, turnId, responseState, localize('backboard.progress.toolStart', "Starting {0}.", display.displayName));
		const alreadyStreaming = responseState.streamingToolCalls?.has(call.id) ?? false;
		if (!alreadyStreaming) {
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallStart,
				turnId,
				toolCallId: call.id,
				toolName: call.name,
				displayName: display.displayName,
				...(clientTool && session.toolsClientId ? { contributor: { kind: ToolCallContributorKind.Client, clientId: session.toolsClientId } } : {}),
				_meta: { toolKind: display.toolKind, source: clientTool ? 'client-fallback' : 'backboard' },
			});
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallDelta,
				turnId,
				toolCallId: call.id,
				content: toolInput,
			});
		}

			if (clientTool) {
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: call.id,
					invocationMessage: display.invocationMessage,
					toolInput,
					confirmed: ToolCallConfirmationReason.NotNeeded,
					_meta: { toolKind: display.toolKind, source: 'client-fallback' },
				});
				responseState.streamingToolCalls?.delete(call.id);
				if (!session.toolsClientId) {
					const message = localize('backboard.tool.clientMissing', "No active Backboard client is connected to run {0}.", display.displayName);
					this._fire(session.sessionUri, {
						type: ActionType.ChatToolCallComplete,
						turnId,
						toolCallId: call.id,
						result: {
							success: false,
							pastTenseMessage: display.failedMessage,
							content: [{ type: ToolResultContentType.Text, text: message }],
							error: { message },
						},
					});
					responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: false, output: message });
					return toolOutput(call.id, { success: false, content: message });
				}
				try {
					const result = await session.pendingClientToolCalls.register(call.id);
					const output = toolCallResultOutput(result);
					this._appendBackboardProgress(session, turnId, responseState, result.success ? localize('backboard.progress.clientToolComplete', "{0} finished.", display.displayName) : localize('backboard.progress.clientToolFailed', "{0} returned an error.", display.displayName));
					responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: result.success, output });
					return toolOutput(call.id, { success: result.success, content: output });
				} catch (error) {
					const message = error instanceof CancellationError ? localize('backboard.tool.cancelled', "{0} was cancelled.", display.displayName) : (error instanceof Error ? error.message : String(error));
					this._fire(session.sessionUri, {
						type: ActionType.ChatToolCallComplete,
						turnId,
						toolCallId: call.id,
						result: {
							success: false,
							pastTenseMessage: display.failedMessage,
							content: [{ type: ToolResultContentType.Text, text: message }],
							error: { message },
						},
					});
					responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: false, output: message });
					return toolOutput(call.id, { success: false, content: message });
				}
			}

			const allowed = mode === 'free' || isReadOnlyTool(call.name);
			this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallReady,
				turnId,
				toolCallId: call.id,
				invocationMessage: display.invocationMessage,
				toolInput,
				confirmed: allowed ? ToolCallConfirmationReason.NotNeeded : undefined,
				_meta: { toolKind: display.toolKind, source: 'backboard' },
			});
			responseState.streamingToolCalls?.delete(call.id);

			if (!allowed) {
				const message = localize('backboard.tool.requiresApproval', "Backboard tool call requires approval. Switch this Sandbox session to Full Access to allow write tools automatically.");
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: false,
						pastTenseMessage: display.skippedMessage,
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: false, output: message });
				return toolOutput(call.id, { success: false, content: message });
			}

			const reportContent = createToolContentReporter((content: string) => this._fire(session.sessionUri, {
				type: ActionType.ChatToolCallContentChanged,
				turnId,
				toolCallId: call.id,
				content: [{ type: ToolResultContentType.Text, text: content }],
			}));
			try {
				const result = await executeBackboardTool(this._bridge, session.workingDirectory?.fsPath, call, reportContent.report);
				reportContent.flush();
				this._appendBackboardProgress(session, turnId, responseState, localize('backboard.progress.toolComplete', "{0} finished.", display.displayName));
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: true,
						pastTenseMessage: display.completedMessage,
						content: result ? [{ type: ToolResultContentType.Text, text: result }] : undefined,
					},
				});
				responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: true, output: result ?? '' });
				return toolOutput(call.id, { success: true, content: result });
			} catch (error) {
				reportContent.flush();
				const message = error instanceof Error ? error.message : String(error);
				this._appendBackboardProgress(session, turnId, responseState, localize('backboard.progress.toolFailed', "{0} failed: {1}", display.displayName, message));
				this._fire(session.sessionUri, {
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: call.id,
					result: {
						success: false,
						pastTenseMessage: display.failedMessage,
						content: [{ type: ToolResultContentType.Text, text: message }],
						error: { message },
					},
				});
				responseState.toolOutputs.push({ id: call.id, name: display.displayName, input: toolInput, success: false, output: message });
				return toolOutput(call.id, { success: false, content: message });
			}
		}

	private _refreshModels(deferNetwork = false): void {
		const cachedModels = this._readCachedModels();
		const initialModels = cachedModels.length ? cachedModels : BUNDLED_BACKBOARD_MODELS;
		if (initialModels.length) {
			this._models.set(backboardModelInfos(initialModels), undefined);
		}
		const refresh = (): void => {
			this._bridge.send('listModels', undefined, { config: bridgeConfig() }, undefined).promise.then(events => {
				const bridgeModels = events.find(event => event.type === 'models')?.models ?? [];
				if (bridgeModels.length) {
					this._writeCachedModels(bridgeModels);
				}
				const models = bridgeModels.length
					? backboardModelInfos(bridgeModels)
					: backboardModelInfos(cachedModels, BUNDLED_BACKBOARD_MODELS);
				this._models.set(models.length ? models : [fallbackModel()], undefined);
			}).catch(error => {
				this._logService.warn(`[Backboard] Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
				if (!initialModels.length) {
					this._models.set([fallbackModel()], undefined);
				}
			});
		};
		if (deferNetwork) {
			const handle = setTimeout(refresh, 2500);
			this._register({ dispose: () => clearTimeout(handle) });
		} else {
			refresh();
		}
	}

	private _modelCachePath(): string {
		return path.join(this._environmentService.appSettingsHome.fsPath, 'globalStorage', 'backboard.backboard', 'models.json');
	}

	private _readCachedModels(): BridgeModel[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this._modelCachePath(), 'utf8'));
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

	private _writeCachedModels(models: readonly BridgeModel[]): void {
		const cachePath = this._modelCachePath();
		const dir = path.dirname(cachePath);
		try {
			fs.mkdirSync(dir, { recursive: true });
			const tempPath = path.join(dir, `models.${process.pid}.${Date.now()}.tmp`);
			const entry = {
				env: currentBackboardEnv(),
				version: BACKBOARD_MODEL_CACHE_VERSION,
				fetchedAt: Date.now(),
				models: models.filter(isBridgeModel).filter(isVisibleBridgeModel),
			};
			fs.writeFileSync(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
			fs.renameSync(tempPath, cachePath);
		} catch (error) {
			this._logService.warn(`[Backboard] Failed to write cached models: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _panelHistoryEntry(id: string): Promise<BackboardPanelHistoryEntry | undefined> {
		return (await this._panelHistoryEntries()).find(entry => entry.id === id);
	}

	private async _panelHistoryEntries(): Promise<BackboardPanelHistoryEntry[]> {
		const states = readBackboardPanelStates(this._logService);
		const entries = new Map<string, BackboardPanelHistoryEntry>();
		for (const state of states.sort((left, right) => panelStateTimestamp(left) - panelStateTimestamp(right))) {
			const workspace = typeof state.currentWorkspace === 'string' ? state.currentWorkspace : undefined;
			for (const rawEntry of Array.isArray(state.historyEntries) ? state.historyEntries : []) {
				const entry = normalizePanelHistoryEntry(rawEntry, workspace);
				if (entry) {
					entries.set(entry.id, entry);
				}
			}
		}
		return [...entries.values()].sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
	}
}

function readBackboardPanelStates(logService: ILogService): BackboardPanelPersistedState[] {
	const states: BackboardPanelPersistedState[] = [];
	const sharedState = readSharedBackboardPanelState(logService);
	if (sharedState) {
		states.push(...sharedState);
	}
	const bySignature = new Map<string, BackboardPanelPersistedState>();
	for (const state of states) {
		if (!hasPanelStateContent(state)) {
			continue;
		}
		bySignature.set(panelStateSignature(state), state);
	}
	return [...bySignature.values()];
}

function readSharedBackboardPanelState(logService: ILogService): BackboardPanelPersistedState[] | undefined {
	const statePath = path.join(os.homedir(), '.backboard_ide', 'panel-state.json');
	const states: BackboardPanelPersistedState[] = [];
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
		if (isObjectRecord(parsed)) {
			const store = parsed as BackboardPanelStateStore;
			states.push(
				...(store.latest && isPanelPersistedState(store.latest) ? [store.latest] : []),
				...Object.values(store.byWorkspace ?? {}).filter(isPanelPersistedState),
			);
		}
	} catch (error) {
		if (!isFileNotFoundError(error) && !(error instanceof SyntaxError)) {
			logService.warn(`[Backboard] Failed to read shared panel state: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	states.push(...readSharedBackboardThreadStates(logService));
	return states.length ? states : undefined;
}

function readSharedBackboardThreadStates(logService: ILogService): BackboardPanelPersistedState[] {
	const entries = readSharedBackboardThreadEntries(logService);
	if (!entries.length) {
		return [];
	}
	const byWorkspace = new Map<string | undefined, BackboardPanelHistoryEntry[]>();
	for (const entry of entries) {
		const workspace = entry.currentWorkspace;
		const bucket = byWorkspace.get(workspace) ?? [];
		bucket.push(entry);
		byWorkspace.set(workspace, bucket);
	}
	const states: BackboardPanelPersistedState[] = [];
	for (const [workspace, workspaceEntries] of byWorkspace) {
		const sorted = workspaceEntries.sort((left, right) => panelHistoryEntryTimestamp(right) - panelHistoryEntryTimestamp(left));
		states.push({
			activeView: 'chat',
			activeHistoryId: sorted[0]?.id,
			currentWorkspace: workspace,
			promptQueue: [],
			historyEntries: sorted,
			savedAt: panelHistoryEntryTimestamp(sorted[0]),
		});
	}
	return states;
}

function readSharedBackboardThreadEntries(logService: ILogService): BackboardPanelHistoryEntry[] {
	const entries: BackboardPanelHistoryEntry[] = [];
	for (const threadPath of listSharedBackboardThreadFiles(logService)) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
			if (!isObjectRecord(parsed)) {
				continue;
			}
			const thread = parsed as BackboardPanelThreadFile;
			const entry = normalizePanelHistoryEntry(thread.entry, thread.workspace);
			if (entry) {
				entries.push(entry);
			}
			} catch (error) {
				if (!(error instanceof SyntaxError)) {
					logService.warn(`[Backboard] Failed to read shared thread ${threadPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
	}
	return entries;
}

function isPanelPersistedState(value: unknown): value is BackboardPanelPersistedState {
	return isObjectRecord(value)
		&& (value.activeView === undefined || typeof value.activeView === 'string')
		&& (value.activeHistoryId === undefined || typeof value.activeHistoryId === 'string')
		&& (value.currentWorkspace === undefined || typeof value.currentWorkspace === 'string')
		&& (value.promptQueue === undefined || Array.isArray(value.promptQueue))
		&& (value.historyEntries === undefined || Array.isArray(value.historyEntries))
		&& (value.savedAt === undefined || typeof value.savedAt === 'number');
}

function hasPanelStateContent(state: BackboardPanelPersistedState): boolean {
	return !!state.activeHistoryId || !!state.promptQueue?.length || !!state.historyEntries?.length;
}

function panelStateTimestamp(state: BackboardPanelPersistedState): number {
	if (typeof state.savedAt === 'number') {
		return state.savedAt;
	}
	return (state.historyEntries ?? []).reduce<number>((max, entry) => {
		if (!isObjectRecord(entry)) {
			return max;
		}
		return Math.max(max, typeof entry.updatedAt === 'number' ? entry.updatedAt : 0, typeof entry.startedAt === 'number' ? entry.startedAt : 0);
	}, 0);
}

function panelStateSignature(state: BackboardPanelPersistedState): string {
	return `${state.currentWorkspace ?? ''}:${state.activeHistoryId ?? ''}:${panelStateTimestamp(state)}:${state.historyEntries?.length ?? 0}`;
}

function normalizePanelHistoryEntry(value: unknown, currentWorkspace: string | undefined): BackboardPanelHistoryEntry | undefined {
	if (!isObjectRecord(value) || typeof value.id !== 'string' || !value.id) {
		return undefined;
	}
	const workspace = typeof value.currentWorkspace === 'string' ? value.currentWorkspace : currentWorkspace;
	return {
		id: value.id,
		title: typeof value.title === 'string' ? value.title : undefined,
		prompt: typeof value.prompt === 'string' ? value.prompt : undefined,
		startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined,
		updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
		status: typeof value.status === 'string' ? value.status : undefined,
		html: typeof value.html === 'string' ? value.html : undefined,
		outputText: typeof value.outputText === 'string' ? value.outputText : undefined,
		toolOutputs: Array.isArray(value.toolOutputs) ? value.toolOutputs : undefined,
		messages: Array.isArray(value.messages) ? value.messages : undefined,
		currentWorkspace: workspace,
	};
}

function panelHistoryEntryTimestamp(entry: BackboardPanelHistoryEntry | undefined): number {
	if (!entry) {
		return 0;
	}
	return Math.max(entry.updatedAt ?? 0, entry.startedAt ?? 0);
}

function panelEntryWorkspace(entry: BackboardPanelHistoryEntry): URI | undefined {
	return entry.currentWorkspace ? URI.file(entry.currentWorkspace) : undefined;
}

function panelHistoryEntryToTurn(entry: BackboardPanelHistoryEntry): Turn {
	const responseText = entry.outputText || assistantTextFromPanelHtml(entry.html) || stripHtml(entry.html ?? '');
	return {
		id: entry.id,
		message: {
			text: entry.prompt || entry.title || 'Backboard chat',
			origin: { kind: MessageKind.User },
		},
		responseParts: responseText ? [{
			kind: ResponsePartKind.Markdown,
			id: `${entry.id}-response`,
			content: responseText,
		}] : [],
		usage: undefined,
		state: /fail/i.test(entry.status ?? '') ? TurnState.Error : TurnState.Complete,
	};
}

function panelEntryStatus(entry: BackboardPanelHistoryEntry): SessionStatus {
	const status = (entry.status ?? '').toLowerCase();
	if (status.includes('running') || status.includes('progress')) {
		return SessionStatus.InProgress;
	}
	if (status.includes('error') || status.includes('fail')) {
		return SessionStatus.Error;
	}
	return SessionStatus.Idle;
}

function isBackboardImportantProgress(message: string): boolean {
	return /\b(idle|reconnect|reconnected|continuation|submitting|posting|waiting|still running|still loading|failed|error|too large)\b/i.test(message);
}

function formatBackboardElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (!minutes) {
		return `${seconds}s`;
	}
	return `${minutes}m ${seconds}s`;
}

function truncateBackboardProgressForChat(message: string): string {
	const maxLength = 360;
	if (message.length <= maxLength) {
		return message;
	}
	return `${message.slice(0, maxLength - 3)}...`;
}

function assistantTextFromPanelHtml(html: string | undefined): string {
	if (!html) {
		return '';
	}
	const parts: string[] = [];
	const pattern = /<div class="messageCard assistant"[\s\S]*?<div class="messageText">([\s\S]*?)<\/div>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html))) {
		const text = stripHtml(match[1]);
		if (text) {
			parts.push(text);
		}
	}
	return parts.join('\n\n');
}

function stripHtml(html: string): string {
	return decodeHtmlEntities(html)
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

async function writeSharedBackboardThread(session: BackboardSession, prompt: string, assistantText: string, errorMessage: string | undefined, responseState: BackboardResponseState, logService: ILogService, status: 'running' | 'complete' | 'error'): Promise<void> {
	try {
		const now = Date.now();
		const workspace = session.workingDirectory?.fsPath;
		const title = session.title || panelHistoryTitle(prompt);
		const response = errorMessage ? `${assistantText}\n\n${errorMessage}`.trim() : assistantText.trim();
		const entry = {
			id: session.sessionId,
			title,
			prompt,
			startedAt: session.createdAt,
			updatedAt: now,
			status,
			currentWorkspace: workspace,
			outputText: response,
			messages: [
				{ role: 'user', content: prompt },
				...(response ? [{ role: errorMessage ? 'error' : 'assistant', content: response }] : []),
			],
			toolOutputs: responseState.toolOutputs,
			html: panelThreadHtml(prompt, response, errorMessage),
			promptQueue: [],
			fileChanges: [],
		};
		await fs.promises.mkdir(sharedBackboardThreadsDir(), { recursive: true });
		const threadPath = sharedBackboardThreadPath(workspace, session.sessionId);
		await fs.promises.mkdir(path.dirname(threadPath), { recursive: true });
		await writeJsonFileAtomic(threadPath, {
			version: 1,
			source: 'sandbox',
			workspace,
			threadId: session.sessionId,
			savedAt: now,
			entry,
		});
		if (process.platform !== 'win32') {
			await fs.promises.chmod(threadPath, 0o600);
		}
		await updateSharedBackboardPanelState(entry, workspace, now);
	} catch (error) {
		logService.warn(`[Backboard] Failed to write shared sandbox thread: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function updateSharedBackboardPanelState(entry: Record<string, unknown>, workspace: string | undefined, savedAt: number): Promise<void> {
	const store = readSharedBackboardPanelStateStore();
	const key = sharedPanelStateStorageKey(workspace);
	const previous = workspace ? store.byWorkspace?.[key] : store.latest;
	const previousEntries = Array.isArray(previous?.historyEntries) ? previous.historyEntries : [];
	const historyEntries = [entry, ...previousEntries.filter(item => !(isObjectRecord(item) && item.id === entry.id))].slice(0, 40);
	const state: BackboardPanelPersistedState = {
		activeView: 'chat',
		activeHistoryId: typeof entry.id === 'string' ? entry.id : undefined,
		currentWorkspace: workspace,
		promptQueue: [],
		historyEntries,
		savedAt,
	};
	const next: BackboardPanelStateStore = {
		byWorkspace: { ...(store.byWorkspace ?? {}), [key]: state },
		latest: state,
	};
	const statePath = sharedBackboardPanelStatePath();
	await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
	await writeJsonFileAtomic(statePath, next);
	if (process.platform !== 'win32') {
		await fs.promises.chmod(statePath, 0o600);
	}
}

function readSharedBackboardPanelStateStore(): BackboardPanelStateStore {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(sharedBackboardPanelStatePath(), 'utf8'));
		if (!isObjectRecord(parsed)) {
			return {};
		}
		const byWorkspace: Record<string, BackboardPanelPersistedState> = {};
		if (isObjectRecord(parsed.byWorkspace)) {
			for (const [key, value] of Object.entries(parsed.byWorkspace)) {
				if (isPanelPersistedState(value)) {
					byWorkspace[key] = value;
				}
			}
		}
		return {
			latest: isPanelPersistedState(parsed.latest) ? parsed.latest : undefined,
			byWorkspace: Object.keys(byWorkspace).length ? byWorkspace : undefined,
		};
	} catch {
		return {};
	}
}

function panelThreadHtml(prompt: string, assistantText: string, errorMessage: string | undefined): string {
	const user = `<div class="messageCard user"><div class="messageText">${escapePanelHtml(prompt)}</div></div>`;
	const assistantClass = errorMessage ? 'messageCard error' : 'messageCard assistant';
	const assistant = assistantText ? `<div class="${assistantClass}"><div class="messageText">${escapePanelHtml(assistantText).replace(/\n/g, '<br>')}</div></div>` : '';
	return `${user}${assistant}`;
}

function panelHistoryTitle(prompt: string): string {
	const words = prompt.trim().split(/\s+/).filter(Boolean);
	return words.slice(0, 8).join(' ') || 'Untitled chat';
}

function escapePanelHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function sharedBackboardPanelStatePath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'panel-state.json');
}

function sharedBackboardThreadsDir(): string {
	return path.join(os.homedir(), '.backboard_ide', 'threads');
}

function listSharedBackboardThreadFiles(logService: ILogService): string[] {
	const root = sharedBackboardThreadsDir();
	const files: string[] = [];
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			const entryPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				for (const threadEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
					const threadEntryPath = path.join(entryPath, threadEntry.name);
					if (threadEntry.isDirectory()) {
						const threadPath = path.join(threadEntryPath, 'thread.json');
						if (fs.existsSync(threadPath)) {
							files.push(threadPath);
						}
					}
				}
			}
		}
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			logService.warn(`[Backboard] Failed to list shared threads: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return files;
}

function sharedBackboardThreadPath(workspace: string | undefined, id: string): string {
	return path.join(sharedBackboardThreadsDir(), safeWorkspaceThreadDirName(workspace), safePanelThreadFileName(id), 'thread.json');
}

function sandboxBridgeSessionId(session: BackboardSession): string {
	return `sandbox:${safeWorkspaceThreadDirName(session.workingDirectory?.fsPath)}:${session.sessionId}`;
}

function safeWorkspaceThreadDirName(workspace: string | undefined): string {
	const normalized = workspace || 'default';
	const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
	const label = safePanelThreadFileName(path.basename(normalized) || 'default').slice(0, 40) || 'default';
	return `${label}-${digest}`;
}

function sharedPanelStateStorageKey(workspace = 'default'): string {
	const normalizedWorkspace = workspace || 'default';
	const digest = createHash('sha256').update(normalizedWorkspace).digest('hex').slice(0, 24);
	return `backboard.panel.state.${digest}`;
}

function safePanelThreadFileName(id: string): string {
	return id.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${generateUuid()}.tmp`;
	await fs.promises.writeFile(tempPath, `${JSON.stringify(value, undefined, '\t')}\n`, 'utf8');
	await fs.promises.rename(tempPath, filePath);
}

class BackboardBridgeProcess extends Disposable {
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingBridgeRequest>();
	private readonly toolCache = new Map<string, CachedBackboardTools>();

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

	async listTools(mode: string, config?: Record<string, unknown>): Promise<unknown[] | undefined> {
		const effectiveConfig = config ?? bridgeConfig();
		const cacheKey = backboardToolCacheKey(mode, effectiveConfig);
		const cached = this.toolCache.get(cacheKey);
		if (cached?.pending) {
			return cached.pending;
		}
		if (cached && cached.expiresAt > Date.now()) {
			return cached.tools;
		}
		const pending = this._fetchTools(mode, effectiveConfig);
		this.toolCache.set(cacheKey, { expiresAt: 0, pending });
		try {
			const tools = await pending;
			this.toolCache.set(cacheKey, { expiresAt: Date.now() + BACKBOARD_TOOL_CACHE_TTL_MS, tools });
			return tools;
		} catch (error) {
			this.toolCache.delete(cacheKey);
			throw error;
		}
	}

	private async _fetchTools(mode: string, config?: Record<string, unknown>): Promise<unknown[] | undefined> {
		const events = await this.send('listTools', undefined, { mode, config: config ?? bridgeConfig() }, undefined).promise;
		return events.find(event => event.type === 'tools')?.tools;
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

function streamingToolInvocationMessage(toolName: string, filePath: string | undefined, argumentsChars: number | undefined, contentLines: number | undefined): string {
	const fileName = filePath ? path.basename(filePath) : undefined;
	const progress = streamingToolProgress(argumentsChars, contentLines);
	if (isWriteTool(toolName)) {
		return fileName
			? localize('backboard.streamingTool.writeFile', "Writing {0}{1}...", fileName, progress)
			: localize('backboard.streamingTool.write', "Writing file{0}...", progress);
	}
	if (isEditTool(toolName)) {
		return fileName
			? localize('backboard.streamingTool.editFile', "Editing {0}{1}...", fileName, progress)
			: localize('backboard.streamingTool.edit', "Editing file{0}...", progress);
	}
	return localize('backboard.streamingTool.generic', "Preparing {0}{1}...", rawDisplayToolName(toolName), progress);
}

function streamingToolProgress(argumentsChars: number | undefined, contentLines: number | undefined): string {
	const hasLines = typeof contentLines === 'number' && contentLines > 0;
	const hasChars = typeof argumentsChars === 'number' && argumentsChars > 0;
	if (hasLines && hasChars) {
		return localize('backboard.streamingTool.linesAndSize', " ({0}, {1} streamed)", formatLineCount(contentLines), formatCharCount(argumentsChars));
	}
	if (hasLines) {
		return localize('backboard.streamingTool.lines', " ({0} streamed)", formatLineCount(contentLines));
	}
	if (hasChars) {
		return localize('backboard.streamingTool.size', " ({0} streamed)", formatCharCount(argumentsChars));
	}
	return '';
}

function isWriteTool(toolName: string): boolean {
	return ['write', 'write_file', 'create_file', 'overwrite_file', 'append_file'].includes(toolName);
}

function isEditTool(toolName: string): boolean {
	return ['edit', 'edit_file', 'search_replace'].includes(toolName);
}

function formatCharCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k chars`;
	}
	return localize('backboard.streamingTool.chars', "{0} chars", count);
}

function formatLineCount(count: number): string {
	if (count === 1) {
		return localize('backboard.streamingTool.oneLine', "1 line");
	}
	return localize('backboard.streamingTool.linesCount', "{0} lines", count);
}

function isRecoverableToolOutputSubmissionError(message: string | undefined): boolean {
	return typeof message === 'string'
		&& (
			(message.includes('Tool outputs for run ID') && message.includes('were already submitted'))
			|| message.includes('No assistant message found requiring action for run ID')
		);
}

function backboardDisplayErrorMessage(message: string): string {
	if (/api key|authentication|unauthorized|missing auth/i.test(message)) {
		return `${message} Run "Backboard: Sign In" from the Command Palette to save credentials in ~/.backboard_ide/config.json.`;
	}
	if (/upstream idle timeout/i.test(message)) {
		return `${message} Backboard opened the stream but the upstream stopped sending events before the next text or tool-call chunk arrived. The raw provider/error event was written to the Backboard IDE logs.`;
	}
	return message;
}

function safeStringifyForLog(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function backboardTraceProgressMessage(event: BridgeEvent): string | undefined {
	const details = isObjectRecord(event.details) ? event.details : {};
	const elapsed = formatElapsedMs(event.elapsedMs);
	switch (event.stage) {
		case 'request_built': {
			const provider = stringValueFromRecord(details.provider) || 'unknown provider';
			const model = stringValueFromRecord(details.model) || 'unknown model';
			const mode = stringValueFromRecord(details.mode) || 'unknown mode';
			const toolCount = numberValueFromRecord(details.toolCount);
			const promptChars = numberValueFromRecord(details.promptChars);
			return localize(
				'backboard.trace.requestBuilt',
				"Built Backboard request for {0}/{1}, mode {2}, {3} tools, {4} prompt chars{5}.",
				provider,
				model,
				mode,
				toolCount ?? 0,
				promptChars ?? 0,
				elapsed,
			);
		}
		case 'post_start':
			return localize('backboard.trace.postStart', "Opening Backboard message stream{0}.", elapsed);
		case 'post_stream_open':
			return localize('backboard.trace.streamOpen', "Backboard stream opened{0}. Waiting for model events.", elapsed);
		case 'stream_first_chunk': {
			const phase = stringValueFromRecord(details.phase) || 'stream';
			const chunkType = stringValueFromRecord(details.chunkType) || 'unknown';
			return localize('backboard.trace.firstChunk', "First Backboard {0} chunk received: {1}{2}.", phase, chunkType, elapsed);
		}
		case 'tool_outputs_post_start':
			return localize('backboard.trace.toolOutputPostStart', "Posting tool outputs back to Backboard{0}.", elapsed);
		default:
			if (event.stage) {
				return localize('backboard.trace.generic', "Backboard bridge stage: {0}{1}.", event.stage, elapsed);
			}
			return undefined;
	}
}

function formatElapsedMs(value: number | string | undefined): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return localize('backboard.trace.elapsed', " after {0}ms", value);
	}
	if (typeof value === 'string' && value.trim()) {
		return localize('backboard.trace.elapsedString', " after {0}ms", value.trim());
	}
	return '';
}

function numberValueFromRecord(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
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
	const pricePair = modelPricePair(model);
	const inputCost = pricePair?.[0];
	const outputCost = pricePair?.[1];
	const cacheCost = numericBridgeModelValue(model, ['cachePricePerMillion', 'cacheCostPer1mTokens', 'cachePrice', 'cache_price', 'cacheCost']);
	const cacheWriteCost = numericBridgeModelValue(model, ['cacheWritePricePerMillion', 'cacheWriteCostPer1mTokens', 'cacheWritePrice', 'cache_write_price', 'cacheWriteCost']);
	const pricingMeta = createAgentModelPricingMeta({
		inputCost,
		cacheCost,
		cacheWriteCost,
		outputCost,
	});
	return {
		provider: 'backboard',
		id,
		name: model.displayName || model.name,
		maxContextWindow: typeof model.contextLimit === 'number' ? model.contextLimit : undefined,
		supportsVision: model.supportsVision ?? false,
		_meta: {
			upstreamProvider: normalizeProviderKey(model.provider),
			upstreamProviderLabel: providerLabel(model.provider),
			pricing: modelPriceLabel(model),
			...(pricingMeta ?? {}),
		},
	};
}

function numericBridgeModelValue(model: BridgeModel, keys: readonly (keyof BridgeModel)[]): number | undefined {
	for (const key of keys) {
		const value = model[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function formatModelPrice(value: number): string {
	return `$${value.toFixed(2)}/M`;
}

function modelPricePair(model: BridgeModel): readonly [number, number] | undefined {
	const explicitInput = numericBridgeModelValue(model, ['inputPricePerMillion', 'inputCostPer1mTokens', 'input_cost_per_1m_tokens', 'inputPrice', 'input_price', 'promptPrice', 'promptPricePerMillion']);
	const explicitOutput = numericBridgeModelValue(model, ['outputPricePerMillion', 'outputCostPer1mTokens', 'output_cost_per_1m_tokens', 'outputPrice', 'output_price', 'completionPrice', 'completionPricePerMillion']);
	if (explicitInput !== undefined && explicitOutput !== undefined) {
		return [explicitInput, explicitOutput];
	}
	const id = [model.provider, model.name, model.displayName].filter(Boolean).join(' ').toLowerCase().replace(/[._]/g, '-');
	if (id.includes('claude-haiku-4-5') || id.includes('claude-haiku-4.5')) {
		return [1, 5];
	}
	if (id.includes('claude-sonnet-4')) {
		return [3, 15];
	}
	if (id.includes('claude-opus-4-5') || id.includes('claude-opus-4.5') || id.includes('claude-opus-4-6') || id.includes('claude-opus-4-7') || id.includes('claude-opus-4-8')) {
		return [5, 25];
	}
	if (id.includes('claude-opus-4')) {
		return [15, 75];
	}
	return undefined;
}

function modelPriceLabel(model: BridgeModel): string | undefined {
	if (typeof model.pricing === 'string' && model.pricing.trim() !== '') {
		return model.pricing;
	}
	const pair = modelPricePair(model);
	return pair ? `${formatModelPrice(pair[0])} in, ${formatModelPrice(pair[1])} out` : undefined;
}

function fallbackModel(): IAgentModelInfo {
	return {
		provider: 'backboard',
		id: DEFAULT_MODEL_ID,
		name: 'DeepSeek V4 Flash',
		supportsVision: false,
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

function backboardModelInfos(...modelSets: readonly (readonly BridgeModel[])[]): IAgentModelInfo[] {
	const mergedModels = mergeBridgeModels(...modelSets);
	return mergedModels
		.filter(isVisibleBridgeModel)
		.concat(supplementalBridgeModels(mergedModels))
		.sort(compareBridgeModels)
		.map(toAgentModelInfo);
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
		[BACKBOARD_WEB_SEARCH_CONFIG_KEY]: normalizeWebSearchMode(merged[BACKBOARD_WEB_SEARCH_CONFIG_KEY]),
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
	return {
		provider: parsedModel.provider,
		model: parsedModel.model,
		mode: bridgeModeFromConfig(values),
		intensity: stringConfigValue(values, BACKBOARD_INTENSITY_CONFIG_KEY, 'fast'),
		webSearch: stringConfigValue(values, BACKBOARD_WEB_SEARCH_CONFIG_KEY, 'off'),
		imageGeneration: stringConfigValue(values, BACKBOARD_IMAGE_CONFIG_KEY, 'off'),
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

function backboardToolCacheKey(mode: string, config: Record<string, unknown>): string {
	const env = normalizeBackboardEnv(config.env);
	const apiUrl = stringValueFromRecord(config.apiUrl) || stringValueFromRecord(config.api_url) || '';
	const credential = stringValueFromRecord(config.accessToken)
		|| stringValueFromRecord(config.apiKey)
		|| stringValueFromRecord(config.api_key)
		|| '';
	const credentialHash = credential ? createHash('sha256').update(credential).digest('hex').slice(0, 12) : '';
	return `${mode}:${env}:${apiUrl}:${credentialHash}`;
}

function bridgeConfig(): Record<string, unknown> {
	const persisted = readBackboardConfigJsonSync();
	const env = normalizeBackboardEnv(
		process.env.BACKBOARD_ENV
		|| process.env.VSCODE_BACKBOARD_ENV
		|| stringValueFromRecord(persisted.env)
		|| 'prod'
	);
	const apiUrl = process.env.BACKBOARD_API_URL
		|| process.env.VSCODE_BACKBOARD_API_URL
		|| stringValueFromRecord(persisted.api_url)
		|| stringValueFromRecord(persisted.apiUrl);
	const apiKey = process.env.BACKBOARD_API_KEY
		|| process.env.VSCODE_BACKBOARD_API_KEY
		|| backboardConfigApiKey(persisted, env);
	const accessToken = process.env.BACKBOARD_ACCESS_TOKEN
		|| process.env.VSCODE_BACKBOARD_ACCESS_TOKEN
		|| backboardConfigAccessToken(persisted);
	return {
		env,
		...(apiUrl ? { apiUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		...(accessToken ? { accessToken } : {}),
	};
}

function backboardConfigPath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'config.json');
}

function readBackboardConfigJsonSync(): BackboardConfigJson {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(backboardConfigPath(), 'utf8'));
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isFileNotFoundError(error) || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

function backboardConfigEnvKeys(config: BackboardConfigJson): Record<string, string> {
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

function backboardConfigApiKey(config: BackboardConfigJson, env = normalizeBackboardEnv(config.env)): string | undefined {
	return stringValueFromRecord(config.api_key)
		|| stringValueFromRecord(config.apiKey)
		|| stringValueFromRecord(backboardConfigEnvKeys(config)[env]);
}

function backboardConfigAccessToken(config: BackboardConfigJson): string | undefined {
	const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
	return stringValueFromRecord(oauth?.access_token);
}

function createToolContentReporter(emit: (content: string) => void): { report: (content: string) => void; flush: () => void } {
	let latestContent = '';
	let flushHandle: ReturnType<typeof setTimeout> | undefined;
	const flush = (): void => {
		if (flushHandle) {
			clearTimeout(flushHandle);
			flushHandle = undefined;
		}
		if (latestContent) {
			emit(latestContent);
		}
	};
	return {
		report: (content: string) => {
			latestContent = toolContentPreview(content);
			flushHandle ??= setTimeout(flush, 50);
		},
		flush,
	};
}

function clientToolForCall(session: BackboardSession, name: string): ToolDefinition | undefined {
	return session.clientTools?.find(tool => tool.name === name);
}

function prepareClientToolCall(session: BackboardSession, call: ParsedToolCall): { call: ParsedToolCall; clientTool?: ToolDefinition } {
	const directClientTool = clientToolForCall(session, call.name);
	if (directClientTool) {
		return {
			call: isRunSubagentToolName(directClientTool.name)
				? { ...call, args: normalizeRunSubagentArgs(call.args) }
				: call,
			clientTool: directClientTool,
		};
	}
	if (!isLegacySubagentToolName(call.name)) {
		return { call };
	}
	const runSubagentTool = clientToolForCall(session, 'runSubagent');
	if (!runSubagentTool) {
		return { call };
	}
	return {
		call: {
			...call,
			name: runSubagentTool.name,
			args: normalizeRunSubagentArgs(call.args),
		},
		clientTool: runSubagentTool,
	};
}

function normalizeRunSubagentArgs(args: Record<string, unknown>): Record<string, unknown> {
	const prompt = stringArg(args, 'prompt', 'task', 'input', 'description');
	const description = stringArg(args, 'description', 'summary', 'title', 'prompt');
	const agentName = stringArg(args, 'agentName', 'agent_name', 'subagent_type', 'subagentType', 'agent');
	const model = stringArg(args, 'model', 'modelName', 'model_name');
	return {
		...args,
		prompt,
		description: description || truncateForSubagentDescription(prompt),
		...(agentName ? { agentName } : {}),
		...(model ? { model } : {}),
	};
}

function truncateForSubagentDescription(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'Run focused task';
	}
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function isRunSubagentToolName(name: string): boolean {
	return name === 'runSubagent';
}

function isLegacySubagentToolName(name: string): boolean {
	return ['task', 'Task', 'Agent'].includes(name);
}

const backboardAllowedClientToolNames = new Set([
	'open_browser_page',
	'openBrowserPage',
	'read_page',
	'readPage',
	'screenshot_page',
	'screenshotPage',
	'navigate_page',
	'navigatePage',
	'click_element',
	'clickElement',
	'type_in_page',
	'typeInPage',
	'hover_element',
	'hoverElement',
	'drag_element',
	'dragElement',
	'handle_dialog',
	'handleDialog',
	'run_playwright_code',
	'runPlaywrightCode',
	'runSubagent',
]);

function mergeBackboardTools(bridgeTools: unknown[] | undefined, clientTools: readonly ToolDefinition[] | undefined, mode: string): unknown[] | undefined {
	const merged: unknown[] = [];
	const names = new Set<string>();
	for (const tool of bridgeTools ?? []) {
		const name = backboardFunctionToolName(tool);
		if (name) {
			names.add(name);
		}
		merged.push(tool);
	}
	for (const tool of clientTools ?? []) {
		if (!backboardAllowedClientToolNames.has(tool.name) || names.has(tool.name)) {
			continue;
		}
		if (isRunSubagentToolName(tool.name) && (mode === 'ask' || mode === 'manual')) {
			continue;
		}
		names.add(tool.name);
		merged.push(toBackboardFunctionTool(tool));
	}
	return merged.length ? merged : undefined;
}

function trimBackboardToolsForRequest(tools: unknown[] | undefined, prompt: string, webSearch: string, imageGeneration: string): unknown[] | undefined {
	if (!tools?.length) {
		return tools;
	}
	const trimmed = tools.filter(tool => {
		const name = backboardFunctionToolName(tool);
		if (!name) {
			return true;
		}
		if (name === 'computer' || name === 'sleep' || name === 'persistence_decide') {
			return false;
		}
		if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
			return promptMentionsPlan(prompt);
		}
		if (name === 'generate_image' || name === 'image_generate') {
			return imageGeneration === 'auto' || promptMentionsImage(prompt);
		}
		if (name === 'web_search' || name === 'web_fetch') {
			return webSearch !== 'off' || promptNeedsWeb(prompt);
		}
		return true;
	});
	return trimmed.length ? trimmed : tools;
}

function promptMentionsPlan(prompt: string): boolean {
	return /\b(plan|planning|roadmap|steps|strategy)\b/i.test(prompt);
}

function promptMentionsImage(prompt: string): boolean {
	return /\b(image|picture|photo|draw|drawing|illustration|logo|icon|sprite|visual|render)\b/i.test(prompt);
}

function promptNeedsWeb(prompt: string): boolean {
	return /https?:\/\//i.test(prompt) || /\b(web|website|url|online|internet|latest|current|today|docs)\b/i.test(prompt);
}

function backboardFunctionToolName(tool: unknown): string | undefined {
	if (!isObjectRecord(tool)) {
		return undefined;
	}
	const fn = isObjectRecord(tool.function) ? tool.function : undefined;
	return firstStringProperty(fn ?? tool, ['name']);
}

function toBackboardFunctionTool(tool: ToolDefinition): unknown {
	const isSubagentTool = isRunSubagentToolName(tool.name);
	return {
		type: 'function',
		function: {
			name: tool.name,
			description: isSubagentTool
				? localize('backboard.clientTool.runSubagent.description', "Launch a native VS Code subagent for a focused delegated task. Use this whenever the user explicitly asks to spawn, launch, run, delegate to, or use subagents, even if the workspace is empty or the task is creative/non-code. For multiple subagents, call this tool once per subtask sequentially.")
				: tool.description ?? tool.title ?? localize('backboard.clientTool.description', "Run {0}", tool.name),
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
		_meta: { ...(tool._meta ?? {}), source: 'backboard-client-browser', ...(isSubagentTool ? { toolKind: 'subagent' } : {}) },
	};
}

function toolCallResultOutput(result: ToolCallResult): string {
	return getToolOutputText(result)
		?? (result.structuredContent ? compactJson(result.structuredContent) : undefined)
		?? (typeof result.pastTenseMessage === 'string' ? result.pastTenseMessage : compactJson(result.pastTenseMessage))
		?? (result.success ? 'Tool completed with no output.' : 'Tool failed with no output.');
}

function toolContentPreview(content: string): string {
	const maxLength = 128 * 1024;
	if (content.length <= maxLength) {
		return content;
	}
	return `${content.slice(0, maxLength)}\n[Output truncated]\n`;
}

async function executeBackboardTool(bridge: BackboardBridgeProcess, rootPath: string | undefined, call: ParsedToolCall, reportContent?: (content: string) => void): Promise<string> {
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
			return writeFileTool(rootPath, call.name, call.args, reportContent);
		case 'append_file':
			return appendFileTool(rootPath, call.args, reportContent);
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
			return runShellTool(rootPath, call.args, reportContent);
		case 'run_code':
		case 'repl':
			return runCodeTool(rootPath, call.args, reportContent);
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
	const rg = await runRipgrep(root, [
		'--files',
		'--hidden',
		...ripgrepIgnoredDirectoryGlobs(),
		'--glob',
		pattern,
	], { timeout: 10_000, maxBuffer: 256 * 1024 });
	if (rg.ok || rg.code === 1) {
		return limitLines(rg.stdout, 300);
	}
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
	const outputMode = stringArg(args, 'output_mode') || 'content';
	const rgArgs = [
		'--hidden',
		'--line-number',
		'--no-heading',
		'--color',
		'never',
		...ripgrepIgnoredDirectoryGlobs(),
		'--glob',
		fullPattern,
		...(boolArg(args, 'case_insensitive') ? ['--ignore-case'] : []),
		...(outputMode === 'files_with_matches' ? ['--files-with-matches'] : []),
		...(outputMode === 'count' ? ['--count-matches'] : []),
		'--',
		pattern,
	];
	const rg = await runRipgrep(root, rgArgs, { timeout: 10_000, maxBuffer: 512 * 1024 });
	if (rg.ok || rg.code === 1) {
		if (outputMode === 'content') {
			return limitLines(rg.stdout, 100);
		}
		if (outputMode === 'count') {
			return String(sumRipgrepCounts(rg.stdout));
		}
		return limitLines(rg.stdout, 100);
	}
	const includeRegex = globToRegExp(fullPattern);
	const flags = boolArg(args, 'case_insensitive') ? 'i' : '';
	const regex = new RegExp(pattern, flags);
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
	if (!terms.length) {
		throw new Error('codebase_search requires query');
	}
	const limit = numberArg(args, 'num_results') ?? 15;
	const rg = await runRipgrep(root, [
		'--hidden',
		'--line-number',
		'--no-heading',
		'--color',
		'never',
		'--ignore-case',
		...ripgrepIgnoredDirectoryGlobs(),
		'--glob',
		'**/*',
		'--',
		terms.map(escapeRegExp).join('|'),
	], { timeout: 10_000, maxBuffer: 768 * 1024 });
	if (rg.ok || rg.code === 1) {
		return scoreRipgrepSearchOutput(rg.stdout, terms, limit);
	}
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

const BACKBOARD_LARGE_WRITE_PROGRESS_CHARS = 8_000;
const BACKBOARD_LARGE_WRITE_CHUNK_CHARS = 4_000;

function largeWriteChunkCount(content: string): number {
	return Math.max(1, Math.ceil(content.length / BACKBOARD_LARGE_WRITE_CHUNK_CHARS));
}

async function writeStringInChunks(file: string, content: string, append: boolean, reportProgress?: (written: number, total: number) => void): Promise<number> {
	if (!append) {
		await fs.promises.writeFile(file, '', 'utf8');
	}
	let written = 0;
	const chunks = largeWriteChunkCount(content);
	for (let offset = 0; offset < content.length; offset += BACKBOARD_LARGE_WRITE_CHUNK_CHARS) {
		const chunk = content.slice(offset, offset + BACKBOARD_LARGE_WRITE_CHUNK_CHARS);
		await fs.promises.appendFile(file, chunk, 'utf8');
		written += chunk.length;
		reportProgress?.(written, content.length);
	}
	return chunks;
}

async function writeFileTool(rootPath: string | undefined, toolName: string, args: Record<string, unknown>, reportContent?: (content: string) => void): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	const relative = relativePath(workspaceRoot(rootPath), file);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	if (content.length > BACKBOARD_LARGE_WRITE_PROGRESS_CHARS) {
		reportContent?.(`Writing ${relative}: 0/${content.length} chars`);
		await writeStringInChunks(file, content, false, (written, total) => reportContent?.(`Writing ${relative}: ${written}/${total} chars`));
		reportContent?.(`Wrote ${relative}: ${content.length} chars`);
		return `Wrote ${relative} (${content.length} chars)`;
	}
	await fs.promises.writeFile(file, content, 'utf8');
	return `Wrote ${relative}`;
}

async function appendFileTool(rootPath: string | undefined, args: Record<string, unknown>, reportContent?: (content: string) => void): Promise<string> {
	const file = resolveWorkspacePath(rootPath, filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	const relative = relativePath(workspaceRoot(rootPath), file);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	if (content.length > BACKBOARD_LARGE_WRITE_PROGRESS_CHARS) {
		reportContent?.(`Appending ${relative}: 0/${content.length} chars`);
		await writeStringInChunks(file, content, true, (written, total) => reportContent?.(`Appending ${relative}: ${written}/${total} chars`));
		reportContent?.(`Appended ${content.length} chars to ${relative}`);
		return `Appended ${content.length} chars to ${relative}`;
	}
	await fs.promises.appendFile(file, content, 'utf8');
	return `Appended ${content.length} chars to ${relative}`;
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

async function runShellTool(rootPath: string | undefined, args: Record<string, unknown>, reportContent?: (content: string) => void): Promise<string> {
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
				reportContent?.(output);
			}
		};
		const finish = (suffix = '') => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			const result = `${output}${suffix}`;
			reportContent?.(result);
			resolve(result);
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

async function runCodeTool(rootPath: string | undefined, args: Record<string, unknown>, reportContent?: (content: string) => void): Promise<string> {
	const code = stringArg(args, 'code');
	if (!code) {
		throw new Error('run_code/repl requires code');
	}
	const language = (stringArg(args, 'language') || 'python').toLowerCase();
	if (language === 'shell') {
		return runShellTool(rootPath, { ...args, command: code }, reportContent);
	}
	const command = language === 'node' || language === 'typescript'
		? `node -e ${shellQuote(code)}`
		: `python3 -c ${shellQuote(code)}`;
	return runShellTool(rootPath, { ...args, command }, reportContent);
}

async function sleepTool(args: Record<string, unknown>): Promise<string> {
	const seconds = Math.max(0, numberArg(args, 'seconds') ?? 1);
	await new Promise(resolve => setTimeout(resolve, seconds * 1000));
	return `Waited ${seconds} second(s).`;
}

interface ProcessOutput {
	readonly ok: boolean;
	readonly code: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
}

async function runRipgrep(cwd: string, args: readonly string[], options: { timeout: number; maxBuffer: number }): Promise<ProcessOutput> {
	return runProcess('rg', args, cwd, options);
}

function runProcess(command: string, args: readonly string[], cwd: string, options: { timeout: number; maxBuffer: number }): Promise<ProcessOutput> {
	return new Promise<ProcessOutput>(resolve => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const child = spawn(command, args, { cwd, env: process.env });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
			const text = chunk.toString();
			if (target === 'stdout') {
				stdout = appendLimited(stdout, text, options.maxBuffer);
			} else {
				stderr = appendLimited(stderr, text, options.maxBuffer);
			}
		};
		const finish = (code: number | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			resolve({ ok: code === 0, code, stdout, stderr });
		};
		timer = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, options.timeout);
		child.stdout.on('data', chunk => append('stdout', chunk));
		child.stderr.on('data', chunk => append('stderr', chunk));
		child.on('error', () => finish(undefined));
		child.on('close', code => finish(code ?? undefined));
	});
}

function appendLimited(current: string, next: string, maxLength: number): string {
	if (current.length >= maxLength) {
		return current;
	}
	if (current.length + next.length <= maxLength) {
		return current + next;
	}
	return current + next.slice(0, maxLength - current.length);
}

function ripgrepIgnoredDirectoryGlobs(): string[] {
	return [...IGNORED_DIRECTORIES].flatMap(directory => ['--glob', `!${directory}/**`, '--glob', `!**/${directory}/**`]);
}

function limitLines(text: string, limit: number): string {
	return text.trimEnd().split(/\r?\n/).slice(0, limit).join('\n');
}

function sumRipgrepCounts(text: string): number {
	return text.trim().split(/\r?\n/).reduce((sum, line) => {
		const separator = line.lastIndexOf(':');
		const value = Number(separator >= 0 ? line.slice(separator + 1) : line);
		return Number.isFinite(value) ? sum + value : sum;
	}, 0);
}

function scoreRipgrepSearchOutput(text: string, terms: readonly string[], limit: number): string {
	const scored = new Map<string, { score: number; preview: string }>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^(.*?):\d+:(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const [, file, preview] = match;
		const lower = preview.toLowerCase();
		const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
		if (score <= 0) {
			continue;
		}
		const existing = scored.get(file);
		if (!existing) {
			scored.set(file, { score, preview: preview.trim().slice(0, 240) });
		} else {
			existing.score += score;
		}
	}
	return [...scored.entries()]
		.sort(([, left], [, right]) => right.score - left.score)
		.slice(0, limit)
		.map(([file, item]) => `${file}: ${item.preview}`)
		.join('\n');
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
	if (!rootPath) {
		throw new Error(localize('backboard.workspace.required', "No workspace folder is attached to this Backboard session. Start a new Backboard session from the open folder before using file or shell tools."));
	}
	return path.resolve(rootPath);
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

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isReadOnlyTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search', 'web_search', 'web_fetch'].includes(name);
}

function isParallelSafeBackboardTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search'].includes(name);
}

function rawDisplayToolName(name: string): string {
	return name.split('_').map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ');
}

function backboardToolDisplay(call: ParsedToolCall, clientTool?: ToolDefinition): BackboardToolDisplay {
	if (clientTool) {
		const displayName = clientTool.title || localize('backboard.tool.clientFallback.displayName', "Backboard Client Tool");
		if (isRunSubagentToolName(clientTool.name)) {
			const description = stringArg(call.args, 'description', 'prompt');
			return {
				displayName,
				invocationMessage: description ? localize('backboard.tool.runSubagent.invocationWithDescription', "Starting subagent: {0}", description) : localize('backboard.tool.runSubagent.invocation', "Starting subagent"),
				completedMessage: localize('backboard.tool.runSubagent.completed', "Ran subagent"),
				failedMessage: localize('backboard.tool.runSubagent.failed', "Subagent failed"),
				skippedMessage: localize('backboard.tool.runSubagent.skipped', "Skipped subagent"),
				toolKind: 'subagent',
			};
		}
		return {
			displayName,
			invocationMessage: localize('backboard.tool.clientFallback.invocation', "Running Backboard client tool {0}", displayName),
			completedMessage: localize('backboard.tool.clientFallback.completed', "Ran Backboard client tool {0}", displayName),
			failedMessage: localize('backboard.tool.clientFallback.failed', "Backboard client tool {0} failed", displayName),
			skippedMessage: localize('backboard.tool.clientFallback.skipped', "Skipped Backboard client tool {0}", displayName),
			toolKind: 'client',
		};
	}

	const focus = backboardToolFocus(call);
	switch (call.name) {
		case 'bash':
		case 'run_terminal_cmd':
			return backboardToolMessages(
				localize('backboard.tool.terminal.displayName', "Backboard Terminal"),
				focus ? localize('backboard.tool.terminal.invocationWithCommand', "Running Backboard terminal command: {0}", focus) : localize('backboard.tool.terminal.invocation', "Running Backboard terminal command"),
				localize('backboard.tool.terminal.completed', "Ran Backboard terminal command"),
				'terminal',
			);
		case 'read_file':
			return backboardToolMessages(
				localize('backboard.tool.readFile.displayName', "Backboard Read File"),
				focus ? localize('backboard.tool.readFile.invocationWithFile', "Reading {0}", focus) : localize('backboard.tool.readFile.invocation', "Reading file with Backboard"),
				localize('backboard.tool.readFile.completed', "Read file with Backboard"),
				'file',
			);
		case 'list_dir':
			return backboardToolMessages(
				localize('backboard.tool.listDirectory.displayName', "Backboard List Directory"),
				focus ? localize('backboard.tool.listDirectory.invocationWithDirectory', "Listing {0}", focus) : localize('backboard.tool.listDirectory.invocation', "Listing directory with Backboard"),
				localize('backboard.tool.listDirectory.completed', "Listed directory with Backboard"),
				'file',
			);
		case 'glob':
			return backboardToolMessages(
				localize('backboard.tool.glob.displayName', "Backboard Find Files"),
				focus ? localize('backboard.tool.glob.invocationWithPattern', "Finding files matching {0}", focus) : localize('backboard.tool.glob.invocation', "Finding files with Backboard"),
				localize('backboard.tool.glob.completed', "Found files with Backboard"),
				'search',
			);
		case 'grep':
			return backboardToolMessages(
				localize('backboard.tool.grep.displayName', "Backboard Search Text"),
				focus ? localize('backboard.tool.grep.invocationWithPattern', "Searching text for {0}", focus) : localize('backboard.tool.grep.invocation', "Searching text with Backboard"),
				localize('backboard.tool.grep.completed', "Searched text with Backboard"),
				'search',
			);
		case 'codebase_search':
			return backboardToolMessages(
				localize('backboard.tool.codebaseSearch.displayName', "Backboard Code Search"),
				focus ? localize('backboard.tool.codebaseSearch.invocationWithQuery', "Searching code for {0}", focus) : localize('backboard.tool.codebaseSearch.invocation', "Searching code with Backboard"),
				localize('backboard.tool.codebaseSearch.completed', "Searched code with Backboard"),
				'search',
			);
		case 'write':
		case 'write_file':
		case 'create_file':
		case 'overwrite_file':
			return backboardToolMessages(
				localize('backboard.tool.writeFile.displayName', "Backboard Write File"),
				focus ? localize('backboard.tool.writeFile.invocationWithFile', "Writing {0}", focus) : localize('backboard.tool.writeFile.invocation', "Writing file with Backboard"),
				localize('backboard.tool.writeFile.completed', "Wrote file with Backboard"),
				'file',
			);
		case 'append_file':
			return backboardToolMessages(
				localize('backboard.tool.appendFile.displayName', "Backboard Append File"),
				focus ? localize('backboard.tool.appendFile.invocationWithFile', "Appending to {0}", focus) : localize('backboard.tool.appendFile.invocation', "Appending to file with Backboard"),
				localize('backboard.tool.appendFile.completed', "Appended to file with Backboard"),
				'file',
			);
		case 'edit':
		case 'edit_file':
		case 'search_replace':
			return backboardToolMessages(
				localize('backboard.tool.editFile.displayName', "Backboard Edit File"),
				focus ? localize('backboard.tool.editFile.invocationWithFile', "Editing {0}", focus) : localize('backboard.tool.editFile.invocation', "Editing file with Backboard"),
				localize('backboard.tool.editFile.completed', "Edited file with Backboard"),
				'file',
			);
		case 'delete_file':
			return backboardToolMessages(
				localize('backboard.tool.deleteFile.displayName', "Backboard Delete File"),
				focus ? localize('backboard.tool.deleteFile.invocationWithFile', "Deleting {0}", focus) : localize('backboard.tool.deleteFile.invocation', "Deleting file with Backboard"),
				localize('backboard.tool.deleteFile.completed', "Deleted file with Backboard"),
				'file',
			);
		case 'create_directory':
			return backboardToolMessages(
				localize('backboard.tool.createDirectory.displayName', "Backboard Create Directory"),
				focus ? localize('backboard.tool.createDirectory.invocationWithDirectory', "Creating directory {0}", focus) : localize('backboard.tool.createDirectory.invocation', "Creating directory with Backboard"),
				localize('backboard.tool.createDirectory.completed', "Created directory with Backboard"),
				'file',
			);
		case 'web_search':
			return backboardToolMessages(
				localize('backboard.tool.webSearch.displayName', "Backboard Web Search"),
				focus ? localize('backboard.tool.webSearch.invocationWithQuery', "Searching the web for {0}", focus) : localize('backboard.tool.webSearch.invocation', "Searching the web with Backboard"),
				localize('backboard.tool.webSearch.completed', "Searched the web with Backboard"),
				'search',
			);
		case 'web_fetch':
			return backboardToolMessages(
				localize('backboard.tool.webFetch.displayName', "Backboard Fetch URL"),
				focus ? localize('backboard.tool.webFetch.invocationWithUrl', "Fetching {0}", focus) : localize('backboard.tool.webFetch.invocation', "Fetching URL with Backboard"),
				localize('backboard.tool.webFetch.completed', "Fetched URL with Backboard"),
				'search',
			);
		case 'generate_image':
			return backboardToolMessages(
				localize('backboard.tool.generateImage.displayName', "Backboard Image Generation"),
				focus ? localize('backboard.tool.generateImage.invocationWithPrompt', "Generating image for {0}", focus) : localize('backboard.tool.generateImage.invocation', "Generating image with Backboard"),
				localize('backboard.tool.generateImage.completed', "Generated image with Backboard"),
				'tool',
			);
		case 'todo_write':
			return backboardToolMessages(
				localize('backboard.tool.todo.displayName', "Backboard Todo List"),
				localize('backboard.tool.todo.invocation', "Updating Backboard todo list"),
				localize('backboard.tool.todo.completed', "Updated Backboard todo list"),
				'tool',
			);
		case 'read_lints':
			return backboardToolMessages(
				localize('backboard.tool.readLints.displayName', "Backboard Diagnostics"),
				focus ? localize('backboard.tool.readLints.invocationWithFocus', "Reading diagnostics for {0}", focus) : localize('backboard.tool.readLints.invocation', "Reading diagnostics with Backboard"),
				localize('backboard.tool.readLints.completed', "Read diagnostics with Backboard"),
				'tool',
			);
		case 'task':
			return backboardToolMessages(
				localize('backboard.tool.task.displayName', "Backboard Subtask"),
				focus ? localize('backboard.tool.task.invocationWithPrompt', "Starting Backboard subtask: {0}", focus) : localize('backboard.tool.task.invocation', "Starting Backboard subtask"),
				localize('backboard.tool.task.completed', "Finished Backboard subtask"),
				'tool',
			);
		case 'enter_plan_mode':
			return backboardToolMessages(
				localize('backboard.tool.enterPlan.displayName', "Backboard Plan Mode"),
				localize('backboard.tool.enterPlan.invocation', "Entering Backboard plan mode"),
				localize('backboard.tool.enterPlan.completed', "Entered Backboard plan mode"),
				'tool',
			);
		case 'exit_plan_mode':
			return backboardToolMessages(
				localize('backboard.tool.exitPlan.displayName', "Backboard Plan"),
				localize('backboard.tool.exitPlan.invocation', "Preparing Backboard plan"),
				localize('backboard.tool.exitPlan.completed', "Prepared Backboard plan"),
				'tool',
			);
		case 'persistence_decide':
			return backboardToolMessages(
				localize('backboard.tool.persistence.displayName', "Backboard Persistence"),
				localize('backboard.tool.persistence.invocation', "Checking Backboard task persistence"),
				localize('backboard.tool.persistence.completed', "Checked Backboard task persistence"),
				'tool',
			);
		case 'sleep':
			return backboardToolMessages(
				localize('backboard.tool.sleep.displayName', "Backboard Wait"),
				focus ? localize('backboard.tool.sleep.invocationWithDuration', "Waiting {0} seconds", focus) : localize('backboard.tool.sleep.invocation', "Waiting with Backboard"),
				localize('backboard.tool.sleep.completed', "Waited with Backboard"),
				'tool',
			);
		case 'repl':
			return backboardToolMessages(
				localize('backboard.tool.repl.displayName', "Backboard REPL"),
				localize('backboard.tool.repl.invocation', "Running Backboard REPL code"),
				localize('backboard.tool.repl.completed', "Ran Backboard REPL code"),
				'terminal',
			);
		case 'run_code':
			return backboardToolMessages(
				localize('backboard.tool.runCode.displayName', "Backboard Run Code"),
				localize('backboard.tool.runCode.invocation', "Running code with Backboard"),
				localize('backboard.tool.runCode.completed', "Ran code with Backboard"),
				'terminal',
			);
		case 'computer':
			return backboardToolMessages(
				localize('backboard.tool.computer.displayName', "Backboard Computer"),
				localize('backboard.tool.computer.invocation', "Using Backboard computer control"),
				localize('backboard.tool.computer.completed', "Used Backboard computer control"),
				'tool',
			);
		default: {
			const displayName = localize('backboard.tool.generic.displayName', "Backboard {0}", rawDisplayToolName(call.name));
			return backboardToolMessages(
				displayName,
				localize('backboard.tool.generic.invocation', "Running {0}", displayName),
				localize('backboard.tool.generic.completed', "Ran {0}", displayName),
				inferBackboardToolKind(call.name),
			);
		}
	}
}

function backboardToolMessages(displayName: string, invocationMessage: string, completedMessage: string, toolKind: string): BackboardToolDisplay {
	return {
		displayName,
		invocationMessage,
		completedMessage,
		failedMessage: localize('backboard.tool.failed', "{0} failed", displayName),
		skippedMessage: localize('backboard.tool.skipped', "Skipped {0}", displayName),
		toolKind,
	};
}

function backboardToolFocus(call: ParsedToolCall): string {
	const value = stringArg(
		call.args,
		'command',
		'cmd',
		'path',
		'file_path',
		'filePath',
		'target_file',
		'targetFile',
		'target_directory',
		'targetDirectory',
		'relative_workspace_path',
		'pattern',
		'query',
		'url',
		'prompt',
		'description',
		'reason',
		'seconds',
	);
	const maxLength = 120;
	return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function inferBackboardToolKind(name: string): string {
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

function toolOutput(toolCallId: string, output: unknown): unknown {
	return { tool_call_id: toolCallId, toolCallId, output: JSON.stringify(output) };
}

function toolInputPreview(call: ParsedToolCall): string {
	return safeJson(redactToolInputForDisplay(call.name, call.args));
}

function redactToolInputForDisplay(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
	if (!isContentHeavyTool(toolName)) {
		return args;
	}
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (isContentArgumentKey(key) && typeof value === 'string') {
			redacted[key] = localize('backboard.toolInput.contentOmitted', "[content omitted, {0} chars]", value.length);
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function isContentHeavyTool(toolName: string): boolean {
	return [
		'write',
		'write_file',
		'create_file',
		'overwrite_file',
		'append_file',
		'edit',
		'edit_file',
		'search_replace',
	].includes(toolName);
}

function isContentArgumentKey(key: string): boolean {
	return [
		'content',
		'contents',
		'new_text',
		'newText',
		'old_string',
		'oldString',
		'new_string',
		'newString',
	].includes(key);
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
