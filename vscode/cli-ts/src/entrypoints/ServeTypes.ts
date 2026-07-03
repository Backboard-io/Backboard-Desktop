import type { PermissionPolicy } from "../core/tools/ToolPermissionGateTypes.ts";

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
			model?: string;
			thinking?: string;
			excludedTools?: string[];
			permission?: PermissionPolicy;
			memory?: string;
			skills?: string[];
			files?: ServeFileAttachment[];
	  }
	| { op: "steer"; requestId?: string; prompt: string }
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
