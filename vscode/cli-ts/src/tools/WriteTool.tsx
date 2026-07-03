import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
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

	override isConcurrencySafe(): boolean {
		return true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const filePath = resolve(ctx.cwd, input.file_path);
		return await withPathLocks([filePath], async () => {
			await ensureDir(dirname(filePath));
			await writeFile(filePath, input.content, "utf8");

			const bytes = Buffer.byteLength(input.content, "utf8");
			const diagnostics = await collectDiagnosticsFeedback(ctx, filePath);
			return ok(
				{ filePath, bytes },
				`Wrote ${input.file_path} (${bytes} bytes)${diagnostics}`,
				`Wrote ${input.file_path}`,
			);
		});
	}
}
