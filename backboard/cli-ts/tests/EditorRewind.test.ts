import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CheckpointManager } from "../src/core/checkpoints/CheckpointManager.ts";
import { EditorRewind } from "../src/core/checkpoints/EditorRewind.ts";
import type {
	RestorePlan,
	RestoreResult,
} from "../src/core/checkpoints/journalTypes.ts";
import { sessionPathsForRoot } from "../src/core/session/SessionStore.ts";

let root: string;
let work: string;
let checkpoints: CheckpointManager;
let rewind: EditorRewind;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "editor-rewind-")));
	work = join(root, "workspace");
	await mkdir(work);
	checkpoints = new CheckpointManager(
		new EventBus(),
		sessionPathsForRoot(join(root, "session")),
		work,
	);
	rewind = new EditorRewind(checkpoints);
	await rewind.initialize();
});
afterEach(async () => {
	await checkpoints.dispose();
	await rm(root, { recursive: true, force: true });
});

async function turn(id: string, change: () => Promise<void>): Promise<void> {
	await checkpoints.beginTurn(id, id, work);
	await change();
	await checkpoints.endTurn(id);
}

describe("Editor rewind", () => {
	it("restores shell-only changes before the selected request and recovers manual edits", async () => {
		const file = join(work, "mario.html");
		await writeFile(file, "A");
		await turn("one", async () => {});
		await turn("two", async () => {
			await writeFile(file, "B");
		});
		await turn("three", async () => {
			await writeFile(file, "C");
		});
		await writeFile(file, "manual edit");
		await writeFile(join(work, "unrelated.txt"), "keep");
		const prepared = await rewind.prepare("restore-1", ["two", "three"]);
		const committed = await rewind.commit(prepared.id, [
			{ path: file, content: "unsaved edit" },
		]);
		expect([
			await readFile(file, "utf8"),
			await readFile(join(work, "unrelated.txt"), "utf8"),
			committed.status,
		]).toEqual(["A", "keep", "committed"]);
		// A transport retry must not recapture or restore the files again.
		expect((await rewind.commit(prepared.id, [])).backupId).toBe(
			committed.backupId,
		);
		const recovered = await rewind.recover(prepared.id);
		expect({
			disk: await readFile(file, "utf8"),
			buffers: recovered.buffers,
		}).toEqual({
			disk: "manual edit",
			buffers: [{ path: file, content: "unsaved edit" }],
		});
	});

	it("preserves empty files, reverses create/delete/rename, and supports redo", async () => {
		const empty = join(work, "empty.txt");
		const old = join(work, "old.txt");
		const moved = join(work, "moved.txt");
		const created = join(work, "created.txt");
		await writeFile(empty, "");
		await writeFile(old, "original");
		await turn("change", async () => {
			await unlink(empty);
			await rename(old, moved);
			await writeFile(created, "new");
		});
		await rewind.prepare("undo", ["change"]);
		const undo = await rewind.commit("undo", []);
		expect([
			await readFile(empty, "utf8"),
			await readFile(old, "utf8"),
		]).toEqual(["", "original"]);
		expect(await Bun.file(created).exists()).toBe(false);
		expect(await Bun.file(moved).exists()).toBe(false);
		await rewind.prepare("redo", [], undo.backupId);
		await rewind.commit("redo", []);
		expect([
			await readFile(moved, "utf8"),
			await readFile(created, "utf8"),
		]).toEqual(["original", "new"]);
		expect(await Bun.file(empty).exists()).toBe(false);
	});

	it("redoes every file after stepping back across disjoint requests", async () => {
		const first = join(work, "first.txt");
		const second = join(work, "second.txt");
		await writeFile(first, "A");
		await writeFile(second, "A");
		await turn("first", async () => {
			await writeFile(first, "B");
		});
		await turn("second", async () => {
			await writeFile(second, "B");
		});
		await rewind.prepare("step-1", ["second"]);
		const one = await rewind.commit("step-1", []);
		await rewind.prepare("step-2", ["first", "second"], one.headBackupId);
		const two = await rewind.commit("step-2", []);
		await rewind.prepare("redo-all", [], two.headBackupId);
		await rewind.commit("redo-all", []);
		expect([
			await readFile(first, "utf8"),
			await readFile(second, "utf8"),
		]).toEqual(["B", "B"]);
	});

	it("keeps request-start bytes when a worker integrates after the request finishes", async () => {
		const file = join(work, "worker.txt");
		await writeFile(file, "request start");
		await turn("worker-parent", async () => {});
		await writeFile(file, "later manual edit");
		const context = {
			turnId: "worker-parent",
			toolCallId: "late-worker",
			tool: "worker-integration",
		};
		await checkpoints.recordPreImage(file, context);
		await writeFile(file, "worker result");
		await checkpoints.recordPostImage(file, context);
		await rewind.prepare("late", ["worker-parent"]);
		await rewind.commit("late", []);
		expect(await readFile(file, "utf8")).toBe("request start");
	});

	it("exports ordinary recovery files and unsaved buffers that survive a new branch", async () => {
		const file = join(work, "code.txt");
		await writeFile(file, "before");
		await turn("edit", async () => {
			await writeFile(file, "after");
		});
		await rewind.prepare("backup", ["edit"]);
		await rewind.commit("backup", [
			{ path: file, content: "unsaved", encoding: "utf16le" },
		]);
		await turn("new-branch", async () => {
			await writeFile(file, "new branch");
		});
		const backup = join(
			checkpoints.paths.checkpoints,
			"editor-rewind-backups",
			"backup",
		);
		expect([
			await readFile(join(backup, "disk", "0-code.txt"), "utf8"),
			await readFile(join(backup, "buffers", "0-code.txt"), "utf8"),
		]).toEqual(["after", "unsaved"]);
		expect(
			JSON.parse(
				await readFile(join(backup, "buffers", "manifest.json"), "utf8"),
			),
		).toEqual([
			{
				path: file,
				encoding: "utf16le",
				file: "0-code.txt",
				storedEncoding: "utf8",
			},
		]);
	});

	it("rejects unknown and interrupted boundaries before changing files", async () => {
		await expect(rewind.prepare("missing", ["legacy"])).rejects.toThrow(
			"Checkpoint unavailable",
		);
		await checkpoints.beginTurn("interrupted", "interrupted", work);
		await expect(rewind.prepare("unfinished", ["interrupted"])).rejects.toThrow(
			"Checkpoint unavailable",
		);
	});

	it("composes only the active branch after a rewind and a new request", async () => {
		const file = join(work, "code.txt");
		await writeFile(file, "A");
		await turn("one", async () => {
			await writeFile(file, "B");
		});
		await turn("discarded", async () => {
			await writeFile(file, "C");
		});
		await rewind.prepare("undo", ["discarded"]);
		await rewind.commit("undo", []);
		await turn("replacement", async () => {
			await writeFile(file, "D");
		});
		await rewind.prepare("undo-new", ["replacement"]);
		await rewind.commit("undo-new", []);
		expect(await readFile(file, "utf8")).toBe("B");
		await rewind.prepare("undo-all", ["one", "replacement"]);
		await rewind.commit("undo-all", []);
		expect(await readFile(file, "utf8")).toBe("A");
	});

	it("rolls back a partial filesystem restore instead of reporting success", async () => {
		class FailingCheckpoints extends CheckpointManager {
			failNext = false;
			override async restore(
				plan: RestorePlan,
				options: { skipDiverged: boolean },
			): Promise<RestoreResult> {
				if (!this.failNext) return super.restore(plan, options);
				this.failNext = false;
				const result = await super.restore(
					{ ...plan, entries: plan.entries.slice(0, 1) },
					options,
				);
				return {
					...result,
					skipped: [{ path: plan.entries[1]!.path, reason: "EACCES" }],
				};
			}
		}
		await checkpoints.dispose();
		const failing = new FailingCheckpoints(
			new EventBus(),
			sessionPathsForRoot(join(root, "session")),
			work,
		);
		checkpoints = failing;
		rewind = new EditorRewind(checkpoints);
		await rewind.initialize();
		for (const name of ["a", "b"]) await writeFile(join(work, name), "before");
		await turn("edit", async () => {
			for (const name of ["a", "b"]) await writeFile(join(work, name), "after");
		});
		await rewind.prepare("partial", ["edit"]);
		failing.failNext = true;
		await expect(rewind.commit("partial", [])).rejects.toThrow("EACCES");
		expect(
			await Promise.all(
				["a", "b"].map((name) => readFile(join(work, name), "utf8")),
			),
		).toEqual(["after", "after"]);
	});

	it("recovers a crash during a restore before permitting another request", async () => {
		const file = join(work, "code");
		await writeFile(file, "before");
		await turn("edit", async () => {
			await writeFile(file, "after");
		});
		await rewind.prepare("crash", ["edit"]);
		await rewind.commit("crash", []);
		const journal = join(checkpoints.paths.checkpoints, "editor-rewinds.json");
		const state = JSON.parse(await readFile(journal, "utf8"));
		state.transactions.crash.status = "applying";
		await writeFile(journal, JSON.stringify(state));
		await checkpoints.dispose();
		checkpoints = new CheckpointManager(
			new EventBus(),
			sessionPathsForRoot(join(root, "session")),
			work,
		);
		rewind = new EditorRewind(checkpoints);
		await rewind.initialize();
		expect(await readFile(file, "utf8")).toBe("after");
		expect(() => rewind.assertReady()).not.toThrow();
	});
});
