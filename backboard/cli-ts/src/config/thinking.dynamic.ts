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
		return evidence?.routineTask || evidence?.requestKind === "subagent"
			? "low"
			: "medium";
	}
	// Escalation is bounded. Repeating failures does not establish that maximum
	// effort helps, and infrastructure/permission waits provide no semantic evidence.
	if (evidence.toolRound?.hadSemanticFailure) return "high";
	return "low";
}

export function shouldDeferDynamicThinking(
	nativeAdaptive: boolean,
	evidence: DynamicThinkingEvidence | undefined,
): boolean {
	if (!nativeAdaptive) return false;
	if (evidence?.phase !== "tool_outputs") return !evidence?.routineTask;
	return false;
}
