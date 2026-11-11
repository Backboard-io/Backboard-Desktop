import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { PermissionDecision } from "../core/permissions/types.ts";
import { DIRECT_VIDEO_TOOL } from "../core/tools/names.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { ASK_BEFORE_GENERATING_OPTIONS } from "../prompts/system/generativeMedia.ts";
import type { RequestOptions } from "../providers/AgentClient.ts";
import type {
	GenerateVideoRequest,
	GenerateVideoResult,
} from "../providers/backboard/types.ts";

const schema = z.object({
	prompt: z.string().trim().min(1).describe("Scene description for the clip."),
	duration: z
		.number()
		.min(4)
		.max(8)
		.multipleOf(2)
		.optional()
		.describe("Clip length in seconds."),
	resolution: z.enum(["720p", "1080p"]).optional(),
	generate_audio: z
		.boolean()
		.optional()
		.describe("Whether to generate native audio."),
	aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
	seed: z
		.number()
		.int()
		.optional()
		.describe("Include only if the user supplies a seed."),
	first_frame: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Number of the attached image to use as the first frame."),
	last_frame: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Number of the attached image to use as the last frame. Requires first_frame.",
		),
});

type GenerateVideoToolInput = z.infer<typeof schema>;

export interface GenerateVideoToolDeps {
	generate: (
		request: GenerateVideoRequest,
		options?: RequestOptions,
	) => Promise<GenerateVideoResult>;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;

export class GenerateVideoTool extends Tool<
	GenerateVideoToolInput,
	GenerateVideoResult & { savedPath?: string }
> {
	readonly name = "GenerateVideo";
	readonly inputSchema = schema;

	constructor(private readonly deps: GenerateVideoToolDeps) {
		super();
	}

	override get agentName(): string {
		return DIRECT_VIDEO_TOOL;
	}

	override prompt(): string {
		return "Generate a clip with the composer’s selected Veo 3.1 Lite model. Pass settings requested by the user or set in the Canvas project. Use numbered images attached to this turn as frames. The tool handles confirmation.";
	}

	override isReadOnly(): boolean {
		return false;
	}

	override checkPermissions(): PermissionDecision {
		return { behavior: "allow", reason: "composer video generation setting" };
	}

	override permissionContent(input: GenerateVideoToolInput): string {
		// Preserve the summary used by existing generate_video permission rules.
		return [
			"Veo 3.1 Lite",
			input.duration === undefined ? undefined : `${input.duration}s`,
			input.resolution,
			input.generate_audio === undefined
				? undefined
				: input.generate_audio
					? "audio on"
					: "audio off",
			input.prompt,
		]
			.filter(Boolean)
			.join(" · ");
	}

	override summarizeInput(input: GenerateVideoToolInput): string {
		return [
			input.duration === undefined ? undefined : `${input.duration}s`,
			input.resolution,
			input.aspect_ratio,
			input.generate_audio === undefined
				? undefined
				: input.generate_audio
					? "audio on"
					: "audio off",
			input.seed === undefined ? undefined : `seed ${input.seed}`,
			input.prompt,
		]
			.filter(Boolean)
			.join(" · ");
	}

	override async execute(
		input: GenerateVideoToolInput,
		ctx: ToolContext,
	): Promise<ToolResult<GenerateVideoResult & { savedPath?: string }>> {
		const selection = ctx.directVideoGeneration;
		if (!selection || ctx.agentDepth) {
			throw new Error("Direct video generation is unavailable on this turn.");
		}

		const { prompt, first_frame, last_frame, ...videoConfig } = input;
		const firstFramePath = framePath(selection.framePaths, first_frame);
		const lastFramePath = framePath(selection.framePaths, last_frame);
		if (lastFramePath && !firstFramePath) {
			throw new Error("A last frame requires a first frame.");
		}

		if (selection.askBeforeGenerating) {
			const question = [
				videoModelLabel(selection.model),
				this.summarizeInput(input),
				firstFramePath && `First frame: ${basename(firstFramePath)}`,
				lastFramePath && `Last frame: ${basename(lastFramePath)}`,
				"Generating uses Backboard credits. Longer or higher-resolution clips cost more.",
			]
				.filter(Boolean)
				.join("\n\n");
			const [answer] =
				(await ctx.askQuestions?.([
					{
						header: "Confirm generation",
						question,
						options: [...ASK_BEFORE_GENERATING_OPTIONS],
					},
				])) ?? [];
			if (answer === "Change something") {
				throw new Error(
					"The user wants a change. Ask what to change before calling this tool again.",
				);
			}
			if (answer !== "Generate") {
				throw new Error("Video generation was not approved.");
			}
		}

		const signal = AbortSignal.any([
			ctx.signal,
			AbortSignal.timeout(VIDEO_TIMEOUT_MS),
		]);
		signal.throwIfAborted();
		const generated = await this.deps.generate(
			{
				prompt,
				video_model_provider: selection.model.provider,
				video_model_name: selection.model.name,
				...(Object.values(videoConfig).some((value) => value !== undefined)
					? { video_config: videoConfig }
					: {}),
				firstFramePath,
				lastFramePath,
			},
			{ signal },
		);

		const savedPath = await persistGeneratedVideo(
			generated.url,
			join(ctx.cwd, "generated-videos"),
			this.deps.fetch ?? fetch,
			signal,
		);
		const label = generated.label?.trim() || prompt;
		const relativePath = savedPath
			? projectRelativePath(savedPath, ctx.cwd)
			: undefined;
		const mediaSrc = relativePath ?? generated.url;
		const savedNote = relativePath ? `\n\nSaved to \`${relativePath}\`.` : "";
		const forLLM = `![${label.replace(/[[\]]/g, "")}](${mediaSrc})${savedNote}`;

		return ok(
			{ ...generated, label, ...(savedPath ? { savedPath } : {}) },
			forLLM,
			"Video generated",
			forLLM,
		);
	}
}

function framePath(
	paths: readonly string[],
	index: number | undefined,
): string | undefined {
	if (index === undefined) return undefined;
	const path = paths[index - 1];
	if (!path) throw new Error(`No attached image with frame number ${index}.`);
	return path;
}

function videoModelLabel(selection: {
	provider: string;
	name: string;
}): string {
	const segment = selection.name.split("/").pop() ?? selection.name;
	return segment
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) =>
			/^\d/.test(part)
				? part
				: `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
		)
		.join(" ");
}

function projectRelativePath(path: string, cwd: string): string {
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function persistGeneratedVideo(
	url: string,
	directory: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl(url, { signal });
		if (!response.ok) {
			throw new Error(`download returned HTTP ${response.status}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0) throw new Error("download was empty");
		await mkdir(directory, { recursive: true });
		const contentHash = createHash("sha256").update(bytes).digest("hex");
		const extension = videoExtension(url, response.headers.get("content-type"));
		const path = join(directory, `${contentHash.slice(0, 16)}${extension}`);
		await writeFile(path, bytes);
		return path;
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

function videoExtension(url: string, contentType: string | null): string {
	try {
		const fromUrl = extname(new URL(url).pathname);
		if (fromUrl) return fromUrl;
	} catch {
		// Fall through to the content type.
	}
	if (contentType?.includes("webm")) return ".webm";
	if (contentType?.includes("quicktime")) return ".mov";
	return ".mp4";
}
