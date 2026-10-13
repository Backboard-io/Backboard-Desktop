import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { sha256Hex } from "../src/core/checkpoints/blobStore.ts";
import { CheckpointStore } from "../src/core/checkpoints/CheckpointStore.ts";
import type { SessionPaths } from "../src/core/session/SessionStore.ts";
import { canonicalPhysicalPath } from "../src/utils/pathLocks.ts";

let root: string;
let work: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ckpt-test-"));
	work = join(root, "work");
	await mkdir(work, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function sessionPaths(): SessionPaths {
	const session = join(root, "session");
	const checkpoints = join(session, "checkpoints");
	return {
		root: session,
		clientLog: join(session, "client.jsonl"),
		serverLog: join(session, "server.jsonl"),
		meta: join(session, "meta.json"),
		workers: join(session, "workers.json"),
		checkpoints,
		// Like the real layout: objects + pointer shared next to session dirs.
		checkpointObjects: join(root, "objects"),
		pendingUndo: join(root, "pending-undo.json"),
	};
}

function makeStore(paths = sessionPaths()) {
	const bus = new EventBus();
	const store = new CheckpointStore(paths, bus);
	return { bus, store, paths };
}

function startTurn(bus: EventBus, turnId: string, label = "test turn"): void {
	bus.emit({ type: "user:message", text: label });
	bus.emit({ type: "turn:start", turnId });
}

function endTurn(bus: EventBus, turnId: string): void {
	bus.emit({ type: "turn:end", turnId, status: "completed", durationMs: 1 });
}

const ctx = (turnId: string, toolCallId: string) => ({ turnId, toolCallId });

async function undoLatest(store: CheckpointStore, skipDiverged = false) {
	const target = store.undoTarget();
	if (!target) throw new Error("expected an undo target");
	return store.restore(await store.planRestore(target), { skipDiverged });
}

describe("CheckpointStore", () => {
	it("undoes a new file by deleting it and pruning only empty createdDirs", async () => {
		const { bus, store } = makeStore();
		const dirA = join(work, "a");
		const dirB = join(dirA, "b");
		const file = join(dirB, "new.txt");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), {
			createdDirs: [dirA, dirB],
			tool: "Write",
		});
		await mkdir(dirB, { recursive: true });
		await writeFile(file, "created", "utf8");
		// A stray user file inside a created dir must block that dir's prune.
		const stray = join(dirA, "keep.txt");
		await writeFile(stray, "user data", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("created"));
		endTurn(bus, "t1");

		const result = await undoLatest(store);

		expect(result.deleted).toEqual([await canonicalPhysicalPath(file)]);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dirB)).toBe(false); // empty createdDir pruned
		expect(existsSync(dirA)).toBe(true); // non-empty createdDir kept
		expect(existsSync(stray)).toBe(true);
		expect(existsSync(work)).toBe(true); // never touches non-created dirs
	});

	it("restores true turn-start content for multi-edit turns (first pre-image wins)", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		await store.recordPreImage(file, ctx("t1", "c2"), { tool: "Edit" });
		await writeFile(file, "v2", "utf8");
		await store.recordPostImage(file, ctx("t1", "c2"), Buffer.from("v2"));
		endTurn(bus, "t1");

		await undoLatest(store);

		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("captures multi-file pre/post phases durably and restores the batch", async () => {
		const { bus, store, paths } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await Promise.all([
			writeFile(fileA, "a0", "utf8"),
			writeFile(fileB, "b0", "utf8"),
		]);

		startTurn(bus, "t1");
		await store.recordPreImages(
			[
				{ absPath: fileA, opts: { tool: "ApplyPatch" } },
				{ absPath: fileB, opts: { tool: "ApplyPatch" } },
			],
			ctx("t1", "c1"),
		);
		await Promise.all([
			writeFile(fileA, "a1", "utf8"),
			writeFile(fileB, "b1", "utf8"),
		]);
		await store.recordPostImages(
			[
				{ absPath: fileA, contentIfInMemory: Buffer.from("a1") },
				{ absPath: fileB, contentIfInMemory: Buffer.from("b1") },
			],
			ctx("t1", "c1"),
		);
		endTurn(bus, "t1");
		await store.flush();

		const records = (
			await readFile(join(paths.checkpoints, "journal.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; path?: string });
		await undoLatest(store);

		expect({
			phaseOrder: records
				.filter((record) => ["pre", "post"].includes(record.type))
				.map((record) => `${record.type}:${record.path}`),
			contents: await Promise.all([
				readFile(fileA, "utf8"),
				readFile(fileB, "utf8"),
			]),
		}).toEqual({
			phaseOrder: [
				`pre:${await canonicalPhysicalPath(fileA)}`,
				`pre:${await canonicalPhysicalPath(fileB)}`,
				`post:${await canonicalPhysicalPath(fileA)}`,
				`post:${await canonicalPhysicalPath(fileB)}`,
			],
			contents: ["a0", "b0"],
		});
	});

	it("persists each explicit plural capture phase as one journal batch", async () => {
		const { bus, store } = makeStore();
		const files = ["a.txt", "b.txt", "c.txt"].map((name) => join(work, name));
		const journal = (
			store as unknown as {
				journal: { writeBatch(records: readonly object[]): Promise<void> };
			}
		).journal;
		const writeBatch = journal.writeBatch.bind(journal);
		const batchSizes: number[] = [];
		journal.writeBatch = async (records) => {
			batchSizes.push(records.length);
			await writeBatch(records);
		};

		startTurn(bus, "t1");
		await store.recordPreImages(
			files.map((absPath, index) => ({
				absPath,
				toolCallId: `c${index}`,
				opts: { tool: "Write" },
			})),
			{ turnId: "t1" },
		);
		expect(batchSizes).toEqual([1, 3]);

		await Promise.all(
			files.map(async (file, index) => {
				const content = Buffer.from(`value ${index}`);
				await writeFile(file, content);
				return content;
			}),
		);
		await store.recordPostImages(
			files.map((absPath, index) => ({
				absPath,
				toolCallId: `c${index}`,
				contentIfInMemory: Buffer.from(`value ${index}`),
			})),
			{ turnId: "t1" },
		);
		expect(batchSizes).toEqual([1, 3, 3]);
		expect(
			(
				store as unknown as {
					records: Array<{ type: string; toolCallId?: string }>;
				}
			).records
				.filter((record) => record.type === "pre" || record.type === "post")
				.map((record) => `${record.type}:${record.toolCallId}`),
		).toEqual(["pre:c0", "pre:c1", "pre:c2", "post:c0", "post:c1", "post:c2"]);
	});

	it("does not index a plural pre-image batch whose journal append fails", async () => {
		const { bus, store } = makeStore();
		const seed = join(work, "seed.txt");
		await writeFile(seed, "seed", "utf8");
		startTurn(bus, "t1");
		await store.recordPreImage(seed, ctx("t1", "seed"), { tool: "Edit" });

		const internals = store as unknown as {
			records: Array<{ type: string; toolCallId?: string }>;
			journal: { writeBatch(records: readonly object[]): Promise<void> };
		};
		const beforeCount = internals.records.length;
		internals.journal.writeBatch = async () => {
			throw new Error("pre batch append failed");
		};

		await expect(
			store.recordPreImages(
				["a.txt", "b.txt"].map((name, index) => ({
					absPath: join(work, name),
					toolCallId: `failed-pre-${index}`,
					opts: { tool: "Write" },
				})),
				{ turnId: "t1" },
			),
		).rejects.toThrow("pre batch append failed");

		expect(internals.records).toHaveLength(beforeCount);
		expect(
			internals.records.some((record) =>
				record.toolCallId?.startsWith("failed-pre-"),
			),
		).toBe(false);
	});

	it("does not index a plural post-image batch whose journal append fails", async () => {
		const { bus, store } = makeStore();
		const files = [join(work, "a.txt"), join(work, "b.txt")];
		await Promise.all(files.map((file) => writeFile(file, "before", "utf8")));
		startTurn(bus, "t1");
		await store.recordPreImages(
			files.map((absPath, index) => ({
				absPath,
				toolCallId: `call-${index}`,
				opts: { tool: "Write" },
			})),
			{ turnId: "t1" },
		);
		await Promise.all(files.map((file) => writeFile(file, "after", "utf8")));

		const internals = store as unknown as {
			records: Array<{ type: string; toolCallId?: string }>;
			journal: { writeBatch(records: readonly object[]): Promise<void> };
		};
		const beforeCount = internals.records.length;
		internals.journal.writeBatch = async () => {
			throw new Error("post batch append failed");
		};

		await expect(
			store.recordPostImages(
				files.map((absPath, index) => ({
					absPath,
					toolCallId: `call-${index}`,
					contentIfInMemory: Buffer.from("after"),
				})),
				{ turnId: "t1" },
			),
		).rejects.toThrow("post batch append failed");

		expect(internals.records).toHaveLength(beforeCount);
		expect(
			internals.records.filter((record) => record.type === "post"),
		).toHaveLength(0);
	});

	it("undoes an ApplyPatch move: source recreated, destination deleted", async () => {
		const { bus, store } = makeStore();
		const src = join(work, "src.txt");
		const dst = join(work, "dst.txt");
		await writeFile(src, "moved content", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(src, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await store.recordPreImage(dst, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await unlink(src);
		await writeFile(dst, "moved content", "utf8");
		await store.recordPostImage(src, ctx("t1", "c1"));
		await store.recordPostImage(
			dst,
			ctx("t1", "c1"),
			Buffer.from("moved content"),
		);
		endTurn(bus, "t1");

		await undoLatest(store);

		expect(await readFile(src, "utf8")).toBe("moved content");
		expect(existsSync(dst)).toBe(false);
	});

	it("detects divergence and honors skipDiverged", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		// User hand-edits after the agent's write.
		await writeFile(file, "hand edited", "utf8");

		const target = store.undoTarget();
		if (!target) throw new Error("expected an undo target");
		const plan = await store.planRestore(target);
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]?.diverged).toBe(true);

		const skippedResult = await store.restore(plan, { skipDiverged: true });
		expect(skippedResult.restored).toEqual([]);
		expect(skippedResult.skipped).toEqual([
			{ path: await canonicalPhysicalPath(file), reason: "diverged" },
		]);
		expect(await readFile(file, "utf8")).toBe("hand edited");

		const forcedResult = await store.restore(plan, { skipDiverged: false });
		expect(forcedResult.restored).toEqual([await canonicalPhysicalPath(file)]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("replays an interrupted restore (undo:start without undo:done) idempotently", async () => {
		const { bus, store, paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");
		await store.flush();

		// Simulate a crash mid-restore: the write-ahead marker landed in the
		// journal, but no disk mutation nor undo:done happened.
		const crashRecord = {
			type: "undo:start",
			undoId: "undo_crash",
			targetCheckpointId: "t1",
			redoCheckpointId: null,
			files: [
				{
					path: file,
					action: "write",
					diverged: false,
					hash: sha256Hex(Buffer.from("v0")),
					mode: 0o644,
				},
			],
			seq: 999,
			ts: new Date().toISOString(),
		};
		await appendFile(
			join(paths.checkpoints, "journal.jsonl"),
			`${JSON.stringify(crashRecord)}\n`,
		);

		const reloaded = makeStore(paths).store;
		await reloaded.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");

		// Re-running recovery is a no-op.
		await reloaded.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");

		// A store loaded after recovery sees the undo:done marker on disk.
		const reloadedAgain = makeStore(paths).store;
		await reloadedAgain.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("round-trips CRLF/BOM/binary content byte-exactly", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.bin");
		const original = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]), // BOM
			Buffer.from("line one\r\nline two\r", "latin1"),
			Buffer.from([0x00, 0xff, 0x10, 0x80]), // binary bytes
		]);
		await writeFile(file, original);

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Write" });
		await writeFile(file, "plain utf8 replacement\n", "utf8");
		await store.recordPostImage(
			file,
			ctx("t1", "c1"),
			Buffer.from("plain utf8 replacement\n"),
		);
		endTurn(bus, "t1");

		await undoLatest(store);

		const restored = await readFile(file);
		expect(restored.equals(original)).toBe(true);
	});

	it("restores a redo point and invalidates it on a new agent write", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const undoResult = await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
		expect(undoResult.redoCheckpointId).not.toBeNull();
		expect(store.redoTarget()).toBe(undoResult.redoCheckpointId ?? "");

		// Redo reapplies the undone state...
		const redoTarget = store.redoTarget();
		if (!redoTarget) throw new Error("expected a redo target");
		await store.restore(await store.planRestore(redoTarget), {
			skipDiverged: false,
		});
		expect(await readFile(file, "utf8")).toBe("v1");
		// ...and /undo targets the same turn again after a redo.
		expect(store.undoTarget()).toBe("t1");

		// A fresh undo re-arms redo; a new agent write invalidates it.
		await undoLatest(store);
		expect(store.redoTarget()).not.toBeNull();
		startTurn(bus, "t2");
		const other = join(work, "g.txt");
		await store.recordPreImage(other, ctx("t2", "c2"), { tool: "Write" });
		await writeFile(other, "new", "utf8");
		await store.recordPostImage(other, ctx("t2", "c2"), Buffer.from("new"));
		endTurn(bus, "t2");
		expect(store.redoTarget()).toBeNull();
	});

	it("captures and reverts a file larger than the former pre-image cap", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "huge.bin");
		const original = Buffer.alloc(2 * 1024 * 1024, 7);
		await writeFile(file, original);

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Write" });
		await writeFile(file, "shrunk", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("shrunk"));
		endTurn(bus, "t1");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.skippedFiles).toEqual([]);

		const plan = await store.planRestore("t1");
		expect(plan.entries[0]?.action).toBe("write");

		await undoLatest(store);
		expect(await readFile(file)).toEqual(original);
	}, 30_000);

	it("canonicalizes a symlink capture and restores its target without clobbering the link", async () => {
		const { bus, store } = makeStore();
		const target = join(work, "target.txt");
		const link = join(work, "link.txt");
		await writeFile(target, "real", "utf8");
		await symlink(target, link);

		startTurn(bus, "t1");
		await store.recordPreImage(link, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(link, "changed", "utf8");
		await store.recordPostImage(link, ctx("t1", "c1"), Buffer.from("changed"));
		endTurn(bus, "t1");

		const plan = await store.planRestore("t1");
		expect(plan.entries).toEqual([
			expect.objectContaining({
				path: await canonicalPhysicalPath(target),
				action: "write",
				diverged: false,
			}),
		]);

		await store.restore(plan, { skipDiverged: false });
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("real");
	});

	it("composes real and symlink aliases as one path when undoing a turn", async () => {
		const { bus, store } = makeStore();
		const target = join(work, "target.txt");
		const link = join(work, "link.txt");
		await writeFile(target, "v0", "utf8");
		await symlink(target, link);

		startTurn(bus, "t1");
		await store.recordPreImage(target, ctx("t1", "real-edit"), {
			tool: "Edit",
		});
		await writeFile(target, "v1", "utf8");
		await store.recordPostImage(
			target,
			ctx("t1", "real-edit"),
			Buffer.from("v1"),
		);
		await store.recordPreImage(link, ctx("t1", "alias-edit"), { tool: "Edit" });
		await writeFile(link, "v2", "utf8");
		await store.recordPostImage(
			link,
			ctx("t1", "alias-edit"),
			Buffer.from("v2"),
		);
		endTurn(bus, "t1");

		await undoLatest(store);

		expect(await readFile(target, "utf8")).toBe("v0");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it("rolls back a mid-loop ApplyPatch failure via revertToolCall", async () => {
		const { bus, store } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a v0", "utf8");

		startTurn(bus, "t1");
		// Pre-images for every action path are captured up front.
		await store.recordPreImage(fileA, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await store.recordPreImage(fileB, ctx("t1", "c1"), { tool: "ApplyPatch" });
		// First two writes land, then the patch loop "fails".
		await writeFile(fileA, "a v1", "utf8");
		await store.recordPostImage(fileA, ctx("t1", "c1"), Buffer.from("a v1"));
		await writeFile(fileB, "b created", "utf8");

		await store.revertToolCall("c1");

		expect(await readFile(fileA, "utf8")).toBe("a v0");
		expect(existsSync(fileB)).toBe(false);
	});

	it("walks back through checkpoints on repeated undo and composes across turns", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1", "first change");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		startTurn(bus, "t2", "second change");
		await store.recordPreImage(file, ctx("t2", "c2"), { tool: "Edit" });
		await writeFile(file, "v2", "utf8");
		await store.recordPostImage(file, ctx("t2", "c2"), Buffer.from("v2"));
		endTurn(bus, "t2");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
			"t2",
			"t1",
		]);
		expect(checkpoints[0]?.label).toBe("second change");
		expect(checkpoints[0]?.files).toEqual([await canonicalPhysicalPath(file)]);

		expect(store.undoTarget()).toBe("t2");
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v1");

		expect(store.undoTarget()).toBe("t1");
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");

		expect(store.undoTarget()).toBeNull();
	});

	it("folds sub-agent edits into the parent turn via scopedToTurn", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "sub.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "parent", "delegate work");
		// The sub-agent journals under its own turn ids, which are never
		// finalized on the main bus; the scoped recorder re-attributes them.
		const recorder = store.scopedToTurn("parent");
		// A nested sub-agent re-scopes; the root attribution must win.
		const nested = recorder.scopedToTurn("sub-turn-2");
		await nested.recordPreImage(file, ctx("sub-turn-1", "c1"), {
			tool: "Edit",
		});
		await writeFile(file, "v1", "utf8");
		await nested.recordPostImage(
			file,
			ctx("sub-turn-1", "c1"),
			Buffer.from("v1"),
		);
		endTurn(bus, "parent"); // only the parent turn ever finalizes

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.id).toBe("parent");
		expect(checkpoints[0]?.files).toEqual([await canonicalPhysicalPath(file)]);

		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("captures a pre-image for requireRevertible even when the file is large", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "huge.bin");
		const original = Buffer.alloc(2 * 1024 * 1024, 9);
		await writeFile(file, original);

		startTurn(bus, "t1");
		// No size cap: a large pre-image is captured rather than refused.
		await store.recordPreImage(file, ctx("t1", "c1"), {
			tool: "ApplyPatch",
			requireRevertible: true,
		});
		await writeFile(file, "small", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("small"));
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toHaveLength(1);
		await undoLatest(store);
		expect(await readFile(file)).toEqual(original);
	}, 30_000);

	it("skips a path whose restore fails and still completes the undo", async () => {
		const { bus, store, paths } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a0", "utf8");
		await writeFile(fileB, "b0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(fileA, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(fileA, "a1", "utf8");
		await store.recordPostImage(fileA, ctx("t1", "c1"), Buffer.from("a1"));
		await store.recordPreImage(fileB, ctx("t1", "c2"), { tool: "Edit" });
		await writeFile(fileB, "b1", "utf8");
		await store.recordPostImage(fileB, ctx("t1", "c2"), Buffer.from("b1"));
		endTurn(bus, "t1");

		// Corrupt the blob store: fileA's pre-image blob goes missing.
		const hashA = sha256Hex(Buffer.from("a0"));
		await rm(join(paths.checkpointObjects, hashA.slice(0, 2), hashA), {
			force: true,
		});

		const result = await undoLatest(store);
		expect(result.restored).toEqual([await canonicalPhysicalPath(fileB)]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.path).toBe(await canonicalPhysicalPath(fileA));
		expect(result.skipped[0]?.reason).toMatch(/^error: /);
		expect(await readFile(fileB, "utf8")).toBe("b0");
		expect(await readFile(fileA, "utf8")).toBe("a1"); // untouched

		// The undo completed (undo:done landed): nothing dangles, and redo
		// plus further restores keep working.
		await store.recoverIfNeeded();
		expect(await readFile(fileB, "utf8")).toBe("b0");
		expect(store.redoTarget()).not.toBeNull();
	});

	it("re-checks divergence under the lock at apply time", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const plan = await store.planRestore("t1");
		expect(plan.entries[0]?.diverged).toBe(false);

		// Hand edit while the confirm picker sits open: the stale plan says
		// clean, but "skip hand-edited files" must still protect the edit.
		await writeFile(file, "hand edited", "utf8");
		const skipping = await store.restore(plan, { skipDiverged: true });
		expect(skipping.restored).toEqual([]);
		expect(skipping.skipped).toEqual([
			{ path: await canonicalPhysicalPath(file), reason: "diverged" },
		]);
		expect(await readFile(file, "utf8")).toBe("hand edited");

		// "Revert all" still clobbers, as the user explicitly asked.
		const forced = await store.restore(plan, { skipDiverged: false });
		expect(forced.restored).toEqual([await canonicalPhysicalPath(file)]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("completes a crashed process's restore via the pending-undo pointer", async () => {
		const { bus, store, paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");
		await store.flush();

		// Simulate a hard crash mid-restore in another (now dead) process: the
		// journal holds a dangling undo:start and the workspace pointer names
		// this session. A fresh launch never reloads the old journal itself —
		// it must follow the pointer.
		const crashRecord = {
			type: "undo:start",
			undoId: "undo_crash",
			targetCheckpointId: "t1",
			redoCheckpointId: null,
			skipDiverged: false,
			files: [
				{
					path: file,
					action: "write",
					diverged: false,
					hash: sha256Hex(Buffer.from("v0")),
					mode: 0o644,
				},
			],
			seq: 999,
			ts: new Date().toISOString(),
		};
		await appendFile(
			join(paths.checkpoints, "journal.jsonl"),
			`${JSON.stringify(crashRecord)}\n`,
		);
		await writeFile(
			paths.pendingUndo,
			JSON.stringify({
				sessionRoot: paths.root,
				undoId: "undo_crash",
				pid: 999999999, // long dead
			}),
			"utf8",
		);

		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);

		expect(await readFile(file, "utf8")).toBe("v0");
		expect(existsSync(paths.pendingUndo)).toBe(false);

		// Idempotent: a second recovery pass finds nothing to do.
		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("leaves a live process's pending-undo pointer alone", async () => {
		const { paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v1", "utf8");
		await mkdir(paths.checkpoints, { recursive: true });
		await writeFile(
			paths.pendingUndo,
			JSON.stringify({
				sessionRoot: paths.root,
				undoId: "undo_live",
				pid: 1, // init/launchd: alive (EPERM), not this process
			}),
			"utf8",
		);

		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);

		expect(existsSync(paths.pendingUndo)).toBe(true);
		expect(await readFile(file, "utf8")).toBe("v1");
	});

	it("emits checkpoint:restored on the bus", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const events: Array<{ checkpointId: string; files: number }> = [];
		bus.on("checkpoint:restored", (event) => {
			events.push({ checkpointId: event.checkpointId, files: event.files });
		});
		await undoLatest(store);

		expect(events).toEqual([{ checkpointId: "t1", files: 1 }]);
	});
});
