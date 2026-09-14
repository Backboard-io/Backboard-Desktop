import { describe, expect, it } from "bun:test";
import { buildRunMessageRequest } from "../src/core/agent/RunMessageRequestBuilder.ts";
import { Session } from "../src/core/session/Session.ts";

describe("buildRunMessageRequest", () => {
	it("includes the local workspace id in message metadata", () => {
		const request = buildRunMessageRequest("hello", {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			assistantId: "asst_test",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "auto",
			memoryProfile: "code",
			workspaceId: "workspace_test",
		});

		expect(request.metadata).toEqual({
			backboard_workspace_id: "workspace_test",
		});
	});

	it("carries the captured billing route and omits it when there is none", () => {
		const context = {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "off" as const,
			memoryProfile: "code" as const,
		};

		expect(
			buildRunMessageRequest("hello", { ...context, source: "byok" }).source,
		).toBe("byok");
		expect("source" in buildRunMessageRequest("hello", context)).toBe(false);
	});

	it("adds image-generation fields only when the toggle is on", () => {
		const context = {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "off" as const,
			memoryProfile: "code" as const,
		};

		const off = buildRunMessageRequest("hello", context);
		expect(off.image_generation).toBeUndefined();
		expect(off.image_model_provider).toBeUndefined();
		expect(off.image_model_name).toBeUndefined();

		const on = buildRunMessageRequest("hello", {
			...context,
			imageGeneration: true,
		});
		expect(on.image_generation).toBe("auto");
		expect(on.image_model_provider).toBe("google");
		expect(on.image_model_name).toBe("gemini-3.1-flash-image");
	});

	it("pins a selected OpenRouter upstream and otherwise leaves routing automatic", () => {
		const context = {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			model: { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
			memory: "off" as const,
			memoryProfile: "code" as const,
		};

		expect(buildRunMessageRequest("hello", context).openrouter).toBeUndefined();
		expect(
			buildRunMessageRequest("hello", {
				...context,
				openRouterProvider: "DeepInfra",
			}).openrouter,
		).toEqual({
			providers: ["DeepInfra"],
			allow_fallbacks: false,
		});
		expect(
			buildRunMessageRequest("hello", {
				...context,
				model: { provider: "openai", model: "gpt-5.5" },
				openRouterProvider: "DeepInfra",
			}).openrouter,
		).toBeUndefined();
	});
});
