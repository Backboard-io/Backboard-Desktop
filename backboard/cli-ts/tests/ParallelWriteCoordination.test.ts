import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	type CheckpointRecorder,
	CheckpointStore,
} from "../src/core/checkpoints/CheckpointStore.ts";
import { sessionPathsForRoot } from "../src/core/session/SessionStore.ts";
import { createMutationExecutionMetadata } from "../src/core/tools/MutationBatchCoordinator.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { ApplyPatchTool } from "../src/tools/ApplyPatchTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";
import { withPathLocks } from "../src/utils/pathLocks.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "parallel-write-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function context(
	signal: AbortSignal,
	checkpoints?: CheckpointRecorder,
): ToolContext {
	return {
		sessionId: "parallel",
		turnId: "turn",
		toolCallId: "write",
		cwd: root,
		bus: new EventBus(),
		signal,
		askUser: async () => "",
		checkpoints,
	};
}

describe("parallel writer coordination", () => {
	it("reserves all patch paths before a later overlapping writer", async () => {
		const entered = deferred();
		const release = deferred();
		const order: string[] = [];
		const first = withPathLocks([join(root, "a")], async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const patch = withPathLocks(
			[join(root, "a"), join(root, "b")],
			async () => {
				order.push("patch");
			},
		);
		const later = withPathLocks([join(root, "b")], async () => {
			order.push("later");
		});
		try {
			await Bun.sleep(10);
		} finally {
			release.resolve();
		}
		await Promise.all([first, patch, later]);
		expect(order).toEqual(["patch", "later"]);
	});

	it("does not let one blocked path hold up an independent writer in the same round", async () => {
		const entered = deferred();
		const release = deferred();
		const written = deferred();
		const blocking = withPathLocks([join(root, "blocked")], async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const recorder: CheckpointRecorder = {
			recordPreImage: async () => {},
			recordPostImage: async (path) => {
				if (path.endsWith("independent")) written.resolve();
			},
			revertToolCall: async () => {},
			beginShellCapture: async () => {},
			endShellCapture: async () => {},
			captureWarning: () => null,
			scopedToTurn() {
				return this;
			},
		};
		const ctx = context(new AbortController().signal, recorder);
		const scheduler = new ToolScheduler(
			new ToolRegistry([new WriteTool()]),
			ctx.bus,
		);
		const operation = scheduler.run(
			["blocked", "independent"].map((path) => ({
				id: path,
				name: "Write",
				input: { file_path: path, content: path },
			})),
			ctx,
		);
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				written.promise,
				new Promise<never>((_, reject) => {
					deadline = setTimeout(
						() => reject(new Error("Independent writer was blocked")),
						1000,
					);
				}),
			]);
			expect(await readFile(join(root, "independent"), "utf8")).toBe(
				"independent",
			);
		} finally {
			clearTimeout(deadline);
			release.resolve();
			await blocking;
			await operation;
		}
	});

	it("cancels a queued writer promptly without releasing another owner's lock", async () => {
		const entered = deferred();
		const release = deferred();
		const abort = new AbortController();
		const path = join(root, "a");
		const first = withPathLocks([path], async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		let cancelledEntered = false;
		let laterEntered = false;
		const queued = withPathLocks(
			[path],
			async () => {
				cancelledEntered = true;
			},
			abort.signal,
		);
		const cancelled = queued.catch((error: unknown) => error);
		abort.abort();
		const later = withPathLocks([path], async () => {
			laterEntered = true;
		});
		try {
			expect(await cancelled).toBeInstanceOf(Error);
			await Bun.sleep(10);
			expect({ cancelledEntered, laterEntered }).toEqual({
				cancelledEntered: false,
				laterEntered: false,
			});
		} finally {
			release.resolve();
		}
		await Promise.all([first, later]);
		expect(laterEntered).toBe(true);
	});

	it("flushes ready checkpoints when integration interleaves a parallel write wave, preserving undo", async () => {
		const paths = [join(root, "a"), join(root, "b")];
		await Promise.all(paths.map((path) => writeFile(path, "before")));
		const bus = new EventBus();
		const store = new CheckpointStore(
			sessionPathsForRoot(join(root, "session")),
			bus,
		);
		const ctx = { turnId: "turn" };
		const metadata = await createMutationExecutionMetadata(
			paths.map((path, i) => ({
				toolCallId: String(i),
				toolName: "Write",
				paths: [path],
			})),
			root,
			store,
			ctx,
		);
		const order: string[] = [];
		let integration: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		const mutate = async (index: number) => {
			const path = paths[index]!;
			const toolCallId = String(index);
			const batch = metadata.get(toolCallId)!.checkpoint!;
			await batch.recordPreImages([{ absPath: path }], { ...ctx, toolCallId });
			await writeFile(path, `after ${index}`);
			await batch.recordPostImages([{ absPath: path }], { ...ctx, toolCallId });
			order.push(toolCallId);
		};
		try {
			await withPathLocks([paths[0]!], async () => {
				// Mirrors the worker integration's multi-path reservation landing
				// between two direct mutations in the same checkpoint wave.
				integration = withPathLocks(paths, async () => {
					order.push("integration");
				});
				second = withPathLocks([paths[1]!], () => mutate(1));
				await mutate(0);
			});
			await Promise.all([integration, second]);
			bus.emit({
				type: "turn:end",
				turnId: "turn",
				status: "completed",
				durationMs: 1,
			});
			await store.flush();
			const target = store.undoTarget();
			expect(target).toBeTruthy();
			await store.restore(await store.planRestore(target!), {
				skipDiverged: false,
			});
			expect({
				order,
				contents: await Promise.all(
					paths.map((path) => readFile(path, "utf8")),
				),
			}).toEqual({
				order: ["0", "integration", "1"],
				contents: ["before", "before"],
			});
		} finally {
			store.dispose();
		}
	}, 2000);

	for (const name of ["Write", "Edit", "ApplyPatch"] as const) {
		it(`${name} stops after cancellation during durable pre-image capture`, async () => {
			const path = join(root, "file.txt");
			await writeFile(path, "before\n");
			const abort = new AbortController();
			const checkpoints: CheckpointRecorder = {
				recordPreImage: async () => {
					abort.abort();
				},
				recordPostImage: async () => {},
				revertToolCall: async () => {},
				beginShellCapture: async () => {},
				endShellCapture: async () => {},
				captureWarning: () => null,
				scopedToTurn() {
					return this;
				},
			};
			const ctx = context(abort.signal, checkpoints);
			const operation =
				name === "Write"
					? new WriteTool().execute(
							{ file_path: path, content: "after\n" },
							ctx,
						)
					: name === "Edit"
						? new EditTool().execute(
								{
									file_path: path,
									edits: [{ old_str: "before", new_str: "after" }],
								},
								ctx,
							)
						: new ApplyPatchTool().execute(
								{
									patch:
										"*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
								},
								ctx,
							);
			await expect(operation).rejects.toThrow("aborted");
			expect(await readFile(path, "utf8")).toBe("before\n");
		});
	}
});
