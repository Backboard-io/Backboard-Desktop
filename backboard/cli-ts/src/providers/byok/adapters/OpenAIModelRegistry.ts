/**
 * The OpenAI models this adapter can drive over Chat Completions with function
 * tools. It is an allowlist on purpose: the account's `/models` listing also
 * carries Responses-only ids (`-pro`, `-codex`, `-deep-research`), aliases
 * without tool support (`chatgpt-*`, `-chat-latest`), and non-chat endpoints
 * (realtime, audio, search, transcribe, computer-use). Offering one of those
 * and failing on the first request is worse than not offering it.
 */
export type OpenAIReasoningBehaviour =
	/** No reasoning controls: `reasoning_effort` is rejected. */
	| "none"
	/** Honours `reasoning_effort` alongside function tools. */
	| "effort"
	/**
	 * Reasoning must be switched off explicitly when function tools are present
	 * on Chat Completions (GPT-5.4 through GPT-5.6), so no level can be offered.
	 */
	| "disabled-with-tools";

export interface OpenAIModelSupport {
	/** Base id; dated snapshots (`gpt-4o-2024-08-06`) resolve to it. */
	readonly id: string;
	readonly reasoning: OpenAIReasoningBehaviour;
}

const GPT5_EFFORT_BASES = ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3"] as const;
const GPT5_DISABLED_TOOL_REASONING_BASES = [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6",
] as const;

function withSizes(
	bases: readonly string[],
	reasoning: OpenAIReasoningBehaviour,
): OpenAIModelSupport[] {
	return bases.flatMap((base) => [
		{ id: base, reasoning },
		{ id: `${base}-mini`, reasoning },
		{ id: `${base}-nano`, reasoning },
	]);
}

export const SUPPORTED_OPENAI_MODELS: readonly OpenAIModelSupport[] = [
	...withSizes(GPT5_EFFORT_BASES, "effort"),
	...withSizes(GPT5_DISABLED_TOOL_REASONING_BASES, "disabled-with-tools"),
	{ id: "gpt-4.1", reasoning: "none" },
	{ id: "gpt-4.1-mini", reasoning: "none" },
	{ id: "gpt-4.1-nano", reasoning: "none" },
	{ id: "gpt-4o", reasoning: "none" },
	{ id: "gpt-4o-mini", reasoning: "none" },
	{ id: "o3", reasoning: "effort" },
	{ id: "o3-mini", reasoning: "effort" },
	{ id: "o4-mini", reasoning: "effort" },
];

const SUPPORT_BY_ID = new Map(
	SUPPORTED_OPENAI_MODELS.map((entry) => [entry.id, entry] as const),
);

/** `gpt-4o-2024-08-06` and the older `gpt-4-0613` style both name a base id. */
const DATED_SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{4})$/;

/**
 * GPT-5.4 through GPT-5.6 reject enabled reasoning next to function tools on
 * Chat Completions unless it is explicitly disabled. This is a family rule,
 * not a catalog decision: it is answered for any id in the family so the
 * request builder never sends `reasoning_effort` to one of them.
 */
const DISABLED_TOOL_REASONING_FAMILY = /^gpt-5\.[456](?:$|-)/;

export function normalizeOpenAiModelId(id: string): string {
	return id.trim().toLowerCase();
}

/** The registry entry for an id or its dated snapshot; undefined when unsupported. */
export function openAiModelSupport(id: string): OpenAIModelSupport | undefined {
	const normalized = normalizeOpenAiModelId(id);
	return (
		SUPPORT_BY_ID.get(normalized) ??
		SUPPORT_BY_ID.get(normalized.replace(DATED_SNAPSHOT_SUFFIX, ""))
	);
}

export function isSupportedOpenAiModel(id: string): boolean {
	return openAiModelSupport(id) !== undefined;
}

export function requiresDisabledToolReasoning(model: string): boolean {
	return DISABLED_TOOL_REASONING_FAMILY.test(normalizeOpenAiModelId(model));
}

/**
 * What the picker may offer for reasoning. A model whose reasoning this adapter
 * has to force off with tools advertises no levels, so the UI never shows a
 * control the request ignores.
 */
export function openAiReasoningControls(id: string): {
	supports_thinking: boolean;
	supported_effort_levels: string[];
} {
	const reasoning = openAiModelSupport(id)?.reasoning === "effort";
	return {
		supports_thinking: reasoning,
		supported_effort_levels: reasoning ? ["low", "medium", "high"] : [],
	};
}

/** The one line a turn fails with when its selection is outside the registry. */
export function unsupportedOpenAiModelMessage(id: string): string {
	return `OpenAI model "${id.trim()}" is not available with an API key in Backboard: only Chat Completions models with function-tool support are offered. Pick another OpenAI API Key model.`;
}
