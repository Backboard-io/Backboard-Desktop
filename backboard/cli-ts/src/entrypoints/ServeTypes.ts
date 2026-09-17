import type { ByokProviderId } from "../core/keys/ProviderKeyTypes.ts";
import type { PermissionMode } from "../core/permissions/PermissionMode.ts";
import type {
	ClientToolDefinition,
	ClientToolResultPayload,
} from "../core/tools/ClientToolBridge.ts";
import type { ModelSource } from "../providers/backboard/types.ts";

/**
 * Advertised in the `serve:ready` payload. A host that manages provider keys
 * must see this before it sends credentials or key-billed turns, so an older
 * packaged runtime fails closed instead of silently routing to Backboard.
 */
export const HOST_MANAGED_BYOK_CAPABILITY = "host-managed-byok-v2";

export const SERVE_CAPABILITIES: readonly string[] = [
	HOST_MANAGED_BYOK_CAPABILITY,
];

/** One provider key in a host credential snapshot. */
export interface ServeProviderKey {
	provider: ByokProviderId;
	key: string;
}

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
			/**
			 * Explicit billing route for `model`. Required by a host-managed
			 * runtime whenever `model` is sent; subscription ids keep routing by
			 * their provider id regardless of this value.
			 */
			source?: ModelSource;
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
	| { op: "waitForIdle"; requestId: string }
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
	| { op: "setModel"; requestId?: string; model: string; source?: ModelSource }
	| {
			/**
			 * The host's complete provider-key snapshot: an absent provider is a
			 * removal. Applied synchronously, so it takes effect for every later
			 * line even though handlers otherwise run concurrently.
			 */
			op: "setCredentials";
			requestId?: string;
			revision: number;
			providerKeys: ServeProviderKey[];
	  }
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
