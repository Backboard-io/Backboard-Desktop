import type { TodoItem } from "../core/bus/events.ts";

/**
 * System-prompt segment shown until the session's first TodoWrite call, so
 * the model starts tracking non-trivial work without being asked.
 */
export const TODO_NOT_CALLED_REMINDER = `TodoWrite was not called yet. Use it if the user requests a plan or substantial work has dependencies worth tracking. Skip it for short tasks; tool-call count alone does not justify a plan. Update necessary plans alongside substantive work and preserve unfinished items accurately.`;

export const PLAN_UP_TO_DATE_REPLY = "Plan is up-to-date.";

/**
 * Post-turn reminder injected when the turn ends while todos are still
 * pending or in progress. The response is hidden from the UI, so the model is
 * told to either fix the list via TodoWrite or reply with the exact
 * up-to-date sentinel - never to produce user-facing prose.
 */
export function todoReconciliationReminder(todos: readonly TodoItem[]): string {
	const open = todos.filter((todo) => todo.status !== "completed");
	const lines = open
		.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
		.join("\n");
	return `<system-reminder>
IMPORTANT: It looks like you may have completed the user-facing turn, but the current TodoWrite plan still has pending or in-progress items.

These items are still marked as pending or in_progress:
${lines}

Only respond by calling TodoWrite to update these items accurately, or if no TodoWrite update is needed, reply exactly: ${PLAN_UP_TO_DATE_REPLY}
When updating, keep the list valid: if any items remain pending, exactly one item must be in_progress; if the remaining items are actually finished, mark them completed.
Do not reference this system reminder in any user-facing messages.
</system-reminder>`;
}
