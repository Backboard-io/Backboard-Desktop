import type { ImageContentPayload } from "../image/ImageContent.ts";
import type { AccessibilityElement, ScreenSize } from "../platform/index.ts";

export type MouseButton = "left" | "right" | "middle";

export type KeyModifier = "meta" | "control" | "alt" | "shift";

export type KeyName =
	| "ENTER"
	| "TAB"
	| "SPACE"
	| "ESC"
	| "BACKSPACE"
	| "DELETE"
	| "UP"
	| "DOWN"
	| "LEFT"
	| "RIGHT"
	| "HOME"
	| "END"
	| "PAGEUP"
	| "PAGEDOWN"
	| (string & {});

export type ComputerKey =
	| string
	| {
			key: KeyName;
			modifiers?: Array<KeyModifier | string>;
	  };

export type ComputerTarget = { elementId: string } | { x: number; y: number };

export type ComputerAction =
	| { action: "screenshot" }
	| { action: "click"; target: ComputerTarget; button?: MouseButton }
	| { action: "type"; text: string }
	| { action: "key"; key: ComputerKey }
	| { action: "wait"; durationMs: number }
	| { action: "openApp"; appName: string }
	| {
			action: "task";
			/** The user's whole request for this app; the agent plans its own steps. */
			goal: string;
			appName: string;
			maxSteps?: number;
	  };

export interface ComputerObservation extends ImageContentPayload<"image/png"> {
	success: true;
	action: "screenshot";
	observationId: string;
	screenSize: ScreenSize;
	imageSize: ScreenSize;
	screenshotPath: string;
	screenshotScale: number;
	appName?: string;
	processId?: number;
	windowTitle?: string;
	elements: AccessibilityElement[];
	summary: string;
}

export interface ComputerActionResult {
	success: boolean;
	action: ComputerAction["action"];
	observationId?: string;
	verification: "passed" | "failed" | "unknown";
	summary: string;
	error?: string;
	observation?: ComputerObservation;
}

export type JevTaskOutcome =
	| "done"
	| "abstained"
	| "needs_confirmation"
	| "needs_input"
	| "stalled"
	| "budget_exhausted"
	| "failed";

export interface JevTaskStep {
	step: number;
	/** CLICK, TYPE_TEXT, OPEN_URL, PRESS_ENTER, SCROLL_DOWN, WAIT, DONE, ... */
	operation: string;
	/** The weaker of the operation and target confidences. */
	confidence: number;
	/** Jev's probability that the goal was already met on this screen. */
	complete: number;
	/** Observe plus decide, in milliseconds. */
	decisionMs: number;
	target?: string;
	/** What the writer model composed: typed text, or the address opened. */
	text?: string;
	/** Filled in by the next observation. */
	screenChanged?: boolean;
}

/** Result of a Jev-driven task. Final browser evidence goes to the caller, never Jev. */
export interface JevTaskResult
	extends ComputerActionResult,
		Partial<ImageContentPayload<"image/png">> {
	screenshotPath?: string;
	action: "task";
	outcome: JevTaskOutcome;
	/** `cua-driver`, or `native` when the driver binary was not found. */
	surface: string;
	steps: JevTaskStep[];
}

export interface ComputerQueueResult {
	success: boolean;
	results: Array<ComputerObservation | ComputerActionResult>;
}
