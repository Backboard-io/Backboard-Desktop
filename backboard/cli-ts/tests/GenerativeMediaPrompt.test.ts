import { describe, expect, it } from "bun:test";
import {
	ASK_BEFORE_GENERATING_OPTIONS,
	buildGenerativeMediaPrompt,
	parseCanvasProjectSettings,
} from "../src/prompts/system/generativeMedia.ts";
import { getToolPrompt } from "../src/prompts/tools/index.tsx";

describe("buildGenerativeMediaPrompt", () => {
	it("names the models the composer selected and pins them for the turn", () => {
		const prompt = buildGenerativeMediaPrompt({
			imageModel: { provider: "google", name: "gemini-3.1-flash-image" },
			videoModel: { provider: "openrouter", name: "google/veo-3.1-lite" },
		});

		expect(prompt).toContain("generate_image");
		expect(prompt).toContain("generate_video");
		expect(prompt).toContain("google/gemini-3.1-flash-image");
		expect(prompt).toContain("openrouter/google/veo-3.1-lite");
		expect(prompt).toContain("The selected model is fixed for the turn.");
	});

	it("omits a tool whose picker is off", () => {
		const prompt = buildGenerativeMediaPrompt({
			videoModel: {
				provider: "openrouter",
				name: "bytedance/seedance-2.0-mini",
			},
		});

		expect(prompt).not.toContain("generate_image");
		expect(prompt).toContain("openrouter/bytedance/seedance-2.0-mini");
	});

	it("uses the Desktop Veo function with numbered frames and separate image approval", () => {
		const prompt = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "google/veo-3.1-lite" },
			imageModel: {
				provider: "openrouter",
				name: "google/gemini-3.1-flash-image-preview",
			},
			directVideoFrames: ["start.png", "end.png"],
			askBeforeGenerating: true,
		});
		expect(prompt).toContain("call the `generate_video_direct` function tool");
		expect(prompt).toContain('1. "start.png"\n2. "end.png"');
		expect(prompt).toContain("The tool asks for confirmation");
		expect(prompt).toContain("Before calling `generate_image`, use `ask_user`");
		expect(prompt).not.toContain("`video_config`");
	});

	it("tells the agent to call generate_video instead of curling", () => {
		const prompt = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "bytedance/seedance-2.5" },
		});

		expect(prompt).toContain("call the `generate_video` function tool");
		expect(prompt).toContain("Never use execute, curl");
		expect(prompt).not.toContain("operation=generate_video");
		expect(prompt).toContain("Never open attached images or videos with Read");
		expect(prompt).toContain(
			"If `generate_video` fails with a `hint`, follow it and retry once",
		);
	});

	it("uses the selected tool schema for source clips and video settings", () => {
		for (const name of ["runway/aleph-2", "bytedance/seedance-2.5"]) {
			const prompt = buildGenerativeMediaPrompt({
				videoModel: { provider: "openrouter", name },
			});

			expect(prompt).toContain("input_video_document_id");
			expect(prompt).toContain("video_config");
			expect(prompt).toContain(
				"Omit unused optional settings and input fields instead of sending null",
			);
			expect(prompt).toContain(
				"only settings exposed by the selected tool's schema",
			);
			expect(prompt).toContain("describe only the requested change");
			expect(prompt).toContain(
				"Do not invent duration or resolution overrides for an edit or upscale",
			);
			expect(prompt).not.toContain("this provider has no source-video field");
			expect(prompt).not.toContain("Only Hailuo 3 takes a clip plus images");
			expect(prompt).not.toContain(
				"Seedance models take no video input at all",
			);
			expect(prompt).not.toContain("never as an edit of it");
		}
	});

	it("keeps the video tool description consistent with hosted media arguments", () => {
		for (const profile of ["default", "openai", "anthropic"] as const) {
			const prompt = getToolPrompt("generate_video", { profile });
			expect(prompt).toContain("video_config");
			expect(prompt).toContain(
				"Omit unused optional settings and input fields instead of sending null",
			);
			expect(prompt).toContain("input_video_document_id");
			expect(prompt).toContain(
				"only settings exposed by the selected tool's schema",
			);
			expect(prompt).not.toContain("not input_video_document_id");
			expect(prompt).not.toContain("Only Hailuo 3");
		}
	});

	it("tells the agent to ask for a model instead of calling the media endpoints", () => {
		const prompt = buildGenerativeMediaPrompt({});

		expect(prompt).toContain("Media generation is off for this turn");
		expect(prompt).not.toContain("operation=generate_video");
		expect(prompt).not.toContain("is fixed for the turn");
	});

	it("keeps Backboard's media tools off a key or subscription turn", () => {
		const selected = {
			imageModel: { provider: "google", name: "gemini-3.1-flash-image" },
			videoModel: { provider: "openrouter", name: "google/veo-3.1-lite" },
		};
		const chatgpt = buildGenerativeMediaPrompt({
			...selected,
			route: { source: "subscription", provider: "openai-subscription" },
		});
		const claude = buildGenerativeMediaPrompt({
			...selected,
			route: { source: "subscription", provider: "anthropic-subscription" },
		});
		const key = buildGenerativeMediaPrompt({
			...selected,
			route: { source: "byok", provider: "openai" },
		});
		const backboard = buildGenerativeMediaPrompt({
			...selected,
			route: { source: "backboard", provider: "openai" },
		});

		expect(chatgpt).toContain("use your built-in image generation tool");
		expect(chatgpt).toContain("video generation needs a Backboard model");
		expect(claude).toContain("runs on the user's Claude subscription");
		expect(key).toContain("runs on the user's own API key");
		for (const prompt of [chatgpt, claude, key]) {
			expect(prompt).not.toContain("google/gemini-3.1-flash-image");
			expect(prompt).not.toContain("call the `generate_video` function tool");
		}
		expect(backboard).toContain("google/gemini-3.1-flash-image");
	});

	it("asks for a video length only when a video model is on", () => {
		const video = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "google/veo-3.1-lite" },
		});
		const imageOnly = buildGenerativeMediaPrompt({
			imageModel: { provider: "google", name: "gemini-3.1-flash-image" },
		});

		expect(video).toContain("call `ask_user` before `generate_video`");
		expect(video).toContain('options "5s", "8s", "10s", "15s"');
		expect(video).toContain("without asking");
		expect(imageOnly).not.toContain("Video length");
	});

	it("confirms each generation with ask_user only when Ask Before Generating is on", () => {
		const selection = {
			imageModel: { provider: "google", name: "gemini-3.1-flash-image" },
			videoModel: { provider: "openrouter", name: "bytedance/seedance-2.5" },
		};
		const asking = buildGenerativeMediaPrompt({
			...selection,
			askBeforeGenerating: true,
		});
		const off = buildGenerativeMediaPrompt({
			...selection,
			askBeforeGenerating: false,
		});

		expect(asking).toContain("### Ask Before Generating");
		expect(asking).toContain(
			"Before calling `generate_image` or `generate_video`, call `ask_user` once",
		);
		expect(asking).toContain(
			`options ${ASK_BEFORE_GENERATING_OPTIONS.map((option) => `"${option}"`).join(", ")}`,
		);
		expect(ASK_BEFORE_GENERATING_OPTIONS).toEqual([
			"Generate",
			"Change something",
		]);
		expect(asking).toContain('only after the user answers "Generate"');
		expect(asking).toContain("Never quote a price you do not know.");
		// The length question rides in the same card, and a retry of an approved request is not re-asked.
		expect(asking).toContain(
			'put the "Video length" question first in that same `ask_user` call',
		);
		expect(asking).toContain("needs no new confirmation");
		expect(asking).toContain(
			"call `generate_video` yourself once the user approves",
		);
		expect(asking).not.toContain("you must call `generate_video` directly");
		// Off keeps today's prompt byte for byte.
		expect(off).toBe(buildGenerativeMediaPrompt(selection));
		expect(off).not.toContain("Ask Before Generating");
		expect(off).toContain("you must call `generate_video` directly");
	});

	it("never asks before generating on a turn without Backboard media", () => {
		const subscription = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "bytedance/seedance-2.5" },
			route: { source: "subscription", provider: "anthropic-subscription" },
			askBeforeGenerating: true,
		});
		const noModels = buildGenerativeMediaPrompt({ askBeforeGenerating: true });

		expect(subscription).not.toContain("Ask Before Generating");
		expect(noModels).not.toContain("Ask Before Generating");
	});

	it("adds the Canvas studio brief only in a Canvas project", () => {
		const selection = {
			videoModel: { provider: "openrouter", name: "runway/aleph-2" },
		};
		const canvas = buildGenerativeMediaPrompt({
			...selection,
			canvasProject: true,
		});
		const plain = buildGenerativeMediaPrompt(selection);

		expect(canvas).toContain("## Canvas project");
		expect(canvas).toContain("not a coding assistant");
		expect(canvas).toContain("keep everything about the shot identical");
		expect(canvas).toContain("Never edit or delete `.backboard/canvas.json`");
		expect(canvas.indexOf("## Image and video generation")).toBe(0);
		expect(plain).not.toContain("## Canvas project");
	});

	it("tells a Canvas agent the project's media defaults", () => {
		const settings = parseCanvasProjectSettings(
			JSON.stringify({
				version: 1,
				nodes: [],
				settings: {
					aspectRatio: "9:16",
					duration: 8,
					resolution: "720p",
					audio: false,
				},
			}),
		);
		const prompt = buildGenerativeMediaPrompt({
			videoModel: {
				provider: "openrouter",
				name: "bytedance/seedance-2.0-fast",
			},
			canvasProject: true,
			canvasSettings: settings,
		});

		expect(settings).toEqual({
			aspectRatio: "9:16",
			duration: 8,
			resolution: "720p",
			audio: false,
		});
		expect(prompt).toContain(
			"Project defaults for new clips (chosen in the Canvas settings under the chat): 9:16, 8 seconds, 720p, no audio.",
		);
		expect(parseCanvasProjectSettings("not json")).toBeUndefined();
	});
});
