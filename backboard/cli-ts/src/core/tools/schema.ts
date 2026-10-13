import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/**
 * Converts a Zod object schema into the OpenAI function-calling shape Backboard
 * expects. The Responses API validates function parameters as JSON Schema,
 * not OpenAPI: in particular, exclusive numeric bounds must contain the bound
 * itself (`exclusiveMinimum: 0`) instead of OpenAPI 3's boolean modifier
 * (`exclusiveMinimum: true`, `minimum: 0`). Strips the `$schema`/`$ref`
 * wrapper so the `parameters` object is ready to send as-is.
 */
export function toOpenAITool(
	name: string,
	description: string,
	schema: z.ZodType,
): OpenAITool {
	const json = zodToJsonSchema(schema, {
		target: "jsonSchema7",
		$refStrategy: "none",
	}) as Record<string, unknown>;
	delete json.$schema;

	return {
		type: "function",
		function: { name, description, parameters: json },
	};
}
