import type {
	MemoryProfile,
	ThinkingConfig,
	ThinkingModelMetadata,
} from "../../config/defaults.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import type { BACKBOARD_STREAM_EVENTS } from "./constants.ts";

export type BackboardStatus =
	| "IN_PROGRESS"
	| "REQUIRES_ACTION"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

export interface RawToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface BackboardStreamBase {
	[key: string]: unknown;
	type: string;
	thread_id?: string;
	run_id?: string;
}

export interface BackboardUserMessagePayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.userMessage;
}

export interface BackboardContentStreamingPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.contentStreaming;
	content?: string;
	accumulated_content?: string;
}

export interface BackboardToolSubmitRequiredPayload
	extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.toolSubmitRequired;
	tool_calls?: unknown[];
}

export interface BackboardRunEndedPayload extends BackboardStreamBase {
	type:
		| typeof BACKBOARD_STREAM_EVENTS.runEnded
		| typeof BACKBOARD_STREAM_EVENTS.messageComplete;
	status?: string;
	content?: string;
	final_content?: string;
	model_provider?: string;
	model_name?: string;
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	context_usage?: BackboardContextUsage;
}

export interface BackboardContextUsage {
	used_tokens?: number;
	context_limit?: number;
	percent?: number;
	summary_tokens?: number;
	model?: string;
}

export interface BackboardRunFailedPayload extends BackboardStreamBase {
	type:
		| typeof BACKBOARD_STREAM_EVENTS.runFailed
		| typeof BACKBOARD_STREAM_EVENTS.error;
	error?: string;
	message?: string;
}

export interface BackboardRunCancelledPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.runCancelled;
}

export type BackboardStreamPayload =
	| BackboardUserMessagePayload
	| BackboardContentStreamingPayload
	| BackboardToolSubmitRequiredPayload
	| BackboardRunEndedPayload
	| BackboardRunFailedPayload
	| BackboardRunCancelledPayload
	| BackboardStreamBase;

export interface SendMessageRequest {
	content: string;
	thread_id?: string;
	assistant_id?: string;
	llm_provider?: string;
	model_name?: string;
	system_prompt?: string;
	memory?: string;
	memory_profile?: MemoryProfile;
	thinking?: ThinkingConfig | null;
	tools?: OpenAITool[];
	stream?: boolean;
	voice?: BackboardVoiceConfig;
	audioFile?: BackboardAudioFile;
}

export interface BackboardVoiceConfig {
	stt?: {
		provider: string;
		model: string;
		language?: string;
		provider_options?: Record<string, unknown>;
	};
	tts?: {
		provider: string;
		model: string;
		voice?: string;
		output_format?: string;
		provider_options?: Record<string, unknown>;
	};
}

/** Audio transported over the NDJSON host bridge before becoming multipart. */
export interface BackboardAudioFile {
	fileName: string;
	mimeType: string;
	dataBase64: string;
}

export interface BackboardVoiceRecord {
	stt?: Record<string, unknown> | null;
	tts?: Record<string, unknown> | null;
}

export interface SubmitToolOutputsRequest {
	thread_id: string;
	run_id?: string;
	tool_outputs: Array<{ tool_call_id: string; output: string }>;
	thinking?: ThinkingConfig | null;
	tools?: OpenAITool[];
	stream?: boolean;
}

export interface BackboardResponse {
	thread_id: string;
	content: string | null;
	status: BackboardStatus | null;
	tool_calls: RawToolCall[] | null;
	run_id?: string | null;
	model_provider?: string | null;
	model_name?: string | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	total_tokens?: number | null;
}

/**
 * Provider-neutral turn events. Backboard can yield these from either one JSON
 * response or many SSE payloads without changing the agent loop contract.
 */
/**
 * Coarse, provider-neutral phase of the current turn, derived from the
 * backend's pre-content pipeline frames. `preparing` covers server-side
 * request handling and run setup; `generating` means the model has been
 * engaged and the first token is imminent. Consumed by the host to render a
 * live status line while nothing else is streaming yet.
 */
export type TurnStatusPhase = "preparing" | "generating";

export type ProviderEvent =
	| { kind: "thread"; threadId: string }
	| { kind: "status"; phase: TurnStatusPhase }
	| { kind: "assistant_delta"; text: string }
	| { kind: "reasoning_delta"; text: string }
	| { kind: "voice"; records: BackboardVoiceRecord[] }
	| { kind: "requires_action"; runId: string | null; calls: ProviderToolCall[] }
	| { kind: "usage"; usage: ProviderUsage }
	| {
			kind: "completed";
			finalText?: string;
			usage?: ProviderUsage;
			contextUsage?: BackboardContextUsage;
	  }
	| { kind: "failed"; error: string; retryable?: boolean };

export interface StreamMappingResult {
	events: ProviderEvent[];
	accumulatedContent: string;
	accumulatedReasoning: string;
	lastContentChunk: string;
	lastReasoningChunk: string;
}

export interface ContentDeltaResult {
	text: string | null;
	accumulatedContent: string;
	/** Raw `content` field of this frame, kept for segment-cumulative recovery. */
	lastChunk: string;
}

export interface ProviderToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface ProviderUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	provider?: string;
	model?: string;
}

export interface ModelInfo extends ThinkingModelMetadata {
	id: string;
	provider: string;
	model: string;
	label: string;
	releaseTimestamp?: number;
}

export interface ModelCatalogItem {
	name: string;
	provider: string;
	model_type: string;
	last_updated?: string | number | null;
	max_output_tokens?: number | null;
	supports_thinking?: boolean | null;
	thinking_controls?: ThinkingModelMetadata["thinking_controls"];
}

export type ModelThinkingMetadataResponse = ThinkingModelMetadata;

export interface ModelsListResponse {
	models: ModelCatalogItem[];
	total: number;
}

export interface ProvidersListResponse {
	providers: string[];
	total: number;
}

export interface AssistantInfo {
	assistant_id: string;
	name: string;
	system_prompt?: string | null;
	tools?: unknown[] | null;
}
