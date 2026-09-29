import { describe, expect, it } from "bun:test";
import {
	CuaBrowserSurface,
	elementsFromRefs,
} from "../src/core/computer/CuaBrowserSurface.ts";
import { isBrowserApp } from "../src/core/computer/CuaDriverSurface.ts";
import { describeElement } from "../src/core/computer/JevUseLoop.ts";

/** Shaped like a real `semantic_v2` ref captured from the driver. */
const ref = (
	id: number,
	role: string,
	name: string | null,
	extra: Record<string, unknown> = {},
) => ({
	ref: `p1:${id}`,
	role,
	name,
	value: null,
	actions: ["click", "pointer"],
	frame: "main",
	states: { focusable: true },
	visibility: "in_viewport",
	...extra,
});

describe("DOM refs offered to Jev", () => {
	it("puts visible controls first and folds a link's image and caption into it", () => {
		// Pixlr lists every product three times: the link, its image, its caption.
		const elements = elementsFromRefs([
			ref(0, "link", "Pricing", { visibility: "offscreen" }),
			ref(1, "link", "Pixlr Editor"),
			ref(2, "image", "Pixlr Editor"),
			ref(3, "statictext", "Pixlr Editor"),
			ref(4, "labeltext", "Toggle sidebar"),
			ref(5, "image", ""),
			ref(6, "button", "Create new", { visibility: "near_viewport" }),
		]);
		expect(
			elements.map(
				(element) => `${element.handle} ${describeElement(element)}`,
			),
		).toEqual([
			'p1:1 link "Pixlr Editor"',
			// A caption with no control of its own name is the control.
			'p1:4 labeltext "Toggle sidebar"',
			'p1:6 button "Create new"',
			'p1:0 link "Pricing"',
		]);
	});

	it("takes editability and state from the driver instead of guessing by role", () => {
		const elements = elementsFromRefs([
			ref(0, "searchbox", "Search Wikipedia", {
				actions: ["click", "type"],
				value: "alan",
			}),
			ref(1, "checkbox", "Remember me", { states: { checked: true } }),
			ref(2, "tab", "Images", { states: { selected: true } }),
			// Declares no action, so it is evidence on the page, not a target.
			ref(3, "heading", "Results", { actions: [] }),
		]);
		expect(
			elements.map((element) => [describeElement(element), element.editable]),
		).toEqual([
			['searchbox "Search Wikipedia" (currently "alan")', true],
			['checkbox "Remember me" (currently ON)', false],
			['tab "Images" (selected)', false],
		]);
	});

	it("sends any browser by name to the DOM surface", () => {
		expect(
			[
				"Brave",
				"Brave Browser",
				"Google Chrome",
				"Safari",
				"Browser",
				"Spotify",
				"Notes",
			].map(isBrowserApp),
		).toEqual([true, true, true, true, true, false, false]);
	});
});

describe("browser execution", () => {
	it("prepares the requested Brave executable and sends one background click without retrying errors", async () => {
		const { CuaBrowserSurface } = await import(
			"../src/core/computer/CuaBrowserSurface.ts"
		);
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		let failClick = false;
		let transientReads = 1;
		const driver = {
			async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
				calls.push({ name, args });
				if (name === "launch_app") return { pid: 10 } as T;
				if (name === "browser_prepare") return { prepared_pid: 20 } as T;
				if (name === "list_windows")
					return {
						windows: [
							{
								pid: 20,
								window_id: 30,
								is_on_screen: true,
								bounds: { width: 1000, height: 800 },
							},
						],
					} as T;
				if (name === "get_browser_state") {
					if (transientReads-- > 0)
						throw new Error("Frame with the given frameId is not found");
					return {
						page: { title: "Test", url: "https://example.com" },
						refs: [
							ref(1, "button", "Create"),
							ref(2, "generic", null, { actions: ["scroll"] }),
						],
					} as T;
				}
				if (name === "browser_click" && failClick)
					throw new Error("delivery uncertain");

				return {} as T;
			},
			async tryCall<T>() {
				return {
					ok: true,
					data: {
						target_id: "target",
						tabs: [{ tab_id: "tab", active: true }],
					} as T,
				};
			},
			async close() {},
		};
		const surface = new CuaBrowserSurface("unused", "Brave", driver);
		const signal = new AbortController().signal;
		const seen = await surface.observe(signal);
		expect(calls.find((call) => call.name === "launch_app")?.args).toEqual({
			name: "Brave Browser",
		});
		expect(
			calls.find((call) => call.name === "browser_prepare")?.args.pid,
		).toBe(10);
		expect(seen.appName).toBe("Brave");
		expect(
			calls.filter((call) => call.name === "get_browser_state"),
		).toHaveLength(2);
		const button = seen.elements[0];
		if (!button) throw new Error("Missing fixture button");
		await surface.press(button, signal);
		expect(calls.filter((call) => call.name === "browser_click")).toHaveLength(
			1,
		);
		expect(calls.at(-1)?.args.input_route).toBe("dom_event");
		failClick = true;
		await expect(surface.press(button, signal)).rejects.toThrow(
			"delivery uncertain",
		);
		expect(calls.filter((call) => call.name === "browser_click")).toHaveLength(
			2,
		);
		await surface.scroll("down", signal);
		expect(calls.at(-1)?.args).toMatchObject({
			ref: "p1:2",
			input_route: "dom_event",
			delta_y: 600,
		});
		await surface.draw(
			{ handle: "p1:3", role: "canvas" },
			{
				description: "Two lines",
				strokes: [
					[
						[0.2, 0.2],
						[0.8, 0.8],
					],
					[
						[0.8, 0.2],
						[0.2, 0.8],
					],
				],
			},
			signal,
		);
		const drawings = calls.filter(
			(call) => call.name === "browser_pointer" && call.args.action === "drag",
		);
		expect(drawings).toHaveLength(1);
		expect(drawings[0]?.args.strokes).toHaveLength(2);
		transientReads = 10;
		const reads = calls.filter(
			(call) => call.name === "get_browser_state",
		).length;
		await expect(surface.observe(signal)).rejects.toThrow("frameId");
		expect(
			calls.filter((call) => call.name === "get_browser_state").length - reads,
		).toBe(4);
	});
	it("retains visible unnamed canvases without treating them as text fields", () => {
		expect(
			elementsFromRefs([
				ref(1, "canvas", null, { actions: ["pointer"] }),
				ref(2, "canvas", "Hidden preview", {
					actions: ["pointer"],
					visibility: "offscreen",
				}),
			]),
		).toEqual([
			{
				handle: "p1:1",
				role: "canvas",
				label: "Drawing canvas",
				value: undefined,
				selected: false,
				editable: false,
				clickable: false,
			},
		]);
	});
});

describe("typing into a page field", () => {
	it("types at the caret, then clicks and types, when the driver cannot replace the text", async () => {
		const calls: string[] = [];
		const driver = {
			async call<T>(name: string, args: Record<string, unknown>) {
				calls.push(
					`${name} ${JSON.stringify({ ref: args.ref, text: args.text, replace: args.replace, input_route: args.input_route })}`,
				);
				if (name === "launch_app") return { pid: 1 } as T;
				if (name === "browser_prepare") return { prepared_pid: 1 } as T;
				if (name === "list_windows")
					return {
						windows: [
							{
								pid: 1,
								window_id: 2,
								is_on_screen: true,
								bounds: { width: 900, height: 600 },
							},
						],
					} as T;
				return {} as T;
			},
			async tryCall<T>(name: string, args: Record<string, unknown>) {
				if (name === "get_browser_state")
					return {
						ok: true,
						data: {
							target_id: "t",
							tabs: [{ tab_id: "a", active: true }],
						} as T,
					};
				if (name === "browser_type") {
					calls.push(`try ${name} replace=${args.replace}`);
					return {
						ok: false,
						data: {} as T,
						error:
							"browser_input_trust_unavailable: the exact editable ref did not become focus-ready",
					};
				}
				return { ok: true, data: {} as T };
			},
			async close() {},
		};
		const surface = new CuaBrowserSurface("/driver", "Browser", driver);
		await surface.type(
			{
				handle: "p1:0",
				role: "searchbox",
				label: "Search Wikipedia",
				clickable: true,
			},
			"Alan Turing",
			new AbortController().signal,
		);
		expect(calls.filter((call) => /browser_(type|click)/.test(call))).toEqual([
			"try browser_type replace=true",
			"try browser_type replace=undefined",
			'browser_click {"ref":"p1:0","input_route":"dom_event"}',
			'browser_type {"ref":"p1:0","text":"Alan Turing"}',
		]);
	});
});
