import { describe, expect, it } from "bun:test";
import {
	type CanvasDrawing,
	parseCanvasDrawing,
} from "../src/core/computer/CanvasDrawing.ts";
import {
	type JevSurface,
	JevUseLoop,
} from "../src/core/computer/JevUseLoop.ts";

describe("canvas drawing", () => {
	const plan: CanvasDrawing = {
		description: "A line",
		strokes: [
			[
				[0.2, 0.3],
				[0.8, 0.7],
			],
		],
	};
	it("rejects code, off-canvas coordinates, malformed strokes, and excessive work", () => {
		expect(parseCanvasDrawing(JSON.stringify(plan))).toEqual(plan);
		for (const value of [
			{ ...plan, javascript: "alert(1)" },
			{
				...plan,
				strokes: [
					[
						[0, 0],
						[1, 1],
					],
				],
			},
			{ ...plan, strokes: [[[0.5, 0.5]]] },
			{ ...plan, strokes: Array(49).fill(plan.strokes[0]) },
			{ ...plan, strokes: [Array(257).fill([0.5, 0.5])] },
		])
			expect(() => parseCanvasDrawing(JSON.stringify(value))).toThrow();
	});
	it("lets Jev choose the canvas and passes only validated geometry to the surface", async () => {
		const drawn: unknown[] = [];
		const canvas = { handle: "p1:1", role: "canvas", label: "Drawing canvas" };
		const surface: JevSurface = {
			kind: "test",
			observe: async () => ({ elements: [canvas] }),
			press: async () => {
				throw new Error("unexpected click");
			},
			type: async () => {},
			key: async () => {},
			scroll: async () => {},
			draw: async (target, drawing) => {
				drawn.push({ target, drawing });
			},
		};
		let turn = 0;
		const loop = new JevUseLoop(
			surface,
			async (request) => {
				expect(request.questions.draw_target).toBeDefined();
				const choice = (value: string) => ({
					type: "choice" as const,
					choice: value,
					probabilities: { [value]: 1 },
					confidence: 1,
				});
				return {
					thread_id: "test",
					model: "test",
					answers: {
						operation: choice(turn++ ? "DONE" : "DRAW"),
						draw_target: choice("d1"),
					},
				};
			},
			async (packet) => {
				expect(packet.kind).toBe("drawing");
				return JSON.stringify(plan);
			},
			0,
			0,
		);
		const result = await loop.run(
			{ goal: "draw a line" },
			new AbortController().signal,
		);
		expect(result.outcome).toBe("done");
		expect(result.verification).toBe("unknown");
		expect(drawn).toEqual([{ target: canvas, drawing: plan }]);
	});
	it("reuses prepared strokes after the page changes while the writer runs", async () => {
		let changed = false;
		let writerCalls = 0;
		let turn = 0;
		const drawn: unknown[] = [];
		const surface: JevSurface = {
			kind: "test",
			observe: async () => ({
				text: changed ? "New tooltip" : "Editor",
				elements: [
					{
						handle: changed ? "fresh-canvas" : "old-canvas",
						role: "canvas",
						label: "Drawing canvas",
					},
				],
			}),
			press: async () => {},
			type: async () => {},
			key: async () => {},
			scroll: async () => {},
			draw: async (target, drawing) => {
				drawn.push({ target, drawing });
			},
		};
		const result = await new JevUseLoop(
			surface,
			async () => {
				const choice = (value: string) => ({
					type: "choice" as const,
					choice: value,
					probabilities: { [value]: 1 },
					confidence: 1,
				});
				return {
					thread_id: "test",
					model: "test",
					answers: {
						operation: choice(turn++ < 2 ? "DRAW" : "DONE"),
						draw_target: choice("d1"),
					},
				};
			},
			async () => {
				writerCalls++;
				changed = true;
				return JSON.stringify(plan);
			},
			0,
			0,
		).run({ goal: "Draw a line" }, new AbortController().signal);
		expect(writerCalls).toBe(1);
		expect(result.outcome).toBe("done");
		expect(result.steps.map((step) => step.operation)).toEqual([
			"WAIT",
			"DRAW",
			"DONE",
		]);
		expect(drawn).toEqual([
			{
				target: {
					handle: "fresh-canvas",
					role: "canvas",
					label: "Drawing canvas",
				},
				drawing: plan,
			},
		]);
	});
});
