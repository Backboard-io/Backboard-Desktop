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
	return `Use this tool to draft and maintain a structured todo list for the current coding session. It helps organize multi-step work, make progress visible, and keep the user informed.

## Limits

- Maximum 50 todo items
- Maximum 500 characters per todo item

## Input Format

Pass \`todos\` as an array of objects. Each object must contain:
- \`content\`: a specific task description string.
- \`status\`: one of \`pending\`, \`in_progress\`, or \`completed\`.

Example:

\`\`\`json
{
  "todos": [
    { "content": "Inspect project structure", "status": "completed" },
    { "content": "Implement the required behavior", "status": "in_progress" },
    { "content": "Run validators", "status": "pending" }
  ]
}
\`\`\`

Do not pass numbered strings, objects with numeric keys, or markdown checklist text.

${parallelTip(context)}

## When to Use This Tool

Use this tool proactively when:
1. Complex multi-step work requires 3 or more distinct actions.
2. Non-trivial work requires deliberate planning or multiple operations.
3. The user asks for a todo list.
4. The user gives multiple tasks.
5. New instructions arrive.
6. You begin a task, set it to in_progress before starting.
7. You finish a task, mark it completed only after verification.
8. You are handing back control to the user.

## When NOT to Use This Tool

Skip it when:
1. There is a single, straightforward task.
2. The work is trivial and tracking adds no value.
3. It can be done in fewer than 3 trivial steps.
4. The request is purely conversational or informational.
5. Do not create todos based on system context, environment outputs, or your interpretation of what might need doing.

## Task States and Management

1. Task states:
- pending: not started
- in_progress: currently working, limit to one item
- completed: finished

2. Task management:
- Keep exactly one in_progress item when actively working and pending items remain.
- Mark items completed immediately after finishing, not before.
- Remove items that become irrelevant.
- Preserve exact user instructions and exact commands when users provide them.

3. Completion rules:
- Mark completed only when fully done and verified.
- If errors or blockers remain, keep the item in_progress and add a blocker or resolution item.
- Never mark completed if tests fail, implementation is partial, errors are unresolved, or required files/dependencies are missing.

4. Task breakdown:
- Use specific, actionable items.
- Split complex work into smaller steps.
- Include required validation as its own item.

If your todo list has any pending items, you must have exactly one in_progress item. When all work is complete and only a waiting-for-user item remains, mark it in_progress or remove the todo list.`.trim();
}

function parallelTip(context: PromptContext): string {
	const tools = [
		hasTool(context, "Read") ? "Read" : "",
		hasTool(context, "Grep") ? "Grep" : "",
		hasTool(context, "Glob") ? "Glob" : "",
		hasTool(context, "Execute") ? "Execute" : "",
	].filter(Boolean);
	if (tools.length === 0) return "";
	return `## Performance Tip\n\nWhen starting work, update todos in parallel with available independent tools such as ${tools.join(", ")} when it is safe to do so. Do not parallelize writes to the same file or dependent operations.`;
}
