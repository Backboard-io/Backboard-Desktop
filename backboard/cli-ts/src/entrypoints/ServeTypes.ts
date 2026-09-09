import type { PermissionMode } from "../core/permissions/PermissionMode.ts";
import type {
	ClientToolDefinition,
	ClientToolResultPayload,
} from "../core/tools/ClientToolBridge.ts";

/** A binary attachment sent by the IDE and staged for the public R-CLI. */
export interface ServeFileAttachment {
	fileName: string;
	mimeType?: string;
	dataBase64: string;
}

/**
 * One control operation sent by Backboard Studio as one NDJSON line.
 *
 * This transport is the only IDE-specific surface layered on top of the
 * public Backboard R-CLI. The agent loop, tools, permissions, providers,
 * checkpoints, MCP, skills, and session state all remain owned by R-CLI.
 */
export type ServeControl =
	| {
			op: "submit";
			requestId: string;
			prompt: string;
			turnId?: string;
			/** Existing provider thread to resume after an IDE/process restart. */
			threadId?: string;
			/** Prior turns to seed into the first request of a newly forked thread. */
			forkContext?: string;
			/** Hidden host guidance appended to this turn's system prompt. */
			systemContext?: string;
			model?: string;
			thinking?: string;
			excludedTools?: string[];
			permission?: PermissionMode;
			memory?: string;
			skills?: string[];
			files?: ServeFileAttachment[];
			computerUse?: boolean;
			browserUse?: boolean;
			notify?: boolean;
			/** Enables Backboard's built-in image generation for the turn. */
			imageGeneration?: boolean;
			/** Pins an OpenRouter upstream; absent uses automatic routing. */
			openRouterProvider?: string;
			/**
			 * Tools the IDE client executes on the CLI's behalf (integrated
			 * browser, tasks, tests, …). Sent on every turn; an empty/absent
			 * list clears previously registered client tools.
			 */
			clientTools?: ClientToolDefinition[];
	  }
	| { op: "steer"; requestId?: string; prompt: string; systemContext?: string }
	| { op: "warmup"; requestId?: string }
	| { op: "cancel"; requestId?: string }
	| { op: "respondInput"; id: string; answers: string[] }
	| {
			/** The IDE's answer to a `client_tool:call` event. */
			op: "clientToolResult";
			id: string;
			result?: ClientToolResultPayload;
			error?: string;
	  }
	| { op: "setModel"; requestId?: string; model: string }
	| { op: "listModels"; requestId: string }
	| { op: "listTools"; requestId: string }
	| { op: "listSkills"; requestId: string }
	| { op: "archiveWorkers"; requestId: string }
	| { op: "unarchiveWorkers"; requestId: string }
	| { op: "deleteWorkers"; requestId: string }
	| {
			op: "prepareRewind";
			requestId: string;
			transactionId: string;
			turnIds: string[];
			baseCheckpointId?: string;
	  }
	| {
			op: "commitRewind";
			requestId: string;
			transactionId: string;
			buffers: import("../core/checkpoints/EditorRewind.ts").RewindBuffer[];
	  }
	| { op: "recoverRewind"; requestId: string; transactionId: string }
	| { op: "dispose" };

export type ServeRecordType =
	| "serve:rewind"
	| "serve:ready"
	| "serve:turn"
	| "serve:models"
	| "serve:tools"
	| "serve:skills"
	| "serve:warm"
	| "serve:ack"
	| "serve:error";

/** A control response interleaved with R-CLI client events on stdout. */
export interface ServeRecord {
	timestamp: string;
	session_id: string;
	source: "serve";
	type: ServeRecordType;
	requestId?: string;
	payload?: unknown;
}
