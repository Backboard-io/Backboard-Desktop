import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent, ToolCallRef } from "../src/core/bus/events.ts";
import { ToolPermissionGate } from "../src/core/tools/ToolPermissionGate.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { makeContext, TestTool } from "./helpers.ts";

function callRef(name: string): ToolCallRef {
	return { id: `call_${name}`, name, input: {} };
}

describe("ToolPermissionGate", () => {
	it("auto-approves under autoApprove and autopilot without emitting", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));

		for (const policy of ["autoApprove", "autopilot"] as const) {
			const gate = new ToolPermissionGate(bus, policy);
			const decision = await gate.request(
				{ toolCallId: "c1", name: "Write", inputSummary: "x" },
				new AbortController().signal,
			);
			expect(decision).toEqual({ decision: "approve" });
		}
		expect(events).toEqual([]);
	});

	it("emits permission:request under default and resolves on respond", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const gate = new ToolPermissionGate(bus);

		const pending = gate.request(
			{ toolCallId: "c1", name: "Write", inputSummary: "file.txt" },
			new AbortController().signal,
		);
		const request = events.find((e) => e.type === "permission:request");
		expect(request?.type).toBe("permission:request");
		if (request?.type !== "permission:request") throw new Error("unreachable");
		expect(request.request.toolCallId).toBe("c1");
		expect(request.request.name).toBe("Write");

		expect(
			gate.respond(request.request.id, { decision: "deny", reason: "no" }),
		).toBe(true);
		expect(await pending).toEqual({ decision: "deny", reason: "no" });
		expect(
			events.some(
				(e) =>
					e.type === "permission:response" && e.response.decision === "deny",
			),
		).toBe(true);
	});

	it("rejects pending requests on abort", async () => {
		const gate = new ToolPermissionGate(new EventBus());
		const ac = new AbortController();
		const pending = gate.request(
			{ toolCallId: "c1", name: "Write", inputSummary: "x" },
			ac.signal,
		);
		ac.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	it("ignores responses for unknown ids", () => {
		const gate = new ToolPermissionGate(new EventBus());
		expect(gate.respond("perm_missing", { decision: "approve" })).toBe(false);
	});
});

describe("scheduler permission gating", () => {
	it("does not gate read-only tools", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const gate = new ToolPermissionGate(bus);
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const ac = new AbortController();
		const ctx = {
			...makeContext(ac.signal, bus),
			requestPermission: (request: {
				toolCallId: string;
				name: string;
				inputSummary: string;
			}) => gate.request(request, ac.signal),
		};

		const outputs = await scheduler.run([callRef("R")], ctx);

		expect(outputs[0]?.metadata?.error).toBe(false);
		expect(events.some((e) => e.type === "permission:request")).toBe(false);
	});

	it("runs a write tool after approval", async () => {
		const bus = new EventBus();
		const gate = new ToolPermissionGate(bus);
		bus.on("permission:request", (event) => {
			gate.respond(event.request.id, { decision: "approve" });
		});
		const registry = new ToolRegistry([
			new TestTool({ name: "W", readOnly: false }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const ac = new AbortController();
		const ctx = {
			...makeContext(ac.signal, bus),
			requestPermission: (request: {
				toolCallId: string;
				name: string;
				inputSummary: string;
			}) => gate.request(request, ac.signal),
		};

		const outputs = await scheduler.run([callRef("W")], ctx);

		expect(outputs.length).toBe(1);
		expect(outputs[0]?.metadata?.error).toBe(false);
	});

	it("returns an error output to the model when denied", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const gate = new ToolPermissionGate(bus);
		bus.on("permission:request", (event) => {
			gate.respond(event.request.id, { decision: "deny" });
		});
		let executed = false;
		const registry = new ToolRegistry([
			new TestTool({
				name: "W",
				readOnly: false,
				onStart: () => {
					executed = true;
				},
			}),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const ac = new AbortController();
		const ctx = {
			...makeContext(ac.signal, bus),
			requestPermission: (request: {
				toolCallId: string;
				name: string;
				inputSummary: string;
			}) => gate.request(request, ac.signal),
		};

		const outputs = await scheduler.run([callRef("W")], ctx);

		expect(executed).toBe(false);
		expect(outputs[0]?.metadata?.error).toBe(true);
		expect(outputs[0]?.output).toContain("denied by user");
		expect(events.some((e) => e.type === "tool:error")).toBe(true);
	});
});
