import { resolve } from "node:path";
import { reportDiagnostics } from "../../core/lsp/index.ts";
import { measurePerformance } from "../../core/performance/PerformanceTiming.ts";
import type { ToolContext } from "../../core/tools/ToolContext.ts";

/** One cap for the complete post-mutation sweep, regardless of file count. */
export const DIAGNOSTICS_BUDGET_MS = 2_000;

/**
 * Runs LSP diagnostics for a just-edited file and returns a model-visible block
 * to append to the tool output, mirroring opencode's post-edit feedback. Fully
 * best-effort: any failure, timeout, or missing LSP yields an empty string so
 * the edit result is never affected.
 */
export async function collectDiagnosticsFeedback(
	ctx: ToolContext,
	filePath: string,
): Promise<string> {
	return await collectDiagnosticsFeedbackForFiles(ctx, [filePath]);
}

/**
 * Diagnoses all written files concurrently under one global time budget.
 * Individual server failures are isolated, and a timed-out sweep is allowed
 * to finish quietly in the background without delaying the next model round.
 */
export async function collectDiagnosticsFeedbackForFiles(
	ctx: ToolContext,
	filePaths: readonly string[],
): Promise<string> {
	const uniquePaths = [...new Set(filePaths)];
	if (ctx.mutationDiagnosticsBatch && ctx.toolCallId) {
		return await ctx.mutationDiagnosticsBatch.collect(
			ctx.toolCallId,
			uniquePaths,
			async (paths) =>
				await runDiagnosticsSweep(
					{ ...ctx, mutationDiagnosticsBatch: undefined },
					paths,
				),
		);
	}
	return await runDiagnosticsSweep(ctx, uniquePaths);
}

async function runDiagnosticsSweep(
	ctx: ToolContext,
	uniquePaths: readonly string[],
): Promise<string> {
	const lsp = ctx.lsp;
	return await measurePerformance(
		ctx.bus,
		"diagnostics",
		{ toolCallId: ctx.toolCallId, fileCount: uniquePaths.length },
		async () => {
			if (!lsp?.enabled || uniquePaths.length === 0) return "";

			const blocks = await withBudget(
				async () =>
					await Promise.all(
						uniquePaths.map(async (filePath) => {
							const absolute = resolve(ctx.cwd, filePath);
							try {
								await lsp.touchFile(absolute, {
									waitForDiagnostics: true,
								});
								const diagnostics = lsp.diagnosticsForFile(absolute);
								return reportDiagnostics(filePath, diagnostics);
							} catch {
								return "";
							}
						}),
					),
				DIAGNOSTICS_BUDGET_MS,
			);
			if (!blocks) return "";
			return blocks
				.filter((block) => block.length > 0)
				.map(
					(block) =>
						`\n\nLSP errors detected in this file, please fix:\n${block}`,
				)
				.join("");
		},
	);
}

function withBudget<T>(
	fn: () => Promise<T>,
	ms: number,
): Promise<T | undefined> {
	return new Promise<T | undefined>((resolvePromise) => {
		const timer = setTimeout(() => resolvePromise(undefined), ms);
		timer.unref?.();
		fn().then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			() => {
				clearTimeout(timer);
				resolvePromise(undefined);
			},
		);
	});
}
