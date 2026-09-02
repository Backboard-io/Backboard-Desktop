import type { ToolResultDetailLine } from "./ToolResultDetail.ts";

/** Before/after text retained so Backboard Studio can render inline diffs. */
export interface FileEditPreview {
	path: string;
	before: string;
	after: string;
}

/** Full terminal transcript retained for rich IDE rendering. */
export interface TerminalToolResult {
	text: string;
	exitCode?: number;
	timedOut?: boolean;
	truncated?: boolean;
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
	fileEdits?: FileEditPreview[];
	terminalOutput?: TerminalToolResult;
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
