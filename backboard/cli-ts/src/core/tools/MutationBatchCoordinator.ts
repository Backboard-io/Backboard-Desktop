import { resolve } from "node:path";
import { canonicalLockPath } from "../../utils/pathLocks.ts";
import type {
	CheckpointCallContext,
	CheckpointRecorder,
	RecordPostImageRequest,
	RecordPreImageRequest,
} from "../checkpoints/CheckpointStore.ts";
import {
	recordPostImageBatch,
	recordPreImageBatch,
} from "../checkpoints/CheckpointStore.ts";

export interface MutationCheckpointBatch {
	recordPreImages(
		requests: readonly RecordPreImageRequest[],
		ctx: CheckpointCallContext,
	): Promise<void>;
	recordPostImages(
		requests: readonly RecordPostImageRequest[],
		ctx: CheckpointCallContext,
	): Promise<void>;
	settle(toolCallId: string): void;
}

export interface MutationDiagnosticsBatch {
	collect(
		toolCallId: string,
		paths: readonly string[],
		run: (paths: readonly string[]) => Promise<string>,
	): Promise<string>;
	settle(toolCallId: string): void;
}

export interface MutationExecutionMetadata {
	checkpoint?: MutationCheckpointBatch;
	diagnostics?: MutationDiagnosticsBatch;
	batchSize: number;
}

interface CheckpointArrival<TRequest> {
	readonly ctx: CheckpointCallContext;
	readonly requests: readonly TRequest[];
}

/**
 * Coalesces ready captures for one disjoint mutation wave. Each participant
 * awaits its durable pre-images before writing and its post-images before
 * releasing its locks. Never wait for a peer that may be blocked on those locks.
 */
class CheckpointMutationBatch implements MutationCheckpointBatch {
	private readonly pre: ParticipantPhase<RecordPreImageRequest>;
	private readonly post: ParticipantPhase<RecordPostImageRequest>;

	constructor(
		participants: readonly string[],
		recorder: CheckpointRecorder,
		baseContext: CheckpointCallContext,
	) {
		this.pre = new ParticipantPhase(participants, async (arrivals) => {
			const requests = flattenCheckpointArrivals(arrivals);
			await recordPreImageBatch(recorder, requests, {
				...baseContext,
				toolCallId: undefined,
				mutationBatchSize: 1,
			});
		});
		this.post = new ParticipantPhase(participants, async (arrivals) => {
			const requests = flattenCheckpointArrivals(arrivals);
			await recordPostImageBatch(recorder, requests, {
				...baseContext,
				toolCallId: undefined,
				mutationBatchSize: 1,
			});
		});
	}

	async recordPreImages(
		requests: readonly RecordPreImageRequest[],
		ctx: CheckpointCallContext,
	): Promise<void> {
		const toolCallId = requireToolCallId(ctx);
		await this.pre.arrive(toolCallId, {
			ctx,
			requests: requests.map((request) => ({ ...request, toolCallId })),
		});
	}

	async recordPostImages(
		requests: readonly RecordPostImageRequest[],
		ctx: CheckpointCallContext,
	): Promise<void> {
		const toolCallId = requireToolCallId(ctx);
		await this.post.arrive(toolCallId, {
			ctx,
			requests: requests.map((request) => ({ ...request, toolCallId })),
		});
	}

	settle(toolCallId: string): void {
		this.pre.settle(toolCallId);
		this.post.settle(toolCallId);
	}
}

/** Runs one diagnostics sweep only after every mutation has committed or failed. */
class RoundMutationDiagnosticsBatch implements MutationDiagnosticsBatch {
	private readonly participants: ReadonlySet<string>;
	private readonly arrivals = new Map<string, readonly string[]>();
	private readonly settled = new Set<string>();
	private run: ((paths: readonly string[]) => Promise<string>) | undefined;
	private readonly operation: Promise<string>;
	private resolveOperation!: (value: string) => void;
	private started = false;

	constructor(participants: readonly string[]) {
		this.participants = new Set(participants);
		this.operation = new Promise<string>((resolvePromise) => {
			this.resolveOperation = resolvePromise;
		});
	}

	async collect(
		toolCallId: string,
		paths: readonly string[],
		run: (paths: readonly string[]) => Promise<string>,
	): Promise<string> {
		this.assertParticipant(toolCallId);
		if (!this.arrivals.has(toolCallId)) {
			this.arrivals.set(toolCallId, [...paths]);
			this.run ??= run;
		}
		this.startIfReady();
		return await this.operation;
	}

	settle(toolCallId: string): void {
		if (!this.participants.has(toolCallId) || this.arrivals.has(toolCallId)) {
			return;
		}
		this.settled.add(toolCallId);
		this.startIfReady();
	}

	private startIfReady(): void {
		if (
			this.started ||
			this.arrivals.size + this.settled.size < this.participants.size
		) {
			return;
		}
		this.started = true;
		const paths = [
			...new Set([...this.arrivals.values()].flatMap((value) => [...value])),
		];
		if (!this.run || paths.length === 0) {
			this.resolveOperation("");
			return;
		}
		void this.run(paths).then(this.resolveOperation, () =>
			this.resolveOperation(""),
		);
	}

	private assertParticipant(toolCallId: string): void {
		if (!this.participants.has(toolCallId)) {
			throw new Error(
				`Unknown mutation diagnostics participant: ${toolCallId}`,
			);
		}
	}
}

class ParticipantPhase<TRequest> {
	private readonly participants: ReadonlySet<string>;
	private readonly pending = new Map<
		string,
		{
			arrival: CheckpointArrival<TRequest>;
			resolve: () => void;
			reject: (error: unknown) => void;
		}
	>();
	private readonly operations = new Map<string, Promise<void>>();
	private scheduled = false;

	constructor(
		participants: readonly string[],
		private readonly run: (
			arrivals: ReadonlyMap<string, CheckpointArrival<TRequest>>,
		) => Promise<void>,
	) {
		this.participants = new Set(participants);
	}

	arrive(
		toolCallId: string,
		arrival: CheckpointArrival<TRequest>,
	): Promise<void> {
		if (!this.participants.has(toolCallId)) {
			throw new Error(`Unknown mutation checkpoint participant: ${toolCallId}`);
		}
		const existing = this.operations.get(toolCallId);
		if (existing) return existing;
		const operation = new Promise<void>((resolve, reject) => {
			this.pending.set(toolCallId, { arrival, resolve, reject });
		});
		this.operations.set(toolCallId, operation);
		if (!this.scheduled) {
			this.scheduled = true;
			// Coalesce this event-loop turn, without a peer barrier. A worker
			// integration (or another session's patch) can reserve several paths
			// between two calls in this wave. Waiting for both calls while holding
			// either path would create a lock/checkpoint cycle.
			setImmediate(() => this.flushReady());
		}
		return operation;
	}

	settle(_toolCallId: string): void {
		// An absent/failed participant cannot hold up a ready capture.
	}

	private flushReady(): void {
		this.scheduled = false;
		const pending = new Map(this.pending);
		this.pending.clear();
		const ordered = new Map(
			[...this.participants].flatMap((id) => {
				const item = pending.get(id);
				return item ? [[id, item.arrival] as const] : [];
			}),
		);
		// The recorder orders journal appends; disjoint captures can perform
		// their filesystem reads concurrently. Each caller still awaits durability.
		const operation = this.run(ordered);
		void operation.then(
			() => {
				for (const item of pending.values()) item.resolve();
			},
			(error) => {
				for (const item of pending.values()) item.reject(error);
			},
		);
	}
}

/** Builds disjoint checkpoint waves plus one round-wide diagnostics barrier. */
export async function createMutationExecutionMetadata(
	items: readonly {
		toolCallId: string;
		toolName: string;
		paths: readonly string[];
	}[],
	cwd: string,
	recorder: CheckpointRecorder | undefined,
	baseContext: CheckpointCallContext,
): Promise<Map<string, MutationExecutionMetadata>> {
	const mutations = items.filter((item) => isDirectFileMutation(item.toolName));
	if (mutations.length === 0) return new Map();
	const canonical = await Promise.all(
		mutations.map(async (item) => {
			const canonicalPaths = await Promise.all(
				item.paths.map(async (path) => {
					const absolute = resolve(cwd, path);
					try {
						return await canonicalLockPath(absolute);
					} catch {
						// Keep scheduler construction best-effort. The mutation itself
						// performs the authoritative safety check and reports a normal
						// tool error (for example, for a dangling symlink).
						return absolute;
					}
				}),
			);
			return { ...item, canonicalPaths: new Set(canonicalPaths) };
		}),
	);
	const waves: Array<{
		items: typeof canonical;
		paths: Set<string>;
	}> = [];
	for (const item of canonical) {
		// Checkpoint participants must form contiguous provider-order segments.
		// Greedily putting a later disjoint call back into an older wave can create
		// a lock/barrier cycle: A(x) waits for C(y), while intervening B(x,y)
		// waits for A's lock and C waits for B's registration turn. Starting a new
		// wave at every overlap preserves parallel batching without crossing that
		// dependency boundary.
		let wave = waves.at(-1);
		if (
			!wave ||
			[...item.canonicalPaths].some((path) => wave?.paths.has(path))
		) {
			wave = { items: [], paths: new Set() };
			waves.push(wave);
		}
		wave.items.push(item);
		for (const path of item.canonicalPaths) wave.paths.add(path);
	}

	const metadata = new Map<string, MutationExecutionMetadata>();
	const diagnostics =
		canonical.length > 1
			? new RoundMutationDiagnosticsBatch(
					canonical.map((item) => item.toolCallId),
				)
			: undefined;
	for (const wave of waves) {
		const participants = wave.items.map((item) => item.toolCallId);
		const checkpoint =
			recorder && participants.length > 1
				? new CheckpointMutationBatch(participants, recorder, baseContext)
				: undefined;
		for (const item of wave.items) {
			metadata.set(item.toolCallId, {
				checkpoint,
				diagnostics,
				batchSize: participants.length,
			});
		}
	}
	return metadata;
}

function flattenCheckpointArrivals<TRequest extends { toolCallId?: string }>(
	arrivals: ReadonlyMap<string, CheckpointArrival<TRequest>>,
): TRequest[] {
	return [...arrivals.values()].flatMap((arrival) => [...arrival.requests]);
}

function requireToolCallId(ctx: CheckpointCallContext): string {
	if (!ctx.toolCallId) {
		throw new Error("Mutation batch checkpointing requires a tool-call id.");
	}
	return ctx.toolCallId;
}

function isDirectFileMutation(toolName: string): boolean {
	const normalized = toolName.replace(/[_-]/g, "").toLowerCase();
	return (
		normalized === "write" ||
		normalized === "edit" ||
		normalized === "applypatch"
	);
}
