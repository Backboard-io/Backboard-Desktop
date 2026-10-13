import type { ToolRoundThinkingEvidence } from "../../config/thinking.types.ts";
import type { ToolOutput } from "../tools/ToolScheduler.ts";

export function summarizeToolRound(
	outputs: ToolOutput[],
): Omit<
	ToolRoundThinkingEvidence,
	"index" | "consecutiveFailureCount" | "maxUsed"
> {
	return {
		readOnlyOnly:
			outputs.length > 0 && outputs.every((o) => o.metadata?.readOnly === true),
		hadWriteOrExecute: outputs.some((o) => o.metadata?.readOnly === false),
		hadToolError: outputs.some((o) => o.metadata?.error === true),
		hadNonZeroExit: outputs.some(
			(o) =>
				typeof o.metadata?.exitCode === "number" &&
				o.metadata.exitCode !== 0 &&
				o.metadata.outcome !== "no_match" &&
				o.metadata.outcome !== "partial",
		),
		hadTimeout: outputs.some((o) => o.metadata?.timedOut === true),
		// Mechanical failures need a repair or a blocker, not more reasoning.
		hadSemanticFailure: outputs.some(
			(o) =>
				o.metadata?.failureCategory === "execution" &&
				o.metadata?.validation === "failed",
		),
	};
}

export function toolRoundFailed(outputs: ToolOutput[]): boolean {
	return summarizeToolRound(outputs).hadSemanticFailure === true;
}
