import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { assertInsideIsolatedWorkspace } from "../core/tools/WorkspaceBoundary.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { withPathLocks } from "../utils/pathLocks.ts";
import { collectDiagnosticsFeedback } from "./fileEdits/diagnosticsFeedback.ts";
import { buildEditDiffDetailLines } from "./fileEdits/diffPreview.ts";
import {
	applyTextReplacements,
	lineSummary,
} from "./fileEdits/textReplacements.ts";

const editSchema = z.object({
	old_str: z
		.string()
		.describe("The exact text to find and replace in the file"),
	new_str: z.string().describe("The text to replace the old_str with"),
	replace_all: z
		.boolean()
		.optional()
		.describe("Replace all occurrences instead of requiring a unique match"),
});

const schema = z.object({
	file_path: z.string().describe("The path to the file to edit"),
	edits: z
		.array(editSchema)
		.min(1)
		.describe(
			"One or more edits, each with old_str, new_str, and optional replace_all, all matched against the same file snapshot",
		),
});

type Input = z.infer<typeof schema>;
interface Output {
	filePath: string;
	replacements: number;
	edits: number;
}

export class EditTool extends Tool<Input, Output> {
	readonly name = "Edit";
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

	override parseInput(raw: unknown): Input {
		// Tolerate models that send `edits` as a JSON string, or a single
		// edit object instead of an array. Normalize before validating.
		const normalized = normalizeEditsShape(raw);

		// Back-compat: accept the legacy single-edit shape
		// (file_path/old_str/new_str/replace_all) and coerce it into the
		// advertised edits[] form before validating against the main schema.
		const parsed = legacySchema.safeParse(normalized);
		if (parsed.success) {
			const { file_path, old_str, new_str, replace_all } = parsed.data;
			return {
				file_path,
				edits: [{ old_str, new_str, replace_all }],
			};
		}
		return super.parseInput(normalized);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		assertInsideIsolatedWorkspace(ctx, [input.file_path]);
		const filePath = resolve(ctx.cwd, input.file_path);
		const prepared = await measurePerformance(
			ctx.bus,
			"mutation_prepare",
			{ toolCallId: ctx.toolCallId, fileCount: 1 },
			async () => prepareEdit(filePath, input),
		);
		await ctx.mutationLockTurn?.wait();
		const committed = await withPathLocks([filePath], async () => {
			ctx.mutationLockTurn?.advance();
			const originalBytes = await readFile(filePath);
			const original = originalBytes.toString("utf8");
			// The optimistic preparation normally keeps matching/diff work outside
			// the lock. A preceding same-path edit can change the snapshot while
			// this call waits; recompute against the authoritative locked contents
			// so deterministic chained edits retain their existing semantics.
			let edit: PreparedEditResult;
			if (original === prepared.original) {
				if (!prepared.edit) throw prepared.error;
				edit = { original, ...prepared.edit };
			} else {
				edit = { original, ...applyTextReplacements(original, input.edits) };
			}
			const updatedBytes = Buffer.from(edit.updated, "utf8");

			// Byte-exact pre-image (re-read internally; the utf8 `original` above
			// is lossy for CRLF/BOM/binary) journaled before the write so the
			// edit is undoable.
			await measurePerformance(
				ctx.bus,
				"checkpoint_pre_flush",
				{ toolCallId: ctx.toolCallId, fileCount: 1 },
				async () =>
					await (ctx.mutationCheckpointBatch?.recordPreImages(
						[{ absPath: filePath, opts: { tool: this.name } }],
						ctx,
					) ??
						recordPreImageBatch(
							ctx.checkpoints,
							[{ absPath: filePath, opts: { tool: this.name } }],
							ctx,
						)),
			);
			try {
				await measurePerformance(
					ctx.bus,
					"filesystem_commit",
					{ toolCallId: ctx.toolCallId, fileCount: 1 },
					async () => await writeFile(filePath, updatedBytes),
				);
				await measurePerformance(
					ctx.bus,
					"checkpoint_post_flush",
					{ toolCallId: ctx.toolCallId, fileCount: 1 },
					async () =>
						await (ctx.mutationCheckpointBatch?.recordPostImages(
							[{ absPath: filePath, contentIfInMemory: updatedBytes }],
							ctx,
						) ??
							recordPostImageBatch(
								ctx.checkpoints,
								[{ absPath: filePath, contentIfInMemory: updatedBytes }],
								ctx,
							)),
				);
			} catch (error) {
				try {
					await writeFile(filePath, originalBytes);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Edit failed and ${filePath} could not be rolled back`,
					);
				}
				throw error;
			}
			return edit;
		});

		const diagnostics = await collectDiagnosticsFeedback(ctx, filePath);

		const result = ok(
			{
				filePath,
				replacements: committed.replacements,
				edits: input.edits.length,
			},
			`Edited ${input.file_path} (${committed.replacements} replacement(s))${diagnostics}`,
			lineSummary(committed.addedLines, committed.removedLines),
			undefined,
			buildEditDiffDetailLines(
				input.file_path,
				committed.original,
				committed.updated,
			),
		);
		result.fileEdits = [
			{
				path: filePath,
				before: committed.original,
				after: committed.updated,
			},
		];
		return result;
	}
}

type PreparedEditResult = ReturnType<typeof applyTextReplacements> & {
	original: string;
};

type OptimisticEdit =
	| { original: string; edit: ReturnType<typeof applyTextReplacements> }
	| { original: string; edit?: undefined; error: unknown };

async function prepareEdit(
	filePath: string,
	input: Input,
): Promise<OptimisticEdit> {
	const original = await readFile(filePath, "utf8");
	try {
		return { original, edit: applyTextReplacements(original, input.edits) };
	} catch (error) {
		// A same-path call already queued ahead of this one may create the text
		// this edit targets. Defer snapshot-dependent failures until the call
		// owns the path lock and has the authoritative current contents.
		return { original, error };
	}
}

function normalizeEditsShape(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || !("edits" in raw)) {
		return raw;
	}
	const record = raw as Record<string, unknown>;
	let edits = record.edits;

	// `edits` arrived as a JSON string: parse it back into a value.
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			return raw;
		}
	}

	// A single edit object instead of an array: wrap it.
	if (typeof edits === "object" && edits !== null && !Array.isArray(edits)) {
		edits = [edits];
	}

	return { ...record, edits };
}

const legacySchema = z.object({
	file_path: z.string(),
	old_str: z.string(),
	new_str: z.string(),
	replace_all: z.boolean().optional(),
});
