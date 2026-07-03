import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { HookController } from "../hooks/index.ts";
import { AbortError, isAbortError } from "./ToolAbort.ts";
import type { ToolContext } from "./ToolContext.ts";
import { summarizeToolInput, toolErrorStartEvent } from "./ToolEventFactory.ts";
import {
	type ErrorPlanEntry,
	type ExecutablePlanEntry,
	ToolExecutionPlanner,
} from "./ToolExecutionPlanner.ts";
import { ToolHookPipeline } from "./ToolHookPipeline.ts";
import { ToolInvocationRunner } from "./ToolInvocationRunner.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";

export { AbortError, isAbortError };

export interface ToolOutput {
	tool_call_id: string;
	output: string;
	metadata?: ToolOutputMetadata;
}

export interface ToolOutputMetadata {
	name: string;
	readOnly: boolean;
	error: boolean;
}

/**
 * Executes a turn's tool calls with correct ordering semantics:
 *   - consecutive concurrency-safe calls run together in parallel
 *   - any non-safe (write/destructive) call runs alone, in order
 * All outputs are collected and returned together so the caller can submit the
 * full set in one Backboard call. Cancellation throws AbortError; partial
 * outputs are discarded by the caller rather than submitted.
 */
export class ToolScheduler {
	private readonly planner: ToolExecutionPlanner;
	private readonly invocationRunner: ToolInvocationRunner;

	constructor(
		registry: ToolRegistry,
		private readonly bus: EventBus,
		isToolEnabled: (name: string) => boolean = () => true,
		hookController?: HookController,
	) {
		this.planner = new ToolExecutionPlanner(
			registry,
			isToolEnabled,
			hookController,
		);
		this.invocationRunner = new ToolInvocationRunner(
			bus,
			new ToolHookPipeline(hookController),
		);
	}

	async run(calls: ToolCallRef[], ctx: ToolContext): Promise<ToolOutput[]> {
		const plan = this.planner.build(calls);
		// Announce every call in the round up front so the UI can show the
		// whole batch immediately - without this, a call queued behind a
		// slow batch stays invisible until the scheduler reaches it.
		for (const entry of plan) {
			this.bus.emit({
				type: "tool:pending",
				toolCallId: entry.ref.id,
				name:
					("errorOutput" in entry
						? entry.displayName
						: entry.tool.displayName) ?? entry.ref.name,
				inputSummary: summarizeToolInput(
					"errorOutput" in entry ? entry.ref.input : entry.input,
				),
			});
		}
		const outputs: ToolOutput[] = [];
		let batch: ExecutablePlanEntry[] = [];

		const flushBatch = async (): Promise<void> => {
			if (batch.length === 0) return;
			const results = await Promise.all(
				batch.map((entry) => this.invocationRunner.run(entry, ctx)),
			);
			outputs.push(...results);
			batch = [];
		};

		for (const entry of plan) {
			if (ctx.signal.aborted) throw new AbortError();

			if (entry.concurrencySafe) {
				batch.push(entry);
				continue;
			}

			await flushBatch();
			if ("errorOutput" in entry) {
				outputs.push(this.errorOutput(entry));
			} else {
				outputs.push(await this.invocationRunner.run(entry, ctx));
			}
		}

		await flushBatch();
		return outputs;
	}

	private errorOutput(entry: ErrorPlanEntry): ToolOutput {
		this.bus.emit(toolErrorStartEvent(entry.ref, entry.displayName));
		this.bus.emit({
			type: "tool:error",
			toolCallId: entry.ref.id,
			name: entry.displayName ?? entry.ref.name,
			error: entry.errorOutput,
		});
		return {
			tool_call_id: entry.ref.id,
			output: entry.errorOutput,
			metadata: { name: entry.ref.name, readOnly: false, error: true },
		};
	}
}
