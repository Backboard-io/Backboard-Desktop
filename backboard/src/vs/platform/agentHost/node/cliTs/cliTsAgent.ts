/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentRewindRequest, IAgentRewindBuffer, IAgentRewindResult } from '../../common/agentRewind.js';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { type IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal, IAgent, IAgentCommandResult, MCP_AUTH_REQUIRED_ERROR_TYPE, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { buildSubagentSessionUri, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, FileEditKind, MessageAttachmentKind, MessageKind, parseSubagentSessionUri, ResponsePartKind, SessionStatus, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallContributorKind, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputQuestion, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type SessionInputAnswer, type SessionInputResponseKind, type ToolCallResult, type ToolResultContent, type ToolResultFileEditContent, type Turn } from '../../common/state/sessionState.js';
import { IAgentPluginManager, type ISyncedCustomization } from '../../common/agentPluginManager.js';
import { McpServerStatus, type Customization, type McpServerState, type SessionActiveClient } from '../../common/state/protocol/channels-session/state.js';
import { McpCustomizationController } from '../shared/mcpCustomizationController.js';
import { parsePlugin } from '../../../agentPlugins/common/pluginParsers.js';
import { IFileService } from '../../../files/common/files.js';
import { McpServerType, type IMcpServerConfiguration } from '../../../mcp/common/mcpPlatformTypes.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { IAgentHostCheckpointService } from '../../common/agentHostCheckpointService.js';
import { type IFileEditRecord, ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { buildSessionDbUri, FileEditTracker } from '../shared/fileEditTracker.js';
import { claudeCodeVersionStatus, type IClaudeCodeVersionStatus, isClaudeLoggedIn, isClaudeLoggedInRecently, updateClaudeCode } from '../shared/agentLoginProbes.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostGitService, META_DIFF_BASE_BRANCH } from '../agentHostGitService.js';
import { BYOK_COMMANDS, BYOK_GENERATION_ARG, BYOK_KEY_ARG, BYOK_PROVIDER_ARG, BYOK_PROVIDERS, byokProviderDefinition, type ByokProviderId, isByokProviderId, isKeyBilledProvider, keyBilledProviderId, parseBillingRoute, routeProviderFamily, vendorOfProvider } from '../../common/byokProviders.js';
import { BACKBOARD_ACCESS_FULL, BACKBOARD_ACCESS_MANUAL, BACKBOARD_GENERATIVE_MEDIA_OFF, BACKBOARD_IMAGE_MODEL_CONFIG_KEY, BACKBOARD_MODE_PLAN, BACKBOARD_VIDEO_MODEL_CONFIG_KEY, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS, type BridgeModel, backboardAccessSystemContext, backboardModelInfos, backboardMultitaskSystemContext, bridgeConfig, createBackboardTurnSettings, fallbackModel, isBridgeModel, resolveBackboardSessionConfig } from './backboardRuntimeShared.js';
import { ensureBackboardGuestKey } from './backboardGuest.js';

/** cli-ts tool name excluded from the turn when Web Search is toggled off. */
const CLI_TS_WEB_SEARCH_TOOL_NAME = 'WebSearch';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { type CliTsCredentialSnapshot, CliTsServeProcess, cliTsCredentialFingerprint, runCliTsCommand } from './cliTsProcess.js';
import type { CliTsRecord, CliTsAgentEvent, CliTsClientToolDefinition, CliTsClientToolResultContent, CliTsClientToolResultPayload, CliTsFileAttachment, CliTsMcpListPayload, CliTsMcpServerEntry, CliTsMcpServerStatus, CliTsPermissionMode, CliTsReadyPayload, CliTsTurnStatus, CliTsWorkerIntegrationChange, CliTsWorkerIntegrationSnapshot, CliTsWorkerState } from './cliTsProtocol.js';
import { CLI_TS_MCP_STATUS_EVENTS_CAPABILITY } from './cliTsProtocol.js';
import { GenerativeModelCatalog, type GenerativeModelItem, type GenerativeModelProperty } from './generativeModelCatalog.js';
import { describeVideoModel, videoModelCapabilities } from '../../common/generativeMediaCapabilities.js';

/** Formats a selected generative model for the serve control, or `off`. */
function generativeModelSelection(model: { provider: string; name: string } | undefined): string {
	return model ? `${model.provider}/${model.name}` : BACKBOARD_GENERATIVE_MEDIA_OFF;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Maps one catalog row to a `provider/name` picker item. Image catalogs expose
 * `name`; video catalogs expose the OpenRouter model `id` alongside `name`.
 */
function generativeModelCompletionItem(
	model: Record<string, unknown>,
	property: string,
): GenerativeModelItem | undefined {
	const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
	const identifier = property === BACKBOARD_VIDEO_MODEL_CONFIG_KEY
		? (typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : '')
		: (typeof model.name === 'string' ? model.name : '');
	const name = identifier.trim();
	if (!provider || !name) {
		return undefined;
	}
	const display = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : name;
	// Video rows carry what the model accepts, so pickers (and Canvas's edit
	// bar) can tell a video editor like Aleph from a text-to-video model.
	return property === BACKBOARD_VIDEO_MODEL_CONFIG_KEY
		? { value: `${provider}/${name}`, label: display, description: describeVideoModel(videoModelCapabilities(model)) }
		: { value: `${provider}/${name}`, label: display };
}

/**
 * Maps a cli-ts MCP runtime status onto the protocol's server lifecycle
 * state. The runtime reports `needs_authentication` for remote servers that
 * require a token; the runtime runs the OAuth flow itself, so instead of the
 * RFC 9728 token hand-off the state is surfaced as an error tagged
 * {@link MCP_AUTH_REQUIRED_ERROR_TYPE}, which the server list offers to sign in.
 */
function mcpServerStateFromRuntime(status: CliTsMcpServerStatus): McpServerState {
	switch (status.status) {
		case 'connected':
			return { kind: McpServerStatus.Ready };
		case 'disabled':
			return { kind: McpServerStatus.Stopped };
		case 'needs_authentication':
			return {
				kind: McpServerStatus.Error,
				error: { errorType: MCP_AUTH_REQUIRED_ERROR_TYPE, message: status.message ?? localize('cliTsAgent.mcpAuthRequired', "Sign in to use this connector.") },
			};
		case 'error':
			return {
				kind: McpServerStatus.Error,
				error: { errorType: 'mcp-server-failed', message: status.message ?? 'MCP server failed to start.' },
			};
		default:
			return { kind: McpServerStatus.Starting };
	}
}

/**
 * Converts a workbench MCP server configuration into the `.backboard/mcp.json`
 * entry shape the runtime reads. Variable references are rewritten from the
 * VS Code forms (`${input:NAME}`, `${env:NAME}`) to the CLI's `${NAME}` so an
 * environment variable of the same name still resolves at connect time.
 */
function mcpEntryFromConfiguration(configuration: IMcpServerConfiguration): CliTsMcpServerEntry | undefined {
	if (configuration.type === McpServerType.LOCAL) {
		if (!configuration.command) {
			return undefined;
		}
		const env = configuration.env ? mcpEnvToCliEnv(configuration.env) : undefined;
		return {
			type: 'stdio',
			command: rewriteMcpVariables(configuration.command),
			...(configuration.args ? { args: configuration.args.map(rewriteMcpVariables) } : {}),
			...(env && Object.keys(env).length > 0 ? { env } : {}),
			...(configuration.cwd ? { cwd: configuration.cwd } : {}),
		};
	}
	if (!configuration.url) {
		return undefined;
	}
	const headers = configuration.headers ? mcpEnvToCliEnv(configuration.headers) : undefined;
	return {
		type: 'streamable-http',
		url: rewriteMcpVariables(configuration.url),
		...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

function mcpEnvToCliEnv(source: Record<string, string | number | null>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === null) {
			continue;
		}
		env[key] = rewriteMcpVariables(String(value));
	}
	return env;
}

/** Rewrites VS Code MCP variable syntax to the CLI's environment syntax. */
function rewriteMcpVariables(value: string): string {
	return value
		.replace(/\$\{input:([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, name: string, _defaultExpr: string | undefined, fallback: string) => fallback !== undefined ? `\${${name}:-${fallback}}` : `\${${name}}`)
		.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `\${${name}}`);
}

const CLI_TS_STORE_VERSION = 1;
const CHATGPT_SUBSCRIPTION_PROVIDER = 'openai-subscription';
const CHATGPT_SUBSCRIPTION_LOGIN_COMMAND = 'chatgptSubscription.login';
const CLAUDE_SUBSCRIPTION_PROVIDER = 'anthropic-subscription';
const CLAUDE_SUBSCRIPTION_LOGIN_COMMAND = 'claudeSubscription.login';
const CLAUDE_SUBSCRIPTION_ENABLE_COMMAND = 'claudeSubscription.enable';
const CLAUDE_CODE_VERSION_COMMAND = 'claudeSubscription.version';
const CLAUDE_CODE_UPDATE_COMMAND = 'claudeSubscription.update';
/** The release check reads the npm registry; one answer serves every picker open for a while. */
const CLAUDE_CODE_VERSION_TTL_MS = 10 * 60_000;
const CLI_TS_META_WORKTREE_BRANCH = 'backboard.worktree.branchName';
const CLI_TS_META_WORKTREE_PATH = 'backboard.worktree.path';
const CLI_TS_META_WORKTREE_REPOSITORY_ROOT = 'backboard.worktree.repositoryRoot';
/** Upper bound for one `keys validate` round trip (cli-ts caps the vendor call at 15 s). */
const CLI_TS_KEY_VALIDATION_TIMEOUT_MS = 20_000;
/** How long a running serve process may take to acknowledge a credential snapshot. */
const CLI_TS_CREDENTIAL_ACK_TIMEOUT_MS = 5_000;

/** Outcome of pushing a credential snapshot to the running serve processes. */
interface CliTsCredentialPush {
	/** Processes that applied the snapshot. */
	readonly acknowledged: number;
	/** Processes ended because they did not apply it in time, or that had already exited. */
	readonly terminated: number;
	/** Processes that neither acknowledged nor could be confirmed gone. */
	readonly unconfirmed: number;
	readonly total: number;
}

/** Outcome of `cli-ts keys validate`, with the key already scrubbed from any message. */
type CliTsKeyValidation =
	| { readonly ok: true; readonly models: readonly BridgeModel[] }
	| { readonly ok: false; readonly category: string; readonly error: string };

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
			const config = JSON.parse(fs.readFileSync(path.join(homeDir, '.backboard', 'config.json'), 'utf8')) as { chatgptSubscriptionAuthFile?: unknown };
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

/**
 * The billing family of a model id's provider prefix. Every key-billed vendor
 * collapses to `byok`: those conversations are provider-neutral, so switching
 * between two key-billed vendors keeps the thread while any move between a
 * key route and another route is a provider change.
 */
function providerFromModelId(modelId: string | undefined): string | undefined {
	if (!modelId) {
		return undefined;
	}
	const separator = modelId.indexOf('/');
	return separator > 0 ? routeProviderFamily(modelId.slice(0, separator)) : undefined;
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
			: threadId.startsWith('byok_')
				? 'byok'
				: undefined;
	if (threadProvider) {
		return threadProvider !== nextProvider;
	}
	const previousProvider = providerFromModelId(previousModelId);
	if (previousProvider) {
		return previousProvider !== nextProvider;
	}
	// A Backboard thread has no prefix, so a restored unprefixed thread cannot
	// be adopted by a subscription transport or by the user's own key.
	return nextProvider === CHATGPT_SUBSCRIPTION_PROVIDER || nextProvider === CLAUDE_SUBSCRIPTION_PROVIDER || nextProvider === 'byok';
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
 * Publishes, per key-billed model, whether its vendor currently holds a
 * validated key. Key-billed rows stay listed after a key is removed so a
 * session pinned to one keeps its selection visible (labelled as unavailable)
 * instead of being silently moved to another model. No key material is ever
 * exposed here.
 */
export function withByokKeyStates(
	models: readonly IAgentModelInfo[],
	heldVendors: ReadonlySet<string>,
	availableByVendor: ReadonlyMap<string, ReadonlySet<string>>,
): IAgentModelInfo[] {
	return models.map(model => {
		const separator = model.id.indexOf('/');
		const provider = separator > 0 ? model.id.slice(0, separator) : undefined;
		if (!provider || !isKeyBilledProvider(provider)) {
			return model;
		}
		const vendor = vendorOfProvider(provider);
		// Until a key's catalog has been discovered nothing is known against the
		// row, so it stays usable; a discovered catalog is authoritative.
		const available = availableByVendor.get(vendor);
		return {
			...model,
			_meta: {
				...model._meta,
				byokKeyConfigured: heldVendors.has(vendor),
				byokModelAvailable: available === undefined || available.has(model.id.slice(separator + 1)),
			},
		};
	});
}

/**
 * One ordered, restorable piece of a completed turn's response. Markdown and
 * reasoning content accumulates during the live turn (hence mutable); tool
 * parts capture the compact completion facts needed to rebuild a real
 * completed tool-call pill. Execute keeps both its compact CLI detail and the
 * complete bounded terminal transcript used by the IDE terminal card.
 */
type CliTsWorkerWorkspace = NonNullable<CliTsAgentEvent['workspace']>;

type CliTsBackboardToolKind = 'read' | 'grep' | 'glob' | 'fetchUrl' | 'webSearch' | 'todo' | 'computer' | 'browser' | 'findSkill' | 'findMcp' | 'generateVideo';

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
	/** The chat's last selected model, so restored history can show its billing route. */
	readonly model?: ModelSelection;
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
	/** The model recorded in the store; display-only until the IDE selects a model again. */
	storedModel?: ModelSelection;
	activeModel?: ModelSelection;
	modelChangeRevision?: number;
	appliedModelRevision?: number;
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
	/**
	 * IDE-owned MCP servers for this session, keyed by server name, in the
	 * `.backboard/mcp.json` shape the runtime understands. Pushed to the serve
	 * process on every change and re-pushed whenever a process starts.
	 */
	mcpServers?: Record<string, CliTsMcpServerEntry>;
	/** Server names the user disconnected for this session (composer toggle). */
	mcpDisabled?: Set<string>;
	/**
	 * Last runtime state reported by the serve process, keyed by server name.
	 * Includes servers the IDE did not push (a project `.backboard/mcp.json`,
	 * or one the agent added mid-chat with `find_mcp`), so every server the
	 * model can use is visible in the composer.
	 */
	mcpRuntimeStates?: Map<string, McpServerState>;
	/**
	 * Whether the running serve process reports MCP status on its own and owns
	 * the user-level config through authoritative pushes (`mcp-status-events`).
	 */
	mcpStatusEvents?: boolean;
	/** Serializes MCP pushes so overlapping syncs cannot interleave. */
	mcpPush?: Promise<void>;
	/** Publishes MCP server customizations for this session. */
	mcpController?: McpCustomizationController;
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
	 * Starts with the locally-authenticated ChatGPT and Claude subscription routes,
	 * immediately hydrates the previous live Backboard API result from disk,
	 * and refreshes from the backend once a serve process is up. API catalog
	 * providers such as OpenRouter are never supplemented from a compiled list.
	 */
	private readonly _models = observableValue<readonly IAgentModelInfo[]>(
		'cliTsModels',
		withSubscriptionConnectionStates(
			backboardModelInfos(BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS),
			hasUsableChatGptSubscriptionLogin(),
			false,
		),
	);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, CliTsSession>();
	/**
	 * Each stored session's serialized entry, valid while the store file still
	 * has this stamp. The store holds every chat (tens of MB) and a first send
	 * rewrites it several times; re-reading, parsing and re-serializing all of
	 * it on each write blocked the host ~0.4 s per write.
	 */
	private _storeEntries: { readonly stamp: string; readonly entries: ReadonlyMap<string, string> } | undefined;
	/** Full historical child turns recovered from cli-ts's per-agent event logs. */
	private readonly _runtimeSubagentTurnCache = new Map<string, Promise<CliTsRuntimeSubagentRecovery | undefined>>();
	private readonly _runtimeWorkerStateCache = new Map<string, CliTsWorkerState>();
	/** Coalesces worker lifecycle projection without delaying durable runtime state. */
	private readonly _workerProjectionStates = new WeakMap<CliTsTurnState, Map<string, CliTsWorkerProjectionState>>();
	private _modelsRefreshed = false;
	private _modelRefreshPromise: Promise<void> | undefined;
	private readonly _modelRefreshProcess = this._register(new MutableDisposable<CliTsServeProcess>());
	/** Each concurrent catalog fetch owns its process until that request completes. */
	private readonly _generativeCatalogProcesses = this._register(new DisposableStore());
	private readonly _generativeCatalog: GenerativeModelCatalog;
	private _rgDir: Promise<string | undefined> | undefined;
	private _chatGptSubscriptionLoginPromise: Promise<void> | undefined;
	private _claudeSubscriptionEnablePromise: Promise<void> | undefined;
	private _claudeCodeVersion: { readonly checkedAt: number; readonly status: Promise<IClaudeCodeVersionStatus | undefined> } | undefined;
	private _claudeCodeUpdatePromise: Promise<IAgentCommandResult> | undefined;
	private _claudeSubscriptionConnected = false;
	private _claudeSubscriptionStatusRevision = 0;
	/** Validated provider keys pushed by the IDE. Held in memory only; never persisted or logged. */
	private readonly _providerKeys = new Map<ByokProviderId, string>();
	/** The newest key-change generation applied per provider; older ones are refused. */
	private readonly _providerKeyGenerations = new Map<ByokProviderId, number>();
	/** Vendor catalogs discovered with a key. Model names only; cached so rows survive restarts. */
	private readonly _byokCatalog = new Map<ByokProviderId, BridgeModel[]>();
	/** Model names the vendor's current key can reach; absent until its catalog was discovered. */
	private readonly _byokAvailability = new Map<ByokProviderId, Set<string>>();
	/** Successful validations waiting for the IDE to persist and activate the key. */
	private readonly _pendingValidation = new Map<ByokProviderId, { readonly key: string; readonly models: readonly BridgeModel[] }>();
	/** One background catalog discovery per vendor. */
	private readonly _byokDiscovery = new Map<ByokProviderId, Promise<void>>();
	/** Monotonic revision of the credential snapshot; acks echo it. */
	private _credentialRevision = 0;
	/** The Backboard API catalog as last reported by a serve process, key-billed rows stripped. */
	private _lastServeModels: readonly BridgeModel[] = [];
	/** How long a running serve process gets to acknowledge a credential change. */
	private _credentialAckTimeoutMs = CLI_TS_CREDENTIAL_ACK_TIMEOUT_MS;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentPluginManager private readonly _pluginManager: IAgentPluginManager,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._hydrateModelsFromCache();
		this._generativeCatalog = this._register(new GenerativeModelCatalog(
			path.join(path.dirname(this._modelsCachePath()), 'generative-models-cache.json'),
			() => this._currentApiUrl(),
			property => this._fetchGenerativeCatalog(property),
			this._logService,
		));
		void this._refreshClaudeSubscriptionConnectionState();
		this._watchCredentials();
		void ensureBackboardGuestKey(this._logService);
	}

	/**
	 * Signing in or out (SSO, API key, subscription connect/disconnect) changes
	 * which models exist. Refresh the catalog when the credentials change, so
	 * the picker never keeps a signed-out list after a sign-in or vice versa.
	 * The IDE folder also holds chat history, so only a changed credential
	 * fingerprint triggers the refresh.
	 */
	private _watchCredentials(): void {
		let fingerprint = cliTsCredentialFingerprint();
		const check = this._register(new RunOnceScheduler(() => {
			const next = cliTsCredentialFingerprint();
			if (next === fingerprint) {
				return;
			}
			fingerprint = next;
			// Signing out leaves no credentials: fall back to a guest key so
			// the free models keep working. Writing it changes the fingerprint
			// again, which refreshes the catalog with the guest key.
			void ensureBackboardGuestKey(this._logService);
			this._modelsRefreshed = false;
			this._modelRefreshPromise ??= this._refreshModelCatalog()
				.catch(error => this._logService.warn(`[cli-ts] model refresh after a credential change failed: ${error instanceof Error ? error.message : String(error)}`))
				.finally(() => { this._modelRefreshPromise = undefined; });
		}, 500));
		for (const directory of [path.join(os.homedir(), '.backboard_ide'), path.join(os.homedir(), '.backboard')]) {
			try {
				const watcher = fs.watch(directory, { persistent: false }, (_event, file) => {
					if (!file || file.toString().endsWith('.json')) {
						check.schedule();
					}
				});
				this._register(toDisposable(() => watcher.close()));
			} catch {
				// A missing folder has no credentials to watch; the first sign-in creates it.
			}
		}
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
			const raw = JSON.parse(fs.readFileSync(this._modelsCachePath(), 'utf8')) as { apiUrl?: string; models?: unknown[]; byok?: Record<string, unknown> };
			// Key-billed catalogs are vendor-owned and independent of the API URL.
			// They are names only: whether a row is usable is decided by which keys
			// the IDE pushes after startup and what the last discovery could reach,
			// never by the cache alone.
			for (const [provider, entry] of Object.entries(raw.byok ?? {})) {
				if (!isByokProviderId(provider)) {
					continue;
				}
				// Older caches stored the rows alone; availability is then unknown
				// until the key's catalog is discovered again.
				const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as { rows?: unknown; available?: unknown } : undefined;
				const rows = Array.isArray(entry) ? entry : record?.rows;
				if (Array.isArray(rows)) {
					this._byokCatalog.set(provider, rows.filter(isBridgeModel));
				}
				if (Array.isArray(record?.available)) {
					this._byokAvailability.set(provider, new Set(record.available.filter((name): name is string => typeof name === 'string')));
				}
			}
			if ((raw.apiUrl ?? '') === this._currentApiUrl()) {
				this._lastServeModels = (Array.isArray(raw.models) ? raw.models : []).filter(isBridgeModel);
			}
		} catch {
			// First run or unreadable cache — the bundled fallback stays.
		}
		this._publishModels();
	}

	private _persistModelsCache(): void {
		try {
			fs.mkdirSync(path.dirname(this._modelsCachePath()), { recursive: true });
			const byok = Object.fromEntries([...this._byokCatalog].map(([provider, rows]) => {
				const available = this._byokAvailability.get(provider);
				return [provider, { rows, ...(available ? { available: [...available] } : {}) }];
			}));
			fs.writeFileSync(this._modelsCachePath(), `${JSON.stringify({ apiUrl: this._currentApiUrl(), models: this._lastServeModels, byok }, null, '\t')}\n`, 'utf8');
		} catch (error) {
			this._logService.info(`[cli-ts] could not persist models cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Recomputes the published catalog: the Backboard API rows, the key-billed
	 * rows under their `-key` provider ids, and the bundled subscription routes,
	 * each stamped with its connection state. Key-billed rows are listed
	 * whenever a catalog is known, and `byokKeyConfigured` says whether they are
	 * usable right now.
	 */
	private _publishModels(): void {
		const keyRows: BridgeModel[] = [];
		for (const [provider, rows] of this._byokCatalog) {
			for (const row of rows) {
				keyRows.push({ ...row, provider: keyBilledProviderId(provider) });
			}
		}
		const infos = withByokKeyStates(
			withSubscriptionConnectionStates(
				backboardModelInfos(this._lastServeModels, keyRows, BUNDLED_CHATGPT_SUBSCRIPTION_MODELS, BUNDLED_CLAUDE_SUBSCRIPTION_MODELS),
				hasUsableChatGptSubscriptionLogin(),
				this._claudeSubscriptionConnected,
			),
			new Set(this._providerKeys.keys()),
			this._byokAvailability,
		);
		this._models.set(infos.length ? infos : [fallbackModel()], undefined);
	}

	/**
	 * Records what the vendor's current key can reach. Rows discovered earlier
	 * stay in the catalog so a session pinned to one keeps a visible selection;
	 * only their availability changes. The union is what the picker lists.
	 */
	private _recordByokCatalog(provider: ByokProviderId, models: readonly BridgeModel[]): void {
		const merged = new Map((this._byokCatalog.get(provider) ?? []).map(row => [row.name, row] as const));
		for (const row of models) {
			merged.set(row.name, row);
		}
		this._byokCatalog.set(provider, [...merged.values()]);
		this._byokAvailability.set(provider, new Set(models.map(row => row.name)));
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

	async executeCommand(command: string, args?: Readonly<Record<string, unknown>>): Promise<IAgentCommandResult> {
		switch (command) {
			case 'models.refresh':
				this._modelRefreshPromise ??= this._refreshModelCatalog().finally(() => { this._modelRefreshPromise = undefined; });
				await this._modelRefreshPromise;
				return { message: localize('cliTsAgent.models.refreshed', "Models and subscriptions refreshed.") };
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
			case CLAUDE_CODE_VERSION_COMMAND: {
				const status = await this._claudeCodeVersionStatus();
				return { message: '', data: status ? { ...status } : undefined };
			}
			case CLAUDE_CODE_UPDATE_COMMAND:
				this._claudeCodeUpdatePromise ??= this._updateClaudeCode().finally(() => { this._claudeCodeUpdatePromise = undefined; });
				return this._claudeCodeUpdatePromise;
			case BYOK_COMMANDS.validate:
				return this._validateProviderKeyCommand(args);
			case BYOK_COMMANDS.set:
				return this._setProviderKeyCommand(args);
			case BYOK_COMMANDS.remove:
				return this._removeProviderKeyCommand(args);
			case BYOK_COMMANDS.status:
				return this._providerKeyStatusCommand();
			default:
				throw new Error(`Unsupported Backboard command: ${command}`);
		}
	}

	// ---- provider keys (BYOK) ------------------------------------------------
	//
	// The IDE owns the secrets. It validates a key here first, persists it in
	// its own secret storage, then activates it here; every activation pushes
	// the whole snapshot to the running serve processes. Nothing in this class
	// writes a key to disk or to a log.

	private _byokCommandArgs(args: Readonly<Record<string, unknown>> | undefined, requireKey: boolean): { provider: ByokProviderId; key: string | undefined } {
		const provider = args?.[BYOK_PROVIDER_ARG];
		if (!isByokProviderId(provider)) {
			throw new Error(localize('cliTsAgent.byok.unsupportedProvider', "API keys are not supported for provider '{0}'.", String(provider)));
		}
		const rawKey = args?.[BYOK_KEY_ARG];
		const key = typeof rawKey === 'string' ? rawKey.trim() : undefined;
		if (requireKey && !key) {
			throw new Error(localize('cliTsAgent.byok.keyMissing', "Enter a {0} API key.", byokProviderDefinition(provider).label));
		}
		return { provider, key };
	}

	private async _validateProviderKeyCommand(args: Readonly<Record<string, unknown>> | undefined): Promise<IAgentCommandResult> {
		const { provider, key } = this._byokCommandArgs(args, true);
		const label = byokProviderDefinition(provider).label;
		const result = await this._validateProviderKey(provider, key!);
		if (!result.ok) {
			this._logService.info(`[cli-ts] ${provider} key rejected during validation (${result.category})`);
			return { message: result.error, data: { ok: false, category: result.category, error: result.error } };
		}
		this._pendingValidation.set(provider, { key: key!, models: result.models });
		return {
			message: localize('cliTsAgent.byok.validated', "{0} key verified.", label),
			data: { ok: true, modelCount: result.models.length },
		};
	}

	/**
	 * Applies the store's per-provider generation: a change older than the
	 * newest one already applied is refused, so a slow replacement can never
	 * undo a later removal (or the other way round). Equal generations are the
	 * same change again and go through; a missing one is an older caller.
	 */
	private _applyProviderKeyGeneration(provider: ByokProviderId, args: Readonly<Record<string, unknown>> | undefined): void {
		const generation = args?.[BYOK_GENERATION_ARG];
		if (generation === undefined) {
			return;
		}
		if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
			throw new Error(localize('cliTsAgent.byok.badGeneration', "Invalid key change generation."));
		}
		const newest = this._providerKeyGenerations.get(provider);
		if (newest !== undefined && generation < newest) {
			throw new Error(localize('cliTsAgent.byok.staleGeneration', "This {0} key change was superseded by a newer one.", byokProviderDefinition(provider).label));
		}
		this._providerKeyGenerations.set(provider, generation);
	}

	private async _setProviderKeyCommand(args: Readonly<Record<string, unknown>> | undefined): Promise<IAgentCommandResult> {
		const { provider, key } = this._byokCommandArgs(args, true);
		this._applyProviderKeyGeneration(provider, args);
		const pending = this._pendingValidation.get(provider);
		this._pendingValidation.delete(provider);
		this._providerKeys.set(provider, key!);
		if (pending && pending.key === key) {
			this._recordByokCatalog(provider, pending.models);
		} else {
			// Activated without a fresh validation (window start): the key is usable
			// immediately and the catalog fills in when discovery completes.
			void this._discoverByokCatalog(provider, key!);
		}
		this._credentialRevision++;
		this._publishModels();
		this._persistModelsCache();
		const push = await this._pushCredentials();
		return {
			message: localize('cliTsAgent.byok.connected', "{0} key connected.", byokProviderDefinition(provider).label),
			data: { connected: push.unconfirmed === 0, revision: this._credentialRevision, acknowledged: push.acknowledged, terminated: push.terminated, running: push.total },
		};
	}

	private async _removeProviderKeyCommand(args: Readonly<Record<string, unknown>> | undefined): Promise<IAgentCommandResult> {
		const { provider } = this._byokCommandArgs(args, false);
		this._applyProviderKeyGeneration(provider, args);
		this._providerKeys.delete(provider);
		this._pendingValidation.delete(provider);
		this._credentialRevision++;
		// The catalog stays so sessions pinned to these models keep a visible,
		// clearly unavailable selection instead of being moved elsewhere.
		this._publishModels();
		const label = byokProviderDefinition(provider).label;
		// The key left this map before the push, so nothing new can be sent with
		// it; the push makes sure no running turn keeps using it either.
		const push = await this._pushCredentials();
		if (push.unconfirmed > 0) {
			throw new Error(localize('cliTsAgent.byok.removeUnconfirmed', "The {0} key was removed, but {1} running session(s) could not confirm dropping it. Restart Backboard to be sure no session still uses it.", label, push.unconfirmed));
		}
		return {
			message: localize('cliTsAgent.byok.removed', "{0} key removed.", label),
			data: { revision: this._credentialRevision, acknowledged: push.acknowledged, terminated: push.terminated, running: push.total },
		};
	}

	private _providerKeyStatusCommand(): IAgentCommandResult {
		const providers: Record<string, { held: boolean; discovered: boolean }> = {};
		for (const definition of BYOK_PROVIDERS) {
			providers[definition.id] = {
				held: this._providerKeys.has(definition.id),
				discovered: (this._byokCatalog.get(definition.id)?.length ?? 0) > 0,
			};
		}
		return { message: '', data: { providers, revision: this._credentialRevision } };
	}

	/**
	 * Runs `cli-ts keys validate` with the key on the child's stdin. The
	 * runtime answers with one JSON line and never echoes the key. Overridden
	 * in tests.
	 */
	private async _validateProviderKey(provider: ByokProviderId, key: string): Promise<CliTsKeyValidation> {
		const output = await runCliTsCommand(this._logService, ['keys', 'validate', '--provider', provider], { stdin: key, timeoutMs: CLI_TS_KEY_VALIDATION_TIMEOUT_MS });
		const line = output.trim().split('\n').at(-1) ?? '';
		let parsed: { ok?: unknown; category?: unknown; error?: unknown; models?: unknown };
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			throw new Error(localize('cliTsAgent.byok.unreadableValidation', "The Backboard runtime returned an unreadable key validation result. Update Backboard and try again."));
		}
		if (parsed.ok === true) {
			return { ok: true, models: (Array.isArray(parsed.models) ? parsed.models : []).filter(isBridgeModel) };
		}
		return {
			ok: false,
			category: typeof parsed.category === 'string' ? parsed.category : 'provider-error',
			error: typeof parsed.error === 'string' && parsed.error
				? parsed.error
				: localize('cliTsAgent.byok.validationFailed', "The {0} key could not be verified.", byokProviderDefinition(provider).label),
		};
	}

	private _discoverByokCatalog(provider: ByokProviderId, key: string): Promise<void> {
		const inFlight = this._byokDiscovery.get(provider);
		if (inFlight) {
			return inFlight;
		}
		const run = this._validateProviderKey(provider, key)
			.then(result => {
				if (this._providerKeys.get(provider) !== key) {
					return; // replaced or removed while discovering
				}
				if (result.ok) {
					this._recordByokCatalog(provider, result.models);
					this._publishModels();
					this._persistModelsCache();
				} else {
					this._logService.info(`[cli-ts] ${provider} key catalog discovery deferred (${result.category})`);
				}
			})
			.catch(error => {
				this._logService.warn(`[cli-ts] ${provider} key catalog discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				this._byokDiscovery.delete(provider);
			});
		this._byokDiscovery.set(provider, run);
		return run;
	}

	private _credentialControl(): CliTsCredentialSnapshot {
		return {
			op: 'setCredentials',
			revision: this._credentialRevision,
			providerKeys: [...this._providerKeys].map(([provider, key]) => ({ provider, key })),
		};
	}

	/**
	 * Pushes the current snapshot to every serve process that has completed
	 * its startup handshake; one still starting reads the host's keys when it
	 * becomes ready, so the change is already part of its own snapshot. A
	 * process that does not acknowledge in time is terminated: it may still
	 * hold a revoked key or lack a new one, and nothing else may be sent to it.
	 * The push is complete only when every process acknowledged or is gone.
	 */
	private async _pushCredentials(): Promise<CliTsCredentialPush> {
		const running = [...this._sessions.values()]
			.map(session => session.proc)
			.filter((proc): proc is CliTsServeProcess => !!proc?.credentialSnapshotWritten);
		const revision = this._credentialRevision;
		const outcomes = await Promise.all(running.map(async proc => {
			const acknowledged = await raceTimeout(
				proc.request({ ...this._credentialControl(), requestId: proc.nextRequestId() }).then(() => true, () => false),
				this._credentialAckTimeoutMs,
			);
			if (acknowledged) {
				return 'acknowledged';
			}
			if (proc.isRunning) {
				this._logService.warn(`[cli-ts] a serve process did not acknowledge credential revision ${revision} in time; terminating it`);
				proc.terminate(localize('cliTsAgent.byok.runtimeRestarted', "Runtime restarted after a credential change."));
			}
			const exited = await raceTimeout(proc.whenExited().then(() => true), this._credentialAckTimeoutMs);
			return exited ? 'terminated' : 'unconfirmed';
		}));
		const count = (outcome: string) => outcomes.filter(candidate => candidate === outcome).length;
		const push = { acknowledged: count('acknowledged'), terminated: count('terminated'), unconfirmed: count('unconfirmed'), total: running.length };
		if (push.unconfirmed > 0) {
			this._logService.error(`[cli-ts] ${push.unconfirmed} of ${push.total} serve processes could not be confirmed to hold credential revision ${revision}`);
		}
		return push;
	}

	private _assertProviderKeyHeld(vendor: string): void {
		if (isByokProviderId(vendor) && this._providerKeys.has(vendor)) {
			return;
		}
		const label = isByokProviderId(vendor) ? byokProviderDefinition(vendor).label : vendor;
		throw new Error(localize('cliTsAgent.byok.keyRequired', "No {0} API key is connected. Add one under API Keys to use this model.", label));
	}

	/**
	 * The current key's discovered catalog is authoritative: a selection it
	 * lacks (a replacement key with narrower access, say) is refused here, so
	 * the picker's "not available" state and the send outcome always agree.
	 */
	private _assertByokModelAvailable(vendor: string, model: string): void {
		if (!isByokProviderId(vendor)) {
			return;
		}
		const available = this._byokAvailability.get(vendor);
		if (available === undefined || available.has(model)) {
			return;
		}
		const label = byokProviderDefinition(vendor).label;
		throw new Error(localize('cliTsAgent.byok.modelUnavailable', "{0} is not available with the connected {1} API key. Pick another {1} API Key model or replace the key.", model, label));
	}


	private async _ensureChatGptSubscriptionLogin(force: boolean): Promise<void> {
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
		await this._requireClaudeSubscriptionLogin(true);
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

	private _claudeCodeVersionStatus(): Promise<IClaudeCodeVersionStatus | undefined> {
		const cached = this._claudeCodeVersion;
		if (cached && Date.now() - cached.checkedAt < CLAUDE_CODE_VERSION_TTL_MS) {
			return cached.status;
		}
		const status = claudeCodeVersionStatus().catch(() => undefined);
		this._claudeCodeVersion = { checkedAt: Date.now(), status };
		return status;
	}

	/**
	 * Runs `claude update`, then re-reads the catalog: the Claude model list is
	 * whatever the installed Claude Code reports, so an old install lists fewer.
	 */
	private async _updateClaudeCode(): Promise<IAgentCommandResult> {
		await updateClaudeCode();
		this._claudeCodeVersion = undefined;
		const status = await this._claudeCodeVersionStatus();
		this._modelRefreshPromise ??= this._refreshModelCatalog().finally(() => { this._modelRefreshPromise = undefined; });
		await this._modelRefreshPromise;
		return {
			message: status
				? localize('cliTsAgent.claudeCode.updatedTo', "Claude Code updated to {0}. Every Claude model on your plan is now listed.", status.installed)
				: localize('cliTsAgent.claudeCode.updated', "Claude Code updated. Every Claude model on your plan is now listed."),
			data: status ? { ...status } : undefined,
		};
	}

	/** `fresh` asks Claude Code even while an earlier check is still trusted. */
	private async _requireClaudeSubscriptionLogin(fresh = false): Promise<void> {
		try {
			await assertUsableClaudeSubscriptionLogin(fresh ? isClaudeLoggedIn : () => isClaudeLoggedInRecently());
			this._setClaudeSubscriptionConnectionState(true);
		} catch (error) {
			this._setClaudeSubscriptionConnectionState(false);
			throw error;
		}
	}

	private async _refreshClaudeSubscriptionConnectionState(probe: () => Promise<boolean> = isClaudeLoggedIn): Promise<void> {
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
			await Promise.all([
				this._ensureRestoredWorktree(existing),
				this._adoptActiveClient(existing, config.activeClient),
			]);
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
		const sourceSessionId = config.fork ? AgentSession.id(config.fork.session) : undefined;
		const sourceSession = sourceSessionId ? this._sessions.get(sourceSessionId) : undefined;
		const sourceStoredSession = sourceSessionId ? this._readStore(sourceSessionId).find(entry => entry.id === sourceSessionId) : undefined;
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
		} satisfies CliTsStoredSession : config.session ? this._readStore(sessionId).find(entry => entry.id === sessionId) : undefined;
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
		await Promise.all([
			this._ensureRestoredWorktree(session),
			this._adoptActiveClient(session, config.activeClient),
		]);
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
	 * A draft's process is only for that refresh unless `keepProcess` says a
	 * send is already on its way.
	 */
	private async _prewarm(session: CliTsSession, keepProcess = session.materialized): Promise<void> {
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
			if (!keepProcess && !session.materialized && refresh) {
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
		const result = resolveBackboardSessionConfig(params.config, repository);
		for (const property of [BACKBOARD_IMAGE_MODEL_CONFIG_KEY, BACKBOARD_VIDEO_MODEL_CONFIG_KEY] as const) {
			const cached = this._generativeCatalog.peek(property);
			if (cached) {
				const schema = result.schema.properties[property];
				result.schema.properties[property] = {
					...schema,
					// Media is always available on Backboard models, so there is no Off entry.
					enum: cached.map(item => item.value),
					enumLabels: cached.map(item => item.label),
					enumDescriptions: cached.some(item => item.description) ? cached.map(item => item.description ?? '') : undefined,
				};
			}
			// Warm both catalogs without making composer configuration wait for the network.
			void this._generativeCatalog.get(property).catch(() => { /* A picker open can retry and display the error. */ });
		}
		return result;
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
		if (params.property === BACKBOARD_IMAGE_MODEL_CONFIG_KEY || params.property === BACKBOARD_VIDEO_MODEL_CONFIG_KEY) {
			return this._generativeModelCompletions(params.property, params.query, params.refresh);
		}
		if (params.property !== SessionConfigKey.Branch || !params.workingDirectory) {
			return { items: [] };
		}
		const branches = await this._gitService.getBranches(params.workingDirectory, { query: params.query, limit: 200 });
		return { items: branches.map(branch => ({ value: branch, label: branch })) };
	}

	/**
	 * Live image/video catalog for the composer pickers. Media is always
	 * available on Backboard models, so the list has no Off entry.
	 */
	private async _generativeModelCompletions(property: GenerativeModelProperty, query: string | undefined, refresh?: boolean): Promise<SessionConfigCompletionsResult> {
		const items = await this._generativeCatalog.get(property, refresh);
		const filter = query?.trim().toLowerCase();
		const filtered = filter
			? items.filter(item => item.value.toLowerCase().includes(filter) || item.label.toLowerCase().includes(filter))
			: items;
		// The composer filters locally, so its unfiltered snapshot must match the cached schema.
		return { items: filter ? filtered.slice(0, 200) : [...filtered] };
	}

	private async _fetchGenerativeCatalog(property: GenerativeModelProperty): Promise<readonly GenerativeModelItem[]> {
		// A short-lived catalog process reads current credentials and avoids
		// touching the provider routers owned by running conversations.
		const proc = this._generativeCatalogProcesses.add(new CliTsServeProcess(this._logService, { onEvent: () => { } }));
		try {
			const op = property === BACKBOARD_IMAGE_MODEL_CONFIG_KEY ? 'listImageModels' : 'listVideoModels';
			const record = await raceTimeout(proc.request({ op, requestId: proc.nextRequestId() }), 30_000);
			if (!record) {
				throw new Error('Model catalog request timed out.');
			}
			const payload = record.payload;
			const expectedType = property === BACKBOARD_IMAGE_MODEL_CONFIG_KEY ? 'serve:imageModels' : 'serve:videoModels';
			if (record.type !== expectedType || !isPlainRecord(payload) || !Array.isArray(payload.models)) {
				throw new Error('Invalid model catalog response.');
			}
			const items = payload.models
				.filter(isPlainRecord)
				.map(model => generativeModelCompletionItem(model, property))
				.filter((item): item is GenerativeModelItem => item !== undefined);
			if (payload.models.length > 0 && items.length === 0) {
				throw new Error('Invalid model catalog entries.');
			}
			return items;
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to load the ${property} catalog: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		} finally {
			this._generativeCatalogProcesses.delete(proc);
		}
	}

	sendMessage(sessionUri: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const session = this._session(sessionUri);
		const queuedAt = Date.now();
		// A new chat's runtime would otherwise spawn only after the queued model
		// switch, store writes and materialization, and then make the turn wait
		// for its MCP servers to connect. A folder chat's cwd is already final,
		// so start it now; a worktree chat still starts after its checkout.
		if (!session.materialized && !session.archived && session.workingDirectory && this._liveIsolation(session) !== 'worktree') {
			void this._prewarm(session, true);
		}
		return this._queueSessionOperation(session, () => this._sendMessage(session, prompt, attachments, turnId, queuedAt));
	}

	/** The isolation `_doMaterialize` will apply, from the same live config. */
	private _liveIsolation(session: CliTsSession): unknown {
		const liveConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		return { ...(session.config ?? {}), ...(liveConfig ?? {}) }[SessionConfigKey.Isolation];
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

	private async _sendMessage(session: CliTsSession, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string, queuedAt = Date.now()): Promise<void> {
		// Send→submit stage timings, logged once with turn_start. The first
		// send of a new chat crosses several independent waits (session queue,
		// store writes, checkpoint baseline, serve startup) that no other log
		// separates.
		const stages: string[] = [];
		let stageStart = queuedAt;
		const mark = (stage: string) => {
			const now = Date.now();
			stages.push(`${stage}=${now - stageStart}ms`);
			stageStart = now;
		};
		mark('queue');
		if (session.disposed) {
			throw new Error(`Cannot send to disposed Backboard session: ${session.sessionUri.toString()}`);
		}
		if (session.archived) {
			throw new Error(`Cannot send to archived Backboard session: ${session.sessionUri.toString()}`);
		}
		await this._applyPendingModel(session);
		mark('applyModel');
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
		let prepared = prepareSubmitAttachments(prompt, attachments);
		const storedConfig = this._configurationService.getSessionConfigValues(session.sessionUri.toString());
		const settings = createBackboardTurnSettings(storedConfig, session.config, session.model);
		if (settings.videoGeneration || settings.imageGeneration) {
			// Hosted generation reads its inputs from the message's files, so a
			// clip or image attached from disk (Canvas edits, "replace the dog
			// with a cat") must travel as bytes, not as a path to read.
			const mediaNote = await addLocalMediaFiles(prepared, attachments, this._logService);
			if (mediaNote) {
				prepared = { ...prepared, prompt: `${prepared.prompt}\n\n${mediaNote}` };
			}
		}
		const systemContext = [
			backboardMultitaskSystemContext(settings.rawMode),
			backboardAccessSystemContext(settings.accessMode),
		].filter(Boolean).join('\n\n') || undefined;
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
		mark('writeStore');
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
			if (settings.provider === CHATGPT_SUBSCRIPTION_PROVIDER) {
				if (!hasUsableChatGptSubscriptionLogin()) {
					this._fireStatus(session, turn, localize('cliTsAgent.status.waitingForChatGptLogin', "Waiting for ChatGPT sign-in…"));
				}
				await this._ensureChatGptSubscriptionLogin(false);
			} else if (settings.provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
				this._fireStatus(session, turn, localize('cliTsAgent.status.checkingClaudeLogin', "Checking Claude sign-in…"));
				await this._requireClaudeSubscriptionLogin();
			} else if (settings.source === 'byok') {
				this._assertProviderKeyHeld(settings.provider);
				this._assertByokModelAvailable(settings.provider, settings.model);
			}
			if (session.threadId?.startsWith('byok_') && settings.source !== 'byok') {
				// A conversation started on the user's key (possibly by an older
				// build that read the CLI key file) must not continue on Backboard
				// just because the restored selection is a Backboard model.
				throw new Error(localize('cliTsAgent.byok.threadRequiresKey', "This conversation was started with your own API key. Select an API Key model to continue it, or start a new session."));
			}
			// Resolve folder/worktree isolation from the latest live config before
			// starting a process or capturing the session baseline. The checkpoint
			// baseline is immutable once recorded, so capturing the provisional source
			// folder first would permanently break diffs for a later worktree choice.
			mark('login');
			await this._ensureRestoredWorktree(session);
			await this._materialize(session, prompt, storedConfig);
			mark('materialize');
			if (session.disposed) {
				throw new Error(localize('cliTsAgent.sessionDisposedDuringMaterialization', "The Backboard session was deleted before it finished starting."));
			}
			if (session.cancelBeforeSubmit) {
				return;
			}
			await session.baselineCapture;
			const rgDir = await this._resolveRgDir();
			mark('rgDir');
			// Whatever the route, the submit below waits for the runtime's startup
			// handshake: an older runtime that would read its own key file, or one
			// that has not applied the current key snapshot, never receives it.
			const proc = this._ensureProcess(session, rgDir);
			if (session.cancelBeforeSubmit) {
				return;
			}
			this._logService.info(`[cli-ts] turn_start session=${session.sessionId} model=${settings.provider}/${settings.model} source=${settings.source} permission=${permission} cwd=${session.workingDirectory?.fsPath ?? '(missing)'} procRunning=${proc.isRunning} ${stages.join(' ')} total=${Date.now() - queuedAt}ms`);
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
				// The route is explicit on every turn: the runtime never infers
				// billing from which keys happen to be present.
				source: settings.source,
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
				// Always sent so returning a picker to Off clears a previously
				// selected generation model on the persistent serve process.
				imageModel: generativeModelSelection(settings.imageModel),
				videoGeneration: settings.videoGeneration,
				videoModel: generativeModelSelection(settings.videoModel),
				openRouterProvider: settings.openRouterProvider,
				excludedTools,
				// Advertise IDE-executed tools (integrated browser, tasks, …).
				// Omitting the field clears previously registered client tools.
				...(session.clientTools ? { clientTools: this._clientToolsForTurn(session).map(clientToolDefinitionToWire) } : {}),
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
				this._fireFailureNote(session, effectiveTurnId, turn.error);
			}
			this._refreshModelsOnce(session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			turn.failed = true;
			// A terminal serve rejection may follow the more useful run:error.
			// Keep that original failure in both the live row and durable history.
			if (!turn.error) {
				turn.error = { errorType: 'BackboardSendFailed', message: message.trim() ? message : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
				this._fireFailureNote(session, effectiveTurnId, turn.error);
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
		const stored = this._readStore(sessionId).find(entry => entry.id === sessionId);
		const runtimeWorkers = await this._readRuntimeWorkerStates(sessionId);
		const parentTurns = (session?.storedTurns ?? stored?.turns ?? []).map(turn => ({ ...turn,
			...(turn.parts ? { parts: turn.parts.map(part => {
				const worker = part.kind === 'tool' ? runtimeWorkers.get(part.id) : undefined;
				if (part.kind !== 'tool' || !worker || (part.worker && part.worker.revision >= worker.revision)) {
					return part;
				}
				const status = cliTsWorkerCompletionStatus(worker);
				return { ...part, worker, workspace: workspaceFromWorker(worker), ...(status ? { failed: status === 'cancelled' } : {}) };
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
		const stored = session ? undefined : this._readStore(sessionId).find(entry => entry.id === sessionId);
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
			const stored = this._readStore(sessionId).find(entry => entry.id === sessionId);
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
		const session = this._session(sessionUri);
		session.activeModel ??= session.model;
		session.model = model;
		session.modelChangeRevision = (session.modelChangeRevision ?? 0) + 1;
		const owner = session.turn ?? session.subagentTurnOwners.values().next().value;
		if (owner) {
			this._fire(session.sessionUri, { type: ActionType.ChatResponsePart, turnId: owner.turnId, part: {
				kind: ResponsePartKind.SystemNotification,
				content: localize('cliTsAgent.pendingModel', "{0}: Applies after current work finishes", model.id),
			} });
		}
		// The selection is visible immediately; applying it is serialized with
		// sends and waits for detached workers as well as their parent turn.
		void this._queueSessionOperation(session, () => this._applyPendingModel(session)).catch(error => {
			this._logService.warn(`[cli-ts] model change pending: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async _applyPendingModel(session: CliTsSession): Promise<void> {
		if (session.modelChangeRevision === undefined || session.appliedModelRevision === session.modelChangeRevision) {
			return;
		}
		if (session.proc?.isRunning) {
			await session.proc.request({ op: 'waitForIdle', requestId: session.proc.nextRequestId() });
		}
		if (session.disposed) { return; }
		// Read only after the barrier: repeated selections coalesce to the latest.
		const model = session.model;
		if (!model?.id) { return; }
		const revision = session.modelChangeRevision;
		if (isChatGptSubscriptionModel(model.id)) {
			await this._ensureChatGptSubscriptionLogin(false);
		} else if (isClaudeSubscriptionModel(model.id)) {
			await this._requireClaudeSubscriptionLogin();
		}
		if (revision !== session.modelChangeRevision) { return this._applyPendingModel(session); }
		const previousModelId = session.activeModel?.id;
		if (requiresProviderThreadHandoff(session.threadId, previousModelId, model.id)) {
			this._prepareProviderHandoff(session, model.id, previousModelId);
		} else if (session.proc?.isRunning) {
			const route = parseBillingRoute(model.id);
			await session.proc.request({ op: 'setModel', model: route ? `${route.provider}/${route.model}` : model.id,
				...(route ? { source: route.source } : {}), requestId: session.proc.nextRequestId() });
		}
		session.activeModel = model;
		session.appliedModelRevision = revision;
		this._writeStore();
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
				model: session.model ?? session.storedModel,
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
					model: storedSessionModel(entry),
					workingDirectory,
					project: projectDirectory ? { uri: projectDirectory, displayName: path.basename(projectDirectory.fsPath) } : undefined,
				};
			});
		return [...inMemory, ...restored].sort((left, right) => right.modifiedTime - left.modifiedTime);
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		return true;
	}

	/**
	 * Receives the IDE's customization refs and pushes the MCP servers they
	 * carry into this session's serve process.
	 *
	 * The IDE's MCP set (marketplace installs, the seeded Backboard docs
	 * server, and the user's `~/.backboard/mcp.json`, which the IDE imports)
	 * is the same in every window, so Simple and Editor chats see the same
	 * servers. The push is authoritative for the user-level file; the runtime
	 * still layers a project `.backboard/mcp.json` and servers the agent adds
	 * mid-chat. The set is stored on the session and re-applied whenever a new
	 * serve process starts.
	 */
	async setClientCustomizations(session: URI, clientId: string, customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		const entry = this._sessions.get(AgentSession.id(session));
		if (!entry || entry.disposed) {
			return [];
		}
		const synced = await this._syncClientCustomizations(entry, clientId, customizations);
		await this._pushMcpServers(entry);
		return synced;
	}

	/**
	 * The IDE also offers tools of MCP servers it runs itself as client tools.
	 * When the runtime already has the same server connected, the model would
	 * see every tool twice, so those copies are dropped; they stay when the
	 * runtime cannot connect the server (e.g. it needs a secret or sign-in the
	 * IDE already has), which keeps the server usable either way.
	 */
	private _clientToolsForTurn(session: CliTsSession): readonly ToolDefinition[] {
		const tools = session.clientTools?.tools ?? [];
		const states = session.mcpRuntimeStates;
		if (!states) {
			return tools;
		}
		return tools.filter(tool => {
			const meta = tool._meta;
			const serverLabel = meta?.['source'] === 'mcp' ? meta['mcpServerLabel'] : undefined;
			return typeof serverLabel !== 'string' || states.get(serverLabel)?.kind !== McpServerStatus.Ready;
		});
	}

	/**
	 * Honors an active client claimed at `createSession`, which the protocol
	 * defines as equivalent to a `session/activeClientChanged` right after
	 * creation. Without it a new chat has no MCP servers (and no client
	 * tools) until the client's refs happen to change. The servers are
	 * published before this returns so the session's first snapshot lists
	 * them; connecting continues in the background.
	 */
	private async _adoptActiveClient(session: CliTsSession, activeClient: SessionActiveClient | undefined): Promise<void> {
		if (!activeClient || session.disposed) {
			return;
		}
		this.setClientTools(session.sessionUri, activeClient.clientId, activeClient.tools ?? []);
		if (activeClient.customizations === undefined) {
			return;
		}
		try {
			await this._syncClientCustomizations(session, activeClient.clientId, activeClient.customizations);
			void this._pushMcpServers(session);
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to apply the active client's customizations to session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _syncClientCustomizations(session: CliTsSession, clientId: string, customizations: readonly ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		const synced = await this._pluginManager.syncCustomizations(clientId, [...customizations]);
		session.mcpServers = await this._extractSyncedMcpServers(synced);
		// Publish before connecting so the composer lists every server (still
		// starting) rather than only the ones that came up.
		this._publishMcpServers(session);
		return synced;
	}

	async getSessionCustomizations(session: URI): Promise<readonly Customization[]> {
		const entry = this._sessions.get(AgentSession.id(session));
		if (!entry) {
			return [];
		}
		this._getOrCreateMcpController(entry).applyAll(this._mcpServerStates(entry));
		return this._getOrCreateMcpController(entry).topLevelCustomizations();
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

	/**
	 * Connects or disconnects an MCP server for this session. The composer's
	 * server list dispatches this per session customization; disabling marks
	 * the server as `disabled` in the pushed set (the runtime closes the
	 * connection but keeps the configuration), enabling forces a reconnect.
	 * Enabling a server that is waiting for sign-in runs the OAuth flow.
	 */
	setCustomizationEnabled(id: string, enabled: boolean): void {
		for (const session of this._sessions.values()) {
			const customization = session.mcpController?.topLevelCustomizations().find(candidate => candidate.id === id);
			if (!customization) {
				continue;
			}
			const name = customization.name;
			const ideOwned = !!session.mcpServers && Object.hasOwn(session.mcpServers, name);
			const state = session.mcpRuntimeStates?.get(name);
			if (enabled && state?.kind === McpServerStatus.Error && state.error.errorType === MCP_AUTH_REQUIRED_ERROR_TYPE) {
				session.mcpDisabled?.delete(name);
				void this._authenticateMcpServer(session, name);
				return;
			}
			if (!ideOwned) {
				// Project-file and find_mcp servers are configured outside the
				// IDE; they can be reconnected but not switched off here.
				if (enabled) {
					this._getOrCreateMcpController(session).applyOne({ name, state: { kind: McpServerStatus.Starting } });
					void this._pushMcpServers(session, [name]);
				}
				return;
			}
			const disabled = session.mcpDisabled ??= new Set<string>();
			if (enabled) {
				disabled.delete(name);
			} else {
				disabled.add(name);
			}
			this._getOrCreateMcpController(session).applyOne({
				name,
				state: enabled && session.proc?.isRunning ? { kind: McpServerStatus.Starting } : { kind: McpServerStatus.Stopped },
			});
			void this._pushMcpServers(session, enabled ? [name] : []);
			return;
		}
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
		session.mcpController?.dispose();
		session.mcpController = undefined;
		session.mcpRuntimeStates = undefined;
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
		const restored = this._readStore(sessionId).find(entry => entry.id === sessionId);
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
			storedModel: restored && storedSessionModel(restored),
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
		// A window without an open folder (an empty Editor window) still chats:
		// like a terminal agent, the session then works from the home folder.
		const sourceWorkingDirectory = session.sourceWorkingDirectory ?? session.workingDirectory ?? URI.file(os.homedir());
		if (!session.workingDirectory) {
			session.workingDirectory = sourceWorkingDirectory;
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
			this._logService.info(`[cli-ts] restarting session ${session.sessionId} because the CLI executable or credentials changed.`);
		}
		session.proc?.dispose();
		const proc = new CliTsServeProcess(this._logService, {
			sessionId: session.sessionId,
			workingDirectory: workingDirectory?.fsPath,
			extraPathDirs: rgDir ? [rgDir] : undefined,
			onEvent: event => this._handleAgentEvent(session, event),
			onExit: () => {
				session.pendingInputs.clear();
				// The connections died with the process; a respawn reconnects
				// from scratch, so stop showing them as running.
				if (session.proc === proc) {
					session.mcpRuntimeStates = undefined;
					this._publishMcpServers(session);
				}
			},
			// A new process starts from disk only; re-push the IDE-owned MCP
			// server set as soon as it can read control lines.
			onReady: (payload: CliTsReadyPayload) => {
				session.mcpStatusEvents = payload.capabilities?.includes(CLI_TS_MCP_STATUS_EVENTS_CAPABILITY) === true;
				void this._pushMcpServers(session);
			},
			onMcpStatus: payload => {
				if (session.proc === proc) {
					this._applyMcpStatuses(session, payload.servers ?? [], { snapshot: true });
					this._reportMcpWarnings(session, payload.warnings);
				}
			},
			// Every spawn (first start, lazy request, crash respawn) completes the
			// credential handshake, empty snapshot included, before its first
			// request line.
			credentialSnapshot: () => this._credentialControl(),
		});
		session.proc = proc;
		return proc;
	}

	// ---- MCP servers pushed by the IDE -------------------------------------

	private _getOrCreateMcpController(session: CliTsSession): McpCustomizationController {
		if (!session.mcpController) {
			session.mcpController = new McpCustomizationController({
				providerId: this.id,
				sessionId: session.sessionId,
				resolveChildId: () => undefined,
				emit: action => this._fire(session.sessionUri, action),
				isServerEnabled: name => session.mcpDisabled?.has(name) !== true,
			});
		}
		return session.mcpController;
	}

	/**
	 * Current published state for every server the session can use: the
	 * IDE-owned set plus servers the runtime runs on its own (a project
	 * `.backboard/mcp.json`, or one the agent added with `find_mcp`).
	 */
	private _mcpServerStates(session: CliTsSession): { name: string; state: McpServerState }[] {
		const names = new Set<string>([...Object.keys(session.mcpServers ?? {}), ...(session.mcpRuntimeStates?.keys() ?? [])]);
		// Without a runtime (a draft before its first message, or after the
		// process exited) nothing is connecting yet: an enabled server that is
		// `Stopped` connects when the chat starts.
		const pending: McpServerState = session.proc?.isRunning ? { kind: McpServerStatus.Starting } : { kind: McpServerStatus.Stopped };
		return [...names].map(name => ({
			name,
			state: session.mcpDisabled?.has(name)
				? { kind: McpServerStatus.Stopped } as McpServerState
				: session.mcpRuntimeStates?.get(name) ?? pending,
		}));
	}

	private _publishMcpServers(session: CliTsSession): void {
		if (session.disposed) {
			return;
		}
		this._getOrCreateMcpController(session).applyAll(this._mcpServerStates(session));
	}

	/**
	 * Pushes the session's IDE-owned MCP servers to the serve process. No-op
	 * while no process is running (the set is re-pushed on `serve:ready`) and
	 * until the IDE has synced its set: an authoritative empty push would
	 * disconnect the servers the runtime loaded from the user's config.
	 * Pushes are serialized per session so overlapping syncs cannot apply a
	 * stale set after a newer one.
	 */
	private async _pushMcpServers(session: CliTsSession, forceNames: readonly string[] = []): Promise<void> {
		const previous = session.mcpPush ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			const proc = session.proc;
			if (!proc?.isRunning || session.disposed || !session.mcpServers) {
				return;
			}
			const servers: Record<string, CliTsMcpServerEntry> = {};
			for (const [name, entry] of Object.entries(session.mcpServers)) {
				servers[name] = session.mcpDisabled?.has(name) ? { ...entry, disabled: true } : entry;
			}
			try {
				const record = await proc.request({
					op: 'setMcpServers',
					requestId: proc.nextRequestId(),
					servers,
					...(forceNames.length > 0 ? { force: [...forceNames] } : {}),
					...(session.mcpStatusEvents ? { authoritative: true } : {}),
				});
				const payload = record.payload as CliTsMcpListPayload | undefined;
				this._applyMcpStatuses(session, payload?.servers ?? [], { snapshot: true, pushed: servers });
				this._reportMcpWarnings(session, payload?.warnings);
			} catch (error) {
				this._logService.warn(`[cli-ts] Failed to push MCP servers to session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				// Surface the failure in the composer instead of leaving the
				// servers stuck in "starting".
				this._applyMcpStatuses(session, Object.keys(servers).map(name => ({
					name,
					status: 'error' as const,
					message: error instanceof Error ? error.message : String(error),
				})));
			}
		});
		session.mcpPush = next;
		await next;
	}

	/**
	 * Runs the runtime's interactive OAuth sign-in for one server (the system
	 * browser opens on the provider's consent page) and publishes the result.
	 */
	private async _authenticateMcpServer(session: CliTsSession, name: string): Promise<void> {
		const proc = session.proc;
		if (!proc?.isRunning || session.disposed) {
			return;
		}
		if (!session.mcpStatusEvents) {
			// Older runtimes cannot sign in from the IDE; a forced reconnect is
			// the best we can do.
			await this._pushMcpServers(session, [name]);
			return;
		}
		this._getOrCreateMcpController(session).applyOne({ name, state: { kind: McpServerStatus.Starting } });
		try {
			const record = await proc.request({ op: 'authenticateMcpServer', requestId: proc.nextRequestId(), name });
			const payload = record.payload as CliTsMcpListPayload | undefined;
			this._applyMcpStatuses(session, payload?.servers ?? [], { snapshot: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._logService.warn(`[cli-ts] MCP sign-in for '${name}' failed in session ${session.sessionId}: ${message}`);
			this._applyMcpStatuses(session, [{ name, status: 'needs_authentication', message }]);
		}
	}

	/**
	 * Publishes the runtime's server states as session customizations. A
	 * `snapshot` lists every server the runtime knows, so servers missing from
	 * it are gone; an IDE server missing from the reply to its own push was
	 * rejected by the runtime (for example an unusable configuration).
	 */
	private _applyMcpStatuses(session: CliTsSession, statuses: readonly CliTsMcpServerStatus[], options: { readonly snapshot?: boolean; readonly pushed?: Readonly<Record<string, CliTsMcpServerEntry>> } = {}): void {
		if (session.disposed || (!options.snapshot && statuses.length === 0)) {
			return;
		}
		const states = options.snapshot || !session.mcpRuntimeStates
			? new Map<string, McpServerState>()
			: session.mcpRuntimeStates;
		for (const status of statuses) {
			states.set(status.name, mcpServerStateFromRuntime(status));
		}
		if (options.pushed && session.mcpStatusEvents) {
			for (const [name, entry] of Object.entries(options.pushed)) {
				if (!entry.disabled && !states.has(name)) {
					states.set(name, {
						kind: McpServerStatus.Error,
						error: { errorType: 'mcp-server-failed', message: localize('cliTsAgent.mcpRejected', "The Backboard runtime could not use this server's configuration.") },
					});
				}
			}
		}
		session.mcpRuntimeStates = states;
		this._publishMcpServers(session);
	}

	private _reportMcpWarnings(session: CliTsSession, warnings: readonly string[] | undefined): void {
		for (const warning of warnings ?? []) {
			this._logService.warn(`[cli-ts] MCP (session ${session.sessionId}): ${warning}`);
		}
	}

	/**
	 * Reads the MCP servers out of the plugin directories the client synced,
	 * i.e. the servers the IDE offers this session.
	 */
	private async _extractSyncedMcpServers(synced: readonly ISyncedCustomization[]): Promise<Record<string, CliTsMcpServerEntry>> {
		const servers: Record<string, CliTsMcpServerEntry> = {};
		for (const item of synced) {
			if (!item.pluginDir) {
				continue;
			}
			try {
				const parsed = await parsePlugin(item.pluginDir, this._fileService, undefined, os.homedir());
				for (const server of parsed.mcpServers) {
					const entry = mcpEntryFromConfiguration(server.configuration);
					if (entry) {
						servers[server.name] = entry;
					}
				}
			} catch (error) {
				this._logService.warn(`[cli-ts] Failed to read MCP servers from synced customization '${item.pluginDir.toString()}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return servers;
	}

	private async _requestWorkerLifecycle(session: CliTsSession, op: 'archiveWorkers' | 'unarchiveWorkers' | 'deleteWorkers'): Promise<void> {
		let proc = session.proc;
		try {
			if (!proc?.isRunning && !fs.existsSync(path.join(this._runtimeSessionsRoot(), session.sessionId, 'workers.json'))) {
				// cli-ts writes workers.json on the first worker mutation, so without
				// it every lifecycle op is a no-op. Skip the spawn: discarding or
				// GC-ing an empty draft otherwise boots a full serve process (and its
				// workspace scan) that competes with the user's next first send.
				return;
			}
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
		this._models.set(withChatGptSubscriptionConnectionState(this._models.get(), hasUsableChatGptSubscriptionLogin()), undefined);
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
		const models = (payload?.models ?? []).filter(isBridgeModel);
		if (models.length) {
			// A key-billed row the IDE did not push means the runtime read a key
			// from somewhere else; that must never happen in a host-managed runtime.
			const unexpected = models.filter(model => model.source === 'byok' && !(isByokProviderId(model.provider) && this._providerKeys.has(model.provider)));
			if (unexpected.length) {
				this._logService.warn(`[cli-ts] runtime listed ${unexpected.length} key-billed models without a host-provided key (${[...new Set(unexpected.map(model => model.provider))].join(', ')}); ignoring them`);
			}
			// The Backboard API is authoritative for catalog providers; key-billed
			// rows come from the host's own discovery, and the subscription
			// routes are supplemented locally.
			this._lastServeModels = models.filter(model => model.source !== 'byok');
			this._publishModels();
			// Persist for instant hydration on the next window start.
			this._persistModelsCache();
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
				} else {
					// A worker that could not finish hands its task back to the
					// coordinator: its chat ends with a calm note, never an error.
					if (status === 'failed') {
						this._fireFailureNote(session, child.turn.turnId, storedTurn.error!, toolCallId);
					}
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
						? { ...part, worker, workspace: workspaceFromWorker(worker), ...(status ? { failed: status === 'cancelled' } : {}) } : part) };
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
				// Content changes replace the tool's `_meta`; keep AgentSpawn's detached flag.
				...cliTsToolMetadata(cliTsLauncherToolName('Agent', turn.toolInputs.get(toolCallId)?.name), turn.toolInputs.get(toolCallId)?.input),
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
					_meta: cliTsToolMetadata(cliTsLauncherToolName(event.name, turn.toolInputs.get(event.toolCallId)?.name), turn.toolInputs.get(event.toolCallId)?.input, toolUiByCall?.get(event.toolCallId)?.kind, cliTsMutationBatches(turn).get(event.toolCallId)),
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
				const launcherName = cliTsLauncherToolName(name, turn.toolInputs.get(toolCallId)?.name);
				const detachedSubagent = isCliTsDetachedSubagentTool(launcherName);
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
							...(child ? cliTsToolMetadata(launcherName, turn.toolInputs.get(toolCallId)?.input) : {}),
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
					const videoApproval = spec.header === 'Edit Video'
						|| spec.header === 'Duration'
						|| spec.header === 'Quality'
						|| spec.header === 'Native Audio';
					return spec.options.length
						? {
							id,
							title: spec.header,
							kind: ChatInputQuestionKind.SingleSelect,
							message: spec.question,
							required: true,
							options: spec.options.map(option => ({ id: option, label: option })),
							allowFreeformInput: !videoApproval,
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
				if (parentToolCallId) {
					// A child's failure is finalized (with its note) when the child
					// ends; see _completeSubagentTurn.
					return;
				}
				turn.failed = true;
				// An actionable failure (no credit left) says what to do; any
				// other failure keeps the calm generic note.
				turn.error = { errorType: event.actionable ? 'BackboardSendFailed' : 'BackboardError', message: event.error?.trim() ? event.error : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
				this._fireFailureNote(session, turnId, turn.error);
				return;
			}
			default:
				return;
		}
	}

	/**
	 * A turn that could not finish (after the runtime's own silent retries and
	 * model fallbacks) ends with a calm note instead of an error banner. The
	 * note is derived from the stored error, so a reopened chat shows the same.
	 */
	private _fireFailureNote(session: CliTsSession, turnId: string, error: CliTsTurnError, parentToolCallId?: string): void {
		this._fire(session.sessionUri, {
			type: ActionType.ChatResponsePart,
			turnId,
			part: { kind: ResponsePartKind.Markdown, id: generateUuid(), content: cliTsFailureNote(error) },
		}, parentToolCallId);
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
			_meta: cliTsToolMetadata(cliTsLauncherToolName(toolName, turn.toolInputs.get(toolCallId)?.name), turn.toolInputs.get(toolCallId)?.input, (turn as { readonly toolUi?: Map<string, CliTsToolUiState> }).toolUi?.get(toolCallId)?.kind, cliTsMutationBatches(turn).get(toolCallId)),
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

	/**
	 * Every stored session, freshly parsed from disk. Passing `onlyId` returns
	 * just that session (or nothing), parsed from the cached entries instead of
	 * the whole file.
	 */
	private _readStore(onlyId?: string): CliTsStoredSession[] {
		if (onlyId !== undefined) {
			const entry = this._loadStoreEntries().get(onlyId);
			return entry === undefined ? [] : [JSON.parse(entry) as CliTsStoredSession];
		}
		return readStoredSessions(this._storePath());
	}

	/** The store's serialized entries, re-read only when the file changed since. */
	private _loadStoreEntries(): ReadonlyMap<string, string> {
		const storePath = this._storePath();
		const stamp = storeFileStamp(storePath);
		if (this._storeEntries?.stamp === stamp) {
			return this._storeEntries.entries;
		}
		const entries = new Map<string, string>();
		for (const session of readStoredSessions(storePath)) {
			if (!entries.has(session.id)) {
				entries.set(session.id, serializeStoredSession(session));
			}
		}
		this._storeEntries = { stamp, entries };
		return entries;
	}

	private _writeStore(excludedSessionId?: string, strict = false): void {
		try {
			const current = this._loadStoreEntries();
			const next = new Map<string, string>();
			for (const session of this._sessions.values()) {
				if ((session.materialized || session.storedTurns.length > 0 || !!session.turn) && session.sessionId !== excludedSessionId) {
					next.set(session.sessionId, serializeStoredSession(storedSessionOf(session)));
				}
			}
			for (const [id, entry] of current) {
				if (id !== excludedSessionId && !this._sessions.has(id)) {
					next.set(id, entry);
				}
			}
			// The file already says exactly this (a draft that was never sent,
			// a model switch before the first turn): skip the rewrite.
			if (sameStoreEntries(current, next)) {
				return;
			}
			const storePath = this._storePath();
			fs.mkdirSync(path.dirname(storePath), { recursive: true });
			fs.writeFileSync(`${storePath}.tmp`, serializeStore([...next.values()]), { encoding: 'utf8', mode: 0o600 });
			fs.renameSync(`${storePath}.tmp`, storePath);
			this._storeEntries = { stamp: storeFileStamp(storePath), entries: next };
		} catch (error) {
			this._logService.warn(`[cli-ts] Failed to persist session store: ${error instanceof Error ? error.message : String(error)}`);
			if (strict) {
				throw error;
			}
		}
	}
}

// ---- helpers -----------------------------------------------------------------

/** Model aliases only the Claude subscription transport reports as a turn's usage model. */
const CLAUDE_SUBSCRIPTION_USAGE_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * The model a stored session last selected. Sessions stored before the store
 * kept `model` fall back to their turns: a turn whose usage names a
 * bare Claude Code alias ran on the Claude subscription. Other routes report
 * full model names that do not reveal how they were billed.
 */
function storedSessionModel(entry: CliTsStoredSession): ModelSelection | undefined {
	if (entry.model) {
		return entry.model;
	}
	for (let index = entry.turns.length - 1; index >= 0; index--) {
		const usageModel = entry.turns[index].usage?.model?.trim().toLowerCase();
		if (usageModel && CLAUDE_SUBSCRIPTION_USAGE_ALIASES.has(usageModel)) {
			return { id: `${CLAUDE_SUBSCRIPTION_PROVIDER}/${usageModel}` };
		}
	}
	return undefined;
}

/** Every session in the store file; a legacy zero-turn chat gets its prompt back as a turn. */
function readStoredSessions(storePath: string): CliTsStoredSession[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(storePath, 'utf8'));
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

/** What the store keeps for a session that is loaded in this process. */
function storedSessionOf(session: CliTsSession): CliTsStoredSession {
	return {
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
		model: session.model ?? session.storedModel,
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
	};
}

/**
 * Identifies one version of the store file. Every write, this window's or
 * another app instance's, replaces the file by rename (a new inode); an edit
 * in place still changes its size or mtime.
 */
function storeFileStamp(storePath: string): string {
	try {
		const stat = fs.statSync(storePath);
		return `${storePath}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
	} catch {
		return `${storePath}\0missing`;
	}
}

/**
 * One entry of the store's `sessions` array, exactly as
 * `JSON.stringify(store, undefined, '\t')` lays it out, so unchanged entries
 * are written back verbatim and the file keeps its format.
 */
function serializeStoredSession(session: CliTsStoredSession): string {
	// JSON strings escape their newlines, so every raw one is layout.
	return JSON.stringify(session, undefined, '\t').replace(/\n/g, '\n\t\t');
}

function serializeStore(entries: readonly string[]): string {
	return entries.length === 0
		? `{\n\t"version": ${CLI_TS_STORE_VERSION},\n\t"sessions": []\n}\n`
		: `{\n\t"version": ${CLI_TS_STORE_VERSION},\n\t"sessions": [\n\t\t${entries.join(',\n\t\t')}\n\t]\n}\n`;
}

/** Same sessions, same order, same content. */
function sameStoreEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	const left = [...a];
	let index = 0;
	for (const [id, entry] of b) {
		const [otherId, otherEntry] = left[index++];
		if (id !== otherId || entry !== otherEntry) {
			return false;
		}
	}
	return true;
}

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
		// The failure note says it was interrupted; see cliTsFailureNote.
		response: turn.responseText,
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

/** Per-field caps for handoff tool records; see projectHandoffToolPart. */
const HANDOFF_TOOL_FIELD_LIMIT = 600;
const HANDOFF_TOOL_OUTPUT_LIMIT = 2_000;

/**
 * A stored tool part carries the raw tool input and the full captured terminal
 * output (up to 80KB per call). Replaying those verbatim made a handoff grow
 * into megabytes, which the next provider pays for on every turn of the resumed
 * chat. Keep what identifies the call and a bounded window of what it produced.
 */
function projectHandoffToolPart(part: Extract<CliTsStoredPart, { kind: 'tool' }>): Record<string, unknown> {
	const detail = part.detail ? clampHandoffText(part.detail, HANDOFF_TOOL_OUTPUT_LIMIT) : undefined;
	// detail is already a head preview of the same stream; only fall back to the
	// raw capture, tail-first, when there is no preview to describe the result.
	const output = detail === undefined && part.terminalOutput?.text
		? clampHandoffText(part.terminalOutput.text, HANDOFF_TOOL_OUTPUT_LIMIT, 'tail')
		: undefined;
	return {
		name: part.name,
		...(part.inputSummary ? { inputSummary: clampHandoffText(part.inputSummary, HANDOFF_TOOL_FIELD_LIMIT) } : {}),
		...(part.terminalCommand ? { terminalCommand: clampHandoffText(part.terminalCommand, HANDOFF_TOOL_FIELD_LIMIT) } : {}),
		...(part.agentName ? { agentName: part.agentName } : {}),
		...(part.title ? { title: clampHandoffText(part.title, HANDOFF_TOOL_FIELD_LIMIT) } : {}),
		...(detail !== undefined ? { detail } : {}),
		...(output !== undefined ? { output } : {}),
		...(part.terminalOutput?.exitCode !== undefined ? { exitCode: part.terminalOutput.exitCode } : {}),
		...(part.terminalOutput?.timedOut ? { timedOut: true } : {}),
		...(part.failed ? { failed: true } : {}),
	};
}

function clampHandoffText(value: string, limit: number, keep: 'head' | 'tail' = 'head'): string {
	if (value.length <= limit) {
		return value;
	}
	const omitted = value.length - limit;
	return keep === 'head'
		? `${value.slice(0, limit)}\n[+${omitted} characters omitted]`
		: `[${omitted} characters omitted]\n${value.slice(value.length - limit)}`;
}

export function buildConversationHandoffContext(turns: readonly CliTsStoredTurn[], reason: string): string {
	const transcript = turns.map(turn => {
		const tools = turn.parts
			?.filter((part): part is Extract<CliTsStoredPart, { kind: 'tool' }> => part.kind === 'tool')
			.map(projectHandoffToolPart);
		return {
			user: turn.prompt,
			attachments: turn.attachments,
			assistant: turn.response,
			...(tools?.length ? { tools } : {}),
			...(turn.failed ? { responseFailed: true } : {}),
		};
	});
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
				error = { errorType: event.actionable ? 'BackboardSendFailed' : 'BackboardError', message: event.error?.trim() ? event.error : localize('cliTsAgent.requestFailed', "Backboard request failed.") };
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

/**
 * Lifecycle events name a launcher by its display name, and cli-ts displays
 * both the blocking Agent and the detached AgentSpawn as `Subagent`. Only the
 * provider call recorded from `tool:requested` (e.g. `agent_spawn`) says which
 * one ran, so detached semantics must be resolved from that name.
 */
function cliTsLauncherToolName(eventName: string, requestedName: string | undefined): string {
	return requestedName && isCliTsSubagentLauncherTool(eventName) && isCliTsDetachedSubagentTool(requestedName) ? requestedName : eventName;
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
	'generateVideo',
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

const LOCAL_MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

/** Larger clips stay path-only: the whole file crosses stdin as one base64 JSON line. */
const LOCAL_MEDIA_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Longest reference clip the hosted video models accepted in live tests
 * (2026-10-02): 5s and 10s 720p clips worked on Hailuo 3 / FLUX Video Edit /
 * Aleph 2, while the same footage at 15s or 30s 1080p failed with a bare
 * "Media generation failed".
 */
const VIDEO_REFERENCE_MAX_SECONDS = 10;

/** Reads an MP4/MOV's length from its `mvhd` box, or undefined when it has none. */
function mp4DurationSeconds(data: Uint8Array): number | undefined {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let index = 4; index + 32 <= data.length; index++) {
		// 'mvhd'
		if (data[index] !== 0x6d || data[index + 1] !== 0x76 || data[index + 2] !== 0x68 || data[index + 3] !== 0x64) {
			continue;
		}
		const version = data[index + 4];
		const timescale = view.getUint32(index + (version === 1 ? 24 : 16));
		const duration = version === 1
			? Number(view.getBigUint64(index + 28))
			: view.getUint32(index + 20);
		return timescale ? duration / timescale : undefined;
	}
	return undefined;
}

/**
 * The clip to upload for a hosted video model: on macOS, longer or larger clips
 * are re-encoded with the built-in `avconvert` to their first
 * {@link VIDEO_REFERENCE_MAX_SECONDS} seconds at no more than 720p, since the
 * models reject longer references. Elsewhere, or when conversion fails, the
 * original goes as is.
 */
async function videoReference(filePath: string, data: Buffer, logService: ILogService): Promise<{ readonly data: Buffer; readonly trimmedFrom?: number }> {
	if (process.platform !== 'darwin') {
		return { data };
	}
	const seconds = mp4DurationSeconds(data);
	const output = path.join(os.tmpdir(), `backboard-video-reference-${createHash('sha256').update(data).digest('hex').slice(0, 16)}.mp4`);
	try {
		await runTool('/usr/bin/avconvert', [
			'--source', filePath, '--output', output, '--preset', 'Preset1280x720', '--replace',
			'--duration', String(VIDEO_REFERENCE_MAX_SECONDS),
		]);
		const converted = await fs.promises.readFile(output);
		return {
			data: converted,
			trimmedFrom: seconds !== undefined && seconds > VIDEO_REFERENCE_MAX_SECONDS + 0.5 ? seconds : undefined,
		};
	} catch (error) {
		logService.info(`[cli-ts] Could not prepare video reference ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return { data };
	} finally {
		fs.promises.rm(output, { force: true }).catch(() => undefined);
	}
}

/**
 * Reference photos smaller than this on their short edge are scaled up before
 * upload: a 200x200 face photo made Hailuo 3 fail with a bare "Media
 * generation failed" (2026-10-03), and the same photo at 600x600 worked.
 */
const IMAGE_REFERENCE_MIN_EDGE = 400;
const IMAGE_REFERENCE_TARGET_EDGE = 600;

/** Runs a macOS command-line tool, resolving with its stdout. */
function runTool(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => cp.execFile(command, args, { timeout: 120_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/**
 * The photo to upload for a hosted video model: on macOS, one whose short edge
 * is under {@link IMAGE_REFERENCE_MIN_EDGE} pixels is scaled up with the
 * built-in `sips` (as a PNG). Larger photos, GIFs, other platforms, and failed
 * conversions keep the original.
 */
async function imageReference(filePath: string, data: Buffer, mimeType: string, logService: ILogService): Promise<{ readonly data: Buffer; readonly mimeType: string }> {
	if (process.platform !== 'darwin' || mimeType === 'image/gif') {
		return { data, mimeType };
	}
	const output = path.join(os.tmpdir(), `backboard-image-reference-${createHash('sha256').update(data).digest('hex').slice(0, 16)}.png`);
	try {
		const info = await runTool('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
		const width = Number(/pixelWidth: (?<value>\d+)/.exec(info)?.groups?.value);
		const height = Number(/pixelHeight: (?<value>\d+)/.exec(info)?.groups?.value);
		if (!width || !height || Math.min(width, height) >= IMAGE_REFERENCE_MIN_EDGE) {
			return { data, mimeType };
		}
		const longest = Math.ceil(Math.max(width, height) * IMAGE_REFERENCE_TARGET_EDGE / Math.min(width, height));
		await runTool('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(longest), filePath, '--out', output]);
		return { data: await fs.promises.readFile(output), mimeType: 'image/png' };
	} catch (error) {
		logService.info(`[cli-ts] Could not prepare image reference ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return { data, mimeType };
	} finally {
		fs.promises.rm(output, { force: true }).catch(() => undefined);
	}
}

/**
 * Adds the bytes of images and videos attached by path, for turns whose hosted
 * media tools take their inputs from the message's files. Files that are
 * missing, too large or not media keep only their path mention. Clips are
 * trimmed and scaled to what the video models accept, and the prompt says so.
 */
export async function addLocalMediaFiles(prepared: PreparedSubmitAttachments, attachments: readonly MessageAttachment[] | undefined, logService: ILogService): Promise<string | undefined> {
	const trimmed: string[] = [];
	for (const attachment of attachments ?? []) {
		if (attachment.type !== MessageAttachmentKind.Resource) {
			continue;
		}
		let uri: URI;
		try {
			uri = URI.parse(attachment.uri);
		} catch {
			continue;
		}
		const mimeType = LOCAL_MEDIA_MIME_TYPES[path.extname(uri.path).toLowerCase()];
		if (uri.scheme !== 'file' || !mimeType) {
			continue;
		}
		try {
			const stat = await fs.promises.stat(uri.fsPath);
			if (!stat.isFile() || stat.size > LOCAL_MEDIA_MAX_BYTES) {
				continue;
			}
			const data = await fs.promises.readFile(uri.fsPath);
			if (mimeType.startsWith('video/')) {
				const reference = await videoReference(uri.fsPath, data, logService);
				if (reference.trimmedFrom !== undefined) {
					trimmed.push(`${path.basename(uri.fsPath)} (${Math.round(reference.trimmedFrom)}s)`);
				}
				const fileName = reference.data === data ? path.basename(uri.fsPath) : `${path.parse(uri.fsPath).name}.mp4`;
				prepared.files.push({ fileName, mimeType: reference.data === data ? mimeType : 'video/mp4', dataBase64: reference.data.toString('base64') });
				continue;
			}
			const image = await imageReference(uri.fsPath, data, mimeType, logService);
			const fileName = image.data === data ? path.basename(uri.fsPath) : `${path.parse(uri.fsPath).name}.png`;
			prepared.files.push({ fileName, mimeType: image.mimeType, dataBase64: image.data.toString('base64') });
		} catch (error) {
			logService.info(`[cli-ts] Could not attach media ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return trimmed.length
		? `Uploaded clips were cut to their first ${VIDEO_REFERENCE_MAX_SECONDS} seconds at 720p, the longest reference the video models accept: ${trimmed.join(', ')}. Tell the user the edit covers only that part.`
		: undefined;
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
					// A clip is binary: reading it only floods the context. With a video
					// model on it travels with the message as bytes (addLocalMediaFiles).
					parts.push(LOCAL_MEDIA_MIME_TYPES[path.extname(uri.path).toLowerCase()]?.startsWith('video/')
						? `Attached video (a binary clip; do not open it with Read): ${uri.fsPath}`
						: `Attached file (read it with the Read tool): ${uri.fsPath}`);
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

/**
 * The note shown where a turn stopped early. Host-side problems (sign-in, a
 * missing key) carry a message the user can act on; runtime failures have
 * already been retried silently, so they only invite the user to continue.
 */
function cliTsFailureNote(error: CliTsTurnError | undefined): string {
	const quickFix = error ? cliTsConnectQuickFix(error.message) : undefined;
	if (quickFix) {
		return quickFix;
	}
	if (error?.errorType === 'BackboardSubagentFailed') {
		return localize('cliTsAgent.note.subagent', "_This subagent stopped early and handed its task back to the main agent._");
	}
	if (error?.errorType === 'BackboardInterrupted') {
		return localize('cliTsAgent.note.interrupted', "_Backboard closed before this response finished. Send a message to continue from here._");
	}
	if (error?.errorType === 'BackboardSendFailed' && error.message.trim() && error.message !== localize('cliTsAgent.turnFailed', "The Backboard agent reported a failed turn.") && error.message !== localize('cliTsAgent.requestFailed', "Backboard request failed.")) {
		return localize('cliTsAgent.note.actionable', "_This response couldn't start: {0}_", error.message.trim());
	}
	return localize('cliTsAgent.note.stopped', "_This response stopped before it finished. Send a message to continue from here._");
}

/**
 * A turn that could not be routed because the account it bills to is not
 * connected gets a plain sentence and one link that connects it, instead of
 * the runtime's routing error. The chat renders these few command links as
 * trusted (see `rawMarkdownToString`).
 */
function cliTsConnectQuickFix(message: string): string | undefined {
	const command = (id: string, args?: readonly string[]) => `command:${id}${args ? `?${encodeURIComponent(JSON.stringify(args))}` : ''}`;
	if (/can serve anthropic-subscription\//.test(message)) {
		return localize('cliTsAgent.quickFix.claude', "_Claude isn't connected right now._ [Reconnect Claude]({0})", command('backboard.setupSubscription', ['backboard.claudeSubscription']));
	}
	if (/can serve openai-subscription\//.test(message)) {
		return localize('cliTsAgent.quickFix.chatGpt', "_ChatGPT isn't connected right now._ [Reconnect ChatGPT]({0})", command('backboard.setupSubscription', ['backboard']));
	}
	if (/No API key is configured for|No API key backend can serve/.test(message)) {
		return localize('cliTsAgent.quickFix.key', "_This model needs an API key that isn't set up._ [Add API Key]({0})", command('backboard.openApiKeys'));
	}
	if (/No backend can serve/.test(message)) {
		return localize('cliTsAgent.quickFix.backboard', "_This model needs a Backboard sign-in._ [Sign In]({0})", command('backboard.signIn'));
	}
	return undefined;
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
		responseParts: turn.failed
			? [...responseParts, { kind: ResponsePartKind.Markdown, id: `${sessionId}-${index}-note`, content: cliTsFailureNote(turn.error) }]
			: responseParts,
		usage: turn.usage,
		// A failed turn renders as finished with a calm note, never an error banner.
		state: TurnState.Complete,
	};
}
