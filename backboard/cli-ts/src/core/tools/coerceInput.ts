import { z } from "zod";

/**
 * Models (notably OpenRouter-routed ones) routinely quote boolean and number
 * tool arguments, e.g. `{"ignore_case": "true"}` or `{"limit": "2400"}`.
 * Strict Zod schemas reject those with `invalid_type`, failing the whole call
 * even though the intent is unambiguous. Coerce string values only for fields
 * whose schema is boolean/number before validation; everything else passes
 * through untouched so genuinely invalid input still fails validation.
 */
export function coerceScalarStrings(
	schema: z.ZodTypeAny,
	raw: unknown,
): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const shape = objectShape(schema);
	if (!shape) return raw;
	const record = raw as Record<string, unknown>;
	let coerced: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string") continue;
		const kind = scalarKind(shape[key]);
		const next =
			kind === "boolean"
				? coerceBoolean(value)
				: kind === "number"
					? coerceNumber(value)
					: undefined;
		if (next === undefined) continue;
		coerced ??= { ...record };
		coerced[key] = next;
	}
	return coerced ?? raw;
}

function objectShape(
	schema: z.ZodTypeAny,
): Record<string, z.ZodTypeAny> | undefined {
	// Object-level refinements (e.g. Glob's required pattern choice) preserve
	// the field schema and must receive the same scalar repair as plain objects.
	if (schema instanceof z.ZodEffects) return objectShape(schema.innerType());
	return schema instanceof z.ZodObject ? schema.shape : undefined;
}

/** Unwrap optional/nullable/default wrappers to find a bare boolean/number. */
function scalarKind(
	schema: z.ZodTypeAny | undefined,
): "boolean" | "number" | undefined {
	let current = schema;
	while (current) {
		if (current instanceof z.ZodBoolean) return "boolean";
		if (current instanceof z.ZodNumber) return "number";
		if (
			current instanceof z.ZodOptional ||
			current instanceof z.ZodNullable ||
			current instanceof z.ZodDefault
		) {
			current = current._def.innerType;
			continue;
		}
		return undefined;
	}
	return undefined;
}

function coerceBoolean(value: string): boolean | undefined {
	const lowered = value.trim().toLowerCase();
	if (lowered === "true") return true;
	if (lowered === "false") return false;
	return undefined;
}

const NUMBER_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function coerceNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (!NUMBER_PATTERN.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}
