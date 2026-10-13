import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import type { PermissionDecision } from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import type { RequestOptions } from "../providers/AgentClient.ts";
import type {
	GenerateVideoRequest,
	GenerateVideoResult,
} from "../providers/backboard/types.ts";

const schema = z.object({
	prompt: z
		.string()
		.min(1)
		.describe("Scene description for the clip. Do not include a model name."),
	duration: z
		.number()
		.positive()
		.optional()
		.describe("Clip length in seconds, if the selected model supports it."),
	resolution: z
		.string()
		.min(1)
		.optional()
		.describe('Output resolution such as "480p", "720p", or "1080p".'),
	generate_audio: z
		.boolean()
		.optional()
		.describe("Whether to generate native audio in the clip, when supported."),
	aspect_ratio: z
		.string()
		.min(1)
		.optional()
		.describe('Output aspect ratio such as "16:9" or "9:16", when supported.'),
	images: z
		.array(z.string().min(1))
		.max(8)
		.optional()
		.describe(
			"Local image paths the user attached as references or first frames.",
		),
});

type SchemaInput = z.infer<typeof schema>;

export interface GenerateVideoToolInput extends SchemaInput {
	model_provider?: string;
	model_name?: string;
	model_label?: string;
}

export interface GenerateVideoToolDeps {
	getModel: () => { provider: string; name: string } | undefined;
	generate: (
		request: GenerateVideoRequest,
		options?: RequestOptions,
	) => Promise<GenerateVideoResult>;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;
const DURATION_OPTIONS = ["5s", "8s", "10s", "15s", "30s"] as const;
const QUALITY_OPTIONS = ["480p", "720p", "1080p"] as const;

export class GenerateVideoTool extends Tool<
	GenerateVideoToolInput,
	GenerateVideoResult & { savedPath?: string }
> {
	readonly name = "GenerateVideo";
	readonly inputSchema = schema;

	constructor(private readonly deps: GenerateVideoToolDeps) {
		super();
	}

	override get displayName(): string {
		return "Edit Video";
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override checkPermissions(): PermissionDecision {
		return { behavior: "allow", reason: "video approval card" };
	}

	override permissionContent(input: GenerateVideoToolInput): string {
		return this.summarizeInput(input) ?? input.prompt;
	}

	override parseInput(raw: unknown): GenerateVideoToolInput {
		const parsed = super.parseInput(raw);
		const selected = this.deps.getModel();
		return {
			...parsed,
			...(selected
				? {
						model_provider: selected.provider,
						model_name: selected.name,
						model_label: videoModelLabel(selected),
					}
				: {}),
		};
	}

	override summarizeInput(input: GenerateVideoToolInput): string | undefined {
		const parts = [
			input.model_label,
			formatDuration(input.duration),
			input.resolution,
			input.generate_audio === undefined
				? undefined
				: input.generate_audio
					? "audio on"
					: "audio off",
			input.prompt.trim(),
		].filter((part): part is string => !!part);
		return parts.length ? parts.join(" · ") : undefined;
	}

	override async execute(
		input: GenerateVideoToolInput,
		ctx: ToolContext,
	): Promise<ToolResult<GenerateVideoResult & { savedPath?: string }>> {
		const selected = this.deps.getModel();
		if (!selected) {
			throw new Error(
				"No video model is selected in the composer. Ask the user to pick one from the Video menu instead of choosing a model yourself.",
			);
		}

		const approved = await confirmVideoGeneration(input, ctx);
		const videoConfig = compactVideoConfig(approved);
		const timeout = AbortSignal.timeout(VIDEO_TIMEOUT_MS);
		const signal = AbortSignal.any([ctx.signal, timeout]);
		const generated = await this.deps.generate(
			{
				prompt: approved.prompt,
				video_model_provider: selected.provider,
				video_model_name: selected.name,
				...(videoConfig ? { video_config: videoConfig } : {}),
			},
			{ signal },
		);

		const savedPath = await persistGeneratedVideo(
			generated.url,
			join(ctx.cwd, "generated-videos"),
			this.deps.fetch ?? fetch,
			signal,
		);
		const label = generated.label?.trim() || approved.prompt.trim() || "Video";
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

export function videoModelLabel(selection: {
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

async function confirmVideoGeneration(
	input: GenerateVideoToolInput,
	ctx: ToolContext,
): Promise<GenerateVideoToolInput> {
	if (!ctx.askQuestions) {
		return input;
	}
	const duration = preferredOption(
		DURATION_OPTIONS,
		formatDuration(input.duration),
	);
	const quality = preferredOption(QUALITY_OPTIONS, input.resolution);
	const audio = input.generate_audio === false ? "Off" : "On";
	const imageMarkdown = (input.images ?? [])
		.slice(0, 4)
		.map((image, index) => `![Reference ${index + 1}](${image})`)
		.join(" ");
	const modelLine = input.model_label ? `Model: ${input.model_label}` : "";
	const promptBody = [input.prompt.trim(), modelLine, imageMarkdown]
		.filter(Boolean)
		.join("\n\n");
	const answers = await ctx.askQuestions([
		{
			header: "Edit Video",
			question: promptBody,
			options: ["Approve"],
		},
		{
			header: "Duration",
			question: "Duration",
			options: orderedOptions(DURATION_OPTIONS, duration),
		},
		{
			header: "Quality",
			question: "Quality",
			options: orderedOptions(QUALITY_OPTIONS, quality),
		},
		{
			header: "Native Audio",
			question: "Native Audio",
			options: orderedOptions(["On", "Off"], audio),
		},
	]);
	if (answers[0] && answers[0] !== "Approve") {
		throw new Error("Video generation was not approved.");
	}
	return {
		...input,
		duration: parseDuration(answers[1]) ?? input.duration,
		resolution: parseQuality(answers[2]) ?? input.resolution,
		generate_audio: parseAudio(answers[3], input.generate_audio),
	};
}

function preferredOption(
	options: readonly string[],
	value: string | undefined,
): string {
	return value && options.includes(value) ? value : (options[0] ?? "");
}

function orderedOptions(
	options: readonly string[],
	preferred: string,
): string[] {
	const rest = options.filter((option) => option !== preferred);
	return preferred ? [preferred, ...rest] : [...options];
}

function parseDuration(value: string | undefined): number | undefined {
	const match = /^(\d+(?:\.\d+)?)s$/i.exec(value?.trim() ?? "");
	return match ? Number(match[1]) : undefined;
}

function parseQuality(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed &&
		QUALITY_OPTIONS.includes(trimmed as (typeof QUALITY_OPTIONS)[number])
		? trimmed
		: undefined;
}

function parseAudio(
	value: string | undefined,
	fallback: boolean | undefined,
): boolean | undefined {
	if (value?.trim().toLowerCase() === "on") return true;
	if (value?.trim().toLowerCase() === "off") return false;
	return fallback;
}

function compactVideoConfig(
	input: GenerateVideoToolInput,
): GenerateVideoRequest["video_config"] | undefined {
	const config = {
		...(input.duration !== undefined ? { duration: input.duration } : {}),
		...(input.resolution ? { resolution: input.resolution } : {}),
		...(input.generate_audio !== undefined
			? { generate_audio: input.generate_audio }
			: {}),
		...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
	};
	return Object.keys(config).length ? config : undefined;
}

function formatDuration(duration: number | undefined): string | undefined {
	if (duration === undefined) return undefined;
	return Number.isInteger(duration) ? `${duration}s` : `${duration}s`;
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
