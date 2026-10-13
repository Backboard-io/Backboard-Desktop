import type { AccessibilityElement, Platform } from "../platform/index.ts";
import type {
	JevElement,
	JevKey,
	JevObservation,
	JevSurface,
} from "./JevUseLoop.ts";

/**
 * Fallback surface for machines without the Cua Driver binary. It uses the
 * built-in platform layer, which can only click by coordinate: the target app
 * is brought to the front and the real pointer moves. It cannot read page text
 * or navigate a browser, so the agent is weaker here by design.
 */
export class PlatformJevSurface implements JevSurface {
	readonly kind = "native";
	private opened = false;
	private elements = new Map<string, AccessibilityElement>();

	constructor(
		private readonly platform: Platform,
		private readonly appName: string,
	) {}

	async observe(signal: AbortSignal): Promise<JevObservation> {
		if (!this.opened) {
			await this.platform.execute(
				{ kind: "openApp", appName: this.appName },
				signal,
			);
			this.opened = true;
		}
		const snapshot = await this.platform.accessibilitySnapshot(signal);
		// This layer only sees the frontmost app. If focus moved, stop: a real
		// run drifted into another app's Apple menu and was offered Shut Down.
		if (!sameApp(snapshot.appName, this.appName)) {
			throw new Error(
				`${this.appName} is no longer the frontmost app (now ${snapshot.appName ?? "unknown"}). Re-open it before continuing.`,
			);
		}
		this.elements = new Map();
		const elements: JevElement[] = [];
		for (const element of snapshot.elements) {
			if (element.enabled === false || !element.bounds) continue;
			if (element.bounds.width <= 0 || element.bounds.height <= 0) continue;
			this.elements.set(element.id, element);
			elements.push({
				handle: element.id,
				role: element.role,
				label: element.name,
				value: element.value,
			});
		}
		return {
			appName: snapshot.appName,
			windowTitle: snapshot.windowTitle,
			elements,
		};
	}

	async press(element: JevElement, signal: AbortSignal): Promise<void> {
		const bounds = this.elements.get(element.handle)?.bounds;
		if (!bounds)
			throw new Error(`Element is no longer on screen: ${element.handle}`);
		await this.platform.execute(
			{
				kind: "click",
				point: {
					x: bounds.x + bounds.width / 2,
					y: bounds.y + bounds.height / 2,
				},
				button: "left",
			},
			signal,
		);
	}

	async type(
		element: JevElement,
		text: string,
		signal: AbortSignal,
	): Promise<void> {
		// This layer types into whatever has focus, so focus the field first.
		await this.press(element, signal);
		await this.platform.execute({ kind: "type", text }, signal);
	}

	async key(key: JevKey, signal: AbortSignal): Promise<void> {
		await this.platform.execute(
			{
				kind: "key",
				key: { key: key === "return" ? "ENTER" : "ESC", modifiers: [] },
			},
			signal,
		);
	}

	async scroll(direction: "up" | "down", signal: AbortSignal): Promise<void> {
		await this.platform.execute(
			{
				kind: "key",
				key: {
					key: direction === "down" ? "PAGEDOWN" : "PAGEUP",
					modifiers: [],
				},
			},
			signal,
		);
	}
}

function sameApp(actual: string | undefined, expected: string): boolean {
	const norm = (value: string) =>
		value
			.toLowerCase()
			.replace(/\.app$/, "")
			.trim();
	return actual !== undefined && norm(actual) === norm(expected);
}
