import { describe, expect, it } from "bun:test";
import { buildGenerativeMediaPrompt } from "../src/prompts/system/generativeMedia.ts";

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
	});

	it("tells the agent to ask for a model instead of calling the media endpoints", () => {
		const prompt = buildGenerativeMediaPrompt({});

		expect(prompt).toContain("Media generation is off for this turn");
		expect(prompt).not.toContain("operation=generate_video");
		expect(prompt).not.toContain("is fixed for the turn");
	});
});
