import type { ServeControl } from "./ServeTypes.ts";

const KNOWN_OPS = new Set<ServeControl["op"]>([
	"submit",
	"steer",
	"warmup",
	"cancel",
	"respondInput",
	"respondPermission",
	"setModel",
	"listModels",
	"listTools",
	"listSkills",
	"dispose",
]);

export type ParsedControlLine =
	| { ok: true; control: ServeControl }
	| { ok: false; error: string; requestId?: string };

/**
 * Parses one stdin control line into a `ServeControl`. Malformed lines return
 * a structured error instead of throwing so a bad host write can never crash
 * the serve process.
 */
export function parseControlLine(line: string): ParsedControlLine | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: "invalid control line: not JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "invalid control line: not an object" };
	}

	const record = value as Record<string, unknown>;
	const requestId =
		typeof record.requestId === "string" ? record.requestId : undefined;
	const op = record.op;
	if (typeof op !== "string" || !KNOWN_OPS.has(op as ServeControl["op"])) {
		return {
			ok: false,
			error: `invalid control line: unknown op ${JSON.stringify(op ?? null)}`,
			requestId,
		};
	}

	const missing = (field: string): ParsedControlLine => ({
		ok: false,
		error: `invalid ${op} op: missing ${field}`,
		requestId,
	});
	switch (op as ServeControl["op"]) {
		case "submit":
			if (typeof record.requestId !== "string") return missing("requestId");
			if (typeof record.prompt !== "string") return missing("prompt");
			break;
		case "steer":
			if (typeof record.prompt !== "string") return missing("prompt");
			break;
		case "respondInput":
			if (typeof record.id !== "string") return missing("id");
			if (typeof record.answer !== "string") return missing("answer");
			break;
		case "respondPermission":
			if (typeof record.id !== "string") return missing("id");
			if (record.decision !== "approve" && record.decision !== "deny") {
				return missing("decision");
			}
			break;
		case "setModel":
			if (typeof record.model !== "string") return missing("model");
			break;
		case "listModels":
		case "listTools":
		case "listSkills":
			if (typeof record.requestId !== "string") return missing("requestId");
			break;
		default:
			break;
	}

	return { ok: true, control: value as ServeControl };
}
