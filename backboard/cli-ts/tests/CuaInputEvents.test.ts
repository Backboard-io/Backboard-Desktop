import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Exercise the exact code embedded in the driver against a minimal event target.
const load = (name: string) =>
	new Function(
		`return (${readFileSync(new URL(`../../cua-driver/rust/crates/cua-driver-core/src/browser/${name}.js`, import.meta.url), "utf8")});`,
	)();
function target() {
	class InputEvent {
		constructor(
			readonly type: string,
			readonly options: Record<string, unknown>,
		) {}
	}
	const events: InputEvent[] = [];
	const element = {
		tagName: "CANVAS",
		isConnected: true,
		disabled: false,
		getAttribute: () => null,
		getBoundingClientRect: () => ({
			x: 10,
			y: 20,
			left: 10,
			top: 20,
			right: 510,
			bottom: 420,
			width: 500,
			height: 400,
		}),
		contains: () => false,
		setPointerCapture: (): void => {
			throw new Error("NotFoundError");
		},
		releasePointerCapture: () => {},
		hasPointerCapture: () => false,
		dispatchEvent: (event: InputEvent) => {
			events.push(event);
			if (event.type === "pointerdown") element.setPointerCapture();
			return true;
		},
		click: () => {
			events.push(new InputEvent("click", {}));
		},
		ownerDocument: {
			defaultView: {
				innerWidth: 1000,
				innerHeight: 800,
				PointerEvent: InputEvent,
				MouseEvent: InputEvent,
				setTimeout: (fn: () => void) => fn(),
			},
			elementFromPoint: (_x?: number, _y?: number): unknown => element,
		},
	};
	// A page handler captures the event's actual pointer id.
	element.dispatchEvent = (event) => {
		events.push(event);
		if (event.type === "pointerdown")
			(element.setPointerCapture as (id: number) => void)(
				event.options.pointerId as number,
			);
		return true;
	};
	return { element, events };
}
describe("driver background input", () => {
	it("fits the entire drawing uniformly around an obstruction before any brush-down", async () => {
		const { element, events } = target();
		element.ownerDocument.elementFromPoint = (_x, y) =>
			(y ?? 0) > 300 ? {} : element;
		const strokes = [
			[
				[0.2, 0.2],
				[0.8, 0.2],
			],
			[
				[0.2, 0.8],
				[0.8, 0.8],
			],
		];
		expect(await load("canvas_stroke").call(element, strokes, true)).toBe(true);
		const down = events.filter((e) => e.type === "pointerdown");
		expect(down).toHaveLength(2);
		expect(down[0]?.options.clientX).toBeCloseTo(170);
		expect(down[0]?.options.clientY).toBeCloseTo(148);
		expect(down[1]?.options.clientY).toBeCloseTo(292);
	});
	it("does not start a drawing when even a later stroke cannot fit", async () => {
		const { element, events } = target();
		element.ownerDocument.elementFromPoint = (_x, y) =>
			(y ?? 0) >= 220 ? {} : element;
		expect(
			await load("canvas_stroke").call(
				element,
				[
					[
						[0.2, 0.2],
						[0.8, 0.2],
					],
					[
						[0.2, 0.8],
						[0.8, 0.8],
					],
				],
				true,
			),
		).toBe(false);
		expect(events).toHaveLength(0);
	});
	it("stops and releases capture if the canvas disappears after a stroke", async () => {
		const { element, events } = target();
		const capture = element.setPointerCapture;
		const dispatch = element.dispatchEvent;
		element.dispatchEvent = (event) => {
			if (event.type === "mouseup") element.isConnected = false;
			return dispatch(event);
		};
		await expect(
			load("canvas_stroke").call(
				element,
				[
					[
						[0.2, 0.2],
						[0.8, 0.2],
					],
					[
						[0.2, 0.8],
						[0.8, 0.8],
					],
				],
				true,
			),
		).rejects.toThrow("some strokes may have landed");
		expect(events.filter((e) => e.type === "pointerdown")).toHaveLength(1);
		expect(element.setPointerCapture).toBe(capture);
	});
	it("delivers a bounded continuous stroke and restores pointer capture", async () => {
		const { element, events } = target();
		const capture = element.setPointerCapture;
		expect(
			await load("canvas_stroke").call(element, [
				[0.2, 0.3],
				[0.8, 0.7],
			]),
		).toBe(true);
		expect(events.map((e) => e.type)).toEqual([
			"pointermove",
			"mousemove",
			"pointerdown",
			"mousedown",
			"pointermove",
			"mousemove",
			"pointerup",
			"mouseup",
		]);
		expect(events[2]?.options).toMatchObject({
			clientX: 110,
			clientY: 140,
			buttons: 1,
		});
		expect(element.setPointerCapture).toBe(capture);
	});
	it("refuses occluded canvas input before dispatch", async () => {
		const { element, events } = target();
		element.ownerDocument.elementFromPoint = () => ({});
		expect(
			await load("canvas_stroke").call(element, [
				[0.2, 0.3],
				[0.8, 0.7],
			]),
		).toBe(false);
		expect(events).toHaveLength(0);
	});
	it("leaves the clicked brush tool before hit testing the canvas", async () => {
		const brush = target();
		brush.element.setPointerCapture = () => {};
		expect(load("semantic_click").call(brush.element)).toBe(true);
		const canvas = target();
		canvas.element.ownerDocument = brush.element.ownerDocument;
		let tooltipVisible = true;
		const dispatch = brush.element.dispatchEvent;
		brush.element.dispatchEvent = (event) => {
			if (event.type === "mouseleave") tooltipVisible = false;
			return dispatch(event);
		};
		brush.element.ownerDocument.elementFromPoint = () =>
			tooltipVisible ? {} : canvas.element;
		expect(
			await load("canvas_stroke").call(canvas.element, [
				[0.2, 0.3],
				[0.8, 0.7],
			]),
		).toBe(true);
		expect(tooltipVisible).toBe(false);
		expect(canvas.events.some((event) => event.type === "pointerdown")).toBe(
			true,
		);
	});
	it("sends mousedown before click for controls and refuses a covered control", () => {
		const { element, events } = target();
		element.setPointerCapture = () => {};
		expect(load("semantic_click").call(element)).toBe(true);
		expect(events.map((e) => e.type)).toContain("mousedown");
		expect(events.at(-1)?.type).toBe("click");
		events.length = 0;
		element.ownerDocument.elementFromPoint = () => ({});
		expect(load("semantic_click").call(element)).toBe(false);
		expect(events).toHaveLength(0);
	});
});

it("only recovers refusal outcomes that prove no input was dispatched", async () => {
	const { isUndispatchedRefusal } = await import(
		"../src/core/computer/CuaDriverClient.ts"
	);
	expect(isUndispatchedRefusal("refused (browser_ref_stale): gone")).toBe(true);
	expect(
		isUndispatchedRefusal(
			"refused (browser_action_unavailable): click target is no longer visible, enabled, or unobstructed",
		),
	).toBe(true);
	for (const error of [
		"refused: route_unavailable",
		"DOM click raised a page-side exception; delivery is uncertain",
		"refused (browser_action_unavailable): synthetic drag raised a page-side exception",
		"refused (browser_consent_required): no grant",
	])
		expect(isUndispatchedRefusal(error)).toBe(false);
});
