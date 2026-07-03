import { describe, expect, it } from "bun:test";
import type { TodoItem } from "../src/core/bus/events.ts";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { makeContext } from "./helpers.ts";

describe("TodoWriteTool", () => {
	it("trims content and preserves ids for unchanged todos", async () => {
		const previousTodos: TodoItem[] = [
			{ id: "todo_existing", content: "Plan work", status: "pending" },
		];
		const tool = new TodoWriteTool();
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.getTodos = () => previousTodos;
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [
				{ content: " Plan work ", status: "in_progress" },
				{ content: "Write tests", status: "pending" },
			],
		});
		const result = await tool.execute(input, ctx);

		expect(result.data.count).toBe(2);
		expect(emittedTodos[0]).toEqual({
			id: "todo_existing",
			content: "Plan work",
			status: "in_progress",
		});
		expect(emittedTodos[1]).toMatchObject({
			content: "Write tests",
			status: "pending",
		});
		expect(emittedTodos[1]?.id).toMatch(/^todo_/);
	});

	it("rejects blank todo content", () => {
		const tool = new TodoWriteTool();

		expect(() =>
			tool.parseInput({
				todos: [{ content: "   ", status: "pending" }],
			}),
		).toThrow();
	});

	it("rejects multiple in-progress todos", () => {
		const tool = new TodoWriteTool();

		expect(() =>
			tool.parseInput({
				todos: [
					{ content: "One", status: "in_progress" },
					{ content: "Two", status: "in_progress" },
				],
			}),
		).toThrow("TodoWrite accepts at most one in_progress todo.");
	});

	it("rejects pending todos without an in-progress todo", () => {
		const tool = new TodoWriteTool();

		expect(() =>
			tool.parseInput({
				todos: [{ content: "One", status: "pending" }],
			}),
		).toThrow(
			"TodoWrite requires one in_progress todo when pending todos remain.",
		);
	});
});
