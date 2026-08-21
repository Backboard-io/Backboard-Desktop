import { describe, expect, it } from "bun:test";
import { translateMacAutomationError } from "../src/core/platform/MacPlatform.ts";

describe("translateMacAutomationError", () => {
	it("maps screencapture TCC denials to Screen Recording guidance", () => {
		expect(
			translateMacAutomationError(
				"screencapture exited with code 1: screencapture: could not create image from display 1",
			),
		).toContain("Screen Recording");
	});

	it("maps assistive-access and Apple-events denials to Accessibility guidance", () => {
		const denials = [
			"osascript exited with code 1: osascript is not allowed assistive access. (-25211)",
			'osascript exited with code 1: execution error: Not authorized to send Apple events to System Events. (-1743)',
		];
		for (const message of denials) {
			expect(translateMacAutomationError(message)).toContain("Accessibility");
		}
	});

	it("passes through unrelated errors", () => {
		expect(
			translateMacAutomationError("screencapture exited with code 1"),
		).toBeNull();
		expect(translateMacAutomationError("The operation was aborted.")).toBeNull();
	});
});
