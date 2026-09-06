import { canonicalToolName } from "../tools/names.ts";
import type { ToolOutput } from "../tools/ToolScheduler.ts";

/** Execution evidence, never inferred from arbitrary model or tool-output prose. */
export interface CompletionEvidence {
	successfulMutations: number;
	unvalidatedMutations: number;
	validationFailed: boolean;
}

/** Tracks changes and checks in execution order; a later change invalidates prior checks. */
export class CompletionEvidenceTracker {
	private state: CompletionEvidence = {
		successfulMutations: 0,
		unvalidatedMutations: 0,
		validationFailed: false,
	};

	get snapshot(): CompletionEvidence {
		return { ...this.state };
	}

	observe(outputs: readonly ToolOutput[]): void {
		for (const { metadata } of outputs) {
			if (!metadata) continue;
			if (metadata.validation === "failed") {
				this.state.validationFailed = true;
				continue;
			}
			if (metadata.error) continue;
			if (metadata.validation === "passed") {
				this.state.unvalidatedMutations = 0;
				this.state.validationFailed = false;
				continue;
			}
			if (
				metadata.readOnly ||
				metadata.mutated === false ||
				canonicalToolName(metadata.name) === "todo_write"
			)
				continue;
			this.state.successfulMutations++;
			this.state.unvalidatedMutations++;
		}
	}
}
