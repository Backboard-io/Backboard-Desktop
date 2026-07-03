import { shortId } from "../../utils/id.ts";
import type { TodoItem } from "../bus/events.ts";
import type { TodoDraft } from "./types.ts";

export function reconcileTodos(
	drafts: readonly TodoDraft[],
	previousTodos: readonly TodoItem[],
): TodoItem[] {
	const previousByContent = new Map<string, TodoItem[]>();
	for (const todo of previousTodos) {
		const existing = previousByContent.get(todo.content);
		if (existing) {
			existing.push(todo);
		} else {
			previousByContent.set(todo.content, [todo]);
		}
	}

	return drafts.map((draft) => {
		const previous = previousByContent.get(draft.content)?.shift();
		return {
			id: previous?.id ?? shortId("todo"),
			content: draft.content,
			status: draft.status,
		};
	});
}

export function areTodosComplete(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}
