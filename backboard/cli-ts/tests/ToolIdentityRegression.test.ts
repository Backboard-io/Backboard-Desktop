import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import {
	canonicalToolInput,
	sameToolCallIdentity,
} from "../src/core/tools/ToolCallIdentity.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok } from "../src/core/tools/ToolResult.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { BackboardStreamEventMapper } from "../src/providers/backboard/mappers.ts";
import { ToolCallDeltaAccumulator } from "../src/providers/ToolCallDeltaAccumulator.ts";
import mismatchFixture from "./fixtures/tool-identity-mismatch.json";
import { makeContext, TestTool } from "./helpers.ts";

describe("tool identity invariants", () => {
	it("never returns early A output for final B with the same id and arguments", async () => {
		const started: string[] = [];
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const tools = ["A", "B"].map(
			(name) => new TestTool({ name, onStart: (name) => started.push(name) }),
		);
		const round = new ToolScheduler(new ToolRegistry(tools), bus).createRound(
			makeContext(new AbortController().signal, bus),
		);
		round.offer({ id: "same", name: "A", input: {} });
		await Bun.sleep(0);
		const output = await round.finalize([{ id: "same", name: "B", input: {} }]);
		expect({ started, output: output[0]?.metadata?.failureCategory }).toEqual({
			started: ["A"],
			output: "protocol",
		});
		expect(output[0]?.output).toContain("Tool protocol error");
		expect(
			events.some(
				(event) => event.type === "tool:identity" && event.phase === "mismatch",
			),
		).toBe(true);
	});

	it("reuses reordered validated keys and built-in aliases", async () => {
		let runs = 0;
		class ReadFixture extends Tool<{ left: number; right: number }, string> {
			readonly name = "Read";
			readonly inputSchema = z.object({ left: z.number(), right: z.number() });
			override isReadOnly() {
				return true;
			}
			override isConcurrencySafe() {
				return true;
			}
			override async execute() {
				runs++;
				return ok("read", "read", "read");
			}
		}
		const bus = new EventBus();
		const round = new ToolScheduler(
			new ToolRegistry([new ReadFixture()]),
			bus,
		).createRound(makeContext(new AbortController().signal, bus));
		round.offer({ id: "alias", name: "Read", input: { left: 1, right: 2 } });
		await Bun.sleep(0);
		await round.finalize([
			{ id: "alias", name: "read", input: { right: 2, left: 1 } },
		]);
		expect(runs).toBe(1);
	});

	it("scopes early results to session, turn, round, and retry attempt", () => {
		const identity = {
			sessionId: "session",
			turnId: "turn",
			roundId: "round",
			attempt: 0,
			name: "read",
			input: "{}",
		};
		for (const changed of [
			{ sessionId: "other" },
			{ turnId: "other" },
			{ roundId: "other" },
			{ attempt: 1 },
		]) {
			expect(sameToolCallIdentity(identity, { ...identity, ...changed })).toBe(
				false,
			);
		}
		expect(canonicalToolInput([1, 2])).not.toBe(canonicalToolInput([2, 1]));
		expect(canonicalToolInput("false")).not.toBe(canonicalToolInput(false));
	});

	it("does not execute a mutating call twice on duplicate finalize", async () => {
		let runs = 0;
		const bus = new EventBus();
		const round = new ToolScheduler(
			new ToolRegistry([
				new TestTool({ name: "Write", readOnly: false, onStart: () => runs++ }),
			]),
			bus,
		).createRound(makeContext(new AbortController().signal, bus));
		const calls = [{ id: "write", name: "Write", input: {} }];
		const [first, duplicate] = await Promise.all([
			round.finalize(calls),
			round.finalize(calls),
		]);
		expect({ runs, duplicate }).toEqual({ runs: 1, duplicate: first });
		await expect(
			round.finalize([
				{ id: "write", name: "Write", input: { value: "different" } },
			]),
		).rejects.toThrow("protocol error");
	});

	it("rejects duplicate final IDs before any mutation executes", async () => {
		let runs = 0;
		const bus = new EventBus();
		const round = new ToolScheduler(
			new ToolRegistry([
				new TestTool({ name: "Write", readOnly: false, onStart: () => runs++ }),
			]),
			bus,
		).createRound(makeContext(new AbortController().signal, bus));
		const call = { id: "duplicate", name: "Write", input: {} };
		await expect(round.finalize([call, call])).rejects.toThrow(
			"duplicate call ID",
		);
		expect(runs).toBe(0);
	});

	it("does not submit an early read after cancellation or emit late results after reset", async () => {
		const controller = new AbortController();
		const bus = new EventBus();
		const results: string[] = [];
		bus.on("tool:result", (event) => results.push(event.toolCallId));
		const round = new ToolScheduler(
			new ToolRegistry([new TestTool({ name: "Read", delayMs: 15 })]),
			bus,
		).createRound(makeContext(controller.signal, bus));
		const call = { id: "cancelled", name: "Read", input: {} };
		round.offer(call);
		controller.abort();
		await expect(round.finalize([call])).rejects.toThrow();
		round.reset();
		await Bun.sleep(25);
		expect(results).toEqual([]);
	});

	it("invalid final schemas produce argument errors without reusing the read", async () => {
		const bus = new EventBus();
		const round = new ToolScheduler(
			new ToolRegistry([new TestTool({ name: "Read" })]),
			bus,
		).createRound(makeContext(new AbortController().signal, bus));
		round.offer({ id: "invalid", name: "Read", input: { value: "okay" } });
		const output = await round.finalize([
			{ id: "invalid", name: "Read", input: { value: [] } },
		]);
		expect(output[0]?.metadata?.failureCategory).toBe("invalid_argument");
	});
});

describe("provider boundary replay", () => {
	it("rejects the sanitized historical Glob/Grep name disagreement", () => {
		const traces: unknown[] = [];
		const mapper = new BackboardStreamEventMapper(["glob", "grep"], (trace) =>
			traces.push(trace),
		);
		const events = mismatchFixture.flatMap((frame) => mapper.map(frame));
		expect(events.at(-1)).toMatchObject({ kind: "failed", retryable: false });
		expect(events.some((event) => event.kind === "requires_action")).toBe(
			false,
		);
		expect(JSON.stringify(traces)).not.toContain("src/");
	});

	it("collapses repeated final calls and executes a duplicated mutation exactly once", async () => {
		let runs = 0;
		const mapper = new BackboardStreamEventMapper();
		const call = {
			id: "same",
			type: "function",
			function: { name: "write", arguments: '{"value":"fixture"}' },
		};
		const batch = {
			type: "tool_submit_required",
			tool_calls: [call, structuredClone(call)],
		};
		const event = mapper
			.map(batch)
			.find((event) => event.kind === "requires_action");
		if (!event || event.kind !== "requires_action")
			throw new Error("Missing final batch");
		expect(event.calls).toHaveLength(1);
		const bus = new EventBus();
		const round = new ToolScheduler(
			new ToolRegistry([
				new TestTool({ name: "Write", readOnly: false, onStart: () => runs++ }),
			]),
			bus,
		).createRound(makeContext(new AbortController().signal, bus));
		const first = await round.finalize(event.calls);
		const repeated = mapper
			.map(batch)
			.find((event) => event.kind === "requires_action");
		if (!repeated || repeated.kind !== "requires_action")
			throw new Error("Missing replay batch");
		expect(await round.finalize(repeated.calls)).toEqual(first);
		expect(runs).toBe(1);
	});

	it("preserves distinct IDs/order and accepts only structurally identical duplicate arguments", () => {
		const call = (id: string, name: string, input: object) => ({
			id,
			type: "function",
			function: { name, arguments: JSON.stringify(input) },
		});
		const mapper = new BackboardStreamEventMapper();
		expect(
			mapper.map({
				type: "tool_submit_required",
				tool_calls: [
					call("a", "Glob", { path: ".", patterns: ["*.ts"] }),
					call("b", "glob", { patterns: ["*.ts"], path: "." }),
					call("a", "glob", { patterns: ["*.ts"], path: "." }),
				],
			}),
		).toMatchObject([
			{ kind: "requires_action", calls: [{ id: "a" }, { id: "b" }] },
		]);
		for (const conflict of [
			call("a", "grep", { path: "." }),
			call("a", "glob", { path: "different" }),
		]) {
			expect(
				new BackboardStreamEventMapper().map({
					type: "tool_submit_required",
					tool_calls: [call("a", "glob", { path: "." }), conflict],
				}),
			).toMatchObject([{ kind: "failed", retryable: false }]);
		}
	});

	it("does not silently drop malformed calls from a final batch", () => {
		const mapper = new BackboardStreamEventMapper();
		expect(
			mapper.map({
				type: "tool_submit_required",
				tool_calls: [
					{
						id: "good",
						type: "function",
						function: { name: "read", arguments: "{}" },
					},
					{ id: "bad" },
				],
			}),
		).toEqual([expect.objectContaining({ kind: "failed", retryable: false })]);
	});

	it("assembles interleaved indices in provider order with provisional UI IDs", () => {
		const accumulator = new ToolCallDeltaAccumulator(["read", "write"]);
		accumulator.add([
			{ index: 1, function: { name: "wr", arguments: '{"value":' } },
		]);
		accumulator.add([
			{
				index: 0,
				id: "real-read",
				function: { name: "read", arguments: "{}" },
			},
		]);
		const started = accumulator.add([
			{ index: 1, function: { name: "ite", arguments: '"v"}' } },
		]);
		expect(started[0]).toMatchObject({ kind: "tool_started", name: "write" });
		accumulator.add([{ index: 1, id: "real-write" }]);
		expect(accumulator.finish()).toEqual({
			calls: [
				{ id: "real-read", name: "read", input: {} },
				{ id: "real-write", name: "write", input: { value: "v" } },
			],
		});
	});

	it("rejects replaced IDs, duplicate IDs, missing final IDs, and invalid final JSON", () => {
		for (const deltas of [
			[
				{ index: 0, id: "a", function: { name: "read", arguments: "{}" } },
				{ index: 0, id: "b" },
			],
			[
				{ index: 0, id: "a", function: { name: "read", arguments: "{}" } },
				{ index: 1, id: "a" },
			],
			[{ index: 0, function: { name: "read", arguments: "{}" } }],
			[{ index: 0, id: "a", function: { name: "read", arguments: "{" } }],
		]) {
			const accumulator = new ToolCallDeltaAccumulator(["read"]);
			for (const delta of deltas) accumulator.add([delta]);
			expect(accumulator.finish()).toHaveProperty("error");
		}
	});
});
