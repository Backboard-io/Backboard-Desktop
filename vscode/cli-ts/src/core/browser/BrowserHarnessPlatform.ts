import { writeFile } from "node:fs/promises";
import { BasePlatform } from "../platform/BasePlatform.ts";
import { pngSize, resizeWithCandidates } from "../platform/png.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	ImagePayload,
	PlatformAction,
	PlatformKey,
	ResizePngInput,
	ScreenBounds,
	ScreenshotCapture,
} from "../platform/types.ts";
import {
	type BrowserHarnessClient,
	BrowserHarnessSession,
} from "./BrowserHarnessSession.ts";
import type { BrowserPlatform } from "./BrowserTypes.ts";

interface CaptureResult {
	data?: string;
}

interface LayoutMetricsResult {
	cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
	cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
}

interface RuntimeEvaluateResult {
	result?: {
		value?: unknown;
	};
}

interface DomElementSnapshot {
	role?: unknown;
	name?: unknown;
	value?: unknown;
	enabled?: unknown;
	focused?: unknown;
	bounds?: unknown;
}

export class BrowserHarnessPlatform
	extends BasePlatform
	implements BrowserPlatform
{
	private readonly client: BrowserHarnessClient;
	private screenshotToCssScale = 1;

	constructor(client: BrowserHarnessClient = new BrowserHarnessSession()) {
		super();
		this.client = client;
	}

	async screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		await this.client.call("Page.enable", {}, signal);
		const [shot, metrics] = await Promise.all([
			this.client.call<CaptureResult>(
				"Page.captureScreenshot",
				{ format: "png", fromSurface: true },
				signal,
			),
			this.client.call<LayoutMetricsResult>(
				"Page.getLayoutMetrics",
				{},
				signal,
			),
		]);
		if (typeof shot.data !== "string") {
			throw new Error("Browser screenshot did not include image data");
		}
		const bytes = Buffer.from(shot.data, "base64");
		await writeFile(path, bytes);
		const size = pngSize(bytes, "browser screenshot");
		const cssWidth =
			metrics.cssVisualViewport?.clientWidth ??
			metrics.cssLayoutViewport?.clientWidth;
		this.screenshotToCssScale =
			typeof cssWidth === "number" && cssWidth > 0 ? size.width / cssWidth : 1;
		return { path, bytes, screenSize: size };
	}

	override async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		const result = await this.client.call<RuntimeEvaluateResult>(
			"Runtime.evaluate",
			{
				expression: DOM_SNAPSHOT_SCRIPT,
				returnByValue: true,
				awaitPromise: false,
			},
			signal,
		);
		const value = result.result?.value;
		if (!value || typeof value !== "object") return { elements: [] };
		const raw = value as Record<string, unknown>;
		const elements = Array.isArray(raw.elements)
			? raw.elements.map((item, index) => this.toElement(item, index))
			: [];
		return {
			appName: "Browser",
			windowTitle:
				typeof raw.title === "string" && raw.title ? raw.title : undefined,
			elements: elements.filter((item): item is AccessibilityElement => !!item),
		};
	}

	async execute(action: PlatformAction, signal: AbortSignal): Promise<void> {
		switch (action.kind) {
			case "openApp":
				if (/^(chrome|chromium|browser)$/i.test(action.appName)) return;
				throw new Error("Browser tool cannot open desktop applications.");
			case "type":
				if (action.mode === "keys") {
					await this.typeAsKeyEvents(action.text, signal);
					return;
				}
				await this.client.call(
					"Input.insertText",
					{ text: action.text },
					signal,
				);
				return;
			case "key":
				await this.key(action.key, signal, action.phase, action.holdMs);
				return;
			case "click":
				await this.click(
					action.point.x / this.screenshotToCssScale,
					action.point.y / this.screenshotToCssScale,
					action.button,
					signal,
				);
				return;
			case "scroll":
				await this.scroll(action, signal);
				return;
			case "drag":
				await this.drag(action.from, action.to, action.durationMs, signal);
				return;
		}
	}

	async navigate(url: string, signal: AbortSignal): Promise<void> {
		await this.client.call("Page.enable", {}, signal);
		await this.client.call("Page.navigate", { url }, signal);
	}

	/**
	 * Downscale by re-capturing through CDP with a scaled clip. Without this
	 * override the {@link BasePlatform} default returns null and a Retina-sized
	 * screenshot above the byte cap becomes a hard error instead of a smaller
	 * image (the desktop platforms shell out to sips/System.Drawing instead).
	 */
	protected override async resizePng(
		input: ResizePngInput,
	): Promise<ImagePayload | null> {
		const metrics = await this.client.call<LayoutMetricsResult>(
			"Page.getLayoutMetrics",
			{},
			input.signal,
		);
		const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
		const cssWidth = viewport?.clientWidth;
		const cssHeight = viewport?.clientHeight;
		if (!cssWidth || !cssHeight) return null;
		return resizeWithCandidates(input, async (width, out) => {
			const shot = await this.client.call<CaptureResult>(
				"Page.captureScreenshot",
				{
					format: "png",
					fromSurface: true,
					clip: {
						x: 0,
						y: 0,
						width: cssWidth,
						height: cssHeight,
						scale: width / cssWidth,
					},
				},
				input.signal,
			);
			if (typeof shot.data !== "string") {
				throw new Error("Browser screenshot did not include image data");
			}
			await writeFile(out, Buffer.from(shot.data, "base64"));
		});
	}

	private async click(
		x: number,
		y: number,
		button: "left" | "right" | "middle",
		signal: AbortSignal,
	): Promise<void> {
		const cdpButton = button === "middle" ? "middle" : button;
		await this.client.call(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x, y, button: cdpButton, clickCount: 1 },
			signal,
		);
		await this.client.call(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x, y, button: cdpButton, clickCount: 1 },
			signal,
		);
	}

	private async key(
		key: PlatformKey,
		signal: AbortSignal,
		phase: "down" | "up" | "press" = "press",
		holdMs?: number,
	): Promise<void> {
		const code = keyCode(key.key);
		const modifiers = modifierMask(key.modifiers);
		const base = {
			key: code.key,
			code: code.code,
			windowsVirtualKeyCode: code.windowsVirtualKeyCode,
			modifiers,
		};
		// Printable keys (and Enter) carry `text` so pages that listen for
		// keypress/beforeinput see the same event stream a physical keyboard
		// produces. Pure key-state listeners (games) only need keydown/keyup.
		const text =
			code.key.length === 1
				? code.key
				: code.key === "Enter"
					? "\r"
					: undefined;
		const down = text
			? { ...base, type: "keyDown", text }
			: { ...base, type: "rawKeyDown" };
		if (phase !== "up") {
			await this.client.call("Input.dispatchKeyEvent", down, signal);
		}
		if (phase === "press" && holdMs && holdMs > 0) {
			// Emulate the browser's native auto-repeat while the key is held, so
			// games that step per keydown event keep moving for the whole hold.
			const deadline = Date.now() + Math.min(holdMs, MAX_KEY_HOLD_MS);
			while (Date.now() < deadline) {
				await holdDelay(
					Math.min(KEY_REPEAT_INTERVAL_MS, deadline - Date.now()),
					signal,
				);
				if (Date.now() >= deadline) break;
				await this.client.call(
					"Input.dispatchKeyEvent",
					{ ...down, autoRepeat: true },
					signal,
				);
			}
		}
		if (phase !== "down") {
			await this.client.call(
				"Input.dispatchKeyEvent",
				{ ...base, type: "keyUp" },
				signal,
			);
		}
	}

	private async typeAsKeyEvents(
		text: string,
		signal: AbortSignal,
	): Promise<void> {
		for (const char of text) {
			const isNewline = char === "\n" || char === "\r";
			await this.key(
				{ key: isNewline ? "ENTER" : char, modifiers: [] },
				signal,
			);
			await holdDelay(TYPE_KEY_EVENT_DELAY_MS, signal);
		}
	}

	private async scroll(
		action: {
			point?: { x: number; y: number };
			deltaX: number;
			deltaY: number;
		},
		signal: AbortSignal,
	): Promise<void> {
		let x: number;
		let y: number;
		if (action.point) {
			x = action.point.x / this.screenshotToCssScale;
			y = action.point.y / this.screenshotToCssScale;
		} else {
			const metrics = await this.client.call<LayoutMetricsResult>(
				"Page.getLayoutMetrics",
				{},
				signal,
			);
			const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
			x = (viewport?.clientWidth ?? 800) / 2;
			y = (viewport?.clientHeight ?? 600) / 2;
		}
		await this.client.call(
			"Input.dispatchMouseEvent",
			{
				type: "mouseWheel",
				x,
				y,
				deltaX: action.deltaX,
				deltaY: action.deltaY,
			},
			signal,
		);
	}

	private async drag(
		from: { x: number; y: number },
		to: { x: number; y: number },
		durationMs: number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const scale = this.screenshotToCssScale;
		const start = { x: from.x / scale, y: from.y / scale };
		const end = { x: to.x / scale, y: to.y / scale };
		const steps = Math.max(
			2,
			Math.min(
				DRAG_MAX_STEPS,
				Math.round((durationMs ?? 300) / DRAG_STEP_INTERVAL_MS),
			),
		);
		await this.client.call(
			"Input.dispatchMouseEvent",
			{ type: "mouseMoved", x: start.x, y: start.y },
			signal,
		);
		await this.client.call(
			"Input.dispatchMouseEvent",
			{
				type: "mousePressed",
				x: start.x,
				y: start.y,
				button: "left",
				clickCount: 1,
			},
			signal,
		);
		for (let step = 1; step <= steps; step++) {
			const t = step / steps;
			await this.client.call(
				"Input.dispatchMouseEvent",
				{
					type: "mouseMoved",
					x: start.x + (end.x - start.x) * t,
					y: start.y + (end.y - start.y) * t,
					button: "left",
				},
				signal,
			);
			await holdDelay(DRAG_STEP_INTERVAL_MS, signal);
		}
		await this.client.call(
			"Input.dispatchMouseEvent",
			{
				type: "mouseReleased",
				x: end.x,
				y: end.y,
				button: "left",
				clickCount: 1,
			},
			signal,
		);
	}

	private toElement(
		value: unknown,
		index: number,
	): AccessibilityElement | null {
		if (!value || typeof value !== "object") return null;
		const raw = value as DomElementSnapshot;
		const bounds = parseBounds(raw.bounds, this.screenshotToCssScale);
		if (!bounds) return null;
		return {
			id: `el_${index + 1}`,
			appName: "Browser",
			role: typeof raw.role === "string" ? raw.role : "element",
			name: typeof raw.name === "string" ? raw.name : undefined,
			value: typeof raw.value === "string" ? raw.value : undefined,
			bounds,
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			focused: typeof raw.focused === "boolean" ? raw.focused : undefined,
		};
	}
}

function parseBounds(value: unknown, scale: number): ScreenBounds | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const x = numberValue(raw.x);
	const y = numberValue(raw.y);
	const width = numberValue(raw.width);
	const height = numberValue(raw.height);
	if (
		x === undefined ||
		y === undefined ||
		width === undefined ||
		height === undefined
	) {
		return undefined;
	}
	return {
		x: x * scale,
		y: y * scale,
		width: width * scale,
		height: height * scale,
	};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function modifierMask(modifiers: PlatformKey["modifiers"]): number {
	let mask = 0;
	for (const modifier of modifiers) {
		if (modifier === "alt") mask |= 1;
		if (modifier === "control") mask |= 2;
		if (modifier === "meta") mask |= 4;
		if (modifier === "shift") mask |= 8;
	}
	return mask;
}

function keyCode(key: string): {
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
} {
	// Single characters pass through with their case preserved: a game checking
	// `event.key === "w"` must see "w", not "W". `code`/keyCode still use the
	// uppercase physical-key identity.
	if (key.length === 1) {
		const upper = key.toUpperCase();
		return {
			key,
			code: /[a-z]/i.test(key) ? `Key${upper}` : keyCodeForSymbol(key),
			windowsVirtualKeyCode: upper.charCodeAt(0),
		};
	}
	const mapped = KEY_CODES[key.toUpperCase()];
	if (mapped) return mapped;
	throw new Error(
		`Unsupported browser key: ${key}. Use a single character or one of: ${Object.keys(KEY_CODES).join(", ")}.`,
	);
}

function keyCodeForSymbol(key: string): string {
	if (/[0-9]/.test(key)) return `Digit${key}`;
	if (key === " ") return "Space";
	return key;
}

const KEY_CODES: Record<
	string,
	{ key: string; code: string; windowsVirtualKeyCode: number }
> = {
	ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
	RETURN: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
	TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
	SPACE: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
	SPACEBAR: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
	ESC: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	ESCAPE: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	BACKSPACE: {
		key: "Backspace",
		code: "Backspace",
		windowsVirtualKeyCode: 8,
	},
	DELETE: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
	UP: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
	DOWN: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	LEFT: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	RIGHT: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
	ARROWUP: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ARROWDOWN: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ARROWLEFT: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ARROWRIGHT: {
		key: "ArrowRight",
		code: "ArrowRight",
		windowsVirtualKeyCode: 39,
	},
	SHIFT: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
	CONTROL: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
	ALT: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
	META: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
	HOME: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
	END: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
	PAGEUP: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
	PAGEDOWN: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

const MAX_KEY_HOLD_MS = 10_000;
const KEY_REPEAT_INTERVAL_MS = 55;
const TYPE_KEY_EVENT_DELAY_MS = 15;
const DRAG_STEP_INTERVAL_MS = 16;
const DRAG_MAX_STEPS = 40;

function holdDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

const DOM_SNAPSHOT_SCRIPT = `(() => {
	const selectors = [
		"a[href]",
		"button",
		"input",
		"textarea",
		"select",
		"[role]",
		"[onclick]",
		"[contenteditable='true']",
		"[tabindex]:not([tabindex='-1'])"
	];
	const elements = [];
	const seen = new Set();
	for (const el of document.querySelectorAll(selectors.join(","))) {
		if (!(el instanceof HTMLElement) || seen.has(el)) continue;
		seen.add(el);
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
		const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim().slice(0, 160);
		elements.push({
			role: el.getAttribute("role") || el.tagName.toLowerCase(),
			name: text || undefined,
			value: "value" in el ? String(el.value).slice(0, 160) : undefined,
			enabled: !("disabled" in el && el.disabled),
			focused: document.activeElement === el,
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
		});
		if (elements.length >= 120) break;
	}
	return { title: document.title, url: location.href, elements };
})()`;
