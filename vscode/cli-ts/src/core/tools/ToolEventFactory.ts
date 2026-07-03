import type { AgentEvent, ToolCallRef } from "../bus/events.ts";
import { requireAgentToolOutput } from "./AgentToolOutputGuard.ts";
import type { Tool } from "./Tool.ts";
import type { ToolResultDetailLine } from "./ToolResultDetail.ts";

export function toolStartEvent(
	ref: ToolCallRef,
	input: unknown,
	tool?: Tool,
): AgentEvent {
	const inputSummary = summarizeToolInput(input);
	const name = tool?.displayName ?? ref.name;
	const agentMode =
		tool?.agentName === "agent" ? agentModeFromInput(input) : undefined;
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name,
		inputSummary,
		...(agentMode ? { agentMode } : {}),
	};
}

export function toolErrorStartEvent(
	ref: ToolCallRef,
	displayName: string | undefined,
): AgentEvent {
	return {
		type: "tool:start",
		toolCallId: ref.id,
		name: displayName ?? ref.name,
		inputSummary: summarizeToolInput(ref.input),
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
	output: unknown,
	title: string,
	detail?: string,
	detailLines?: ToolResultDetailLine[],
): AgentEvent {
	const name = tool.displayName;
	if (tool.agentName === "agent") {
		return {
			type: "tool:result",
			toolCallId: ref.id,
			name,
			title,
			...(detail ? { detail } : {}),
			...(detailLines ? { detailLines } : {}),
			agentOutput: requireAgentToolOutput(output),
		};
	}
	return {
		type: "tool:result",
		toolCallId: ref.id,
		name,
		title,
		...(detail ? { detail } : {}),
		...(detailLines ? { detailLines } : {}),
	};
}

export function summarizeToolInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as {
		file_path?: unknown;
		path?: unknown;
		command?: unknown;
		pattern?: unknown;
		url?: unknown;
		query?: unknown;
		question?: unknown;
		prompt?: unknown;
	};
	const primary =
		obj.file_path ??
		obj.path ??
		obj.command ??
		obj.pattern ??
		obj.url ??
		obj.query ??
		obj.question ??
		obj.prompt;
	if (typeof primary !== "string") return "";
	const isPathField = primary === obj.file_path || primary === obj.path;
	let normalized = primary.replace(/\s+/g, " ").trim();
	if (isPathField) normalized = relativizePath(normalized);
	return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

function relativizePath(value: string): string {
	const cwd = process.cwd();
	if (value === cwd) return ".";
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
