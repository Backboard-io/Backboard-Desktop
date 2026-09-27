import { describe, expect, it } from "bun:test";
import {
	buildGenerativeMediaPrompt,
	parseCanvasProjectSettings,
} from "../src/prompts/system/generativeMedia.ts";

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

	it("tells the agent to call generate_video instead of curling", () => {
		const prompt = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "bytedance/seedance-2.5" },
		});

		expect(prompt).toContain("call the `generate_video` function tool");
		expect(prompt).toContain("Never use execute, curl");
		expect(prompt).not.toContain("operation=generate_video");
		// On OpenRouter an attached clip is a video reference described as a new video (edit wording fails on Seedance),
		// never read with Read, and failures are retried from the tool's hint or reported.
		expect(prompt).toContain("pass that clip in the references (`input_reference_document_ids`)");
		expect(prompt).toContain("Write the prompt as a new video that follows the reference, never as an edit of it");
		expect(prompt).not.toContain("Keep the same footage, camera motion");
		expect(prompt).toContain("Never open attached images or videos with Read");
		expect(prompt).toContain("If `generate_video` fails with a `hint`, follow it and retry once");
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

		expect(video).toContain('call `ask_user` before `generate_video`');
		expect(video).toContain('options "5s", "8s", "10s", "15s"');
		expect(video).toContain("without asking");
		expect(imageOnly).not.toContain("Video length");
	});

	it("adds the Canvas studio brief only in a Canvas project", () => {
		const selection = {
			videoModel: { provider: "openrouter", name: "runway/aleph-2" },
		};
		const canvas = buildGenerativeMediaPrompt({ ...selection, canvasProject: true });
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
				settings: { aspectRatio: "9:16", duration: 8, resolution: "720p", audio: false },
			}),
		);
		const prompt = buildGenerativeMediaPrompt({
			videoModel: { provider: "openrouter", name: "bytedance/seedance-2.0-fast" },
			canvasProject: true,
			canvasSettings: settings,
		});

		expect(settings).toEqual({ aspectRatio: "9:16", duration: 8, resolution: "720p", audio: false });
		expect(prompt).toContain(
			"Project defaults for new clips (chosen in the Canvas settings under the chat): 9:16, 8 seconds, 720p, no audio.",
		);
		expect(parseCanvasProjectSettings("not json")).toBeUndefined();
	});
});
