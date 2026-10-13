import { describe, expect, it } from "bun:test";
import {
	capacityFallbackCandidates,
	freeFallbackCandidates,
	isModelAvailabilityError,
	isModelCapacityError,
	isThinkingCompatibilityError,
} from "../src/core/agent/RuntimeRecovery.ts";
import {
	isAccountBlockedError,
	isSignInRequiredError,
} from "../src/core/agent/TurnRetry.ts";
import { backboardHttpErrorMessage } from "../src/providers/backboard/errors.ts";
import {
	isFreeCatalogModel,
	normalizeSelectableModels,
} from "../src/providers/backboard/modelCatalog.ts";
import type {
	ModelCatalogItem,
	ModelInfo,
} from "../src/providers/backboard/types.ts";

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

	it("treats only exact-$0, non-router OpenRouter rows as free, like the server", () => {
		const row = (
			name: string,
			extra: Partial<ModelCatalogItem> & Record<string, unknown> = {},
		): ModelCatalogItem => ({
			name,
			provider: "openrouter",
			model_type: "llm",
			input_cost_per_1m_tokens: 0,
			output_cost_per_1m_tokens: 0,
			...extra,
		});
		expect({
			free: isFreeCatalogModel(row("cohere/north-mini-code:free")),
			routerAlias: isFreeCatalogModel(row("openrouter/free")),
			sentinel: isFreeCatalogModel(
				row("openrouter/fusion", {
					input_cost_per_1m_tokens: -1000000,
					output_cost_per_1m_tokens: -1000000,
				}),
			),
			cachedPrice: isFreeCatalogModel(
				row("x/cheap", { cached_input_cost_per_1m_tokens: 0.01 }),
			),
			unpriced: isFreeCatalogModel(
				row("x/unknown", { input_cost_per_1m_tokens: undefined }),
			),
			directProvider: isFreeCatalogModel({
				...row("gpt-free"),
				provider: "openai",
			}),
		}).toEqual({
			free: true,
			routerAlias: false,
			sentinel: false,
			cachedPrice: false,
			unpriced: false,
			directProvider: false,
		});
	});

	it("offers tool-capable free models, largest context first", () => {
		const models = normalizeSelectableModels([
			{
				name: "small:free",
				provider: "openrouter",
				model_type: "llm",
				input_cost_per_1m_tokens: 0,
				output_cost_per_1m_tokens: 0,
				context_limit: 100_000,
			},
			{
				name: "big:free",
				provider: "openrouter",
				model_type: "llm",
				input_cost_per_1m_tokens: 0,
				output_cost_per_1m_tokens: 0,
				context_limit: 500_000,
			},
			{
				name: "notools:free",
				provider: "openrouter",
				model_type: "llm",
				input_cost_per_1m_tokens: 0,
				output_cost_per_1m_tokens: 0,
				supports_tools: false,
				context_limit: 900_000,
			},
			{
				name: "paid",
				provider: "openrouter",
				model_type: "llm",
				input_cost_per_1m_tokens: 1,
				output_cost_per_1m_tokens: 2,
			},
		]);
		expect(freeFallbackCandidates(models)).toEqual([
			{ provider: "openrouter", model: "big:free" },
			{ provider: "openrouter", model: "small:free" },
		]);
	});

	it("keeps the server's refusal text so blocked turns can be told apart", () => {
		const guest = backboardHttpErrorMessage(403, {
			detail: "Sign in to use this model. Free models work without an account.",
		});
		expect({
			guest,
			bare: backboardHttpErrorMessage(500, null),
			blocked: isAccountBlockedError(guest),
			signIn: isSignInRequiredError(guest),
			credits: isSignInRequiredError(
				"You're out of credits, so we paused LLM chat. Add credits on the Billing page.",
			),
		}).toEqual({
			guest:
				"Backboard request failed: HTTP 403: Sign in to use this model. Free models work without an account.",
			bare: "Backboard request failed: HTTP 500",
			blocked: true,
			signIn: true,
			credits: false,
		});
	});
});
