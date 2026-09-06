import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { HookController } from "../hooks/index.ts";
import { canonicalToolName } from "./names.ts";
import { AbortError, isAbortError } from "./ToolAbort.ts";
import {
	canonicalToolInput,
	sameToolCallIdentity,
	type ToolCallIdentity,
	toolInputFingerprint,
} from "./ToolCallIdentity.ts";
import type { ToolContext } from "./ToolContext.ts";
import { toolErrorStartEvent, toolPendingEvent } from "./ToolEventFactory.ts";
import {
	type ErrorPlanEntry,
	type ExecutablePlanEntry,
	type PlanEntry,
	ToolExecutionPlanner,
} from "./ToolExecutionPlanner.ts";
import type { ToolFailureCategory } from "./ToolFailure.ts";
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
	failureCategory?: ToolFailureCategory;
	exitCode?: number;
	timedOut?: boolean;
	cancelled?: boolean;
	retryable?: boolean;
	validation?: "passed" | "failed";
	mutated?: boolean;
	outcome?: "success" | "no_match" | "partial" | "failure";
}

/**
 * Receives per-tool-call events while the provider response is still
 * streaming, so rendering and (safe) execution can start before the full
 * round arrives.
 */
export interface EarlyToolSink {
	/** The call's name has streamed; render its row immediately. */
	announce(id: string, name: string): void;
	/** The call's arguments finished streaming; it may start early. */
	offer(call: ToolCallRef): void;
	/** The stream is being retried; abort and discard all early state. */
	reset(): void;
}

export interface ToolCallRoundOptions {
	/** Calls for which this predicate returns true are ignored entirely
	 * (announce and offer are no-ops). Used to skip calls already answered
	 * in a previous round. */
	skip?: (id: string) => boolean;
}

type SettledOutput = { output: ToolOutput } | { error: unknown };

type ExecutionBatchItem =
	| { kind: "early"; settled: Promise<SettledOutput> }
	| { kind: "entry"; entry: ExecutablePlanEntry };

interface EarlyExecution {
	/** The parsed input the call actually ran with, for reconciliation
	 * against the authoritative list in finalize(). */
	identity: ToolCallIdentity;
	settled: Promise<SettledOutput>;
	/** Aborts this execution alone - fired when finalize() discards it so the
	 * orphan can't race the authoritative re-run on the same transcript row. */
	abort: AbortController;
}

/**
 * Executes a turn's tool calls with correct ordering semantics:
 *   - consecutive concurrency-safe calls run together in parallel
 *   - any non-safe (write/destructive) call runs alone, in order
 * All outputs are collected and returned together so the caller can submit the
 * full set in one Backboard call. Cancellation throws AbortError; partial
 * outputs are discarded by the caller rather than submitted.
 *
 * createRound() returns a per-round object that additionally accepts streamed
 * per-call events (EarlyToolSink) so safe calls can start while the provider
 * response is still streaming.
 */
export class ToolScheduler {
	private readonly planner: ToolExecutionPlanner;
	private readonly invocationRunner: ToolInvocationRunner;

	constructor(
		private readonly registry: ToolRegistry,
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
		return this.createRound(ctx).finalize(calls);
	}

	callIdentity(call: ToolCallRef): string {
		const entry = this.planner.build([call])[0];
		return canonicalToolInput({
			name: canonicalToolName(
				entry && "tool" in entry ? entry.tool.name : call.name,
			),
			input: entry && "input" in entry ? entry.input : call.input,
		});
	}

	createRound(
		ctx: ToolContext,
		options: ToolCallRoundOptions = {},
	): ToolCallRound {
		return new ToolCallRound(
			this.planner,
			this.invocationRunner,
			this.registry,
			this.bus,
			ctx,
			options,
		);
	}
}

/**
 * One round of tool calls. Streamed events (announce/offer) may arrive before
 * the authoritative call list; finalize() reconciles against that list, awaits
 * early-started calls, runs the rest with the classic ordering semantics, and
 * returns outputs ordered by the final list.
 *
 * Early execution is deliberately conservative: a call starts before finalize
 * only when it is read-only AND concurrency-safe AND every call streamed
 * before it in this round has also streamed complete arguments. That preserves
 * the invariant that a read never runs ahead of an earlier write - writes
 * (including concurrency-safe-but-write-capable tools like Agent, and anything
 * unparseable) always wait for the full round.
 *
 * Rows announced to the UI are always resolved: execution events terminate the
 * rows finalize() runs, and reset()/finalize() emit `tool:retracted` for any
 * row abandoned by a stream retry or absent from the authoritative list.
 */
export class ToolCallRound implements EarlyToolSink {
	private readonly roundId = `tool_round_${nextRoundId++}`;
	private readonly announcedNames = new Map<string, string>();
	private readonly identityConflicts = new Set<string>();
	private finalization:
		| { signature: string; promise: Promise<ToolOutput[]> }
		| undefined;
	private readonly announced = new Set<string>();
	private readonly offered = new Map<string, PlanEntry>();
	private readonly inFlight = new Map<string, EarlyExecution>();
	// Ids whose execution reached a terminal event (tool:result/tool:error).
	// Retraction skips them: a completed row must survive a mid-round abort,
	// and may already have drained to static scrollback where it can't be
	// un-printed anyway. The Store's tool:retracted reducer independently
	// refuses to drop terminal rows, which backstops the unavoidable microtask
	// gap between the runner's terminal emit and the add here.
	private readonly settledIds = new Set<string>();
	private completedOutputs: ToolOutput[] = [];
	// Bumped by every cleanup. An execution abandoned by reset() can be past
	// its last abort checkpoint and still settle afterwards; the epoch check
	// keeps its late settledIds.add from poisoning the next attempt, where the
	// same call id may be re-announced and must stay retractable.
	private epoch = 0;
	private attemptAbort = new AbortController();
	private finalizedSuccessfully = false;
	private earlyStartBlocked = false;

	constructor(
		private readonly planner: ToolExecutionPlanner,
		private readonly invocationRunner: ToolInvocationRunner,
		private readonly registry: ToolRegistry,
		private readonly bus: EventBus,
		private readonly ctx: ToolContext,
		private readonly options: ToolCallRoundOptions = {},
	) {}

	announce(id: string, name: string): void {
		if (this.options.skip?.(id) || this.ctx.signal.aborted || this.finalization)
			return;
		const previous = this.announcedNames.get(id);
		if (previous && canonicalToolName(previous) !== canonicalToolName(name)) {
			if (this.offered.has(id)) {
				this.identityConflicts.add(id);
				this.inFlight.get(id)?.abort.abort();
			}
			this.traceIdentity(
				id,
				name,
				"mismatch",
				undefined,
				previous,
				"announced tool name changed",
			);
			return;
		}
		if (this.announced.has(id)) return;
		this.traceIdentity(id, name, "announce");
		this.announcedNames.set(id, name);
		this.announced.add(id);
		const tool = this.registry.get(name);
		this.bus.emit(
			toolPendingEvent(id, tool?.displayName ?? name, undefined, tool),
		);
	}

	offer(call: ToolCallRef): void {
		if (
			this.options.skip?.(call.id) ||
			this.ctx.signal.aborted ||
			this.finalization
		)
			return;
		const previousName = this.offered.get(call.id)?.ref.name;
		if (
			previousName &&
			canonicalToolName(previousName) !== canonicalToolName(call.name)
		) {
			this.identityConflicts.add(call.id);
			this.inFlight.get(call.id)?.abort.abort();
			this.traceIdentity(
				call.id,
				call.name,
				"mismatch",
				call.input,
				previousName,
				"ready tool name changed",
			);
		}
		this.announcedNames.set(call.id, call.name);
		const previous = this.offered.get(call.id);
		if (previous) {
			const updated = this.planner.build([call])[0];
			if (
				updated &&
				!("errorOutput" in updated) &&
				!("errorOutput" in previous) &&
				canonicalToolInput(previous.input) !== canonicalToolInput(updated.input)
			) {
				this.traceIdentity(
					call.id,
					call.name,
					"mismatch",
					updated.input,
					previous.ref.name,
					"duplicate ready event changed validated arguments; awaiting final input",
				);
			}
			return;
		}
		const entry = this.planner.build([call])[0];
		if (!entry) return;
		this.offered.set(call.id, entry);
		this.traceIdentity(
			call.id,
			call.name,
			"ready",
			"input" in entry ? entry.input : call.input,
		);
		// Re-emitting pending is safe: the store upserts by id, filling in the
		// input summary on a row announced with the name alone.
		this.emitPending(entry);
		this.announced.add(call.id);
		this.startReadyEarlyCalls();
	}

	reset(): void {
		// Abort in-flight early executions instead of merely forgetting them:
		// a retried stream can re-offer the same call id, and an un-aborted
		// orphan would execute concurrently with the retry's run while its
		// events keep mutating the transcript row.
		this.cleanup();
		this.attemptAbort = new AbortController();
		this.finalizedSuccessfully = false;
		this.completedOutputs = [];
		this.finalization = undefined;
		this.earlyStartBlocked = false;
	}

	completedToolOutputs(): readonly ToolOutput[] {
		return this.completedOutputs;
	}

	finalize(calls: ToolCallRef[]): Promise<ToolOutput[]> {
		const plan = this.planner.build(calls);
		const signature = canonicalToolInput(
			plan.map((entry) => ({
				id: entry.ref.id,
				name: canonicalToolName(entry.ref.name),
				input: "input" in entry ? entry.input : entry.ref.input,
			})),
		);
		if (this.finalization) {
			return this.finalization.signature === signature
				? this.finalization.promise
				: Promise.reject(
						new Error(
							"Tool protocol error: finalized call list changed within one round",
						),
					);
		}
		const ids = new Set<string>();
		for (const entry of plan) {
			if (ids.has(entry.ref.id)) {
				this.reset();
				return Promise.reject(
					new Error("Tool protocol error: duplicate call ID in final list"),
				);
			}
			ids.add(entry.ref.id);
		}
		const promise = this.finalizePlan(plan);
		this.finalization = { signature, promise };
		return promise;
	}

	private async finalizePlan(entries: PlanEntry[]): Promise<ToolOutput[]> {
		const ctx = {
			...this.ctx,
			signal: AbortSignal.any([this.ctx.signal, this.attemptAbort.signal]),
		};
		const plan = entries.map((entry): PlanEntry => {
			const previous = this.offered.get(entry.ref.id)?.ref.name;
			this.traceIdentity(
				entry.ref.id,
				entry.ref.name,
				"final",
				"input" in entry ? entry.input : entry.ref.input,
			);
			if (
				this.identityConflicts.has(entry.ref.id) ||
				(previous &&
					canonicalToolName(previous) !== canonicalToolName(entry.ref.name))
			) {
				this.traceIdentity(
					entry.ref.id,
					entry.ref.name,
					"mismatch",
					entry.ref.input,
					previous,
					"final tool name disagrees with stream",
				);
				return {
					ref: entry.ref,
					concurrencySafe: false,
					errorOutput:
						"Tool protocol error: the tool name changed for this call ID. No final call was executed; submit a new call with a consistent ID, name, and arguments.",
					failureCategory: "protocol",
				};
			}
			return entry;
		});
		// Announce every call in the round up front so the UI can show the
		// whole batch immediately - without this, a call queued behind a
		// slow batch stays invisible until the scheduler reaches it.
		// Track them in announced too: if finalize aborts mid-round, the
		// finally-reset can only retract rows it knows about.
		for (const entry of plan) {
			if (!this.announced.has(entry.ref.id)) this.emitPending(entry);
			this.announced.add(entry.ref.id);
		}
		const outputs: ToolOutput[] = [];
		this.completedOutputs = outputs;
		let batch: ExecutionBatchItem[] = [];

		const flushBatch = async (): Promise<void> => {
			if (batch.length === 0) return;
			const entries = batch.flatMap((item) =>
				item.kind === "entry" ? [item.entry] : [],
			);
			const entryOutputs =
				entries.length > 0
					? this.runTrackedBatch(entries, ctx)
					: Promise.resolve([]);
			let entryIndex = 0;
			const starts = batch.map((item): Promise<ToolOutput> => {
				if (item.kind === "early") return unwrapSettled(item.settled);
				const index = entryIndex++;
				return entryOutputs.then((values) => {
					const output = values[index];
					if (!output)
						throw new Error("Tool batch completed without an output");
					return output;
				});
			});
			const results = await Promise.allSettled(starts);
			for (const result of results) {
				if (result.status === "fulfilled") outputs.push(result.value);
			}
			batch = [];
			const failure = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		};

		for (const entry of plan) {
			if (ctx.signal.aborted) throw new AbortError();

			const early = this.takeMatchingEarlyExecution(entry);
			if (early) {
				batch.push({ kind: "early", settled: early.settled });
				continue;
			}

			if (entry.concurrencySafe) {
				batch.push({ kind: "entry", entry });
				continue;
			}

			await flushBatch();
			if ("errorOutput" in entry) {
				outputs.push(this.errorOutput(entry));
			} else {
				outputs.push(await this.runTracked(entry, ctx));
			}
		}

		await flushBatch();
		// Retract any streamed row the authoritative list never confirmed so
		// the UI can drop it; its settled promise can never reject unhandled.
		this.finalizedSuccessfully = true;
		this.cleanup(new Set(plan.map((entry) => entry.ref.id)));
		return outputs;
	}

	/**
	 * Shared tail of reset() and finalize(): abort early executions that are
	 * still in flight (an un-aborted orphan would keep running - and keep
	 * emitting events - after its row is gone), retract unresolved announced
	 * rows, and drop per-attempt state.
	 */
	private cleanup(confirmed?: Set<string>): void {
		// Completed spawns intentionally outlive their tool round; their parent
		// cancellation signal and task manager still own their lifecycle.
		if (!this.finalizedSuccessfully) this.attemptAbort.abort();
		for (const early of this.inFlight.values()) early.abort.abort();
		this.retractAnnounced(confirmed);
		this.inFlight.clear();
		this.settledIds.clear();
		this.announcedNames.clear();
		this.identityConflicts.clear();
		this.epoch++;
	}

	/** Run an entry and remember that its row reached a terminal event, so a
	 * later retraction can't delete a completed row. The runner only rejects
	 * on abort, which emits no terminal event - those stay retractable. The
	 * epoch check discards a settle that lands after cleanup() already moved
	 * this round to its next attempt. */
	private runTracked(
		entry: ExecutablePlanEntry,
		ctx: ToolContext,
	): Promise<ToolOutput> {
		const epoch = this.epoch;
		return this.invocationRunner.run(entry, ctx).then((output) => {
			if (epoch === this.epoch) {
				this.settledIds.add(entry.ref.id);
				this.traceIdentity(
					entry.ref.id,
					entry.tool.agentName,
					"result",
					entry.input,
				);
			}
			return output;
		});
	}

	private runTrackedBatch(
		entries: readonly ExecutablePlanEntry[],
		ctx: ToolContext,
	): Promise<ToolOutput[]> {
		const epoch = this.epoch;
		return this.invocationRunner.runBatch(entries, ctx, (entry) => {
			if (epoch === this.epoch) {
				this.settledIds.add(entry.ref.id);
				this.traceIdentity(
					entry.ref.id,
					entry.tool.agentName,
					"result",
					entry.input,
				);
			}
		});
	}

	/**
	 * Reuse the early result only when the input it actually ran with matches
	 * the authoritative input. They can diverge for the same id: the server's
	 * continuation path overwrites the args accumulator wholesale after the
	 * ready event is emitted. On mismatch the entry re-runs normally.
	 */
	private takeMatchingEarlyExecution(
		entry: PlanEntry,
	): EarlyExecution | undefined {
		const early = this.inFlight.get(entry.ref.id);
		if (!early) return undefined;
		this.inFlight.delete(entry.ref.id);
		// Discarded executions are aborted, not just forgotten: an orphan left
		// running would race the authoritative re-run of the same id, and
		// whichever settles last would own the visible row.
		if (
			"errorOutput" in entry ||
			!sameToolCallIdentity(early.identity, this.identityFor(entry))
		) {
			early.abort.abort();
			this.traceIdentity(
				entry.ref.id,
				entry.ref.name,
				"mismatch",
				"input" in entry ? entry.input : entry.ref.input,
				early.identity.name,
				"early result discarded: identity or validated input changed",
			);
			return undefined;
		}
		this.traceIdentity(entry.ref.id, entry.ref.name, "reuse", entry.input);
		return early;
	}

	/** Emit tool:retracted for every announced row that was neither confirmed
	 * by the authoritative list nor already resolved by a terminal event. */
	private retractAnnounced(confirmed?: Set<string>): void {
		for (const id of this.announced) {
			if (confirmed?.has(id) || this.settledIds.has(id)) continue;
			this.bus.emit({ type: "tool:retracted", toolCallId: id });
		}
		this.announced.clear();
		this.offered.clear();
	}

	/**
	 * Starts the contiguous read-only prefix whose arguments are complete.
	 * Providers commonly announce every tool row before finishing any argument
	 * payload. Re-checking the full prefix on every offer lets the earlier calls
	 * start too once that gap closes, instead of only starting the final call.
	 *
	 * Announcement order is provider order, so an incomplete or mutating entry
	 * is a hard barrier: a later read must not race ahead of an earlier write.
	 */
	private startReadyEarlyCalls(): void {
		if (this.earlyStartBlocked) return;
		for (const id of this.announced) {
			if (this.inFlight.has(id)) continue;
			const entry = this.offered.get(id);
			if (!entry) return;
			if (
				"errorOutput" in entry ||
				this.identityConflicts.has(id) ||
				!entry.concurrencySafe ||
				!entry.tool.isReadOnly(entry.input)
			) {
				this.earlyStartBlocked = true;
				return;
			}

			// Hooked tools cannot reach here: the planner clears concurrencySafe
			// for matching trusted hooks, preserving their exactly-once semantics.
			const abort = new AbortController();
			const earlyCtx: ToolContext = {
				...this.ctx,
				signal: AbortSignal.any([this.ctx.signal, abort.signal]),
			};
			this.inFlight.set(id, {
				identity: this.identityFor(entry),
				abort,
				settled: this.runTracked(entry, earlyCtx).then(
					(output): SettledOutput => {
						// Post-settlement abort is inert for the run itself; it just
						// detaches the composite signal from the turn-long ctx.signal
						// so consumed executions don't accumulate listeners there.
						abort.abort();
						return { output };
					},
					(error): SettledOutput => {
						abort.abort();
						return { error };
					},
				),
			});
		}
	}

	private identityFor(entry: ExecutablePlanEntry): ToolCallIdentity {
		return {
			sessionId: this.ctx.sessionId,
			turnId: this.ctx.turnId,
			roundId: this.roundId,
			attempt: this.epoch,
			name: entry.tool.agentName,
			input: canonicalToolInput(entry.input),
		};
	}

	private traceIdentity(
		id: string,
		name: string,
		phase: "announce" | "ready" | "final" | "reuse" | "mismatch" | "result",
		input?: unknown,
		previousName?: string,
		reason?: string,
	): void {
		this.bus.emit({
			type: "tool:identity",
			sessionId: this.ctx.sessionId,
			turnId: this.ctx.turnId,
			roundId: this.roundId,
			attempt: this.epoch,
			toolCallId: id,
			phase,
			name: canonicalToolName(name),
			...(input === undefined
				? {}
				: { inputFingerprint: toolInputFingerprint(input) }),
			...(previousName
				? { previousName: canonicalToolName(previousName) }
				: {}),
			...(reason ? { reason } : {}),
		});
	}

	private emitPending(entry: PlanEntry): void {
		// For error entries the tool instance isn't on the entry, so resolve it
		// from the registry: a disabled/invalid-args row still summarizes its own
		// input (e.g. the file path), while a genuinely unknown tool falls back.
		const tool =
			"errorOutput" in entry ? this.registry.get(entry.ref.name) : entry.tool;
		this.bus.emit(
			toolPendingEvent(
				entry.ref.id,
				("errorOutput" in entry ? entry.displayName : entry.tool.displayName) ??
					entry.ref.name,
				"errorOutput" in entry ? entry.ref.input : entry.input,
				tool,
			),
		);
	}

	private errorOutput(entry: ErrorPlanEntry): ToolOutput {
		this.settledIds.add(entry.ref.id);
		this.bus.emit(
			toolErrorStartEvent(
				entry.ref,
				entry.displayName,
				this.registry.get(entry.ref.name),
			),
		);
		this.bus.emit({
			type: "tool:error",
			toolCallId: entry.ref.id,
			name: entry.displayName ?? entry.ref.name,
			error: entry.errorOutput,
		});
		return {
			tool_call_id: entry.ref.id,
			output: entry.errorOutput,
			metadata: {
				name: entry.ref.name,
				readOnly: false,
				error: true,
				failureCategory: entry.failureCategory ?? "invalid_argument",
			},
		};
	}
}

let nextRoundId = 0;

async function unwrapSettled(
	settled: Promise<SettledOutput>,
): Promise<ToolOutput> {
	const result = await settled;
	if ("output" in result) return result.output;
	throw result.error;
}
