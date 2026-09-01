import { DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD } from "./thinking.constants.ts";
import type {
	DynamicThinkingEvidence,
	ThinkingLevel,
} from "./thinking.types.ts";

export type DynamicThinkingDecision = "defer" | ThinkingLevel;

export function resolveDynamicThinkingLevel(
	evidence: DynamicThinkingEvidence | undefined,
): ThinkingLevel {
	if (evidence?.phase !== "tool_outputs") {
		if (evidence?.hasDiagnosticText) return "high";
		// Parallel workers already receive a narrowly-scoped task and a reduced
		// tool surface. Starting every one at the parent turn's balanced effort
		// multiplies long reasoning latency across the whole fan-out. Dynamic mode
		// starts workers fast, then the tool-output branch below still escalates
		// when execution provides evidence that deeper reasoning is warranted.
		return evidence?.requestKind === "subagent" ? "low" : "medium";
	}

	const round = evidence.toolRound;
	if (!round) return evidence.requestKind === "subagent" ? "low" : "medium";

	const failed = round.hadToolError || round.hadNonZeroExit || round.hadTimeout;
	if (!failed) return evidence.requestKind === "subagent" ? "low" : "medium";

	if (
		round.consecutiveFailureCount >= DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD &&
		!round.maxUsed
	) {
		return "max";
	}

	return "high";
}

export function shouldDeferDynamicThinking(
	nativeAdaptive: boolean,
	evidence: DynamicThinkingEvidence | undefined,
): boolean {
	if (!nativeAdaptive) return false;
	if (evidence?.phase !== "tool_outputs") return true;
	const round = evidence.toolRound;
	if (!round) return true;
	return !(round.hadToolError || round.hadNonZeroExit || round.hadTimeout);
}
