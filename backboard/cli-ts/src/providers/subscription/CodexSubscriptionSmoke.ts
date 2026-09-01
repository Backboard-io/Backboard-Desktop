import { randomUUID } from "node:crypto";
import { parseSseFrame, readSseFrames } from "../backboard/sse.ts";
import {
	buildSubscriptionHeaders,
	loadCodexSubscriptionCredentials,
} from "./SubscriptionAuth.ts";

export {
	buildSubscriptionHeaders,
	type CodexSubscriptionCredentials,
	loadCodexSubscriptionCredentials,
} from "./SubscriptionAuth.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CLIENT_VERSION = "3.0.2";

type JsonObject = Record<string, unknown>;

export interface CodexSubscriptionSmokeOptions {
	model?: string;
	prompt?: string;
	baseUrl?: string;
	authFile?: string;
	fetchImpl?: typeof fetch;
	onProgress?: (message: string) => void;
}

export interface CodexSubscriptionSmokeResult {
	model: string;
	toolCallId: string;
	toolArguments: JsonObject;
	toolOutput: JsonObject;
	assistantText: string;
}

interface StreamResult {
	outputItems: JsonObject[];
	text: string;
}

const PROBE_TOOL = {
	type: "function",
	name: "backboard_probe",
	description:
		"Calls a deterministic tool owned by the external Backboard smoke harness.",
	strict: true,
	parameters: {
		type: "object",
		properties: {
			message: {
				type: "string",
				description:
					"A short message proving that the model requested the tool.",
			},
		},
		required: ["message"],
		additionalProperties: false,
	},
} as const;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
	object: JsonObject,
	key: string,
	context: string,
): string {
	const value = object[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${context} is missing ${key}`);
	}
	return value;
}

export function buildResponsesRequest(
	model: string,
	input: JsonObject[],
	toolChoice: "auto" | "required",
	sessionId: string,
): JsonObject {
	return {
		model,
		instructions:
			"You are testing an external agent harness. Use the supplied tool when requested, then briefly report what the external harness returned.",
		input,
		tools: [PROBE_TOOL],
		tool_choice: toolChoice,
		parallel_tool_calls: false,
		reasoning: { effort: "low", summary: "auto" },
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: sessionId,
	};
}

export function parseModelsResponse(value: unknown): string[] {
	if (!isObject(value) || !Array.isArray(value.models)) {
		throw new Error("Codex models response did not contain a models array.");
	}

	return value.models
		.filter(isObject)
		.filter(
			(model) =>
				model.supported_in_api !== false && model.visibility !== "hide",
		)
		.sort((left, right) => {
			const leftPriority =
				typeof left.priority === "number"
					? left.priority
					: Number.MAX_SAFE_INTEGER;
			const rightPriority =
				typeof right.priority === "number"
					? right.priority
					: Number.MAX_SAFE_INTEGER;
			return leftPriority - rightPriority;
		})
		.map((model) => model.slug)
		.filter(
			(slug): slug is string => typeof slug === "string" && slug.length > 0,
		);
}

export function collectResponseEvent(
	value: unknown,
	result: StreamResult,
): void {
	if (!isObject(value)) return;
	if (value.type === "response.output_item.done" && isObject(value.item)) {
		result.outputItems.push(value.item);
	}
	if (
		value.type === "response.output_text.delta" &&
		typeof value.delta === "string"
	) {
		result.text += value.delta;
	}
}

async function readResponseStream(response: Response): Promise<StreamResult> {
	if (!response.ok) {
		const message = (await response.text()).slice(0, 2_000);
		throw new Error(
			`Codex endpoint returned HTTP ${response.status}: ${message}`,
		);
	}
	if (!response.body)
		throw new Error("Codex endpoint returned no response body.");

	const result: StreamResult = { outputItems: [], text: "" };
	for await (const frame of readSseFrames(response.body)) {
		const payload = parseSseFrame(frame);
		if (payload === "[DONE]") break;
		collectResponseEvent(payload, result);
	}
	return result;
}

function userMessage(text: string): JsonObject {
	return {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
	};
}

function findProbeCall(items: JsonObject[]): JsonObject {
	const call = items.find(
		(item) => item.type === "function_call" && item.name === PROBE_TOOL.name,
	);
	if (!call) {
		throw new Error("The model did not request the backboard_probe tool.");
	}
	return call;
}

function parseToolArguments(call: JsonObject): JsonObject {
	const encoded = requiredString(call, "arguments", "Function call");
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch (error) {
		throw new Error("Function call arguments were not valid JSON.", {
			cause: error,
		});
	}
	if (!isObject(parsed)) {
		throw new Error("Function call arguments were not a JSON object.");
	}
	return parsed;
}

async function fetchModels(
	baseUrl: string,
	headers: Headers,
	fetchImpl: typeof fetch,
): Promise<string[]> {
	const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
	url.searchParams.set("client_version", CLIENT_VERSION);
	const response = await fetchImpl(url, { headers });
	if (!response.ok) {
		throw new Error(`Codex models endpoint returned HTTP ${response.status}.`);
	}
	return parseModelsResponse(await response.json());
}

export async function runCodexSubscriptionSmoke(
	options: CodexSubscriptionSmokeOptions = {},
): Promise<CodexSubscriptionSmokeResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	const sessionId = randomUUID();
	const credentials = await loadCodexSubscriptionCredentials(options.authFile);
	const headers = buildSubscriptionHeaders(credentials, sessionId);
	const availableModels = await fetchModels(baseUrl, headers, fetchImpl);
	const model = options.model ?? availableModels[0];
	if (!model)
		throw new Error("No subscription-capable Codex model was returned.");
	if (options.model && !availableModels.includes(options.model)) {
		throw new Error(
			`Requested model ${options.model} is not available to this account.`,
		);
	}

	options.onProgress?.(`Using subscription model ${model}`);
	const prompt =
		options.prompt ??
		"Call backboard_probe once with the message 'subscription model reached Backboard harness'.";
	const initialInput = [userMessage(prompt)];
	const firstResponse = await fetchImpl(
		`${baseUrl.replace(/\/$/, "")}/responses`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(
				buildResponsesRequest(model, initialInput, "required", sessionId),
			),
		},
	);
	const first = await readResponseStream(firstResponse);
	const toolCall = findProbeCall(first.outputItems);
	const toolCallId = requiredString(toolCall, "call_id", "Function call");
	const toolArguments = parseToolArguments(toolCall);

	// This is the important boundary: the subscription model requested a tool,
	// but this local process (standing in for Backboard's scheduler) executes it.
	const toolOutput: JsonObject = {
		handledBy: "backboard-smoke-harness",
		received: toolArguments.message,
		proof: `local-tool-${sessionId.slice(0, 8)}`,
	};
	options.onProgress?.(
		"Backboard smoke harness executed backboard_probe locally",
	);

	const continuationInput = [
		...initialInput,
		...first.outputItems,
		{
			type: "function_call_output",
			call_id: toolCallId,
			output: JSON.stringify(toolOutput),
		},
	];
	const secondResponse = await fetchImpl(
		`${baseUrl.replace(/\/$/, "")}/responses`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(
				buildResponsesRequest(model, continuationInput, "auto", sessionId),
			),
		},
	);
	const second = await readResponseStream(secondResponse);

	return {
		model,
		toolCallId,
		toolArguments,
		toolOutput,
		assistantText: second.text.trim(),
	};
}
