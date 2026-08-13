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

/** A binary attachment sent with a submit op; serve persists it and points the agent at it. */
export interface CliTsFileAttachment {
	readonly fileName: string;
	readonly mimeType?: string;
	readonly dataBase64: string;
}

/** One control operation, written to the serve process's stdin as one JSON line. */
export type CliTsServeControl =
	| {
		readonly op: 'submit';
		readonly requestId: string;
		readonly prompt: string;
		/**
		 * Backend thread to resume, from the persisted session. Lets a fresh
		 * serve process continue the conversation instead of starting a new
		 * thread with no memory of prior turns.
		 */
		readonly threadId?: string;
		readonly model?: string;
		readonly thinking?: string;
		/** Omit provider reasoning traces from responses when supported. */
		readonly excludeReasoning?: boolean;
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
		/** Enables image-generation intent (reserved; inert until backend support). */
		readonly imageGeneration?: boolean;
	}
	| { readonly op: 'steer'; readonly requestId?: string; readonly prompt: string }
	| { readonly op: 'warmup'; readonly requestId?: string }
	| { readonly op: 'cancel'; readonly requestId?: string }
	| { readonly op: 'respondInput'; readonly id: string; readonly answers: readonly string[] }
	| { readonly op: 'setModel'; readonly requestId?: string; readonly model: string }
	| { readonly op: 'listModels'; readonly requestId: string }
	| { readonly op: 'listTools'; readonly requestId: string }
	| { readonly op: 'listSkills'; readonly requestId: string }
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
	readonly phase?: 'preparing' | 'generating';
	readonly turnId?: string;
	readonly messageId?: string;
	readonly toolCallId?: string;
	readonly name?: string;
	readonly inputSummary?: string;
	readonly title?: string;
	readonly detail?: string;
	readonly detailLines?: readonly unknown[];
	readonly fileEdits?: readonly { readonly path: string; readonly before: string; readonly after: string }[];
	readonly error?: string;
	readonly message?: string;
	readonly status?: CliTsTurnStatus | 'done' | 'error';
	readonly durationMs?: number;
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
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly model?: string; readonly provider?: string };
	readonly todos?: readonly unknown[];
	readonly agentToolCallId?: string;
	readonly call?: { readonly id: string; readonly name: string; readonly inputSummary: string; readonly status: string };
	readonly childToolCallId?: string;
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
}

export function isCliTsRecord(value: unknown): value is CliTsRecord {
	return !!value && typeof value === 'object'
		&& typeof (value as CliTsRecord).type === 'string'
		&& ((value as CliTsRecord).source === 'client' || (value as CliTsRecord).source === 'serve');
}
