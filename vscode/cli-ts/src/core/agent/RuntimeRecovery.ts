import type { ModelRef } from "../../config/defaults.ts";
import type { ModelInfo } from "../../providers/backboard/types.ts";
import { errorMessage } from "../../utils/errors.ts";

export function isModelCapacityError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return [
		"currently at capacity",
		"model is at capacity",
		"model at capacity",
		"model capacity",
		"provider is overloaded",
		"provider overloaded",
		"model is overloaded",
		"high demand",
		"no capacity",
	].some((pattern) => message.includes(pattern));
}

export function isModelAvailabilityError(error: unknown): boolean {
	if (isModelCapacityError(error)) return true;
	const message = errorMessage(error).toLowerCase();
	return [
		"no endpoints found",
		"no endpoint found",
		"no endpoints available",
		"no available endpoints",
		"no provider available",
		"no providers available",
		"model is unavailable",
		"model unavailable",
	].some((pattern) => message.includes(pattern));
}

export function isThinkingCompatibilityError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	if (!message.includes("thinking") && !message.includes("reasoning")) {
		return false;
	}
	return [
		"not supported",
		"unsupported",
		"not available",
		"unavailable",
		"cannot",
		"can't",
		"invalid",
		"unknown field",
		"unexpected field",
		"does not support",
	].some((pattern) => message.includes(pattern));
}

/**
 * Capacity recovery order: recently successful models first, then an available
 * GLM-5.3 model. Models already tried during this turn are skipped.
 */
export function capacityFallbackCandidates(
	models: readonly ModelInfo[],
	successfulModels: readonly ModelRef[],
): ModelRef[] {
	const available = new Map(
		models.map((model) => [modelKey(model), model] as const),
	);
	const previous = successfulModels.flatMap((model) => {
		const match = available.get(modelKey(model));
		return match ? [{ provider: match.provider, model: match.model }] : [];
	});
	const glm = [...models]
		.filter((model) => isGlm53(model.model))
		.sort((a, b) => glmRank(a.model) - glmRank(b.model))
		.map((model) => ({ provider: model.provider, model: model.model }));

	const seen = new Set<string>();
	return [...previous, ...glm].filter((model) => {
		const key = modelKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function modelKey(model: ModelRef): string {
	return `${model.provider}/${model.model}`.trim().toLowerCase();
}

function isGlm53(model: string): boolean {
	return /(?:^|[/_.-])glm[-_.]?5[.-]3(?:$|[/_.-])/.test(model.toLowerCase());
}

function glmRank(model: string): number {
	const normalized = model.toLowerCase();
	return /(?:^|\/)glm[-_.]?5[.-]3$/.test(normalized) ? 0 : 1;
}
