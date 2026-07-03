import { describe, expect, it } from "bun:test";
import { askUserOptionWindowStart } from "../src/ui/components/AskUserPrompt.tsx";

describe("AskUserPrompt", () => {
	it("keeps short option lists unscrolled", () => {
		expect(askUserOptionWindowStart(4, 5)).toBe(0);
	});

	it("scrolls long option lists to keep the selected option visible", () => {
		expect(askUserOptionWindowStart(0, 12)).toBe(0);
		expect(askUserOptionWindowStart(8, 12)).toBe(1);
		expect(askUserOptionWindowStart(11, 12)).toBe(4);
	});
});
