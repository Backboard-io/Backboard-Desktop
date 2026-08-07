import type { ToolOutput } from "../tools/ToolScheduler.ts";

const IMPLEMENTATION_TOOL_NAMES = new Set([
	"apply_patch",
	"create",
	"edit",
	"notebook_edit",
	"write",
]);

export const IMPLEMENTATION_PROGRESS_ROUND_THRESHOLD = 2;

export const IMPLEMENTATION_PROGRESS_HINT = `<system-reminder>
Progress check: if this request requires code changes and the evidence gathered so far is sufficient, begin implementation now. Batch independent discovery calls and related edits when safe. Continue investigating only when a specific unresolved question could change the correct implementation.
</system-reminder>`;

/**
 * Keeps productive investigation from turning into open-ended exploration.
 * The reminder is advisory rather than a hard limit: difficult tasks can keep
 * investigating, while straightforward implementation work is nudged toward
 * an edit after two model/tool round-trips.
 */
export class ExecutionPacing {
	private roundsWithoutImplementation = 0;
	private reminderSent = false;

	prepareForSubmission(outputs: ToolOutput[]): ToolOutput[] {
		if (outputs.length === 0 || this.reminderSent) return outputs;

		if (outputs.some((output) => isImplementationTool(output.metadata?.name))) {
			this.reminderSent = true;
			return outputs;
		}

		this.roundsWithoutImplementation++;
		if (
			this.roundsWithoutImplementation < IMPLEMENTATION_PROGRESS_ROUND_THRESHOLD
		) {
			return outputs;
		}

		this.reminderSent = true;
		const lastIndex = outputs.length - 1;
		return outputs.map((output, index) =>
			index === lastIndex
				? {
						...output,
						output: `${output.output}\n\n${IMPLEMENTATION_PROGRESS_HINT}`,
					}
				: output,
		);
	}
}

function isImplementationTool(name: string | undefined): boolean {
	return (
		name !== undefined && IMPLEMENTATION_TOOL_NAMES.has(name.toLowerCase())
	);
}
