import type { PermissionPolicy } from "../core/tools/ToolPermissionGateTypes.ts";
import type {
	BackboardAudioFile,
	BackboardVoiceConfig,
} from "../providers/backboard/types.ts";

/**
 * One control operation, sent by the host as a single NDJSON line on stdin.
 * The host is typically the Backboard IDE's agent host, which keeps one serve
 * process per chat session and submits one `submit` op per user message.
 */
export interface ServeFileAttachment {
	fileName: string;
	mimeType?: string;
	dataBase64: string;
}

export type ServeControl =
	| {
			op: "submit";
			requestId: string;
			prompt: string;
			/**
			 * Backend thread to resume. A serve process starts with no thread
			 * binding; without this, a host restart (new process) would begin a
			 * fresh thread and lose all conversation memory even though the host
			 * still shows the old transcript. Adopted only while the session has
			 * no thread yet — an established binding is never clobbered.
			 */
			threadId?: string;
			model?: string;
			thinking?: string;
			/** Omit provider reasoning traces from responses when supported. */
			excludeReasoning?: boolean;
			excludedTools?: string[];
			permission?: PermissionPolicy;
			memory?: string;
			skills?: string[];
			files?: ServeFileAttachment[];
			/** Enables the computer-use tools for this turn (default off). */
			computerUse?: boolean;
			/** Enables the browser-use tool for this turn (default off). */
			browserUse?: boolean;
			/** Enables turn-completion notifications for this turn (default off). */
			notify?: boolean;
			/** Enables image-generation intent (reserved; inert until a tool consumes it). */
			imageGeneration?: boolean;
			/** Per-turn Backboard voice pipeline configuration. */
			voice?: BackboardVoiceConfig;
			/** Base64 audio from the desktop composer; uploaded as audio_file. */
			audioFile?: BackboardAudioFile;
	  }
	| { op: "steer"; requestId?: string; prompt: string }
	| { op: "warmup"; requestId?: string }
	| { op: "cancel"; requestId?: string }
	| { op: "respondInput"; id: string; answer: string }
	| {
			op: "respondPermission";
			id: string;
			decision: "approve" | "deny";
			reason?: string;
	  }
	| { op: "setModel"; requestId?: string; model: string }
	| { op: "listModels"; requestId: string }
	| { op: "listTools"; requestId: string }
	| { op: "listSkills"; requestId: string }
	| { op: "dispose" };

export type ServeRecordType =
	| "serve:ready"
	| "serve:turn"
	| "serve:models"
	| "serve:tools"
	| "serve:skills"
	| "serve:warm"
	| "serve:ack"
	| "serve:error";

/**
 * A serve-mode control response, written to stdout as one JSONL line. These
 * interleave with the `JsonEventStream` agent-event records; hosts tell them
 * apart by `source`.
 */
export interface ServeRecord {
	timestamp: string;
	session_id: string;
	source: "serve";
	type: ServeRecordType;
	requestId?: string;
	payload?: unknown;
}

export interface ServeToolInfo {
	name: string;
	displayName: string;
}
