import { readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
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
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { assertInsideIsolatedWorkspace } from "../core/tools/WorkspaceBoundary.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir, fileExists } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
import { assertNoDanglingSymlink } from "../utils/pathSafety.ts";
import { collectDiagnosticsFeedback } from "./fileEdits/diagnosticsFeedback.ts";

const schema = z.object({
	file_path: z.string().describe("The path to the file to write"),
	content: z.string().describe("The complete file contents"),
});

type Input = z.infer<typeof schema>;

interface Output {
	filePath: string;
	bytes: number;
}

export class WriteTool extends Tool<Input, Output> {
	readonly name = "Write";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override permissionContent(input: Input): string {
		return input.file_path;
	}

	override permissionContentIsPaths(): boolean {
		return true;
	}

	override permissionPaths(input: Input): readonly string[] {
		return [input.file_path];
	}

	override checkPermissions(
		input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (ctx.mode !== "acceptEdits" && ctx.mode !== "auto") return undefined;
		if (pathsInsideCwd([input.file_path], ctx.cwd)) {
			return {
				behavior: "allow",
				reason: `edit inside working directory (${ctx.mode})`,
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
		assertInsideIsolatedWorkspace(ctx, [input.file_path]);
		const prepared = await measurePerformance(
			ctx.bus,
			"mutation_prepare",
			{ toolCallId: ctx.toolCallId, fileCount: 1 },
			async () => {
				const content = Buffer.from(input.content, "utf8");
				return {
					filePath: resolve(ctx.cwd, input.file_path),
					content,
					bytes: content.byteLength,
				};
			},
		);
		await ctx.mutationLockTurn?.wait();
		const mutation = withPathLocks(
			[prepared.filePath],
			async () => {
				throwIfAborted(ctx.signal);
				const filePath = prepared.filePath;
				// Recheck after acquiring the lock so a link swapped in after permission
				// resolution cannot redirect this write to an unvalidated target.
				assertNoDanglingSymlink(filePath);
				const existed = await fileExists(filePath);
				const beforeBytes = existed ? await readFile(filePath) : undefined;
				const before = beforeBytes?.toString("utf8") ?? "";
				// Journal the pre-image (and any directories this write is about to
				// create, so undo can prune them) before touching disk.
				const createdDirs = await missingAncestorDirs(dirname(filePath));
				await measurePerformance(
					ctx.bus,
					"checkpoint_pre_flush",
					{ toolCallId: ctx.toolCallId, fileCount: 1 },
					async () =>
						await (ctx.mutationCheckpointBatch?.recordPreImages(
							[
								{
									absPath: filePath,
									opts: { createdDirs, tool: this.name },
								},
							],
							ctx,
						) ??
							recordPreImageBatch(
								ctx.checkpoints,
								[
									{
										absPath: filePath,
										opts: { createdDirs, tool: this.name },
									},
								],
								ctx,
							)),
				);
				throwIfAborted(ctx.signal);
				try {
					await measurePerformance(
						ctx.bus,
						"filesystem_commit",
						{ toolCallId: ctx.toolCallId, fileCount: 1 },
						async () => {
							await ensureDir(dirname(filePath));
							await writeFile(filePath, prepared.content);
						},
					);
					await measurePerformance(
						ctx.bus,
						"checkpoint_post_flush",
						{ toolCallId: ctx.toolCallId, fileCount: 1 },
						async () =>
							await (ctx.mutationCheckpointBatch?.recordPostImages(
								[{ absPath: filePath, contentIfInMemory: prepared.content }],
								ctx,
							) ??
								recordPostImageBatch(
									ctx.checkpoints,
									[{ absPath: filePath, contentIfInMemory: prepared.content }],
									ctx,
								)),
					);
				} catch (error) {
					try {
						await restoreWrite(filePath, beforeBytes, createdDirs);
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							`Write failed and ${filePath} could not be rolled back`,
						);
					}
					throw error;
				}
				return before;
			},
			ctx.signal,
		);
		// withPathLocks reserves in invocation order before yielding. A blocked
		// path must not hold up registration of later independent writes.
		ctx.mutationLockTurn?.advance();
		const before = await mutation;

		const diagnostics = await collectDiagnosticsFeedback(
			ctx,
			prepared.filePath,
		);
		const result = ok(
			{ filePath: prepared.filePath, bytes: prepared.bytes },
			`Wrote ${input.file_path} (${prepared.bytes} bytes)${diagnostics}`,
			`Wrote ${input.file_path}`,
		);
		result.fileEdits = [
			{ path: prepared.filePath, before, after: input.content },
		];
		return result;
	}
}

async function restoreWrite(
	filePath: string,
	before: Uint8Array | undefined,
	createdDirs: readonly string[],
): Promise<void> {
	if (before) {
		await writeFile(filePath, before);
		return;
	}
	await rm(filePath, { force: true });
	for (const directory of createdDirs) {
		try {
			await rmdir(directory);
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
				throw error;
			}
		}
	}
}

/**
 * Ancestor directories of `dir` (inclusive) that do not exist yet — the
 * directories `ensureDir` is about to create, deepest first.
 */
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
