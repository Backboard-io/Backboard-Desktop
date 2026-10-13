import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { ComputerRuntime } from "../src/core/computer/ComputerRuntime.ts";
import { resolveAppName } from "../src/core/computer/CuaDriverSurface.ts";
import { JevBrain, type JevDecider } from "../src/core/computer/JevBrain.ts";
import type {
	AccessibilitySnapshot,
	ImagePayload,
	Platform,
	PlatformAction,
	ScreenshotCapture,
} from "../src/core/platform/index.ts";
import type { ModelRoute } from "../src/providers/backboard/types.ts";
import { makeContext } from "./helpers.ts";

/** One app window with a single button; pressing it swaps the button. */
class OneButtonApp implements Platform {
	private label = "Next";
	async screenshot(): Promise<ScreenshotCapture> {
		throw new Error("a Jev task must never take a screenshot");
	}
	async fitPngForPayload(): Promise<ImagePayload> {
		throw new Error("unused");
	}
	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		return {
			appName: "Notes",
			windowTitle: "Notes",
			elements: [
				{
					id: "el_1",
					role: "AXButton",
					name: this.label,
					bounds: { x: 0, y: 0, width: 10, height: 10 },
				},
			],
		};
	}
	async execute(action: PlatformAction): Promise<void> {
		if (action.kind === "click") this.label = "Finish";
	}
}

/** Clicks the first target once, then declares the goal met. */
const clickThenDone: JevDecider = (() => {
	let turn = 0;
	return async () => {
		const choice = (value: string) => ({
			type: "choice" as const,
			choice: value,
			confidence: 0.9,
			probabilities: { [value]: 0.9 },
		});
		const first = turn++ === 0;
		return {
			thread_id: "t",
			model: "jev-test",
			answers: {
				complete: { type: "noul" as const, noul: 0 },
				operation: choice(first ? "CLICK" : "DONE"),
				click_target: choice("c1"),
			},
		};
	};
})();

describe("Jev computer-use sub-agent", () => {
	it("runs a task as a named sub-agent with each action nested under the tool call", async () => {
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const routes: Array<Readonly<ModelRoute> | undefined> = [];
		const runtime = new ComputerRuntime({
			platform: new OneButtonApp(),
			resolveCuaDriver: () => undefined,
			brain: () => new JevBrain(clickThenDone),
			jevWriter: async (_packet, options) => {
				routes.push(options.modelRoute);
				return null;
			},
		});
		const route: ModelRoute = {
			provider: "openrouter",
			model: "m",
			source: "backboard",
		};
		const result = await runtime.execute(
			[{ action: "task", appName: "Notes", goal: "Finish setup" }],
			{
				...makeContext(new AbortController().signal, bus),
				toolCallId: "call_1",
				modelRoute: route,
			},
		);

		const compact = events
			.filter((event) => event.type.startsWith("agent:child"))
			.map((event) => {
				switch (event.type) {
					case "agent:child_start":
						return `start ${event.agentName} <- ${event.agentToolCallId}: ${event.prompt}`;
					case "agent:child_tool_start":
						return `  run   ${event.call.id} ${event.call.name} | ${event.call.inputSummary}`;
					case "agent:child_tool_result":
						return `  ${event.status}  ${event.childToolCallId}`;
					case "agent:child_event":
						return event.event.type === "assistant:message"
							? `  says  ${event.event.text}`
							: event.event.type;
					case "agent:child_end":
						return `end ${event.status}`;
					default:
						return event.type;
				}
			});
		expect({ success: result.success, compact }).toEqual({
			success: true,
			compact: [
				"start Jev · Notes <- call_1: Finish setup",
				'  run   call_1:jev:1 Computer | CLICK AXButton "Next"',
				"  done  call_1:jev:1",
				"  run   call_1:jev:2 Computer | DONE",
				"  done  call_1:jev:2",
				"  says  The agent reported the goal complete after 2 step(s).",
				"end completed",
			],
		});
	});

	it("reports an orderly handoff in words, not as a failed turn", async () => {
		// Regression: a stalled run surfaced in the IDE as an unexplained
		// "BackboardSubagentFailed: The Backboard subagent reported a failed turn."
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const blocked: JevDecider = async () => ({
			thread_id: "t",
			model: "jev-test",
			answers: {
				complete: { type: "noul", noul: 0 },
				operation: {
					type: "choice",
					choice: "BLOCKED",
					confidence: 0.9,
					probabilities: { BLOCKED: 0.9 },
				},
			},
		});
		await new ComputerRuntime({
			platform: new OneButtonApp(),
			resolveCuaDriver: () => undefined,
			brain: () => new JevBrain(blocked),
			jevWriter: async () => null,
		}).execute([{ action: "task", appName: "Notes", goal: "Draw a cat" }], {
			...makeContext(new AbortController().signal, bus),
			toolCallId: "call_3",
		});
		const said = events.flatMap((event) =>
			event.type === "agent:child_event" &&
			event.event.type === "assistant:message"
				? [event.event.text]
				: [],
		);
		const ended = events.flatMap((event) =>
			event.type === "agent:child_end" ? [event.status] : [],
		);
		expect({ said, ended }).toEqual({
			said: [
				"The agent found no confident next move. Take a screenshot and continue with direct actions.",
			],
			ended: ["completed"],
		});
	});

	it("resolves the app a person names to the one macOS knows", () => {
		const apps = [
			{ name: "Brave Browser", bundle_id: "com.brave.Browser", running: true },
			{ name: "Google Chrome", bundle_id: "com.google.Chrome" },
			{ name: "Google Chrome Canary", bundle_id: "com.google.Chrome.canary" },
			{ name: "Notes", bundle_id: "com.apple.Notes" },
		];
		expect(
			[
				"Brave",
				"brave browser",
				"Notes.app",
				"Chrome",
				"Google Chrome",
				"Word",
			].map((name) => resolveAppName(name, apps)?.bundle_id),
		).toEqual([
			"com.brave.Browser",
			"com.brave.Browser",
			"com.apple.Notes",
			// Two installed Chromes and neither running: refuse rather than guess.
			undefined,
			"com.google.Chrome",
			undefined,
		]);
	});

	it("bills the writer on the turn's own route", async () => {
		// Regression: in the IDE every task died at its first TYPE_TEXT with
		// "Refusing to send a request without a billing route in host-managed mode."
		let seen: Readonly<ModelRoute> | undefined;
		const typeOnce: JevDecider = async () => ({
			thread_id: "t",
			model: "jev-test",
			answers: {
				complete: { type: "noul", noul: 0 },
				operation: {
					type: "choice",
					choice: "TYPE_TEXT",
					confidence: 0.9,
					probabilities: { TYPE_TEXT: 0.9 },
				},
				type_target: {
					type: "choice",
					choice: "t1",
					confidence: 0.9,
					probabilities: { t1: 0.9 },
				},
			},
		});
		const platform = new OneButtonApp();
		platform.accessibilitySnapshot = async () => ({
			appName: "Notes",
			windowTitle: "Notes",
			elements: [
				{
					id: "el_1",
					role: "AXTextField",
					name: "Title",
					bounds: { x: 0, y: 0, width: 10, height: 10 },
				},
			],
		});
		const route: ModelRoute = {
			provider: "openrouter",
			model: "m",
			source: "backboard",
		};
		await new ComputerRuntime({
			platform,
			resolveCuaDriver: () => undefined,
			brain: () => new JevBrain(typeOnce),
			jevWriter: async (_packet, options) => {
				seen = options.modelRoute;
				return null;
			},
		}).execute([{ action: "task", appName: "Notes", goal: "Name the note" }], {
			...makeContext(new AbortController().signal),
			toolCallId: "call_2",
			modelRoute: route,
		});
		expect(seen).toEqual(route);
	});
});
