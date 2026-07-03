import type { ReactNode } from "react";
import type { z } from "zod";
import type { PromptContext } from "../../prompts/PromptModule.ts";
import { toAgentToolName } from "./names.ts";
import { type OpenAITool, toOpenAITool } from "./schema.ts";
import type { ToolContext } from "./ToolContext.ts";
import type { ToolResult } from "./ToolResult.ts";

/**
 * Abstract base for every tool. Subclasses declare their name, Zod input
 * schema, and `execute` logic; everything else has sane defaults. Concurrency
 * and destructiveness defaults are conservative: a tool is parallel-safe only
 * if it is read-only.
 *
 * `prompt()` returns the tool's model-facing description, sourced from
 * `prompts/tools/*` (empty placeholders for now).
 */
export abstract class Tool<I = unknown, O = unknown> {
	abstract readonly name: string;
	abstract readonly inputSchema: z.ZodType<I>;

	get agentName(): string {
		return toAgentToolName(this.name);
	}

	get displayName(): string {
		return this.name;
	}

	/** Model-facing description. Empty until prompts are authored. */
	prompt(_context: PromptContext = {}): string {
		return "";
	}

	isReadOnly(_input: I): boolean {
		return true;
	}

	isConcurrencySafe(input: I): boolean {
		return this.isReadOnly(input);
	}

	isDestructive(_input: I): boolean {
		return false;
	}

	abstract execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;

	/** Optional lifecycle cleanup for tools that hold external resources. */
	async dispose(): Promise<void> {}

	/** UI rendering of the invocation line. Overridable per tool. */
	renderCall(_input: I): ReactNode {
		return null;
	}

	/** UI rendering of the result block. Overridable per tool. */
	renderResult(_output: O): ReactNode {
		return null;
	}

	parseInput(raw: unknown): I {
		return this.inputSchema.parse(stripNullProps(raw));
	}

	toJSONSchema(context: PromptContext = {}): OpenAITool {
		return toOpenAITool(this.agentName, this.prompt(context), this.inputSchema);
	}
}

/**
 * Models routinely send `null` for optional parameters. Zod's `.optional()`
 * rejects null, so we drop null-valued top-level keys before validation. This
 * keeps the advertised schema clean (optional, not nullable) while tolerating
 * the common null-for-omitted convention.
 */
export function stripNullProps(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value !== null) out[key] = value;
	}
	return out;
}
