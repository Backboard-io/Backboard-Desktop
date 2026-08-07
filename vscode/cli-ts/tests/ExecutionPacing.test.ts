import { describe, expect, it } from "bun:test";
import {
	ExecutionPacing,
	IMPLEMENTATION_PROGRESS_HINT,
} from "../src/core/agent/ExecutionPacing.ts";
import type { ToolOutput } from "../src/core/tools/ToolScheduler.ts";

function output(id: string, name: string, text = "ok"): ToolOutput {
	return {
		tool_call_id: id,
		output: text,
		metadata: { name, readOnly: name === "read", error: false },
	};
}

describe("ExecutionPacing", () => {
	it("nudges implementation after two rounds without an edit", () => {
		const pacing = new ExecutionPacing();

		const first = pacing.prepareForSubmission([output("1", "read")]);
		const second = pacing.prepareForSubmission([output("2", "grep")]);

		expect(first[0]?.output).toBe("ok");
		expect(second[0]?.output).toContain(IMPLEMENTATION_PROGRESS_HINT);
	});

	it("adds the reminder once even when exploration continues", () => {
		const pacing = new ExecutionPacing();

		pacing.prepareForSubmission([output("1", "read")]);
		pacing.prepareForSubmission([output("2", "grep")]);
		const third = pacing.prepareForSubmission([output("3", "read")]);

		expect(third[0]?.output).toBe("ok");
	});

	it("does not nudge after implementation has started", () => {
		const pacing = new ExecutionPacing();

		pacing.prepareForSubmission([output("1", "read")]);
		const edit = pacing.prepareForSubmission([output("2", "apply_patch")]);
		const later = pacing.prepareForSubmission([output("3", "read")]);

		expect(edit[0]?.output).toBe("ok");
		expect(later[0]?.output).toBe("ok");
	});

	it("preserves batched outputs and annotates only the last result", () => {
		const pacing = new ExecutionPacing();

		pacing.prepareForSubmission([output("1", "read")]);
		const batch = pacing.prepareForSubmission([
			output("2", "read", "first"),
			output("3", "grep", "second"),
		]);

		expect(batch[0]?.output).toBe("first");
		expect(batch[1]?.output).toBe(`second\n\n${IMPLEMENTATION_PROGRESS_HINT}`);
	});
});
