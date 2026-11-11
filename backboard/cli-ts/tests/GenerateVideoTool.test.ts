import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import type { GenerateVideoRequest } from "../src/providers/backboard/types.ts";
import { GenerateVideoTool } from "../src/tools/GenerateVideoTool.tsx";
import { makeContext } from "./helpers.ts";

const model = { provider: "openrouter", name: "google/veo-3.1-lite" };

function testContext(
	selection: Partial<NonNullable<ToolContext["directVideoGeneration"]>> = {},
): ToolContext {
	return {
		...makeContext(new AbortController().signal),
		directVideoGeneration: {
			model,
			askBeforeGenerating: false,
			framePaths: [],
			...selection,
		},
	};
}

function testTool(calls: GenerateVideoRequest[] = []) {
	return new GenerateVideoTool({
		generate: async (request) => {
			calls.push(request);
			return { url: "https://example.com/clip.mp4" };
		},
		fetch: async () => new Response(new Uint8Array([1, 2, 3, 4])),
	});
}

describe("GenerateVideoTool", () => {
	it("advertises a distinct client function without a model argument", () => {
		const tool = testTool();
		const schema = tool.toJSONSchema();
		expect(schema.function.name).toBe("generate_video_direct");
		expect(JSON.stringify(schema.function.parameters)).not.toContain(
			"model_name",
		);
		expect(() =>
			tool.parseInput({ prompt: "A forest", duration: 5 }),
		).toThrow();
	});

	it("sends the selected model and only supported, supplied settings", async () => {
		const calls: GenerateVideoRequest[] = [];
		const tool = testTool(calls);
		const input = tool.parseInput({
			prompt: "A cat in a forest",
			duration: "4",
			resolution: "720p",
			generate_audio: false,
			aspect_ratio: "16:9",
			video_model_name: "another-model",
			provider: { order: ["another-provider"] },
		});
		const cwd = await mkdtemp(join(tmpdir(), "generate-video-"));
		try {
			const result = await tool.execute(input, { ...testContext(), cwd });
			expect(calls).toEqual([
				{
					prompt: "A cat in a forest",
					video_model_provider: model.provider,
					video_model_name: model.name,
					video_config: {
						duration: 4,
						resolution: "720p",
						generate_audio: false,
						aspect_ratio: "16:9",
					},
				},
			]);
			expect(result.title).toBe("Video generated");
			expect(result.forLLM).toMatch(/generated-videos\/[a-f0-9]+\.mp4/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("confirms the actual frames before submitting and omits unspecified settings", async () => {
		const calls: GenerateVideoRequest[] = [];
		const tool = testTool(calls);
		const cwd = await mkdtemp(join(tmpdir(), "generate-video-"));
		const framePaths = [join(cwd, "start.png"), join(cwd, "end.png")];
		try {
			await tool.execute(
				tool.parseInput({
					prompt: "A toy boat drifts",
					first_frame: 1,
					last_frame: 2,
				}),
				{
					...testContext({ askBeforeGenerating: true, framePaths }),
					cwd,
					askQuestions: async (questions) => {
						expect(calls).toHaveLength(0);
						expect(questions).toHaveLength(1);
						expect(questions[0]?.header).toBe("Confirm generation");
						expect(questions[0]?.question).toContain("First frame: start.png");
						expect(questions[0]?.question).toContain("Last frame: end.png");
						return ["Generate"];
					},
				},
			);
			expect(calls).toEqual([
				{
					prompt: "A toy boat drifts",
					video_model_provider: model.provider,
					video_model_name: model.name,
					firstFramePath: framePaths[0],
					lastFramePath: framePaths[1],
				},
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("does not generate without approval or without an authorized selection", async () => {
		const calls: GenerateVideoRequest[] = [];
		const tool = testTool(calls);
		const input = tool.parseInput({ prompt: "A toy boat drifts" });
		await expect(
			tool.execute(input, {
				...testContext({ askBeforeGenerating: true }),
				askQuestions: async () => [],
			}),
		).rejects.toThrow("Video generation was not approved");
		await expect(
			tool.execute(input, makeContext(new AbortController().signal)),
		).rejects.toThrow("Direct video generation is unavailable");
		await expect(
			tool.execute(
				tool.parseInput({ ...input, first_frame: 2 }),
				testContext(),
			),
		).rejects.toThrow("No attached image with frame number 2");
		expect(calls).toHaveLength(0);
	});
});
