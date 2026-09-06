import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const todoWrite: PromptModule = definePrompt(
	buildTodoWritePrompt(),
	buildTodoWritePrompt,
);

function buildTodoWritePrompt(context: PromptContext = {}): string {
	return `Maintain a visible plan when the user requests one or substantial work has dependencies worth tracking. Skip plans for short reads, searches, narrow edits, and single validation commands; tool-call count alone is not a reason to plan.

Pass \`todos\` as an array of objects containing content and status. Do not pass numbered strings or Markdown checklists. The schema defines limits and allowed statuses.

- Track the user's actual scope and acceptance criteria; preserve requested commands and their order.
- Keep one item in_progress while active work remains. Mark completed only after the work and relevant verification finish.
- Update necessary plans alongside substantive work. Batch status updates when several items have completed; avoid a separate model round just for bookkeeping.
- Preserve incomplete items and state blockers accurately. Never mark them complete because a response ended, tests failed, or progress stopped. Do not remove user-requested work to make the list appear finished.
${["Read", "Grep", "Glob", "Execute"].some((tool) => hasTool(context, tool)) ? "- Plan updates may run alongside independent tools when their status does not depend on those tools succeeding.\n" : ""}
Example: {"todos":[{"content":"Implement the requested change","status":"in_progress"},{"content":"Run the relevant regression test","status":"pending"}]}`;
}
