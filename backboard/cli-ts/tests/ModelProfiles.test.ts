import { describe, expect, it } from "bun:test";
import {
	combineToolAllowlists,
	combineToolExclusions,
	getModelProfile,
	resolveModelProfile,
} from "../src/config/modelProfiles/index.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";

describe("model profiles", () => {
	it("matches model profiles from provider/model strings", () => {
		expect(
			resolveModelProfile({ provider: "openai", model: "gpt-5.5" }).name,
		).toBe("openai");
		expect(
			resolveModelProfile({
				provider: "anthropic",
				model: "claude-sonnet-4.5",
			}).name,
		).toBe("anthropic");
		expect(
			resolveModelProfile({ provider: "openrouter", model: "z-ai/glm-5.2" })
				.name,
		).toBe("glm");
	});

	it("finds model profiles by partial profile names", () => {
		expect(getModelProfile("open")?.name).toBe("openai");
		expect(getModelProfile("anth")?.name).toBe("anthropic");
		expect(getModelProfile("missing")).toBeUndefined();
	});

	it("combines model profile and base profile tool allowlists", () => {
		expect(combineToolAllowlists([], [])).toEqual([]);
		expect(combineToolAllowlists([], ["Read", "Grep"])).toEqual([
			"read",
			"grep",
		]);
		expect(
			combineToolAllowlists(["Read", "Edit", "Execute"], ["Read", "Grep"]),
		).toEqual(["read"]);
	});

	it("combines tool exclusions", () => {
		expect(combineToolExclusions(["Write"], ["Edit", "Write"])).toEqual([
			"write",
			"edit",
		]);
	});

	it("configures model profile edit surfaces", () => {
		expect(
			resolveModelProfile({ provider: "openai", model: "gpt-5.5" })
				.excludedTools,
		).toEqual(["Write", "Edit"]);
		expect(
			resolveModelProfile({ provider: "anthropic", model: "claude" })
				.excludedTools,
		).toEqual(["ApplyPatch"]);
		expect(
			resolveModelProfile({ provider: "openrouter", model: "z-ai/glm" })
				.excludedTools,
		).toEqual(["ApplyPatch"]);
	});

	it("keeps model profile prompts identical until variants are configured", () => {
		const defaultPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "openrouter",
				model: "z-ai/glm-5.2",
			}).systemPromptLayout,
		});
		const openaiPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "openai",
				model: "gpt-5.5",
			}).systemPromptLayout,
		});
		const antPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "anthropic",
				model: "claude-sonnet-4.5",
			}).systemPromptLayout,
		});

		expect(openaiPrompt).toBe(defaultPrompt);
		expect(antPrompt).toBe(defaultPrompt);
		expect(openaiPrompt).toContain("You are Backboard");
	});

	it("instructs every prompt profile to parallelize independent tool work", () => {
		for (const profile of ["default", "openai", "anthropic", "glm"] as const) {
			const prompt = getSystemPrompt({ profile });
			expect(prompt).toMatch(/independent tool calls/i);
			expect(prompt).toMatch(/progress commentary/i);
			expect(prompt).toMatch(/stream while safe tools run/i);
		}
	});

	it("keeps throwaway verification artifacts out of every prompt profile", () => {
		for (const profile of ["default", "openai", "anthropic", "glm"] as const) {
			const prompt = getSystemPrompt({ profile, enabledTools: ["Execute"] });
			expect(prompt).toMatch(/throwaway artifacts out of the project/i);
			expect(prompt).toMatch(/remove it before finishing/i);
		}
	});

	it("teaches every prompt profile how to integrate with Backboard", () => {
		for (const profile of ["default", "openai", "anthropic", "glm"] as const) {
			const prompt = getSystemPrompt({ profile });
			expect(prompt).toContain(
				"Backboard is the default AI platform for this IDE",
			);
			expect(prompt).toContain("POST /threads/messages");
			expect(prompt).toContain("POST /threads/tool-outputs");
			expect(prompt).toContain("X-API-Key");
			expect(prompt).toContain("GET /models");
			expect(prompt).toContain("Do not confuse the two layers");
		}
	});

	it("prefers Backboard MCP docs and falls back to official web docs", () => {
		const withMcp = getSystemPrompt({
			enabledTools: ["mcp__backboard__search_docs", "FetchUrl"],
		});
		expect(withMcp).toContain("mcp__backboard__*");
		expect(withMcp).not.toContain("Fetch `https://docs.backboard.io/llms.txt`");

		const withFetch = getSystemPrompt({ enabledTools: ["FetchUrl"] });
		expect(withFetch).toContain("https://docs.backboard.io/llms.txt");
		expect(withFetch).toContain("https://docs.backboard.io/api-reference/");
	});
});
