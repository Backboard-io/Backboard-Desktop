import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import {
	ImageContent,
	type ImageContentPayload,
} from "../core/image/ImageContent.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import {
	READ_TOOL_DEFAULT_LINE_LIMIT,
	READ_TOOL_IMAGE_MIME_BY_EXTENSION,
	READ_TOOL_MAX_BYTES,
} from "./ReadTool.constants.ts";

const schema = z.object({
	file_path: z
		.string()
		.describe(
			"The path to the file to read. Absolute, or relative to the working directory.",
		),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("The line number to start reading from (0-based, defaults to 0)"),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("The maximum number of lines to read (defaults to 2400)"),
});

type Input = z.infer<typeof schema>;

interface TextOutput {
	filePath: string;
	content: string;
	totalLines: number;
	truncated: boolean;
}

interface ImageOutput extends ImageContentPayload {
	filePath: string;
	contentType: "image";
	mimeType: string;
	sizeBytes: number;
}

type Output = TextOutput | ImageOutput;

export class ReadTool extends Tool<Input, Output> {
	readonly name = "Read";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const filePath = resolve(ctx.cwd, input.file_path);
		const info = await stat(filePath);
		if (info.size > READ_TOOL_MAX_BYTES) {
			throw new Error(
				`File too large (${info.size} bytes); limit is ${READ_TOOL_MAX_BYTES}`,
			);
		}

		const imageMimeType = imageMimeTypeForPath(filePath);
		if (imageMimeType) {
			const bytes = await readFile(filePath);
			const output: ImageOutput = {
				filePath,
				contentType: "image",
				mimeType: imageMimeType,
				sizeBytes: info.size,
				...ImageContent.fromBytes(bytes, imageMimeType),
			};
			return ok(
				output,
				JSON.stringify(output),
				`Read image (${imageMimeType}, ${info.size} bytes)`,
			);
		}

		const raw = await readFile(filePath, "utf8");
		const lines = raw.split("\n");
		const total = lines.length;

		// Pre-warm the language server for this file so diagnostics are hot before
		// the model edits it. Fire-and-forget: never blocks or fails the read.
		if (ctx.lsp?.enabled) {
			void ctx.lsp.touchFile(filePath).catch(() => {});
		}

		const start = input.offset ?? 0;
		const end = input.limit
			? start + input.limit
			: Math.min(start + READ_TOOL_DEFAULT_LINE_LIMIT, total);
		const slice = lines.slice(start, end);
		const truncated = end < total || start > 0;

		const content = slice.join("\n");
		return ok(
			{ filePath, content, totalLines: total, truncated },
			content,
			truncated
				? `Read ${slice.length}/${total} lines`
				: `Read ${slice.length} lines`,
		);
	}
}

function imageMimeTypeForPath(filePath: string): string | null {
	return (
		READ_TOOL_IMAGE_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase()) ??
		null
	);
}
