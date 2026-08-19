import type { PermissionMode } from "../core/permissions/PermissionMode.ts";

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
			/** Existing provider thread to resume after an IDE/process restart. */
			threadId?: string;
			model?: string;
			thinking?: string;
			/** "Show Reasoning" off: ask the provider to omit reasoning traces. */
			excludeReasoning?: boolean;
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
	  }
	| { op: "steer"; requestId?: string; prompt: string }
	| { op: "warmup"; requestId?: string }
	| { op: "cancel"; requestId?: string }
	| { op: "respondInput"; id: string; answers: string[] }
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

/** A control response interleaved with R-CLI client events on stdout. */
export interface ServeRecord {
	timestamp: string;
	session_id: string;
	source: "serve";
	type: ServeRecordType;
	requestId?: string;
	payload?: unknown;
}
