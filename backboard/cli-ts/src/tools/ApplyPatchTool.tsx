import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
	type RecordPostImageRequest,
	type RecordPreImageRequest,
	recordPostImageBatch,
	recordPreImageBatch,
} from "../core/checkpoints/CheckpointStore.ts";
import { measurePerformance } from "../core/performance/PerformanceTiming.ts";
import { pathsInsideCwd } from "../core/permissions/pathsInside.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import { throwIfAborted } from "../core/tools/ToolAbort.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import {
	type FileEditPreview,
	ok,
	type ToolResult,
} from "../core/tools/ToolResult.ts";
import type { ToolResultDetailLine } from "../core/tools/ToolResultDetail.ts";
import { assertInsideIsolatedWorkspace } from "../core/tools/WorkspaceBoundary.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir, fileExists } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
import { collectDiagnosticsFeedbackForFiles } from "./fileEdits/diagnosticsFeedback.ts";
import { buildEditDiffDetailLines } from "./fileEdits/diffPreview.ts";
import {
	applyPatchUpdate,
	contentFromAddedLines,
	type PatchOperation,
	parsePatch,
} from "./fileEdits/patch.ts";
import { lineSummary } from "./fileEdits/textReplacements.ts";

const schema = z.object({
	patch: z.string().describe("Patch text to apply"),
});

type Input = z.infer<typeof schema>;

interface Output {
	files: string[];
	operations: number;
}

type PatchAction =
	| { kind: "write"; path: string; content: string }
	| { kind: "delete"; path: string };

type PathSnapshot =
	| { kind: "missing" }
	| { kind: "file"; content: string; fingerprint: string }
	| { kind: "other"; fingerprint: string };

interface PreparedPatch {
	actions: PatchAction[];
	fileEdits: FileEditPreview[];
	detailLines: ToolResultDetailLine[];
	addedLines: number;
	removedLines: number;
	snapshots: Map<string, PathSnapshot>;
}

type OptimisticPatch =
	| { snapshots: Map<string, PathSnapshot>; plan: PreparedPatch }
	| { snapshots: Map<string, PathSnapshot>; plan?: undefined; error: unknown };

/** Every path a patch would touch, or null when it does not parse. */
function patchPaths(patch: string): string[] | null {
	try {
		return parsePatch(patch).flatMap(operationPaths);
	} catch {
		return null;
	}
}

/**
 * Joins paths so their boundaries survive the round trip into a rule string.
 * A patch header takes the whole rest of the line as the path, so a path may
 * contain spaces: joining raw would let the single path `src/file ../secret`
 * encode identically to the pair `src/file` + `../secret`, and a grant
 * approved for the first would silently authorize the second. Escaping the
 * separator and the escape itself keeps the two distinct.
 */
function encodePathList(paths: readonly string[]): string {
	return paths
		.map((path) => path.replaceAll("\\", "\\\\").replaceAll(" ", "\\ "))
		.join(" ");
}

export class ApplyPatchTool extends Tool<Input, Output> {
	readonly name = "ApplyPatch";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	/**
	 * The paths the patch touches, so rules and "always allow" scope to files
	 * the way Edit and Write do. Without this the persisted grant is a bare
	 * `apply_patch`, which allows every future patch to every file.
	 */
	override permissionContent(input: Input): string | undefined {
		const paths = patchPaths(input.patch);
		return paths && paths.length > 0 ? encodePathList(paths) : undefined;
	}

	override permissionContentIsPaths(): boolean {
		return true;
	}

	override permissionPaths(input: Input): readonly string[] | undefined {
		return patchPaths(input.patch) ?? undefined;
	}

	override checkPermissions(
		input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		// A patch that does not parse cannot apply; deny rather than prompt, so
		// an "always allow" can never persist an unscopeable grant.
		if (patchPaths(input.patch) === null) {
			return {
				behavior: "deny",
				reason: "Patch could not be parsed, so no files were identified.",
			};
		}
		if (ctx.mode !== "acceptEdits" && ctx.mode !== "auto") return undefined;
		const paths = patchPaths(input.patch);
		if (paths !== null && paths.length > 0 && pathsInsideCwd(paths, ctx.cwd)) {
			return {
				behavior: "allow",
				reason: `patch inside working directory (${ctx.mode})`,
			};
		}
		return undefined;
	}

	override isConcurrencySafe(): boolean {
		return true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		throwIfAborted(ctx.signal);
		const operations = parsePatch(input.patch);
		const resolvedPaths = operations
			.flatMap(operationPaths)
			.map((path) => resolve(ctx.cwd, path));
		assertInsideIsolatedWorkspace(ctx, resolvedPaths);
		const prepared = await measurePerformance(
			ctx.bus,
			"mutation_prepare",
			{
				toolCallId: ctx.toolCallId,
				fileCount: new Set(resolvedPaths).size,
			},
			async () => await preparePatch(operations, ctx.cwd),
		);

		await ctx.mutationLockTurn?.wait();
		const mutation = withPathLocks(
			resolvedPaths,
			async () => {
				throwIfAborted(ctx.signal);
				// Preparation is optimistic. Re-check snapshots under the sorted path
				// locks, and only rebuild if an earlier same-path call won the race.
				const snapshotsAreCurrent = await patchSnapshotsAreCurrent(
					prepared.snapshots,
				);
				let plan: PreparedPatch;
				if (snapshotsAreCurrent) {
					if (!prepared.plan) throw prepared.error;
					plan = prepared.plan;
				} else {
					const currentSnapshots = await capturePatchSnapshots(resolvedPaths);
					plan = buildPatchPlan(operations, ctx.cwd, currentSnapshots);
				}
				const preImages = await patchPreImages(plan, this.name);
				await measurePerformance(
					ctx.bus,
					"checkpoint_pre_flush",
					{ toolCallId: ctx.toolCallId, fileCount: preImages.length },
					async () =>
						await (ctx.mutationCheckpointBatch?.recordPreImages(
							preImages,
							ctx,
						) ?? recordPreImageBatch(ctx.checkpoints, preImages, ctx)),
				);

				throwIfAborted(ctx.signal);
				try {
					await measurePerformance(
						ctx.bus,
						"filesystem_commit",
						{ toolCallId: ctx.toolCallId, fileCount: preImages.length },
						async () => await applyPatchActions(plan.actions),
					);
					const postImages = patchPostImages(plan.actions);
					await measurePerformance(
						ctx.bus,
						"checkpoint_post_flush",
						{ toolCallId: ctx.toolCallId, fileCount: postImages.length },
						async () =>
							await (ctx.mutationCheckpointBatch?.recordPostImages(
								postImages,
								ctx,
							) ?? recordPostImageBatch(ctx.checkpoints, postImages, ctx)),
					);
				} catch (error) {
					await rollbackPatch(plan, ctx);
					throw error;
				}
				return plan;
			},
			ctx.signal,
		);
		// withPathLocks reserves in invocation order before yielding. A blocked
		// path must not hold up registration of later independent writes.
		ctx.mutationLockTurn?.advance();
		const committed = await mutation;

		const writtenPaths = finalWrittenPaths(committed.actions);
		const diagnostics = await collectDiagnosticsFeedbackForFiles(
			ctx,
			writtenPaths,
		);
		const result = ok(
			{
				files: [...new Set(operations.flatMap(operationPaths))],
				operations: operations.length,
			},
			`Applied patch to ${operations.length} operation(s)${diagnostics}`,
			lineSummary(committed.addedLines, committed.removedLines),
			undefined,
			committed.detailLines,
		);
		result.fileEdits = committed.fileEdits;
		return result;
	}
}

async function preparePatch(
	operations: readonly PatchOperation[],
	cwd: string,
): Promise<OptimisticPatch> {
	const paths = operations
		.flatMap(operationPaths)
		.map((path) => resolve(cwd, path));
	const snapshots = await capturePatchSnapshots(paths);
	try {
		return { snapshots, plan: buildPatchPlan(operations, cwd, snapshots) };
	} catch (error) {
		// As with Edit, a queued same-path patch may make this operation valid
		// before it acquires the lock. Preserve the optimistic work but defer the
		// snapshot-dependent error until the locked revalidation.
		return { snapshots, error };
	}
}

function buildPatchPlan(
	operations: readonly PatchOperation[],
	cwd: string,
	snapshots: Map<string, PathSnapshot>,
): PreparedPatch {
	const actions: PatchAction[] = [];
	const fileEdits: FileEditPreview[] = [];
	const detailLines: ToolResultDetailLine[] = [];
	let addedLines = 0;
	let removedLines = 0;
	for (const operation of operations) {
		const filePath = resolve(cwd, operation.path);
		const snapshot = snapshots.get(filePath) ?? { kind: "missing" };
		if (operation.kind === "add") {
			if (snapshot.kind !== "missing") {
				throw new Error(`File already exists: ${operation.path}`);
			}
			const content = contentFromAddedLines(operation.lines, "\n");
			actions.push({ kind: "write", path: filePath, content });
			fileEdits.push({ path: filePath, before: "", after: content });
			addedLines += operation.lines.length;
			detailLines.push(
				...prefixDetailLineKeys(
					operation.path,
					buildEditDiffDetailLines(operation.path, "", content),
				),
			);
			continue;
		}

		const original = regularSnapshotContent(snapshot, operation.path);
		if (operation.kind === "delete") {
			actions.push({ kind: "delete", path: filePath });
			fileEdits.push({ path: filePath, before: original, after: "" });
			removedLines += countContentLines(original);
			detailLines.push(
				...prefixDetailLineKeys(
					operation.path,
					buildEditDiffDetailLines(operation.path, original, ""),
				),
			);
			continue;
		}

		const content = applyPatchUpdate(original, operation.hunks, operation.path);
		const outputPath = operation.movePath
			? resolve(cwd, operation.movePath)
			: filePath;
		if (
			operation.movePath &&
			(snapshots.get(outputPath) ?? { kind: "missing" }).kind !== "missing"
		) {
			throw new Error(`File already exists: ${operation.movePath}`);
		}
		actions.push({ kind: "write", path: outputPath, content });
		fileEdits.push({
			path: outputPath,
			before: operation.movePath ? "" : original,
			after: content,
		});
		if (operation.movePath) {
			actions.push({ kind: "delete", path: filePath });
			fileEdits.push({ path: filePath, before: original, after: "" });
		}
		for (const hunk of operation.hunks) {
			addedLines += hunk.addedLineCount;
			removedLines += hunk.removedLineCount;
		}
		const displayPath = operation.movePath ?? operation.path;
		detailLines.push(
			...prefixDetailLineKeys(
				displayPath,
				buildEditDiffDetailLines(displayPath, original, content),
			),
		);
	}
	return {
		actions,
		fileEdits,
		detailLines,
		addedLines,
		removedLines,
		snapshots,
	};
}

async function capturePatchSnapshots(
	paths: readonly string[],
): Promise<Map<string, PathSnapshot>> {
	const uniquePaths = [...new Set(paths)];
	const entries = await Promise.all(
		uniquePaths.map(
			async (path): Promise<[string, PathSnapshot]> => [
				path,
				await capturePatchSnapshot(path),
			],
		),
	);
	return new Map(entries);
}

async function capturePatchSnapshot(path: string): Promise<PathSnapshot> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await lstatOrMissing(path);
		if (!before) return { kind: "missing" };
		const fingerprint = statFingerprint(before);
		if (!before.isFile()) return { kind: "other", fingerprint };
		try {
			const content = await readFile(path, "utf8");
			const after = await lstatOrMissing(path);
			if (after?.isFile() && statFingerprint(after) === fingerprint) {
				return { kind: "file", content, fingerprint };
			}
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
	}
	throw new Error(`File changed repeatedly while preparing patch: ${path}`);
}

async function patchSnapshotsAreCurrent(
	snapshots: ReadonlyMap<string, PathSnapshot>,
): Promise<boolean> {
	const matches = await Promise.all(
		[...snapshots].map(async ([path, snapshot]) => {
			const current = await lstatOrMissing(path);
			if (!current) return snapshot.kind === "missing";
			if (snapshot.kind === "missing") return false;
			return statFingerprint(current) === snapshot.fingerprint;
		}),
	);
	return matches.every(Boolean);
}

async function lstatOrMissing(
	path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

function statFingerprint(info: Awaited<ReturnType<typeof lstat>>): string {
	return [
		info.dev,
		info.ino,
		info.mode,
		info.size,
		info.mtimeMs,
		info.ctimeMs,
	].join(":");
}

function regularSnapshotContent(
	snapshot: PathSnapshot,
	displayPath: string,
): string {
	if (snapshot.kind === "file") return snapshot.content;
	if (snapshot.kind === "other") throw new Error(`Not a file: ${displayPath}`);
	throw new Error(`File does not exist: ${displayPath}`);
}

async function patchPreImages(
	plan: PreparedPatch,
	tool: string,
): Promise<RecordPreImageRequest[]> {
	const paths = [...new Set(plan.actions.map((action) => action.path))];
	return await Promise.all(
		paths.map(async (path) => {
			const createdDirs =
				plan.snapshots.get(path)?.kind === "missing"
					? await missingAncestorDirs(dirname(path))
					: [];
			return {
				absPath: path,
				opts: {
					tool,
					requireRevertible: true,
					...(createdDirs.length > 0 ? { createdDirs } : {}),
				},
			};
		}),
	);
}

function patchPostImages(
	actions: readonly PatchAction[],
): RecordPostImageRequest[] {
	const final = new Map<string, RecordPostImageRequest>();
	for (const action of actions) {
		final.set(
			action.path,
			action.kind === "write"
				? {
						absPath: action.path,
						contentIfInMemory: Buffer.from(action.content, "utf8"),
					}
				: { absPath: action.path },
		);
	}
	return [...final.values()];
}

async function applyPatchActions(
	actions: readonly PatchAction[],
): Promise<void> {
	for (const action of actions) {
		if (action.kind === "delete") {
			await unlink(action.path);
			continue;
		}
		await ensureDir(dirname(action.path));
		await writeFile(action.path, action.content, "utf8");
	}
}

async function rollbackPatch(
	plan: PreparedPatch,
	ctx: ToolContext,
): Promise<void> {
	if (ctx.checkpoints) {
		try {
			await ctx.checkpoints.revertToolCall(ctx.toolCallId ?? "unknown");
			return;
		} catch {
			// Fall through to the in-memory snapshots. The checkpoint is the
			// durable recovery path, but an I/O failure there must not knowingly
			// leave a half-applied patch in this live process.
		}
	}
	const paths = [
		...new Set(plan.actions.map((action) => action.path)),
	].reverse();
	for (const path of paths) {
		const snapshot = plan.snapshots.get(path);
		if (!snapshot || snapshot.kind === "other") continue;
		if (snapshot.kind === "missing") {
			try {
				await unlink(path);
			} catch (error) {
				if ((error as { code?: string }).code !== "ENOENT") throw error;
			}
			continue;
		}
		await ensureDir(dirname(path));
		await writeFile(path, snapshot.content, "utf8");
	}
}

function finalWrittenPaths(actions: readonly PatchAction[]): string[] {
	const final = new Map<string, PatchAction["kind"]>();
	for (const action of actions) final.set(action.path, action.kind);
	return [...final]
		.filter(([, kind]) => kind === "write")
		.map(([path]) => path);
}

async function missingAncestorDirs(dir: string): Promise<string[]> {
	const missing: string[] = [];
	let current = dir;
	while (!(await fileExists(current))) {
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return missing;
}

function prefixDetailLineKeys(
	filePath: string,
	lines: readonly ToolResultDetailLine[],
): ToolResultDetailLine[] {
	return lines.map((line) => ({
		...line,
		key: `${filePath}:${line.key}`,
	}));
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return normalized.endsWith("\n")
		? normalized.split("\n").length - 1
		: normalized.split("\n").length;
}

function operationPaths(operation: PatchOperation): string[] {
	if (operation.kind === "update" && operation.movePath) {
		return [operation.path, operation.movePath];
	}
	return [operation.path];
}
