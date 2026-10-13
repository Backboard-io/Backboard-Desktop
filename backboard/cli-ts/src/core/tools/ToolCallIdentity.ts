import { createHash } from "node:crypto";
import { canonicalToolName } from "./names.ts";

/** JSON tool inputs with sorted object keys; array order and scalar types stay significant. */
export function canonicalToolInput(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite tool input");
		return Object.is(value, -0) ? "-0" : JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map(canonicalToolInput).join(",")}]`;
	if (
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalToolInput((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	throw new Error("Tool input is not a plain JSON value");
}

/** Compact diagnostics deliberately contain hashes, never argument values. */
export function toolInputFingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalToolInput(value)).digest("hex");
}

export interface ToolCallIdentity {
	sessionId: string;
	turnId?: string;
	roundId: string;
	attempt: number;
	name: string;
	input: string;
}

export function sameToolCallIdentity(
	left: ToolCallIdentity,
	right: ToolCallIdentity,
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.roundId === right.roundId &&
		left.attempt === right.attempt &&
		canonicalToolName(left.name) === canonicalToolName(right.name) &&
		left.input === right.input
	);
}
