import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { ToolResultDetailLine } from "../core/tools/ToolResultDetail.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir, fileExists } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
import { collectDiagnosticsFeedback } from "./fileEdits/diagnosticsFeedback.ts";
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

export class ApplyPatchTool extends Tool<Input, Output> {
	readonly name = "ApplyPatch";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const operations = parsePatch(input.patch);
		const resolvedPaths = operations.flatMap((operation) => {
			if (operation.kind === "update" && operation.movePath) {
				return [
					resolve(ctx.cwd, operation.path),
					resolve(ctx.cwd, operation.movePath),
				];
			}
			return [resolve(ctx.cwd, operation.path)];
		});

		return await withPathLocks(resolvedPaths, async () => {
			const actions: Array<
				| { kind: "write"; path: string; content: string }
				| { kind: "delete"; path: string }
			> = [];
			const detailLines: ToolResultDetailLine[] = [];
			let addedLines = 0;
			let removedLines = 0;
			for (const operation of operations) {
				const filePath = resolve(ctx.cwd, operation.path);
				if (operation.kind === "add") {
					if (await fileExists(filePath)) {
						throw new Error(`File already exists: ${operation.path}`);
					}
					const content = contentFromAddedLines(operation.lines, "\n");
					actions.push({
						kind: "write",
						path: filePath,
						content,
					});
					addedLines += operation.lines.length;
					detailLines.push(
						...prefixDetailLineKeys(
							operation.path,
							buildEditDiffDetailLines(operation.path, "", content),
						),
					);
					continue;
				}

				if (operation.kind === "delete") {
					const original = await readRegularFile(filePath, operation.path);
					actions.push({ kind: "delete", path: filePath });
					removedLines += countContentLines(original);
					detailLines.push(
						...prefixDetailLineKeys(
							operation.path,
							buildEditDiffDetailLines(operation.path, original, ""),
						),
					);
					continue;
				}

				const original = await readFile(filePath, "utf8");
				const content = applyPatchUpdate(
					original,
					operation.hunks,
					operation.path,
				);
				const outputPath = operation.movePath
					? resolve(ctx.cwd, operation.movePath)
					: filePath;
				if (operation.movePath && (await fileExists(outputPath))) {
					throw new Error(`File already exists: ${operation.movePath}`);
				}
				actions.push({
					kind: "write",
					path: outputPath,
					content,
				});
				if (operation.movePath)
					actions.push({ kind: "delete", path: filePath });
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

			for (const action of actions) {
				if (action.kind === "delete") {
					await unlink(action.path);
					continue;
				}
				await ensureDir(dirname(action.path));
				await writeFile(action.path, action.content, "utf8");
			}

			const writtenPaths = [
				...new Set(
					actions
						.filter((action) => action.kind === "write")
						.map((action) => action.path),
				),
			];
			let diagnostics = "";
			for (const path of writtenPaths) {
				diagnostics += await collectDiagnosticsFeedback(ctx, path);
			}

			return ok(
				{
					files: [...new Set(operations.flatMap(operationPaths))],
					operations: operations.length,
				},
				`Applied patch to ${operations.length} operation(s)${diagnostics}`,
				lineSummary(addedLines, removedLines),
				undefined,
				detailLines,
			);
		});
	}
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

async function readRegularFile(
	filePath: string,
	displayPath: string,
): Promise<string> {
	const info = await stat(filePath);
	if (!info.isFile()) throw new Error(`Not a file: ${displayPath}`);
	return await readFile(filePath, "utf8");
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
