import { z } from "zod";
import { ComputerRuntime } from "../core/computer/ComputerRuntime.ts";
import type {
	ComputerAction,
	ComputerQueueResult,
} from "../core/computer/ComputerTypes.ts";
import {
	JEV_DEFAULT_MAX_STEPS,
	JEV_MAX_STEPS_LIMIT,
} from "../core/computer/JevUseLoop.ts";
import { stripNullProps, Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const targetSchema = z.union([
	z.object({ elementId: z.string().min(1) }),
	z.object({ x: z.number(), y: z.number() }),
]);

const buttonSchema = z.enum(["left", "right", "middle"]);
const keyModifierSchema = z.enum(["meta", "control", "alt", "shift"]);
const actionNameSchema = z.enum([
	"screenshot",
	"click",
	"type",
	"key",
	"wait",
	"openApp",
	"task",
]);
const keySchema = z.object({
	key: z
		.string()
		.min(1)
		.describe("Canonical key name, e.g. L, ENTER, TAB, BACKSPACE."),
	modifiers: z
		.array(keyModifierSchema)
		.describe(
			"Canonical modifiers. Use meta for Command on macOS and Windows key on Windows.",
		)
		.optional(),
});

const actionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("screenshot"),
		appName: z.string().min(1).optional(),
	}),
	z.object({
		action: z.literal("click"),
		target: targetSchema,
		button: buttonSchema.optional(),
	}),
	z.object({
		action: z.literal("type"),
		text: z.string(),
	}),
	z.object({
		action: z.literal("key"),
		key: keySchema,
	}),
	z.object({
		action: z.literal("wait"),
		durationMs: z.number().int().min(0).max(60_000),
	}),
	z.object({
		action: z.literal("openApp"),
		appName: z.string().min(1),
	}),
	z.object({
		action: z.literal("task"),
		goal: z.string().min(1),
		appName: z.string().min(1),
		maxSteps: z.number().int().min(1).max(JEV_MAX_STEPS_LIMIT).optional(),
	}),
]);

const runtimeSchema = z.object({
	actions: z
		.array(actionSchema)
		.min(1)
		.max(20)
		.describe("Serial action queue. Use one action for a single step."),
	defaultDelayMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Delay between queued actions.")
		.optional(),
	stopOnError: z
		.boolean()
		.describe("Stop queued execution after the first failed action.")
		.optional(),
});

const publicTargetSchema = z.object({
	elementId: z
		.string()
		.min(1)
		.describe(
			"Primary target selector. Use an element id from the latest screenshot elements list.",
		)
		.optional(),
	x: z.number().describe("Fallback screen x coordinate.").optional(),
	y: z.number().describe("Fallback screen y coordinate.").optional(),
});

const publicActionSchema = z.object({
	action: actionNameSchema.describe("Action to perform."),
	target: publicTargetSchema
		.describe(
			"For click actions, use target.elementId from the latest screenshot elements list whenever available. Coordinates are fallback only.",
		)
		.optional(),
	button: buttonSchema.optional(),
	text: z.string().describe("Text to type for the type action.").optional(),
	key: keySchema.optional(),
	durationMs: z.number().int().positive().optional(),
	ms: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Alias for durationMs on wait actions.")
		.optional(),
	appName: z
		.string()
		.min(1)
		.describe(
			"Application name for openApp/task. For a web/drawing task without a specified browser use Browser (automatic Chromium selection). DOM/canvas browser tasks support Brave, Chrome, and Edge, not Safari or Firefox. On screenshot, captures the exact browser task window for this app instead of the foreground desktop.",
		)
		.optional(),
	goal: z
		.string()
		.min(1)
		.describe(
			"For the task action: the user's whole request for appName, in their words, including anything to type or search for. The agent plans its own steps.",
		)
		.optional(),
	maxSteps: z
		.number()
		.int()
		.min(1)
		.max(JEV_MAX_STEPS_LIMIT)
		.describe(
			`For the task action: decision budget, including waits and recovery. Default ${JEV_DEFAULT_MAX_STEPS}, maximum ${JEV_MAX_STEPS_LIMIT}. Loading can wait up to 120 seconds.`,
		)
		.optional(),
});

const publicSchema = z.object({
	actions: z
		.array(publicActionSchema)
		.min(1)
		.max(20)
		.describe("Serial queue of action objects."),
	defaultDelayMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Delay between queued actions.")
		.optional(),
	stopOnError: z
		.boolean()
		.describe("Stop queued execution after the first failed action.")
		.optional(),
});

type Input = z.infer<typeof runtimeSchema>;

export class ComputerTool extends Tool<Input, ComputerQueueResult> {
	readonly name = "Computer";
	readonly inputSchema = publicSchema as z.ZodType<Input>;

	constructor(private readonly runtime = new ComputerRuntime()) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override async dispose(): Promise<void> {
		await this.runtime.dispose();
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override isDestructive(): boolean {
		return true;
	}

	override parseInput(raw: unknown): Input {
		return runtimeSchema.parse(normalizeComputerInput(stripNullProps(raw)));
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<ComputerQueueResult>> {
		const result = await this.runtime.execute(input.actions, ctx, {
			defaultDelayMs: input.defaultDelayMs,
			stopOnError: input.stopOnError,
		});
		return ok(
			result,
			JSON.stringify(result),
			computerResultTitle(input.actions, result),
		);
	}
}

function computerResultTitle(
	actions: readonly ComputerAction[],
	result: ComputerQueueResult,
): string {
	const last = result.results.at(-1);
	if (!last) return result.success ? "Completed" : "Failed";
	if (!last.success) return `Failed ${last.action}`;
	if (actions.length > 1) return `Completed ${actions.length} actions`;
	switch (actions[0]?.action) {
		case "screenshot":
			return "Captured screenshot";
		case "click":
			return "Clicked";
		case "type":
			return "Typed text";
		case "key":
			return "Pressed key";
		case "wait":
			return `Waited ${actions[0].durationMs}ms`;
		case "openApp":
			return `Opened ${actions[0].appName}`;
		case "task":
			return `Completed task in ${actions[0].appName}`;
		default:
			return "Completed";
	}
}

function normalizeComputerInput(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const input = raw as Record<string, unknown>;
	if (!Array.isArray(input.actions)) return input;
	return {
		...input,
		actions: input.actions.map((action) => {
			if (typeof action === "string") {
				return { action };
			}
			if (!action || typeof action !== "object" || Array.isArray(action)) {
				return action;
			}
			const item = action as Record<string, unknown>;
			let normalized = item;
			if (
				normalized.action === undefined &&
				typeof normalized.type === "string"
			) {
				const { type: actionType, ...rest } = item;
				normalized = { ...rest, action: actionType };
			}
			const alias =
				typeof normalized.action === "string"
					? ACTION_ALIASES[normalized.action]
					: undefined;
			if (alias) normalized = { ...normalized, action: alias };
			if (normalized.action === "click" && !isRecord(normalized.target)) {
				const target = clickTarget(normalized);
				if (target) normalized = { ...normalized, target };
			}
			if (
				normalized.action === "openApp" ||
				normalized.action === "task" ||
				normalized.action === "screenshot"
			) {
				const appName = firstString(normalized, APP_NAME_KEYS);
				if (appName) normalized = { ...normalized, appName };
			}
			if (
				normalized.action === "task" &&
				typeof normalized.goal === "string" &&
				typeof normalized.text === "string" &&
				!normalized.goal.includes(normalized.text)
			) {
				// The agent composes its own text now; a supplied value is just detail.
				normalized = {
					...normalized,
					goal: `${normalized.goal} (enter: ${JSON.stringify(normalized.text)})`,
				};
			}
			if (normalized.action === "key" && normalized.key !== undefined) {
				return { ...normalized, key: normalizeKeyInput(normalized.key) };
			}
			if (normalized.action === "wait" && normalized.durationMs === undefined) {
				const durationMs =
					typeof normalized.ms === "number" ? normalized.ms : undefined;
				if (durationMs !== undefined) return { ...normalized, durationMs };
			}
			return normalized;
		}),
	};
}

/**
 * Shapes models actually send. Every one of these was rejected in a real
 * session, leaving the model unable to click at all after a failed task.
 */
const ACTION_ALIASES: Record<string, string> = {
	clickElement: "click",
	click_element: "click",
	left_click: "click",
	tap: "click",
	open_app: "openApp",
	launchApp: "openApp",
	launch_app: "openApp",
};
const ELEMENT_ID_KEYS = ["elementId", "element_id", "ref", "id"];
const APP_NAME_KEYS = ["appName", "app_name", "name", "app", "application"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstString(
	item: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = item[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/** Lifts a flat `x`/`y`, a `coordinate` pair, or a bare element id into `target`. */
function clickTarget(
	item: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (typeof item.target === "string" && item.target.trim()) {
		return { elementId: item.target };
	}
	const elementId = firstString(item, ELEMENT_ID_KEYS);
	if (elementId) return { elementId };
	if (typeof item.x === "number" && typeof item.y === "number") {
		return { x: item.x, y: item.y };
	}
	const pair = item.coordinate ?? item.coordinates;
	if (
		Array.isArray(pair) &&
		typeof pair[0] === "number" &&
		typeof pair[1] === "number"
	) {
		return { x: pair[0], y: pair[1] };
	}
	return undefined;
}

function normalizeKeyInput(raw: unknown): unknown {
	if (typeof raw === "string") return parseKeyChord(raw);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const key = raw as Record<string, unknown>;
	if (typeof key.key !== "string") return key;
	const parsed = parseKeyChord(key.key);
	const explicitModifiers = Array.isArray(key.modifiers)
		? key.modifiers.map((modifier) =>
				typeof modifier === "string"
					? normalizeModifierInput(modifier)
					: modifier,
			)
		: [];
	return {
		...key,
		key: parsed.key,
		modifiers: [...parsed.modifiers, ...explicitModifiers],
	};
}

function parseKeyChord(value: string): { key: string; modifiers: string[] } {
	const parts = value
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const key = parts.pop() ?? value;
	return {
		key,
		modifiers: parts.map(normalizeModifierInput),
	};
}

function normalizeModifierInput(value: string): string {
	switch (value.toLowerCase()) {
		case "cmd":
		case "command":
		case "meta":
		case "win":
		case "windows":
			return "meta";
		case "ctrl":
		case "control":
			return "control";
		case "alt":
		case "option":
			return "alt";
		case "shift":
			return "shift";
		default:
			return value;
	}
}
