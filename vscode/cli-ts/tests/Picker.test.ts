import { describe, expect, it } from "bun:test";
import {
	movePickerSelection,
	resetPickerSelection,
} from "../src/ui/components/Picker.tsx";

describe("Picker pagination", () => {
	it("moves through oversized tabs with repeated down arrows", () => {
		let selection = resetPickerSelection();
		for (let i = 0; i < 13; i++) {
			selection = movePickerSelection(selection, 25, "down");
		}

		expect(selection).toEqual({ itemIndex: 13, windowStart: 2 });
	});

	it("pages through oversized MCP catalog tabs", () => {
		let selection = resetPickerSelection();

		selection = movePickerSelection(selection, 25, "pageDown");
		expect(selection).toEqual({ itemIndex: 12, windowStart: 12 });

		selection = movePickerSelection(selection, 25, "pageDown");
		expect(selection).toEqual({ itemIndex: 24, windowStart: 13 });

		selection = movePickerSelection(selection, 25, "pageUp");
		expect(selection).toEqual({ itemIndex: 12, windowStart: 1 });
	});

	it("wraps while keeping the selected item visible", () => {
		expect(movePickerSelection(resetPickerSelection(), 25, "up")).toEqual({
			itemIndex: 24,
			windowStart: 13,
		});
	});
});
