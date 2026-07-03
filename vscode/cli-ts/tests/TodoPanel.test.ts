import { describe, expect, it } from "bun:test";
import {
	compactTodoSummary,
	shouldShowTodoPanel,
	todoPanelDisplayForTerminalHeight,
	visibleTodoItems,
} from "../src/ui/components/TodoPanel.tsx";

describe("TodoPanel", () => {
	it("shows the panel while at least one todo is unfinished", () => {
		expect(
			shouldShowTodoPanel([
				{ id: "1", content: "done", status: "completed" },
				{ id: "2", content: "next", status: "pending" },
				{ id: "3", content: "active", status: "in_progress" },
			]),
		).toBe(true);
	});

	it("shows the panel when every todo is completed", () => {
		expect(
			shouldShowTodoPanel([{ id: "1", content: "done", status: "completed" }]),
		).toBe(true);
	});

	it("hides the panel when there are no todos", () => {
		expect(shouldShowTodoPanel([])).toBe(false);
	});

	it("limits visible todos and reports hidden count", () => {
		const todos = Array.from({ length: 5 }, (_, index) => ({
			id: `todo_${index}`,
			content: `item ${index}`,
			status: "pending" as const,
		}));

		const visible = visibleTodoItems(todos, 3);

		expect(visible.items.map((todo) => todo.id)).toEqual([
			"todo_0",
			"todo_1",
			"todo_2",
		]);
		expect(visible.hiddenCount).toBe(2);
	});

	it("keeps an active todo visible when truncating", () => {
		const todos = Array.from({ length: 5 }, (_, index) => ({
			id: `todo_${index}`,
			content: `item ${index}`,
			status: index === 4 ? ("in_progress" as const) : ("pending" as const),
		}));

		const visible = visibleTodoItems(todos, 3);

		expect(visible.items.map((todo) => todo.id)).toEqual([
			"todo_0",
			"todo_1",
			"todo_4",
		]);
		expect(visible.hiddenCount).toBe(2);
	});

	it("uses compact display on short terminals", () => {
		expect(todoPanelDisplayForTerminalHeight(20)).toEqual({
			compact: true,
			maxItems: 0,
		});
		expect(todoPanelDisplayForTerminalHeight(21)).toEqual({
			compact: false,
			maxItems: 3,
		});
		expect(todoPanelDisplayForTerminalHeight(29)).toEqual({
			compact: false,
			maxItems: 6,
		});
		expect(todoPanelDisplayForTerminalHeight(37)).toEqual({
			compact: false,
			maxItems: 12,
		});
	});

	it("summarizes compact todos with the active item", () => {
		expect(
			compactTodoSummary([
				{ id: "1", content: "done", status: "completed" },
				{ id: "2", content: "active", status: "in_progress" },
				{ id: "3", content: "next", status: "pending" },
			]),
		).toBe("[>] active (+2)");
	});
});
