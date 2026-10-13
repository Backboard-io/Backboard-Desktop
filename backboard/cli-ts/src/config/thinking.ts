import { resolveBudget } from "./thinking.budgets.ts";
import { THINKING_LEVELS } from "./thinking.constants.ts";
import {
	resolveDynamicThinkingLevel,
	shouldDeferDynamicThinking,
} from "./thinking.dynamic.ts";
import type {
	ThinkingConfig,
	ThinkingIntent,
	ThinkingLevel,
	ThinkingResolveContext,
} from "./thinking.types.ts";
import {
	resolveThinkingCapabilities,
	tokenFieldFor,
} from "./thinkingCapabilities.ts";

export function parseThinking(
	value: string,
): ThinkingIntent | null | undefined {
	const normalized = value.trim().toLowerCase();
	if (["default", "provider-default", "provider_default"].includes(normalized))
		return { kind: "default" };
	if (["off", "no", "disable", "disabled", "false", "0"].includes(normalized))
		return null;

	if (["auto", "adaptive"].includes(normalized)) return { kind: "dynamic" };
	const level =
		normalized === "maximum"
			? "max"
			: normalized === "fast"
				? "low"
				: normalized === "balanced"
					? "medium"
					: normalized === "deep"
						? "high"
						: normalized;
	if (isThinkingLevel(level)) return { kind: "level", level };
	if (normalized === "dynamic") return { kind: "dynamic" };

	const budget = Number(normalized);
	if (Number.isInteger(budget) && budget > 0) {
		return { kind: "budget", tokens: budget };
	}

	throw new Error(
		"thinking must be one of: off, default, low, medium, high, xhigh, max, dynamic, or a token budget",
	);
}

export function resolveThinking(
	context: ThinkingResolveContext,
): ThinkingConfig | null | undefined {
	const { intent, model, metadata } = context;
	if (intent === undefined || intent === null) return intent;

	const capabilities = resolveThinkingCapabilities({ model, metadata });
	const { profile } = capabilities;
	const allowedFields = capabilities.allowedFields;
	if (!capabilities.supportsThinking) {
		return null;
	}
	if (capabilities.defaultsOnly) {
		return withVisibleReasoning({}, allowedFields);
	}

	if (allowedFields.length === 0) {
		return null;
	}

	if (intent.kind === "default") {
		return withVisibleReasoning({}, allowedFields);
	}

	if (intent.kind === "dynamic") {
		if (
			shouldDeferDynamicThinking(
				profile?.nativeAdaptive ?? false,
				context.dynamicEvidence,
			)
		) {
			return withVisibleReasoning({}, allowedFields);
		}
		const level = resolveDynamicThinkingLevel(context.dynamicEvidence);
		const tokenField = tokenFieldFor(allowedFields);
		if (tokenField) {
			const budget = resolveBudget(
				profile?.budgetPolicyId ?? "generic",
				level,
				{
					field: tokenField,
					metadata,
				},
			);
			return withVisibleReasoning(
				tokenField === "max_tokens"
					? { max_tokens: budget }
					: { budget_tokens: budget },
				allowedFields,
			);
		}
		if (allowedFields.includes("effort")) {
			return withVisibleReasoning(
				{ effort: clampEffort(level, profile?.maxEffort) },
				allowedFields,
			);
		}
		return null;
	}

	if (intent.kind === "budget") {
		const tokenField = tokenFieldFor(allowedFields);
		if (!tokenField) {
			return null;
		}
		return withVisibleReasoning(
			tokenField === "max_tokens"
				? { max_tokens: intent.tokens }
				: { budget_tokens: intent.tokens },
			allowedFields,
		);
	}

	if (allowedFields.includes("effort")) {
		return withVisibleReasoning(
			{ effort: clampEffort(intent.level, profile?.maxEffort) },
			allowedFields,
		);
	}

	const tokenField = tokenFieldFor(allowedFields);
	if (!tokenField) {
		return null;
	}
	const budget = resolveBudget(
		profile?.budgetPolicyId ?? "generic",
		intent.level,
		{
			field: tokenField,
			metadata,
		},
	);
	return withVisibleReasoning(
		tokenField === "max_tokens"
			? { max_tokens: budget }
			: { budget_tokens: budget },
		allowedFields,
	);
}

/**
 * Reasoning traces are always user-visible. Backboard exposes this through
 * `exclude_reasoning` for providers that support the field; Studio never
 * offers a setting that can change this invariant.
 */
function withVisibleReasoning(
	config: ThinkingConfig,
	allowedFields: readonly string[],
): ThinkingConfig {
	if (allowedFields.includes("exclude_reasoning")) {
		return { ...config, exclude_reasoning: false };
	}
	return config;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function clampEffort(
	level: ThinkingLevel,
	maxEffort: ThinkingLevel | undefined,
): ThinkingLevel {
	if (maxEffort === undefined) return level;
	const order: readonly ThinkingLevel[] = [
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	return order.indexOf(level) > order.indexOf(maxEffort) ? maxEffort : level;
}
