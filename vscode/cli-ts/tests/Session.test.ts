import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Session } from "../src/core/session/Session.ts";

describe("Session", () => {
	it("tracks todos from bus events and clears completed todos on next turn", () => {
		const bus = new EventBus();
		const session = new Session("sess_test");
		const detach = session.attach(bus);

		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		expect(session.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "completed" },
		]);

		bus.emit({ type: "turn:start", turnId: "turn_2" });
		expect(session.todos).toEqual([]);

		detach();
	});

	it("keeps unfinished todos when the next turn starts", () => {
		const bus = new EventBus();
		const session = new Session("sess_test");
		const detach = session.attach(bus);

		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "pending" }],
		});
		bus.emit({ type: "turn:start", turnId: "turn_2" });

		expect(session.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "pending" },
		]);

		detach();
	});
});
