import { describe, expect, it } from "bun:test";
import {
	capacityFallbackCandidates,
	isModelAvailabilityError,
	isModelCapacityError,
	isThinkingCompatibilityError,
} from "../src/core/agent/RuntimeRecovery.ts";
import type { ModelInfo } from "../src/providers/backboard/types.ts";

function model(provider: string, name: string): ModelInfo {
	return {
		id: `${provider}/${name}`,
		label: `${provider}/${name}`,
		provider,
		model: name,
	};
}

describe("runtime model recovery", () => {
	it("prefers recent working models and then GLM-5.3", () => {
		const candidates = capacityFallbackCandidates(
			[model("openrouter", "z-ai/glm-5.3"), model("openai", "gpt-5.6-sol")],
			[
				{ provider: "missing", model: "gone" },
				{ provider: "openai", model: "gpt-5.6-sol" },
			],
		);

		expect(candidates).toEqual([
			{ provider: "openai", model: "gpt-5.6-sol" },
			{ provider: "openrouter", model: "z-ai/glm-5.3" },
		]);
	});

	it("recognizes capacity and thinking compatibility failures", () => {
		expect(
			isModelCapacityError("The model is currently at capacity"),
		).toBeTrue();
		expect(
			isModelAvailabilityError("No endpoints found for z-ai/glm-4.7."),
		).toBeTrue();
		expect(
			isThinkingCompatibilityError(
				"Thinking is not supported for cerebras/z-ai/glm-4.7",
			),
		).toBeTrue();
		expect(isModelCapacityError("Invalid API key")).toBeFalse();
		expect(isModelAvailabilityError("Invalid API key")).toBeFalse();
	});
});
