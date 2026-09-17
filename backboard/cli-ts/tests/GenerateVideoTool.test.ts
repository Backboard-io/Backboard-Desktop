import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GenerateVideoTool,
	videoModelLabel,
} from "../src/tools/GenerateVideoTool.tsx";
import { makeContext } from "./helpers.ts";

describe("GenerateVideoTool", () => {
	it("advertises generate_video without a model argument", () => {
		const tool = new GenerateVideoTool({
			getModel: () => ({
				provider: "openrouter",
				name: "bytedance/seedance-2.5",
			}),
			generate: async () => ({ url: "https://example.com/clip.mp4" }),
		});
		const schema = tool.toJSONSchema();
		expect(schema.function.name).toBe("generate_video");
		expect(schema.function.parameters).not.toHaveProperty(
			"properties.model_name",
		);
		expect(JSON.stringify(schema.function.parameters)).not.toContain(
			"model_name",
		);
	});

	it("pins the composer model onto the tool call and the Backboard request", async () => {
		const calls: unknown[] = [];
		const tool = new GenerateVideoTool({
			getModel: () => ({
				provider: "openrouter",
				name: "bytedance/seedance-2.5",
			}),
			generate: async (request) => {
				calls.push(request);
				return { url: "https://example.com/clip.mp4" };
			},
			fetch: async () => new Response(new Uint8Array([1, 2, 3, 4])),
		});
		const parsed = tool.parseInput({
			prompt: "A cat and a dog singing",
			duration: 30,
			resolution: "480p",
			generate_audio: true,
			video_model_name: "google/veo-3.1-lite",
		});
		expect(parsed.model_provider).toBe("openrouter");
		expect(parsed.model_name).toBe("bytedance/seedance-2.5");
		expect(parsed.model_label).toBe("Seedance 2.5");

		const cwd = await mkdtemp(join(tmpdir(), "generate-video-"));
		try {
			const result = await tool.execute(parsed, {
				...makeContext(new AbortController().signal),
				cwd,
			});
			expect(calls).toEqual([
				{
					prompt: "A cat and a dog singing",
					video_model_provider: "openrouter",
					video_model_name: "bytedance/seedance-2.5",
					video_config: {
						duration: 30,
						resolution: "480p",
						generate_audio: true,
					},
				},
			]);
			expect(result.title).toBe("Video generated");
			expect(result.forLLM).toMatch(/generated-videos\/[a-f0-9]+\.mp4/);
			expect(result.forLLM).not.toContain("https://example.com/clip.mp4");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("pretty-prints Seedance-style model ids", () => {
		expect(
			videoModelLabel({
				provider: "openrouter",
				name: "bytedance/seedance-2.5",
			}),
		).toBe("Seedance 2.5");
	});

	it("asks for duration and quality before generating", async () => {
		const calls: unknown[] = [];
		const asked: unknown[] = [];
		const tool = new GenerateVideoTool({
			getModel: () => ({
				provider: "openrouter",
				name: "bytedance/seedance-2.5",
			}),
			generate: async (request) => {
				calls.push(request);
				return { url: "https://example.com/clip.mp4" };
			},
			fetch: async () => new Response(new Uint8Array([1, 2, 3, 4])),
		});
		const cwd = await mkdtemp(join(tmpdir(), "generate-video-approve-"));
		try {
			await tool.execute(
				tool.parseInput({
					prompt: "Keep everything about this shot",
					images: ["/tmp/ref.png"],
				}),
				{
					...makeContext(new AbortController().signal),
					cwd,
					askQuestions: async (questions) => {
						asked.push(questions);
						return ["Approve", "8s", "720p", "On"];
					},
				},
			);
			expect(asked).toHaveLength(1);
			expect((asked[0] as { header?: string }[])[0]?.header).toBe("Edit Video");
			expect(calls).toEqual([
				{
					prompt: "Keep everything about this shot",
					video_model_provider: "openrouter",
					video_model_name: "bytedance/seedance-2.5",
					video_config: {
						duration: 8,
						resolution: "720p",
						generate_audio: true,
					},
				},
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
