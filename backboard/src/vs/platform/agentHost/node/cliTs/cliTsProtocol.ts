/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire types for the cli-ts serve protocol.
 *
 * The IDE spawns `backboard-cli-ts --serve` (one process per session) and
 * exchanges newline-delimited JSON with it: control operations on stdin,
 * event/response records on stdout. These types mirror
 * `cli-ts/src/entrypoints/ServeTypes.ts` and `cli-ts/src/core/bus/events.ts`
 * — keep the two sides in sync.
 */

/** Permission modes exposed by the public Backboard R-CLI. */
export type CliTsPermissionMode = 'manual' | 'acceptEdits' | 'auto' | 'bypass';

/** Explicit billing route attached to a model selection (mirrors cli-ts `ModelSource`). */
export type CliTsModelSource = 'backboard' | 'byok' | 'subscription';

/**
 * Advertised in the `serve:ready` payload by runtimes that accept host-managed
 * provider keys and explicit billing routes. An older packaged runtime lacks
 * it, and key-billed turns must then fail closed instead of routing elsewhere.
 */
export const CLI_TS_HOST_MANAGED_BYOK_CAPABILITY = 'host-managed-byok-v2';

/** Critical-path phase names emitted by cli-ts for structured performance logs. */
export type CliTsPerformanceTimingPhase =
	| 'provider_first_event'
	| 'provider_first_visible'
	| 'provider_stream_total'
	| 'provider_tool_announcement'
	| 'provider_tool_batch_finalize'
	| 'permission_wait'
	| 'mutation_prepare'
	| 'checkpoint_pre_flush'
	| 'filesystem_commit'
	| 'checkpoint_post_flush'
	| 'diagnostics'
	| 'worker_queued'
	| 'worktree_ready'
	| 'worker_model'
	| 'result_capture'
	| 'integration'
	| 'ui_event_projection';

/** A binary attachment sent with a submit op; serve persists it and points the agent at it. */
export interface CliTsFileAttachment {
	readonly fileName: string;
	readonly mimeType?: string;
	readonly dataBase64: string;
}

/** One IDE-executed tool advertised to the cli-ts model for a turn. */
export interface CliTsClientToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
}

/** One content part of a client tool result sent back to cli-ts. */
export type CliTsClientToolResultContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly mimeType: string; readonly dataBase64: string }
	| { readonly type: 'resource'; readonly mimeType?: string; readonly dataBase64: string };

/** The result payload of a `clientToolResult` op. */
export interface CliTsClientToolResultPayload {
	readonly success?: boolean;
	readonly content?: readonly CliTsClientToolResultContent[];
	readonly error?: string;
}

/** One control operation, written to the serve process's stdin as one JSON line. */
export type CliTsServeControl =
	| {
		readonly op: 'submit';
		readonly requestId: string;
		readonly prompt: string;
		readonly turnId?: string;
		/**
		 * Backend thread to resume, from the persisted session. Lets a fresh
		 * serve process continue the conversation instead of starting a new
		 * thread with no memory of prior turns.
		 */
		readonly threadId?: string;
		/** Prior turns for the first request of a newly forked backend thread. */
		readonly forkContext?: string;
		/** Hidden per-turn guidance appended to the runtime system prompt. */
		readonly systemContext?: string;
		readonly model?: string;
		/** Billing route for `model`; a host-managed runtime requires it whenever `model` is sent. */
		readonly source?: CliTsModelSource;
		readonly thinking?: string;
		readonly excludedTools?: readonly string[];
		readonly permission?: CliTsPermissionMode;
		readonly memory?: string;
		readonly skills?: readonly string[];
		readonly files?: readonly CliTsFileAttachment[];
		/** Enables cli-ts computer-use tools for this turn (default off). */
		readonly computerUse?: boolean;
		/** Enables the cli-ts browser-use tool for this turn (default off). */
		readonly browserUse?: boolean;
		/** Enables turn-completion notifications for this turn (default off). */
		readonly notify?: boolean;
		/** Enables Backboard's built-in image tool for this turn. */
		readonly imageGeneration?: boolean;
		/** Pins an OpenRouter upstream; absent uses automatic routing. */
		readonly openRouterProvider?: string;
		/** IDE-executed tools advertised to the model; absent clears them. */
		readonly clientTools?: readonly CliTsClientToolDefinition[];
	}
	| { readonly op: 'steer'; readonly requestId?: string; readonly prompt: string; readonly systemContext?: string }
	| { readonly op: 'waitForIdle'; readonly requestId: string }
	| { readonly op: 'warmup'; readonly requestId?: string }
	| { readonly op: 'cancel'; readonly requestId?: string }
	| { readonly op: 'respondInput'; readonly id: string; readonly answers: readonly string[] }
	| { readonly op: 'clientToolResult'; readonly id: string; readonly result?: CliTsClientToolResultPayload; readonly error?: string }
	| { readonly op: 'setModel'; readonly requestId?: string; readonly model: string; readonly source?: CliTsModelSource }
	| {
		/**
		 * The host's complete provider-key snapshot; an absent provider is a
		 * removal. Written first after every spawn and again on every change.
		 */
		readonly op: 'setCredentials';
		readonly requestId?: string;
		readonly revision: number;
		readonly providerKeys: readonly { readonly provider: string; readonly key: string }[];
	}
	| { readonly op: 'listModels'; readonly requestId: string }
	| { readonly op: 'listTools'; readonly requestId: string }
	| { readonly op: 'listSkills'; readonly requestId: string }
	| { readonly op: 'archiveWorkers'; readonly requestId: string }
	| { readonly op: 'unarchiveWorkers'; readonly requestId: string }
	| { readonly op: 'deleteWorkers'; readonly requestId: string }
	| { readonly op: 'prepareRewind'; readonly requestId: string; readonly transactionId: string; readonly turnIds: readonly string[]; readonly baseCheckpointId?: string }
	| { readonly op: 'commitRewind'; readonly requestId: string; readonly transactionId: string; readonly buffers: readonly import('../../common/agentRewind.js').IAgentRewindBuffer[] }
	| { readonly op: 'recoverRewind'; readonly requestId: string; readonly transactionId: string }
	| { readonly op: 'dispose' };

/**
 * One stdout record. `source: 'client'` records carry an agent event in
 * `payload` (the cli-ts `JsonEventStream` shape); `source: 'serve'` records
 * are control responses correlated by `requestId`.
 */
export interface CliTsRecord {
	readonly timestamp: string;
	readonly session_id: string;
	readonly sequence?: number;
	readonly source: 'client' | 'serve';
	readonly type: string;
	readonly requestId?: string;
	readonly payload?: unknown;
}

/** Turn status reported by `serve:turn` and `turn:end`. */
export type CliTsTurnStatus = 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled';

/**
 * The subset of cli-ts `AgentEvent` payload fields the IDE consumes. All
 * fields are optional because the payload shape varies per event `type`;
 * consumers must check the fields they need.
 */
export interface CliTsAgentEvent {
	readonly type: string;
	readonly sessionId?: string;
	readonly threadId?: string | null;
	readonly text?: string;
	/** Coarse pre-content turn phase, carried by `turn:status` events. */
	readonly phase?: 'preparing' | 'generating' | CliTsPerformanceTimingPhase;
	readonly turnId?: string;
	readonly messageId?: string;
	readonly toolCallId?: string;
	readonly name?: string;
	/** Structured tool input, carried by `client_tool:call` events. */
	readonly input?: unknown;
	readonly inputSummary?: string;
	readonly title?: string;
	readonly detail?: string;
	readonly detailLines?: readonly unknown[];
	/** Bounded, JSON-safe native UI payload emitted only by whitelisted core tools. */
	readonly toolUi?: {
		readonly kind?: unknown;
		readonly input?: unknown;
		readonly result?: unknown;
	};
	/** Typed execution state; tool output prose is never a success/failure signal. */
	readonly execution?: {
		readonly failureCategory?: string;
		readonly exitCode?: number;
		readonly timedOut?: boolean;
		readonly cancelled?: boolean;
		readonly retryable?: boolean;
		readonly validation?: 'passed' | 'failed';
		readonly outcome?: 'success' | 'no_match' | 'partial' | 'failure';
	};
	readonly terminalOutput?: {
		readonly text: string;
		readonly exitCode?: number;
		readonly timedOut?: boolean;
		readonly truncated?: boolean;
	};
	readonly fileEdits?: readonly { readonly path: string; readonly before: string; readonly after: string }[];
	readonly error?: string;
	readonly message?: string;
	readonly status?: CliTsTurnStatus | 'done' | 'error';
	readonly durationMs?: number;
	readonly workerId?: string;
	readonly fileCount?: number;
	readonly calls?: readonly { readonly id: string; readonly name: string; readonly input: unknown }[];
	readonly data?: unknown;
	readonly request?: {
		readonly id: string;
		readonly questions?: readonly { readonly header?: string; readonly question: string; readonly options: readonly string[] }[];
		/** Legacy private-CLI fields retained only for tolerant event decoding. */
		readonly toolCallId?: string;
		readonly name?: string;
		readonly inputSummary?: string;
		readonly question?: string;
		readonly options?: readonly string[];
	};
	readonly response?: { readonly id: string; readonly answers?: readonly string[]; readonly decision?: string; readonly answer?: string };
	readonly usage?: { readonly backboardContextUsage?: { readonly source: 'backboard-api'; readonly usedTokens?: number; readonly contextLimit?: number; readonly percent?: number; readonly summaryTokens?: number; readonly model?: string }; readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly contextTokens?: number; readonly contextLimit?: number; readonly model?: string; readonly provider?: string };
	readonly todos?: readonly unknown[];
	readonly agentToolCallId?: string;
	readonly parentBatchToolCallId?: string;
	readonly worker?: CliTsWorkerState;
	readonly agentName?: string;
	readonly childSessionId?: string;
	readonly prompt?: string;
	readonly event?: CliTsAgentEvent;
	readonly call?: { readonly id: string; readonly name: string; readonly inputSummary: string; readonly status: string };
	readonly childToolCallId?: string;
	readonly count?: number;
	readonly workspace?: {
		readonly workerId: string;
		readonly revision?: number;
		readonly name?: string;
		readonly status: 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled' | 'Integrating' | 'Integrated' | 'Conflict';
		readonly executionStatus?: CliTsWorkerState['executionStatus'];
		readonly integrationStatus?: CliTsWorkerState['integrationStatus'];
		readonly integrationChanges?: readonly CliTsWorkerIntegrationChange[];
		readonly branch?: string;
		readonly worktreePath?: string;
		readonly changedFileCount: number;
		readonly startedAt: string;
		readonly finishedAt?: string;
		readonly integrationResult?: string;
		readonly conflictingFiles?: readonly string[];
	};
}

/** Durable task-manager authority, independent of the worker checkout revision. */
export interface CliTsWorkerState {
	readonly handle: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly parentBatchToolCallId?: string;
	readonly prompt: string;
	readonly name?: string;
	readonly revision: number;
	readonly executionStatus: 'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	readonly integrationStatus: 'not_required' | 'pending' | 'integrating' | 'integrated' | 'conflict' | 'skipped';
	readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	readonly readOnly: boolean;
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly workspace?: CliTsAgentEvent['workspace'];
	readonly error?: string;
	readonly persistenceError?: string;
}

/** Immutable bytes captured on the coordinator inside the integration transaction. */
export interface CliTsWorkerIntegrationSnapshot {
	readonly contentPath: string;
	readonly sha256: string;
	readonly byteLength: number;
	readonly mode: number;
}

export interface CliTsWorkerIntegrationChange {
	readonly filePath: string;
	readonly before?: CliTsWorkerIntegrationSnapshot;
	readonly after?: CliTsWorkerIntegrationSnapshot;
}

/** Payload of a `serve:tools` response. */
export interface CliTsToolListPayload {
	readonly tools?: readonly { readonly name: string; readonly displayName: string }[];
}

/** Payload of a `serve:ready` record. */
export interface CliTsReadyPayload {
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly model?: string;
	/** Protocol features this runtime supports; see {@link CLI_TS_HOST_MANAGED_BYOK_CAPABILITY}. */
	readonly capabilities?: readonly string[];
}

export function isCliTsRecord(value: unknown): value is CliTsRecord {
	return !!value && typeof value === 'object'
		&& typeof (value as CliTsRecord).type === 'string'
		&& ((value as CliTsRecord).source === 'client' || (value as CliTsRecord).source === 'serve');
}
