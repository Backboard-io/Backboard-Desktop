import type { AgentEvent, ToolCallRef } from "../bus/events.ts";
import { requireAgentToolOutput } from "./AgentToolOutputGuard.ts";
import { clampSummary, genericInputSummary } from "./inputSummary.ts";
import type { Tool } from "./Tool.ts";
import type { FileEditPreview, TerminalToolResult } from "./ToolResult.ts";
import type { ToolResultDetailLine } from "./ToolResultDetail.ts";
import { backboardToolUiInput, backboardToolUiResult } from "./ToolUiData.ts";

export function toolStartEvent(
	ref: ToolCallRef,
	input: unknown,
	tool?: Tool,
): AgentEvent {
	const inputSummary = summarizeToolInput(input, tool);
	const name = tool?.displayName ?? ref.name;
	const agentMode =
		tool?.agentName === "agent" ? agentModeFromInput(input) : undefined;
	const toolUi = tool ? backboardToolUiInput(tool.agentName, input) : undefined;
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name,
		inputSummary,
		...(agentMode ? { agentMode } : {}),
		...(toolUi ? { toolUi } : {}),
	};
}

export function toolPendingEvent(
	toolCallId: string,
	displayName: string,
	input?: unknown,
	tool?: Tool,
): AgentEvent {
	const toolUi = tool ? backboardToolUiInput(tool.agentName, input) : undefined;
	return {
		type: "tool:pending",
		toolCallId,
		name: displayName,
		inputSummary: summarizeToolInput(input, tool),
		...(toolUi ? { toolUi } : {}),
	};
}

export function toolErrorStartEvent(
	ref: ToolCallRef,
	displayName: string | undefined,
	tool?: Tool,
): AgentEvent {
	const toolUi = tool
		? backboardToolUiInput(tool.agentName, ref.input)
		: undefined;
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name: displayName ?? ref.name,
		inputSummary: summarizeToolInput(ref.input, tool),
		...(toolUi ? { toolUi } : {}),
	};
}

function agentModeFromInput(input: unknown): "worker" | "rlm" | undefined {
	if (!input || typeof input !== "object") return "worker";
	const value = (input as { subagent_type?: unknown }).subagent_type;
	return value === "rlm" || value === "worker" ? value : "worker";
}

export function toolResultEvent(
	ref: ToolCallRef,
	tool: Tool,
	input: unknown,
	output: unknown,
	title: string,
	detail?: string,
	detailLines?: ToolResultDetailLine[],
	fileEdits?: FileEditPreview[],
	terminalOutput?: TerminalToolResult,
): AgentEvent {
	const name = tool.displayName;
	const toolUi = backboardToolUiResult(tool.agentName, input, output);
	if (tool.agentName === "agent") {
		return {
			type: "tool:result",
			toolCallId: ref.id,
			name,
			title,
			...(detail ? { detail } : {}),
			...(detailLines ? { detailLines } : {}),
			agentOutput: requireAgentToolOutput(output),
			...(toolUi ? { toolUi } : {}),
		};
	}
	return {
		type: "tool:result",
		toolCallId: ref.id,
		name,
		title,
		...(detail ? { detail } : {}),
		...(detailLines ? { detailLines } : {}),
		...(fileEdits?.length ? { fileEdits } : {}),
		...(terminalOutput ? { terminalOutput } : {}),
		...(toolUi ? { toolUi } : {}),
	};
}

/**
 * The one-line parameter summary shown beneath a tool's name. Each tool owns the
 * parameters that explain its own calls via `Tool.summarizeInput()` (so renaming
 * a tool param can't silently degrade its summary from afar); tools that don't
 * override fall back to a tool-agnostic free-form field. The result is clamped
 * to one readable line here so every tool gets consistent length handling.
 */
export function summarizeToolInput(input: unknown, tool?: Tool): string {
	if (!input || typeof input !== "object") return "";
	const custom = tool?.summarizeInput(input);
	if (custom) return clampSummary(custom);
	return clampSummary(genericInputSummary(input));
}
