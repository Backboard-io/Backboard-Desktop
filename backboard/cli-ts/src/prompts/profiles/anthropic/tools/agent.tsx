import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const agent: PromptModule = definePrompt(
	buildAgentPrompt(),
	buildAgentPrompt,
);

function buildAgentPrompt(context: PromptContext = {}): string {
	return `Launch a subagent and block until its final report is ready. Use AgentSpawn plus a later AgentWait when useful parent work can continue before the result is needed.

  Optimize for wall-clock completion time, not agent count. Always honor an explicit user request for subagents. Otherwise, use direct file tools for ordinary coding and delegate only independent research or two to four coarse workstreams with clear non-overlapping ownership when parallel model-time savings should exceed startup and integration overhead. Prefer read-only workers for research.

  Required inputs:
  - subagent_type: which subagent to run. "worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL.
  - prompt: the full task to run.

  Capabilities:
  - The subagent works independently and returns one final report; none of its intermediate steps reach your context.
  - Each call is stateless and returns a single final report with no follow-up questions. The subagent cannot talk to the user.

${whenNotToUse(context)}

  How to write a good prompt (template):
  1. Goal:
  2. Context (repo paths / commands / links):
  3. Constraints (what to avoid / must preserve):
  4. Questions to answer or steps to take:
  5. Expected output format (e.g. file paths + summary, patch, checklist):

  Usage notes:
  1. To run subagents in parallel, issue multiple Agent calls in the same assistant message instead of waiting for each result before spawning the next.
  2. The subagent returns one message to you; the user sees nothing unless you summarize it.
  3. State plainly whether the subagent should write code or only research, and exactly what to return.
  4. For rlm, put all detail in the prompt, pass structured data through variables when useful, and end with \`SUBMIT(answer)\`.
  5. Set \`read_only: true\` for research-only workers. The runtime enforces non-mutating tools and may start them while your response is still streaming.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`subagent_type\` | \`string enum: worker, rlm\` | no | "worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL. |
| \`prompt\` | \`string\` | yes | The full delegated prompt, including all task detail, context, and report requirements. |
| \`read_only\` | \`boolean\` | no | Restrict a worker to non-mutating workspace tools so independent research can start while the parent response streams. |
| \`variables\` | \`object\` | no | Optional JSON object for rlm sub-agents. Values are available as \`inputs\`; valid non-reserved keys are also direct variables. |
| \`timeout_ms\` | \`number\` | no | Optional wall-clock budget for rlm sub-agents. When the budget expires, the RLM returns a partial-progress report instead of continuing normal code execution. |`.trim();
}

function whenNotToUse(context: PromptContext): string {
	const lines = [
		hasTool(context, "Read")
			? "  - To read a specific file path, use the read tool."
			: "",
		hasTool(context, "Grep") && hasTool(context, "Glob")
			? '  - To find a specific definition like "class Foo", use the grep/glob tools.'
			: "",
		"  - For ordinary coding, 1-10 known files, tightly coupled work, or shared core files, batch direct file tools instead of spawning a subagent merely to perform writes.",
	].filter(Boolean);
	return `  When NOT to use the Agent tool:\n${lines.join("\n")}`;
}
