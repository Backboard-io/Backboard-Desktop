import type { ToolResultDetailLine } from "./ToolResultDetail.ts";

/**
 * The before/after content of a file that a tool edited, surfaced so hosts
 * (the Backboard IDE) can render an inline diff. The tool provides these
 * because it holds the pre-edit content in memory; a host observing tool
 * events cannot snapshot "before" reliably, since the edit has already been
 * written to disk by the time the event is delivered.
 */
export interface FileEditPreview {
	path: string;
	before: string;
	after: string;
}

/**
 * The outcome of a tool execution.
 * - `data` is the structured result used for UI rendering.
 * - `forLLM` is the string submitted back to Backboard as the tool output.
 * - `title` is a short one-line summary for the transcript.
 */
export interface ToolResult<O = unknown> {
	data: O;
	forLLM: string;
	title: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	/** Set by file-edit tools so hosts can render before/after diffs. */
	fileEdits?: FileEditPreview[];
}

export function ok<O>(
	data: O,
	forLLM: string,
	title: string,
	detail?: string,
	detailLines?: ToolResultDetailLine[],
): ToolResult<O> {
	return {
		data,
		forLLM,
		title,
		...(detail ? { detail } : {}),
		...(detailLines ? { detailLines } : {}),
	};
}
