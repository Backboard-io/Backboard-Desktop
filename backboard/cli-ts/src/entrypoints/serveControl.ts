import { isByokProviderId } from "../core/keys/ProviderKeyTypes.ts";
import type { ServeControl } from "./ServeTypes.ts";

const KNOWN_OPS = new Set<ServeControl["op"]>([
	"submit",
	"steer",
	"warmup",
	"waitForIdle",
	"cancel",
	"respondInput",
	"clientToolResult",
	"setModel",
	"setMcpServers",
	"setCredentials",
	"listModels",
	"listImageModels",
	"listVideoModels",
	"listTools",
	"listSkills",
	"archiveWorkers",
	"unarchiveWorkers",
	"deleteWorkers",
	"dispose",
	"prepareRewind",
	"commitRewind",
	"recoverRewind",
]);

export type ParsedControlLine =
	| { ok: true; control: ServeControl }
	| { ok: false; error: string; requestId?: string };

/** Parse a host line without allowing malformed input to crash the CLI. */
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
	// Errors name the field only. A credential line that fails validation must
	// never have its values echoed back onto stdout.
	const validSource = (value: unknown): boolean =>
		value === undefined ||
		value === "backboard" ||
		value === "byok" ||
		value === "subscription";
	switch (op as ServeControl["op"]) {
		case "prepareRewind":
		case "commitRewind":
		case "recoverRewind":
			if (!requestId) return missing("requestId");
			if (
				typeof record.transactionId !== "string" ||
				!/^[A-Za-z0-9-]+$/.test(record.transactionId)
			)
				return missing("transactionId");
			if (
				op === "prepareRewind" &&
				(!Array.isArray(record.turnIds) ||
					record.turnIds.some((id) => typeof id !== "string"))
			)
				return missing("turnIds");
			if (
				op === "prepareRewind" &&
				record.baseCheckpointId !== undefined &&
				typeof record.baseCheckpointId !== "string"
			)
				return missing("baseCheckpointId");
			if (
				op === "commitRewind" &&
				(!Array.isArray(record.buffers) ||
					record.buffers.some(
						(buffer) =>
							!buffer ||
							typeof buffer.path !== "string" ||
							typeof buffer.content !== "string" ||
							(buffer.encoding !== undefined &&
								typeof buffer.encoding !== "string"),
					))
			)
				return missing("buffers");
			break;
		case "submit":
			if (record.turnId !== undefined && typeof record.turnId !== "string")
				return missing("turnId");
			if (typeof record.requestId !== "string") return missing("requestId");
			if (typeof record.prompt !== "string") return missing("prompt");
			if (
				record.forkContext !== undefined &&
				typeof record.forkContext !== "string"
			) {
				return missing("forkContext");
			}
			if (
				record.systemContext !== undefined &&
				typeof record.systemContext !== "string"
			) {
				return missing("systemContext");
			}
			if (!validSource(record.source)) return missing("source");
			break;
		case "steer":
			if (typeof record.prompt !== "string") return missing("prompt");
			if (
				record.systemContext !== undefined &&
				typeof record.systemContext !== "string"
			) {
				return missing("systemContext");
			}
			break;
		case "respondInput":
			if (typeof record.id !== "string") return missing("id");
			if (
				!Array.isArray(record.answers) ||
				record.answers.some((answer) => typeof answer !== "string")
			) {
				return missing("answers");
			}
			break;
		case "clientToolResult":
			if (typeof record.id !== "string") return missing("id");
			break;
		case "setModel":
			if (typeof record.model !== "string") return missing("model");
			if (!validSource(record.source)) return missing("source");
			break;
		case "setCredentials":
			if (
				typeof record.revision !== "number" ||
				!Number.isInteger(record.revision) ||
				record.revision < 0
			) {
				return missing("revision");
			}
			if (
				!Array.isArray(record.providerKeys) ||
				record.providerKeys.some(
					(entry) =>
						typeof entry !== "object" ||
						entry === null ||
						typeof entry.provider !== "string" ||
						!isByokProviderId(entry.provider) ||
						typeof entry.key !== "string" ||
						entry.key.trim().length === 0,
				)
			) {
				return missing("providerKeys");
			}
			break;
		case "setMcpServers":
			if (
				typeof record.servers !== "object" ||
				record.servers === null ||
				Array.isArray(record.servers)
			)
				return missing("servers");
			if (
				record.force !== undefined &&
				(!Array.isArray(record.force) ||
					record.force.some((name) => typeof name !== "string"))
			)
				return missing("force");
			break;
		case "listModels":
		case "waitForIdle":
		case "listImageModels":
		case "listVideoModels":
		case "listTools":
		case "listSkills":
		case "archiveWorkers":
		case "unarchiveWorkers":
		case "deleteWorkers":
			if (typeof record.requestId !== "string") return missing("requestId");
			break;
		default:
			break;
	}

	return { ok: true, control: value as ServeControl };
}
