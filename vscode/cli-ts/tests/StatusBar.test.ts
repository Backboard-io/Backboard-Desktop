import { describe, expect, it } from "bun:test";
import {
	formatMemoryAmount,
	formatThinkingAmount,
	statusBarSegments,
} from "../src/ui/components/StatusBar.tsx";

const STATUS_BAR_INPUT = {
	status: "ready",
	model: "openai/gpt-5.5",
	path: "~/Documents/backboard/Espri-API/q-cli",
};

describe("StatusBar", () => {
	it("formats thinking amounts for the footer", () => {
		expect(formatThinkingAmount(null)).toBeNull();
		expect(formatThinkingAmount(undefined)).toBeNull();
		expect(formatThinkingAmount({ effort: "low" })).toBe("low");
		expect(formatThinkingAmount({ effort: "medium" })).toBe("medium");
		expect(formatThinkingAmount({ effort: "high" })).toBe("high");
		expect(formatThinkingAmount({ effort: "max" })).toBe("xhigh");
		expect(formatThinkingAmount({ budget_tokens: 4096 })).toBe("4096 tokens");
		expect(formatThinkingAmount({ max_tokens: 8192 })).toBe("8192 tokens");
		expect(formatThinkingAmount({ kind: "default" })).toBe("provider default");
		expect(formatThinkingAmount({ kind: "dynamic" })).toBe("dynamic");
	});

	it("formats memory amounts for the footer", () => {
		expect(formatMemoryAmount("off")).toBeNull();
		expect(formatMemoryAmount("auto")).toBe("memory auto");
		expect(formatMemoryAmount("readonly")).toBe("memory readonly");
	});

	it("keeps model and full path while they fit", () => {
		expect(statusBarSegments({ columns: 80, ...STATUS_BAR_INPUT })).toEqual([
			"openai/gpt-5.5",
			"~/Documents/backboard/Espri-API/q-cli",
		]);
	});

	it("shortens the path before dropping the model", () => {
		expect(statusBarSegments({ columns: 40, ...STATUS_BAR_INPUT })).toEqual([
			"openai/gpt-5.5",
			"~/.../q-cli",
		]);
	});

	it("falls back to the compact path on tight terminals", () => {
		expect(statusBarSegments({ columns: 24, ...STATUS_BAR_INPUT })).toEqual([
			"~/.../q-cli",
		]);
	});

	it("does not render unreadable path fragments when narrow", () => {
		expect(statusBarSegments({ columns: 16, ...STATUS_BAR_INPUT })).toEqual([
			"q-cli",
		]);
		expect(statusBarSegments({ columns: 12, ...STATUS_BAR_INPUT })).toEqual([]);
	});

	it("drops token and thinking details before model and path", () => {
		expect(
			statusBarSegments({
				columns: 60,
				...STATUS_BAR_INPUT,
				thinking: "high",
				memory: "memory auto",
				tokens: "12345 tokens",
			}),
		).toEqual(["openai/gpt-5.5", "high", "memory auto", "~/.../q-cli"]);
	});
});
