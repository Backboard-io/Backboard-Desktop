import { describe, expect, it } from "bun:test";
import { CompletionEvidenceTracker } from "../src/core/agent/CompletionEvidence.ts";
import { finalVerificationNotification } from "../src/core/agent/notifications/FinalVerificationNotification.ts";
import type { ToolOutputMetadata } from "../src/core/tools/ToolScheduler.ts";

function observe(
	tracker: CompletionEvidenceTracker,
	...metadata: ToolOutputMetadata[]
): void {
	tracker.observe(
		metadata.map((entry, index) => ({
			tool_call_id: `${index}`,
			output: "Error: example source text, exit code: 42",
			metadata: entry,
		})),
	);
}

function needsVerification(tracker: CompletionEvidenceTracker): boolean {
	return finalVerificationNotification(true).shouldFire({
		requestKind: "user",
		executedRounds: 100,
		executedToolCalls: 100,
		todos: [],
		completionEvidence: tracker.snapshot,
	});
}

describe("completion evidence", () => {
	it("does not verify read-only discovery, source error strings, failed writes, or plan updates", () => {
		const tracker = new CompletionEvidenceTracker();
		observe(
			tracker,
			{ name: "Grep", readOnly: true, error: false },
			{
				name: "Edit",
				readOnly: false,
				error: true,
				failureCategory: "permission",
			},
			{ name: "TodoWrite", readOnly: false, error: false },
			{ name: "todo_write", readOnly: false, error: false },
			{ name: "Execute", readOnly: false, error: false, mutated: false },
		);
		expect(needsVerification(tracker)).toBe(false);
	});

	it("requires a successful check after the latest mutation", () => {
		const tracker = new CompletionEvidenceTracker();
		observe(tracker, { name: "Edit", readOnly: false, error: false });
		expect(needsVerification(tracker)).toBe(true);
		observe(tracker, {
			name: "Execute",
			readOnly: true,
			error: true,
			validation: "failed",
		});
		expect(needsVerification(tracker)).toBe(true);
		observe(tracker, {
			name: "Execute",
			readOnly: true,
			error: false,
			validation: "passed",
		});
		expect(needsVerification(tracker)).toBe(false);
		observe(tracker, { name: "ApplyPatch", readOnly: false, error: false });
		expect(needsVerification(tracker)).toBe(true);
	});

	it("preserves validation order within a round and does not trust failed validation metadata", () => {
		const tracker = new CompletionEvidenceTracker();
		observe(
			tracker,
			{ name: "Execute", readOnly: true, error: false, validation: "passed" },
			{ name: "Write", readOnly: false, error: false },
			{ name: "Execute", readOnly: true, error: true, validation: "passed" },
		);
		expect(tracker.snapshot.unvalidatedMutations).toBe(1);
	});
});
