import { type ZodTypeAny, z } from "zod";

interface JsonSchemaProperty {
	type?: string | string[];
	description?: string;
	default?: unknown;
	nullable?: boolean;
	enum?: unknown[];
	const?: unknown;
	oneOf?: JsonSchemaProperty[];
	anyOf?: JsonSchemaProperty[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
}

/** Convert Backboard's JSON Schema tool parameters to the SDK's Zod raw shape. */
export function jsonSchemaToZodRawShape(
	inputSchema: Record<string, unknown> | undefined,
): Record<string, ZodTypeAny> {
	if (inputSchema?.type !== "object" || !isObject(inputSchema.properties)) {
		return {};
	}
	const required = new Set(
		Array.isArray(inputSchema.required)
			? inputSchema.required.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
	);
	const shape: Record<string, ZodTypeAny> = {};
	for (const [name, raw] of Object.entries(inputSchema.properties)) {
		let schema: ZodTypeAny;
		try {
			schema = jsonPropertyToZod(raw as JsonSchemaProperty);
		} catch {
			schema = z.unknown();
		}
		shape[name] = required.has(name) ? schema : schema.optional();
	}
	return shape;
}

function jsonPropertyToZod(property: JsonSchemaProperty): ZodTypeAny {
	if (!property || typeof property !== "object") return z.unknown();
	let schema: ZodTypeAny;
	if (property.const !== undefined) {
		schema = literalSchema(property.const);
	} else if (Array.isArray(property.enum) && property.enum.length > 0) {
		const variants = property.enum.map(literalSchema);
		schema =
			variants.length === 1
				? (variants[0] ?? z.unknown())
				: z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
	} else if (property.oneOf?.length) {
		schema = unionOf(property.oneOf);
	} else if (property.anyOf?.length) {
		schema = unionOf(property.anyOf);
	} else {
		const types = Array.isArray(property.type)
			? property.type
			: [property.type];
		const variants = types
			.filter(Boolean)
			.map((type) => typeSchema(String(type), property));
		schema =
			variants.length === 0
				? z.unknown()
				: variants.length === 1
					? (variants[0] ?? z.unknown())
					: z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
	}
	if (property.nullable) schema = schema.nullable();
	if (property.description) schema = schema.describe(property.description);
	if (property.default !== undefined)
		schema = schema.default(property.default as never);
	return schema;
}

function typeSchema(type: string, property: JsonSchemaProperty): ZodTypeAny {
	switch (type) {
		case "string": {
			let schema = z.string();
			if (typeof property.minLength === "number")
				schema = schema.min(property.minLength);
			if (typeof property.maxLength === "number")
				schema = schema.max(property.maxLength);
			return schema;
		}
		case "number":
		case "integer": {
			let schema = type === "integer" ? z.number().int() : z.number();
			if (typeof property.minimum === "number")
				schema = schema.min(property.minimum);
			if (typeof property.maximum === "number")
				schema = schema.max(property.maximum);
			if (typeof property.exclusiveMinimum === "number")
				schema = schema.gt(property.exclusiveMinimum);
			if (typeof property.exclusiveMaximum === "number")
				schema = schema.lt(property.exclusiveMaximum);
			return schema;
		}
		case "boolean":
			return z.boolean();
		case "array": {
			let schema = z.array(
				property.items ? jsonPropertyToZod(property.items) : z.unknown(),
			);
			if (typeof property.minItems === "number")
				schema = schema.min(property.minItems);
			if (typeof property.maxItems === "number")
				schema = schema.max(property.maxItems);
			return schema;
		}
		case "object": {
			const required = new Set(property.required ?? []);
			const shape: Record<string, ZodTypeAny> = {};
			for (const [name, raw] of Object.entries(property.properties ?? {})) {
				const child = jsonPropertyToZod(raw);
				shape[name] = required.has(name) ? child : child.optional();
			}
			return z.object(shape).passthrough();
		}
		case "null":
			return z.null();
		default:
			return z.unknown();
	}
}

function unionOf(properties: JsonSchemaProperty[]): ZodTypeAny {
	const variants = properties.map(jsonPropertyToZod);
	return variants.length === 1
		? (variants[0] ?? z.unknown())
		: z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function literalSchema(value: unknown): ZodTypeAny {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return z.literal(value);
	}
	if (value === null) return z.null();
	return z.unknown();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
