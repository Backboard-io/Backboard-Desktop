import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const agent: PromptModule = definePrompt(
	buildAgentPrompt(),
	buildAgentPrompt,
);

function buildAgentPrompt(context: PromptContext = {}): string {
	return `Delegate one bounded task and wait for its final report. Optimize wall-clock completion time and correctness together.

Honor an explicit user request for sub-agents. For substantial work, delegate independent investigation or writable implementation when concurrent progress outweighs startup and integration costs. Use two to four coarse workers with non-overlapping ownership; writable workers are appropriate for independent components, tests, or separate files. Use direct file tools for tiny tasks, dependent edits, and shared core files.

Issue multiple Agent calls for independent tasks in the same assistant message so workers run concurrently. ${hasTool(context, "AgentSpawn") && hasTool(context, "AgentWait") ? "Use AgentSpawn when useful parent work can continue, then AgentWait when the result is needed." : ""}

Each prompt must include the goal, relevant paths and context, ownership boundaries, acceptance criteria, and the expected report. Workers cannot ask the user questions or recursively delegate. Mark read_only for investigation; write workers use isolated workspaces when configured. Coordinate shared contracts before parallel writes and preserve other work.

After an integrated result, inspect and validate the coordinator workspace. Do not copy, reapply, or cherry-pick changes already integrated by the harness. Surface conflicts or failed workers explicitly; never infer success from a worker merely stopping. Check required results before your final response.

${hasTool(context, "AgentSpawn") ? "Agent and AgentSpawn share the same workspace backend. Switching between them does not repair a failed prerequisite. A queued handle confirms registration only, not model execution or successful integration. " : ""}A reported unavailable prerequisite needs a concrete environment change; do not repeat the same failed setup.

Use subagent_type=rlm only for analysis of supplied JSON variables in the JavaScript REPL. timeout_ms applies to RLM analysis, not ordinary workers. Follow the schema for inputs.`;
}
