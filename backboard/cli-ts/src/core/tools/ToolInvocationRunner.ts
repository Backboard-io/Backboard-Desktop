import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import {
	type GateResult,
	resolveToolPermissions,
} from "../permissions/resolveToolPermission.ts";
import { createMutationExecutionMetadata } from "./MutationBatchCoordinator.ts";
import { throwIfAborted } from "./ToolAbort.ts";
import type { MutationLockTurn, ToolContext } from "./ToolContext.ts";
import { toolResultEvent, toolStartEvent } from "./ToolEventFactory.ts";
import type { ExecutablePlanEntry } from "./ToolExecutionPlanner.ts";
import {
	mergeHookContext,
	normalizeAbort,
	type ToolHookPipeline,
} from "./ToolHookPipeline.ts";
import type { ToolOutput } from "./ToolScheduler.ts";

interface PreparedInvocation {
	entry: ExecutablePlanEntry;
	hookInput: unknown;
	preToolContext?: string;
}

type PreparationResult =
	| { prepared: PreparedInvocation }
	| { output: ToolOutput };

export class ToolInvocationRunner {
	constructor(
		private readonly bus: EventBus,
		private readonly hooks: ToolHookPipeline,
	) {}

	async run(entry: ExecutablePlanEntry, ctx: ToolContext): Promise<ToolOutput> {
		const output = (await this.runBatch([entry], ctx))[0];
		if (!output) throw new Error("Tool batch completed without an output");
		return output;
	}

	/**
	 * Runs one scheduler-safe batch. Pre-tool hooks retain first-deny rights,
	 * then every remaining call is permission-checked together so a round of
	 * independent writes interrupts the user only once.
	 */
	async runBatch(
		entries: readonly ExecutablePlanEntry[],
		ctx: ToolContext,
		onSettled?: (entry: ExecutablePlanEntry) => void,
	): Promise<ToolOutput[]> {
		const preparations = await Promise.all(
			entries.map((entry) => this.prepare(entry, ctx)),
		);
		const prepared = preparations.flatMap((result) =>
			"prepared" in result ? [result.prepared] : [],
		);
		let gates: GateResult[] = [];
		if (prepared.length > 0) {
			try {
				gates = await resolveToolPermissions(
					prepared.map((item) => ({
						tool: item.entry.tool,
						input: item.hookInput,
					})),
					ctx,
				);
			} catch (err) {
				normalizeAbort(err, ctx.signal);
				throw err;
			}
		}
		throwIfAborted(ctx.signal);
		const mutationTurns = createMutationLockTurns(prepared);
		const mutationMetadata = await createMutationExecutionMetadata(
			prepared.flatMap((item, index) => {
				if (
					!gates[index]?.allowed ||
					item.entry.tool.isReadOnly(item.hookInput)
				) {
					return [];
				}
				return [
					{
						toolCallId: item.entry.ref.id,
						toolName: item.entry.tool.name,
						paths: item.entry.tool.permissionPaths(item.hookInput) ?? [],
					},
				];
			}),
			ctx.cwd,
			ctx.checkpoints,
			ctx,
		);

		let gateIndex = 0;
		return await Promise.all(
			preparations.map(async (result, index) => {
				let output: ToolOutput;
				if ("output" in result) {
					output = result.output;
				} else {
					const toolCallId = result.prepared.entry.ref.id;
					const mutationLockTurn = mutationTurns.get(toolCallId);
					const mutation = mutationMetadata.get(toolCallId);
					const gate = gates[gateIndex++] ?? {
						allowed: false,
						denialReason: "Permission resolution did not produce a decision.",
					};
					try {
						output = await this.executePrepared(result.prepared, gate, {
							...ctx,
							mutationBatchSize: mutation?.batchSize ?? 1,
							mutationLockTurn,
							mutationCheckpointBatch: mutation?.checkpoint,
							mutationDiagnosticsBatch: mutation?.diagnostics,
						});
					} finally {
						// A validation/permission failure may never reach a tool's lock.
						// Release the next registration turn without deadlocking the batch.
						mutationLockTurn?.advance();
						mutation?.checkpoint?.settle(toolCallId);
						mutation?.diagnostics?.settle(toolCallId);
					}
				}
				const entry = entries[index];
				if (entry) onSettled?.(entry);
				return output;
			}),
		);
	}

	private async prepare(
		entry: ExecutablePlanEntry,
		ctx: ToolContext,
	): Promise<PreparationResult> {
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
			const message = `Error: pre-tool hook failed for "${ref.name}": ${errorMessage(err)}`;
			this.bus.emit(toolStartEvent(ref, entry.input, entry.tool));
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				output: {
					tool_call_id: ref.id,
					output: message,
					metadata: { name: ref.name, readOnly: false, error: true },
				},
			};
		}

		// No events once the turn is aborted - the scheduler has already
		// rejected, and a late emit would resurrect a committed transcript row.
		throwIfAborted(ctx.signal);
		this.bus.emit(toolStartEvent(ref, hookInput, entry.tool));

		if (deniedReason) {
			const message = `Error: ${deniedReason}`;
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				output: {
					tool_call_id: ref.id,
					output: message,
					metadata: {
						name: ref.name,
						readOnly: entry.tool.isReadOnly(hookInput),
						error: true,
					},
				},
			};
		}

		return { prepared: { entry, hookInput, preToolContext } };
	}

	private async executePrepared(
		prepared: PreparedInvocation,
		gate: GateResult,
		ctx: ToolContext,
	): Promise<ToolOutput> {
		const { entry, hookInput, preToolContext } = prepared;
		const { ref } = entry;
		if (!gate.allowed) {
			const message = `Error: ${gate.denialReason ?? "Permission denied."}`;
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
			const result = await entry.tool.execute(hookInput, {
				...ctx,
				toolCallId: ref.id,
				trace: ctx.trace?.forToolCall(ref.id),
			});
			// A completion after cancel stays silent; its output is discarded.
			throwIfAborted(ctx.signal);
			const post = await this.hooks.applyPostToolHooks(
				ref,
				hookInput,
				result.forLLM,
				false,
				ctx,
			);
			// The post-hook await is another suspension point - a cancel that
			// lands while it runs must not emit tool:result or tool:error.
			throwIfAborted(ctx.signal);
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
					hookInput,
					result.data,
					result.title,
					result.detail,
					result.detailLines,
					result.fileEdits,
					result.terminalOutput,
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
				`Error: ${errorMessage(err)}`,
				true,
				ctx,
			);
			// A cancel landing during that await must stay silent here too.
			throwIfAborted(ctx.signal);
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

function createMutationLockTurns(
	prepared: readonly PreparedInvocation[],
): Map<string, MutationLockTurn> {
	const turns = new Map<string, MutationLockTurn>();
	let previous = Promise.resolve();
	for (const item of prepared) {
		const paths = item.entry.tool.permissionPaths(item.hookInput);
		if (item.entry.tool.isReadOnly(item.hookInput) || !paths?.length) continue;
		const waitForTurn = previous;
		let releaseNext!: () => void;
		previous = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		let advanced = false;
		turns.set(item.entry.ref.id, {
			wait: async () => await waitForTurn,
			advance: () => {
				if (advanced) return;
				advanced = true;
				releaseNext();
			},
		});
	}
	return turns;
}
