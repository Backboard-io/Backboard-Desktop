/** Machine state belongs at the tool boundary, never inferred from tool prose. */
export type ToolFailureCategory =
	| "invalid_argument"
	| "unavailable"
	| "missing_path"
	| "permission"
	| "cancelled"
	| "timeout"
	| "execution"
	| "protocol"
	| "unknown";

export interface ToolExecutionMetadata {
	failureCategory?: ToolFailureCategory;
	exitCode?: number;
	timedOut?: boolean;
	cancelled?: boolean;
	retryable?: boolean;
	validation?: "passed" | "failed";
	mutated?: boolean;
	outcome?: "success" | "no_match" | "partial" | "failure";
}

const categories = new Set<ToolFailureCategory>([
	"invalid_argument",
	"unavailable",
	"missing_path",
	"permission",
	"cancelled",
	"timeout",
	"execution",
	"protocol",
	"unknown",
]);

export function toolFailureMetadata(error: unknown): ToolExecutionMetadata {
	const value =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const code = value.code;
	const category = categories.has(value.category as ToolFailureCategory)
		? (value.category as ToolFailureCategory)
		: code === "ENOENT"
			? "missing_path"
			: code === "EACCES" || code === "EPERM"
				? "permission"
				: value.name === "ZodError" || value.name === "SyntaxError"
					? "invalid_argument"
					: "unknown";
	return {
		failureCategory: category,
		...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
		...(value.timedOut === true ? { timedOut: true } : {}),
		...(value.cancelled === true ? { cancelled: true } : {}),
		retryable: value.retryable === true,
	};
}

/** Summarize schema issues without echoing submitted values or a full Zod dump. */
export function argumentErrorSummary(error: unknown): string {
	const issues = (
		error as { issues?: { path?: PropertyKey[]; message?: string }[] } | null
	)?.issues;
	if (Array.isArray(issues)) {
		return issues
			.slice(0, 3)
			.map(
				(issue) =>
					`${issue.path?.map(String).join(".") || "input"}: ${issue.message ?? "invalid value"}`,
			)
			.join("; ")
			.slice(0, 600);
	}
	return error instanceof SyntaxError
		? "Expected one valid JSON object."
		: "Arguments do not match the tool schema. Check required fields and value types.";
}

/** A successful check is evidence, not a blanket requirement to run all checks. */
export function isValidationCommand(input: unknown): boolean {
	const command = (input as { command?: unknown } | null)?.command;
	if (typeof command !== "string") return false;
	// Only unambiguous direct invocations. Compound commands may mutate after a check.
	if (/[\n;&|`<>]|\$\(/.test(command)) return false;
	return /^\s*(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck(?::[\w-]+)?|lint(?::[\w-]+)?)\b|^\s*(?:pytest|vitest|jest|tsc)\b|^\s*node\s+--test(?:\s|$)|^\s*(?:cargo|go)\s+test\b|^\s*python(?:3)?\s+-m\s+(?:pytest|unittest)\b)/.test(
		command,
	);
}

export function executionFailed(execution?: ToolExecutionMetadata): boolean {
	if (!execution) return false;
	return (
		execution.outcome === "failure" ||
		!!execution.failureCategory ||
		execution.timedOut === true ||
		execution.cancelled === true ||
		(typeof execution.exitCode === "number" &&
			execution.exitCode !== 0 &&
			execution.outcome === undefined)
	);
}
