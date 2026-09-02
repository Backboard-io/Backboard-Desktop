import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { CheckpointRecorder } from "../src/core/checkpoints/CheckpointStore.ts";
import { ALLOW_ONCE } from "../src/core/permissions/PermissionPrompter.ts";
import { parseRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { ApplyPatchTool } from "../src/tools/ApplyPatchTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";

function context(cwd: string): ToolContext {
	return {
		sessionId: "sess_test",
		cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		agentDepth: 0,
	};
}

async function tempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cli-tools-"));
}

describe("mutation tools", () => {
	it("approves and starts three disjoint writes as one parallel round", async () => {
		const cwd = await tempDir();
		let prompts = 0;
		let activeCaptures = 0;
		let maxActiveCaptures = 0;
		let preBatches = 0;
		let postBatches = 0;
		const checkpoints: CheckpointRecorder = {
			recordPreImage: async () => {},
			recordPostImage: async () => {},
			recordPreImages: async (requests) => {
				preBatches++;
				activeCaptures += requests.length;
				maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
				await Bun.sleep(20);
				activeCaptures -= requests.length;
			},
			recordPostImages: async () => {
				postBatches++;
			},
			revertToolCall: async () => {},
			beginShellCapture: async () => {},
			endShellCapture: async () => {},
			captureWarning: () => null,
			scopedToTurn() {
				return this;
			},
		};
		const ctx: ToolContext = {
			...context(cwd),
			checkpoints,
			permissions: {
				mode: "manual",
				rules: parseRuleSet({}),
				interactive: true,
			},
			askUser: async () => {
				prompts++;
				return ALLOW_ONCE;
			},
		};
		const scheduler = new ToolScheduler(
			new ToolRegistry([new WriteTool()]),
			ctx.bus,
		);

		const outputs = await scheduler.run(
			["a.txt", "b.txt", "c.txt"].map((file, index) => ({
				id: `write_${index}`,
				name: "Write",
				input: { file_path: file, content: file },
			})),
			ctx,
		);

		expect({
			prompts,
			preBatches,
			postBatches,
			maxActiveCaptures,
			errors: outputs.filter((output) => output.metadata?.error).length,
			contents: await Promise.all(
				["a.txt", "b.txt", "c.txt"].map((file) =>
					readFile(join(cwd, file), "utf8"),
				),
			),
		}).toEqual({
			prompts: 1,
			preBatches: 1,
			postBatches: 1,
			maxActiveCaptures: 3,
			errors: 0,
			contents: ["a.txt", "b.txt", "c.txt"],
		});
	});

	it("runs one round-wide diagnostic sweep after every disjoint write commits", async () => {
		const cwd = await tempDir();
		const ctx = context(cwd);
		const files = ["a.txt", "b.txt", "c.txt"];
		let active = 0;
		let maxActive = 0;
		let allCommittedAtFirstTouch = false;
		let diagnosticsTimings = 0;
		ctx.bus.on("performance:timing", (event) => {
			if (event.phase === "diagnostics") diagnosticsTimings++;
		});
		ctx.lsp = {
			enabled: true,
			touchFile: async () => {
				if (active === 0) {
					allCommittedAtFirstTouch = (
						await Promise.all(
							files.map(
								async (file) =>
									(await readFile(join(cwd, file), "utf8")) === file,
							),
						)
					).every(Boolean);
				}
				active++;
				maxActive = Math.max(maxActive, active);
				await Bun.sleep(20);
				active--;
			},
			diagnosticsForFile: () => [],
		} as unknown as ToolContext["lsp"];
		const scheduler = new ToolScheduler(
			new ToolRegistry([new WriteTool()]),
			ctx.bus,
		);

		const outputs = await scheduler.run(
			files.map((file, index) => ({
				id: `diagnostic_write_${index}`,
				name: "Write",
				input: { file_path: file, content: file },
			})),
			ctx,
		);

		expect({
			allCommittedAtFirstTouch,
			diagnosticsTimings,
			maxActive,
			errors: outputs.filter((output) => output.metadata?.error).length,
		}).toEqual({
			allCommittedAtFirstTouch: true,
			diagnosticsTimings: 1,
			maxActive: 3,
			errors: 0,
		});
	});

	it("does not deadlock a valid mutation behind a peer that fails before capture", async () => {
		const cwd = await tempDir();
		await symlink(join(cwd, "missing-target.txt"), join(cwd, "dangling.txt"));
		const ctx = context(cwd);
		ctx.checkpoints = {
			recordPreImage: async () => {},
			recordPostImage: async () => {},
			recordPreImages: async () => {},
			recordPostImages: async () => {},
			revertToolCall: async () => {},
			beginShellCapture: async () => {},
			endShellCapture: async () => {},
			captureWarning: () => null,
			scopedToTurn() {
				return this;
			},
		};
		const scheduler = new ToolScheduler(
			new ToolRegistry([new WriteTool()]),
			ctx.bus,
		);

		const outputs = await Promise.race([
			scheduler.run(
				[
					{
						id: "valid_write",
						name: "Write",
						input: { file_path: "valid.txt", content: "complete" },
					},
					{
						id: "invalid_write",
						name: "Write",
						input: { file_path: "dangling.txt", content: "blocked" },
					},
				],
				ctx,
			),
			Bun.sleep(1_000).then(() => {
				throw new Error("mutation batch deadlocked");
			}),
		]);

		expect({
			content: await readFile(join(cwd, "valid.txt"), "utf8"),
			errors: outputs.filter((output) => output.metadata?.error).length,
		}).toEqual({ content: "complete", errors: 1 });
	});

	it("does not deadlock a disjoint checkpoint cohort across a transitive overlap", async () => {
		const cwd = await tempDir();
		await Promise.all([
			writeFile(join(cwd, "x.txt"), "x0\n", "utf8"),
			writeFile(join(cwd, "y.txt"), "y0\n", "utf8"),
		]);
		const ctx = context(cwd);
		ctx.checkpoints = {
			recordPreImage: async () => {},
			recordPostImage: async () => {},
			recordPreImages: async () => {},
			recordPostImages: async () => {},
			revertToolCall: async () => {},
			beginShellCapture: async () => {},
			endShellCapture: async () => {},
			captureWarning: () => null,
			scopedToTurn() {
				return this;
			},
		};
		const scheduler = new ToolScheduler(
			new ToolRegistry([new WriteTool(), new ApplyPatchTool(), new EditTool()]),
			ctx.bus,
		);
		const patch = [
			"*** Begin Patch",
			"*** Update File: x.txt",
			"@@",
			"-x1",
			"+x2",
			"*** Update File: y.txt",
			"@@",
			"-y0",
			"+y1",
			"*** End Patch",
		].join("\n");

		const outputs = await Promise.race([
			scheduler.run(
				[
					{
						id: "write_x",
						name: "Write",
						input: { file_path: "x.txt", content: "x1\n" },
					},
					{
						id: "patch_xy",
						name: "ApplyPatch",
						input: { patch },
					},
					{
						id: "edit_y",
						name: "Edit",
						input: {
							file_path: "y.txt",
							edits: [{ old_str: "y1", new_str: "y2" }],
						},
					},
				],
				ctx,
			),
			Bun.sleep(1_000).then(() => {
				throw new Error("transitive mutation batch deadlocked");
			}),
		]);

		expect(outputs.every((output) => !output.metadata?.error)).toBe(true);
		expect(await readFile(join(cwd, "x.txt"), "utf8")).toBe("x2\n");
		expect(await readFile(join(cwd, "y.txt"), "utf8")).toBe("y2\n");
	});

	it("writes full file contents", async () => {
		const cwd = await tempDir();
		const tool = new WriteTool();

		const result = await tool.execute(
			{ file_path: "nested/file.txt", content: "hello\nworld\n" },
			context(cwd),
		);

		expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe(
			"hello\nworld\n",
		);
		expect(result.fileEdits).toEqual([
			{
				path: join(cwd, "nested/file.txt"),
				before: "",
				after: "hello\nworld\n",
			},
		]);
	});

	it("rolls back a write when post-image durability fails", async () => {
		const cwd = await tempDir();
		const ctx = context(cwd);
		ctx.checkpoints = checkpointRecorderWithFailingPostFlush();

		await expect(
			new WriteTool().execute(
				{ file_path: "nested/file.txt", content: "must not remain" },
				ctx,
			),
		).rejects.toThrow("post-image flush failed");
		await expect(
			readFile(join(cwd, "nested/file.txt"), "utf8"),
		).rejects.toThrow();
	});

	it("rolls back an edit when post-image durability fails", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "before\n", "utf8");
		const ctx = context(cwd);
		ctx.checkpoints = checkpointRecorderWithFailingPostFlush();

		await expect(
			new EditTool().execute(
				{
					file_path: "file.txt",
					edits: [{ old_str: "before", new_str: "after" }],
				},
				ctx,
			),
		).rejects.toThrow("post-image flush failed");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("before\n");
	});

	it("applies multiple multiline edits and legacy single edits", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\nthree\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [
					{ old_str: "one\ntwo", new_str: "1\n2" },
					{ old_str: "three", new_str: "3" },
				],
			},
			context(cwd),
		);
		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				old_str: "1",
				new_str: "one",
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\n2\n3\n");
	});

	it("normalizes edits sent as a JSON string array", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: JSON.stringify([
					{ old_str: "one", new_str: "1" },
					{ old_str: "two", new_str: "2" },
				]),
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("1\n2\n");
	});

	it("normalizes edits sent as a single object", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: { old_str: "one", new_str: "1" },
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("1\ntwo\n");
	});

	it("normalizes edits sent as a JSON string of a single object", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: JSON.stringify({ old_str: "two", new_str: "2" }),
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\n2\n");
	});

	it("treats $ sequences in new_str literally", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "price = X\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "X", new_str: "$${amount} and $1" }],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"price = $${amount} and $1\n",
		);
	});

	it("matches multiline edits in CRLF files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\r\nbeta\r\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "alpha\nbeta", new_str: "one\ntwo" }],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"one\r\ntwo\r\n",
		);
	});

	it("does not partially write when a later edit fails", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\nbeta\n", "utf8");
		const tool = new EditTool();

		await expect(
			tool.execute(
				{
					file_path: "file.txt",
					edits: [
						{ old_str: "alpha", new_str: "one" },
						{ old_str: "missing", new_str: "two" },
					],
				},
				context(cwd),
			),
		).rejects.toThrow("old_str not found");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nbeta\n");
	});

	it("matches every old_str against the original snapshot, not earlier edits", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "file.txt"),
			"const a = 1;\nconst b = a;\n",
			"utf8",
		);
		const tool = new EditTool();

		// Under sequential semantics the first edit would rewrite the text the
		// second edit needs to match; under snapshot semantics both match.
		await tool.execute(
			{
				file_path: "file.txt",
				edits: [
					{ old_str: "const a = 1;", new_str: "const alpha = 1;" },
					{ old_str: "const b = a;", new_str: "const b = alpha;" },
				],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"const alpha = 1;\nconst b = alpha;\n",
		);
	});

	it("rejects edits that overlap the same text", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha beta gamma\n", "utf8");
		const tool = new EditTool();

		await expect(
			tool.execute(
				{
					file_path: "file.txt",
					edits: [
						{ old_str: "alpha beta", new_str: "one" },
						{ old_str: "beta gamma", new_str: "two" },
					],
				},
				context(cwd),
			),
		).rejects.toThrow("overlap");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"alpha beta gamma\n",
		);
	});

	it("serializes parallel edits to the same file", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "a\n", "utf8");
		const scheduler = new ToolScheduler(
			new ToolRegistry([new EditTool()]),
			new EventBus(),
		);

		const outputs = await scheduler.run(
			[
				{
					id: "call_1",
					name: "Edit",
					input: {
						file_path: "file.txt",
						edits: [{ old_str: "a", new_str: "b" }],
					},
				},
				{
					id: "call_2",
					name: "Edit",
					input: {
						file_path: "file.txt",
						edits: [{ old_str: "b", new_str: "c" }],
					},
				},
			],
			context(cwd),
		);

		expect(outputs.every((output) => !output.metadata?.error)).toBe(true);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("c\n");
	});

	it("revalidates chained same-file patches in scheduler order", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "a\n", "utf8");
		const scheduler = new ToolScheduler(
			new ToolRegistry([new ApplyPatchTool()]),
			new EventBus(),
		);
		const patch = (before: string, after: string) =>
			[
				"*** Begin Patch",
				"*** Update File: file.txt",
				"@@",
				`-${before}`,
				`+${after}`,
				"*** End Patch",
			].join("\n");

		const outputs = await scheduler.run(
			[
				{
					id: "patch_1",
					name: "ApplyPatch",
					input: { patch: patch("a", "b") },
				},
				{
					id: "patch_2",
					name: "ApplyPatch",
					input: { patch: patch("b", "c") },
				},
			],
			context(cwd),
		);

		expect({
			errors: outputs.filter((output) => output.metadata?.error).length,
			content: await readFile(join(cwd, "file.txt"), "utf8"),
		}).toEqual({ errors: 0, content: "c\n" });
	});

	it("releases the file lock before post-write diagnostics", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "a\n", "utf8");
		let diagnosticsStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			diagnosticsStarted = resolve;
		});
		let releaseDiagnostics!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseDiagnostics = resolve;
		});
		const firstContext = context(cwd);
		firstContext.lsp = {
			enabled: true,
			touchFile: async () => {
				diagnosticsStarted();
				await release;
			},
			diagnosticsForFile: () => [],
		} as unknown as ToolContext["lsp"];
		const tool = new EditTool();

		const first = tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "a", new_str: "b" }],
			},
			firstContext,
		);
		await started;
		const second = tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "b", new_str: "c" }],
			},
			context(cwd),
		);
		const completedBeforeRelease = await Promise.race([
			second.then(() => true),
			Bun.sleep(200).then(() => false),
		]);
		releaseDiagnostics();
		await Promise.all([first, second]);

		expect({
			completedBeforeRelease,
			content: await readFile(join(cwd, "file.txt"), "utf8"),
		}).toEqual({ completedBeforeRelease: true, content: "c\n" });
	});

	it("applies large patches and appends add-only updates to empty files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "empty.txt"), "", "utf8");
		await writeFile(join(cwd, "large.txt"), "line 1\nline 2\nline 3\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: empty.txt",
					"@@",
					"+first",
					"+second",
					"*** Update File: large.txt",
					"@@",
					" line 1",
					"-line 2",
					"+line two",
					" line 3",
					"*** Add File: added.txt",
					"+created",
					"+file",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "empty.txt"), "utf8")).toBe(
			"first\nsecond\n",
		);
		expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(
			"line 1\nline two\nline 3\n",
		);
		expect(await readFile(join(cwd, "added.txt"), "utf8")).toBe(
			"created\nfile\n",
		);
	});

	it("runs one multi-file patch diagnostic sweep concurrently", async () => {
		const cwd = await tempDir();
		await Promise.all([
			writeFile(join(cwd, "a.txt"), "old\n", "utf8"),
			writeFile(join(cwd, "b.txt"), "old\n", "utf8"),
		]);
		let active = 0;
		let maxActive = 0;
		const ctx = context(cwd);
		ctx.lsp = {
			enabled: true,
			touchFile: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await Bun.sleep(20);
				active--;
			},
			diagnosticsForFile: () => [],
		} as unknown as ToolContext["lsp"];

		await new ApplyPatchTool().execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: a.txt",
					"@@",
					"-old",
					"+new",
					"*** Update File: b.txt",
					"@@",
					"-old",
					"+new",
					"*** End Patch",
				].join("\n"),
			},
			ctx,
		);

		expect(maxActive).toBe(2);
	});

	it("returns compact diff detail lines for applied patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\nbeta\n", "utf8");
		const tool = new ApplyPatchTool();

		const result = await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					" alpha",
					"-beta",
					"+gamma",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(result.title).toBe("Changed +1, -1 lines");
		expect(result.detail).toBeUndefined();
		expect(result.fileEdits).toEqual([
			{
				path: join(cwd, "file.txt"),
				before: "alpha\nbeta\n",
				after: "alpha\ngamma\n",
			},
		]);
		expect(result.detailLines).toContainEqual({
			key: "file.txt:line:1",
			displayValue: "  2     │ beta",
			highlighted: true,
			kind: "removed",
		});
		expect(result.detailLines).toContainEqual({
			key: "file.txt:line:2",
			displayValue: "      2 │ gamma",
			highlighted: true,
			kind: "added",
		});
	});

	it("does not partially write invalid patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\n", "utf8");
		const tool = new ApplyPatchTool();

		await expect(
			tool.execute(
				{
					patch: [
						"*** Begin Patch",
						"*** Add File: created.txt",
						"+created",
						"*** Update File: file.txt",
						"@@",
						" missing",
						"-alpha",
						"+beta",
						"*** End Patch",
					].join("\n"),
				},
				context(cwd),
			),
		).rejects.toThrow("Failed to find expected lines in file.txt");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n");
		await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
	});

	it("deletes files from patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Delete File: file.txt",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		await expect(readFile(join(cwd, "file.txt"), "utf8")).rejects.toThrow();
	});

	it("moves files while applying patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "old.txt"), "alpha\nbeta\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: old.txt",
					"*** Move to: new.txt",
					"@@",
					" alpha",
					"-beta",
					"+gamma",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		await expect(readFile(join(cwd, "old.txt"), "utf8")).rejects.toThrow();
		expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("alpha\ngamma\n");
	});

	it("uses hunk context anchors to target later matches", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "file.txt"),
			"first\nvalue\nsecond\nvalue\n",
			"utf8",
		);
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@ second",
					"-value",
					"+changed",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"first\nvalue\nsecond\nchanged\n",
		);
	});

	it("matches patch context with whitespace and unicode punctuation drift", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha   \nquote “value”\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					" alpha",
					'-quote "value"',
					"+quote changed",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"alpha\nquote changed\n",
		);
	});

	it("anchors patch hunks at the end of files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "tail\nmiddle\ntail\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					"-tail",
					"+end",
					"*** End of File",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"tail\nmiddle\nend\n",
		);
	});
});

function checkpointRecorderWithFailingPostFlush(): CheckpointRecorder {
	return {
		recordPreImage: async () => {},
		recordPostImage: async () => {
			throw new Error("post-image flush failed");
		},
		revertToolCall: async () => {},
		beginShellCapture: async () => {},
		endShellCapture: async () => {},
		captureWarning: () => null,
		scopedToTurn() {
			return this;
		},
	};
}
