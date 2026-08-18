import { describe, expect, it } from "bun:test";
import { AskUserTool } from "../src/tools/AskUserTool.tsx";

describe("AskUserTool", () => {
	it("normalizes labeled option objects and caps oversized option lists", () => {
		const input = new AskUserTool().parseInput({
			questions: [
				{
					header: "What to edit",
					question: "What do you want changed?",
					options: [
						{ id: "gameplay", label: "Gameplay" },
						{ id: "level", label: "Level layout" },
						{ id: "look", label: "Look and feel" },
						{ id: "features", label: "Add a feature" },
						{ id: "bugs", label: "Fix bugs" },
					],
				},
			],
		});

		expect(input.questions[0]?.options).toEqual([
			"Gameplay",
			"Level layout",
			"Look and feel",
			"Add a feature",
		]);
	});

	it("preserves valid string options", () => {
		const input = new AskUserTool().parseInput({
			questions: [
				{
					header: "Choice",
					question: "Pick one",
					options: ["First", "Second"],
				},
			],
		});

		expect(input.questions[0]?.options).toEqual(["First", "Second"]);
	});
});
