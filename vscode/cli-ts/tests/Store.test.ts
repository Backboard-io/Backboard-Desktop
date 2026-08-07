import { describe, expect, it } from "bun:test";
import { initialState } from "../src/state/AppState.ts";
import { reduce } from "../src/state/Store.ts";

describe("Store reducer", () => {
	it("attaches turn duration to assistant messages when the turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "done",
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 81_000,
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("assistant");
		if (item?.kind !== "assistant") throw new Error("expected assistant item");
		expect(item.durationMs).toBe(81_000);
	});

	it("keeps streamed assistant segments in chronological order around tools", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first",
		});
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:1",
			text: "second",
		});

		expect(state.transcript.map((item) => item.kind)).toEqual([
			"assistant",
			"tool",
			"assistant",
		]);
	});

	it("stores tool result detail for transcript rendering", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Edit",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Edit",
			title: "Applied 1 replacement",
			detail: "--- a.ts\n+++ a.ts\n@@\n- old\n+ new",
		});

		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "done",
			title: "Applied 1 replacement",
			detail: "--- a.ts\n+++ a.ts\n@@\n- old\n+ new",
		});
	});

	it("stores typed tool result detail lines for transcript rendering", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Edit",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Edit",
			title: "Applied 1 replacement",
			detailLines: [
				{ key: "old", displayValue: "- old", highlighted: true },
				{ key: "new", displayValue: "+ new", highlighted: true },
			],
		});

		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "done",
			title: "Applied 1 replacement",
			detailLines: [
				{ key: "old", displayValue: "- old", highlighted: true },
				{ key: "new", displayValue: "+ new", highlighted: true },
			],
		});
	});

	it("does not render TodoWrite as a transcript tool row", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "todo_call",
			name: "TodoWrite",
			inputSummary: "",
		});
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "in_progress" }],
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "todo_call",
			name: "TodoWrite",
			title: "Updated 1 todos · 0 completed",
		});

		expect(state.transcript).toEqual([]);
		expect(state.render.liveItems).toEqual([]);
		expect(state.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "in_progress" },
		]);
	});

	it("surfaces TodoWrite errors even though successful updates are hidden", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "todo_call",
			name: "TodoWrite",
			inputSummary: "",
		});
		state = reduce(state, {
			type: "tool:error",
			toolCallId: "todo_call",
			name: "TodoWrite",
			error: "TodoWrite accepts at most one in_progress todo.",
		});

		expect(state.transcript).toEqual([
			{
				kind: "notice",
				id: expect.stringMatching(/^n_/),
				level: "error",
				text: "TodoWrite failed: TodoWrite accepts at most one in_progress todo.",
			},
		]);
		expect(state.render.staticItems).toEqual(state.transcript);
		expect(state.render.liveItems).toEqual([]);
	});

	it("keeps completed todos visible after a turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 1_000,
		});

		expect(state.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "completed" },
		]);
	});

	it("clears completed todos when the next turn starts", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		state = reduce(state, {
			type: "turn:start",
			turnId: "turn_2",
		});

		expect(state.todos).toEqual([]);
	});

	it("commits complete lines and hides the in-progress tail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first line\nsecond",
		});

		expect(state.render.staticItems).toMatchObject([
			{
				kind: "assistant_chunk",
				text: "first line\n",
				showHeader: true,
			},
		]);
		// Per-line streaming: the partial "second" is held in the stream, not rendered live.
		expect(
			state.render.liveItems.some((item) => item.kind === "assistant_chunk"),
		).toBe(false);
		expect(state.render.assistantStreams[0]?.pendingText).toBe("second");
	});

	it("commits long no-newline streaming progressively and bounds the pending tail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: `${"word ".repeat(220)}tail`,
		});

		expect(state.render.staticItems[0]?.kind).toBe("assistant_chunk");
		expect(
			state.render.liveItems.some((item) => item.kind === "assistant_chunk"),
		).toBe(false);
		expect(
			state.render.assistantStreams[0]?.pendingText.length ?? 0,
		).toBeLessThanOrEqual(500);
	});

	it("holds an in-progress table in the pending tail instead of splitting it across chunks", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "Here is a table:\n\n| Name | Score |\n| --- | --- |\n| Alice | 92 |\n",
		});

		// The intro line flushes normally; the open table (no blank line has
		// closed it yet) stays buffered rather than being committed row by row.
		expect(state.render.staticItems).toMatchObject([
			{ kind: "assistant_chunk", text: "Here is a table:\n\n" },
		]);
		expect(state.render.assistantStreams[0]?.pendingText).toBe(
			"| Name | Score |\n| --- | --- |\n| Alice | 92 |\n",
		);

		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "| Bob | 88 |\n\ndone",
		});

		// Once a blank line closes the table, the whole thing flushes as one chunk.
		expect(state.render.staticItems).toMatchObject([
			{ kind: "assistant_chunk", text: "Here is a table:\n\n" },
			{
				kind: "assistant_chunk",
				text: "| Name | Score |\n| --- | --- |\n| Alice | 92 |\n| Bob | 88 |\n\n",
			},
		]);
		expect(state.render.assistantStreams[0]?.pendingText).toBe("done");
	});

	it("finalizes assistant stream into static transcript and appends footer", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first\nsec",
		});
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first\nsecond",
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 61_000,
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems.map((item) => item.kind)).toEqual([
			"assistant_chunk",
			"assistant_chunk",
			"assistant_footer",
		]);
		expect(state.render.staticItems[1]).toMatchObject({
			kind: "assistant_chunk",
			text: "second",
			showHeader: false,
		});
	});

	it("keeps running tool live until final result is committed", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});

		expect(state.render.staticItems).toEqual([]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
		]);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
		]);
	});

	it("shows a pending round immediately and upserts rows in place", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_2",
			name: "Write",
			inputSummary: "b.ts",
		});

		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "pending" },
			{ kind: "tool", id: "call_2", status: "pending" },
		]);

		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});

		// Upserted, not duplicated - and order preserved.
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
			{ kind: "tool", id: "call_2", status: "pending" },
		]);
		expect(
			state.transcript.filter(
				(item) => item.kind === "tool" && item.id === "call_1",
			),
		).toHaveLength(1);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		// The finished head call drains to static; the pending sibling stays
		// live (a pending row must never be committed to <Static>).
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
		]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_2", status: "pending" },
		]);
	});

	it("updates an early tool announcement in place and removes it if discarded", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_early",
			name: "Write",
			inputSummary: "Generating input…",
		});
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_early",
			name: "Write",
			inputSummary: "index.html",
		});

		expect(
			state.transcript.filter(
				(item) => item.kind === "tool" && item.id === "call_early",
			),
		).toHaveLength(1);
		expect(state.render.liveItems).toMatchObject([
			{
				kind: "tool",
				id: "call_early",
				status: "pending",
				inputSummary: "index.html",
			},
		]);

		state = reduce(state, {
			type: "tool:discarded",
			toolCallId: "call_early",
			name: "Write",
		});
		expect(state.transcript).toEqual([]);
		expect(state.render.liveItems).toEqual([]);
	});

	it("commits parallel tools in start order", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Grep",
			inputSummary: "needle",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Grep",
			title: "Found 2 matches",
		});

		expect(state.render.staticItems).toEqual([]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
			{ kind: "tool", id: "call_2", status: "done" },
		]);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
			{ kind: "tool", id: "call_2", status: "done" },
		]);
	});

	it("preserves Agent reports as transcript detail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Agent",
			inputSummary: "inspect",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Agent",
			title: "Agent rlm (2 rounds)",
			agentOutput: {
				mode: "rlm",
				status: "completed",
				rounds: 2,
				tracePath: ".backboard/sessions/s/agents/call_1",
				report: "Found the relevant files and summarized them.",
			},
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected tool item");
		expect(item.title).toBe("Agent rlm (2 rounds)");
		expect(item.detail).toContain("mode: rlm");
		expect(item.detail).toContain("trace: .backboard/sessions/s/agents/call_1");
		expect(item.detail).toContain("Found the relevant files");
	});

	it("tracks live child tool calls under running Agent rows", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "agent_1",
			name: "Agent",
			inputSummary: "inspect",
			agentMode: "worker",
		});
		state = reduce(state, {
			type: "agent:child_tool_start",
			agentToolCallId: "agent_1",
			call: {
				id: "child_1",
				name: "Read",
				inputSummary: "src/a.ts",
				status: "running",
			},
		});
		state = reduce(state, {
			type: "agent:child_tool_result",
			agentToolCallId: "agent_1",
			childToolCallId: "child_1",
			status: "done",
		});

		const item = state.render.liveItems.find(
			(candidate) => candidate.kind === "tool" && candidate.id === "agent_1",
		);
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected Agent tool item");
		expect(item.agentMode).toBe("worker");
		expect(item.childToolCalls).toEqual([
			{
				id: "child_1",
				name: "Read",
				inputSummary: "src/a.ts",
				status: "done",
			},
		]);
	});

	it("keeps non-Agent tool results compact", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected tool item");
		expect(item.detail).toBeUndefined();
	});

	it("groups parallel same-name tools drained in one batch into a tool_group", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		// call_2 finishes first, so nothing drains until call_1 completes and
		// both are drained (and grouped) in the same batch.
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.staticItems).toHaveLength(1);
		const group = state.render.staticItems[0];
		expect(group?.kind).toBe("tool_group");
		if (group?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(group.items.map((item) => item.inputSummary)).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("holds a completed tool live while a parallel same-name call runs, then groups both", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		// call_1 finishes while call_2 is still running: it must stay live so
		// the pair can drain together and collapse into one grouped entry.
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		expect(state.render.liveItems).toHaveLength(2);
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});

		expect(state.render.liveItems).toHaveLength(0);
		expect(state.render.staticItems).toHaveLength(1);
		const group = state.render.staticItems[0];
		if (group?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(group.items.map((item) => item.inputSummary)).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("force-drains held tools when the turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 1_000,
		});

		// call_1 drains even though call_2 never completed.
		expect(
			state.render.staticItems.some(
				(item) => item.kind === "tool" && item.id === "call_1",
			),
		).toBe(true);
	});

	it("never rewrites already-drained static items when a later same-name tool completes", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		const drainedFirst = state.render.staticItems;
		expect(drainedFirst).toHaveLength(1);

		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});

		// Append-only: the first entry must be untouched and the second must be
		// a new entry (Ink's <Static> never re-renders printed items).
		expect(state.render.staticItems).toHaveLength(2);
		expect(state.render.staticItems[0]).toBe(drainedFirst[0]);
		expect(state.render.staticItems[1]).toMatchObject({
			kind: "tool",
			id: "call_2",
		});
	});
});
