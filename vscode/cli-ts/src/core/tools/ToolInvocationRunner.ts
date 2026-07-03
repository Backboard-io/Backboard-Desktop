import type { EventBus } from "../bus/EventBus.ts";
import type { ToolContext } from "./ToolContext.ts";
import {
	summarizeToolInput,
	toolResultEvent,
	toolStartEvent,
} from "./ToolEventFactory.ts";
import type { ExecutablePlanEntry } from "./ToolExecutionPlanner.ts";
import {
	mergeHookContext,
	normalizeAbort,
	type ToolHookPipeline,
} from "./ToolHookPipeline.ts";
import type { ToolOutput } from "./ToolScheduler.ts";

export class ToolInvocationRunner {
	constructor(
		private readonly bus: EventBus,
		private readonly hooks: ToolHookPipeline,
	) {}

	async run(entry: ExecutablePlanEntry, ctx: ToolContext): Promise<ToolOutput> {
		const { ref } = entry;
		let hookInput = entry.input;
		let deniedReason: string | undefined;
		let preToolContext: string | undefined;
		try {
			const preTool = await this.hooks.applyPreToolHooks(
				ref,
				entry.tool,
				entry.input,
				ctx,
			);
			hookInput = preTool.input;
			deniedReason = preTool.deniedReason;
			preToolContext = preTool.additionalContext;
		} catch (err) {
			normalizeAbort(err, ctx.signal);
			const message = `Error: pre-tool hook failed for "${ref.name}": ${errMessage(err)}`;
			this.bus.emit(toolStartEvent(ref, entry.input, entry.tool));
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: { name: ref.name, readOnly: false, error: true },
			};
		}

		if (
			!deniedReason &&
			ctx.requestPermission &&
			!entry.tool.isReadOnly(hookInput)
		) {
			try {
				const permission = await ctx.requestPermission({
					toolCallId: ref.id,
					name: ref.name,
					inputSummary: summarizeToolInput(hookInput),
				});
				if (permission.decision === "deny") {
					deniedReason =
						permission.reason ?? `Tool call "${ref.name}" denied by user`;
				}
			} catch (err) {
				normalizeAbort(err, ctx.signal);
				deniedReason = `permission request failed for "${ref.name}": ${errMessage(err)}`;
			}
		}

		this.bus.emit(toolStartEvent(ref, hookInput, entry.tool));

		if (deniedReason) {
			const message = `Error: ${deniedReason}`;
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: true,
				},
			};
		}

		try {
			if (ctx.signal.aborted) normalizeAbort(new Error("aborted"), ctx.signal);
			const result = await entry.tool.execute(hookInput, {
				...ctx,
				toolCallId: ref.id,
				trace: ctx.trace?.forToolCall(ref.id),
			});
			const post = await this.hooks.applyPostToolHooks(
				ref,
				hookInput,
				result.forLLM,
				false,
				ctx,
			);
			if (post.denied) {
				this.emitError(ref.id, entry.tool.displayName, post.output);
				return {
					tool_call_id: ref.id,
					output: post.output,
					metadata: {
						name: ref.name,
						readOnly: entry.tool.isReadOnly(hookInput),
						error: true,
					},
				};
			}
			const output = mergeHookContext(
				post.output,
				preToolContext,
				post.additionalContext,
			);
			this.bus.emit(
				toolResultEvent(
					ref,
					entry.tool,
					result.data,
					result.title,
					result.detail,
					result.detailLines,
				),
			);
			return {
				tool_call_id: ref.id,
				output,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: false,
				},
			};
		} catch (err) {
			normalizeAbort(err, ctx.signal);
			const post = await this.hooks.applyPostToolHooks(
				ref,
				hookInput,
				`Error: ${errMessage(err)}`,
				true,
				ctx,
			);
			const message = post.denied
				? post.output
				: mergeHookContext(post.output, preToolContext, post.additionalContext);
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: true,
				},
			};
		}
	}

	private emitError(toolCallId: string, name: string, error: string): void {
		this.bus.emit({
			type: "tool:error",
			toolCallId,
			name,
			error,
		});
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
