import {
	executionFailed,
	type ToolExecutionMetadata,
} from "../tools/ToolFailure.ts";
import type { AgentTaskRecord } from "./AgentTaskTypes.ts";

/** Preserve mechanical failure categories when joining or replaying a task. */
export function agentTaskFailure(
	task: AgentTaskRecord,
): ToolExecutionMetadata | undefined {
	if (task.execution && executionFailed(task.execution)) {
		const { failureCategory, exitCode, timedOut, cancelled } = task.execution;
		return {
			failureCategory: failureCategory ?? "unknown",
			exitCode,
			timedOut,
			cancelled,
		};
	}
	if (task.persistenceError) return { failureCategory: "unavailable" };
	if (
		task.status === "queued" ||
		task.status === "running" ||
		task.status === "completed"
	)
		return undefined;
	if (task.status === "cancelled")
		return { failureCategory: "cancelled", cancelled: true };
	if (task.status === "interrupted" || task.result?.data.status === "rejected")
		return { failureCategory: "unavailable" };
	return { failureCategory: "execution" };
}
