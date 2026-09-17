import {
	formatBackboardMemoryMode,
	type MemoryMode,
	type MemoryProfile,
	type ThinkingConfig,
} from "../../config/defaults.ts";
import type {
	ModelSource,
	SendMessageRequest,
} from "../../providers/backboard/types.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";

export interface RunMessageRequestContext {
	session: Session;
	tools: OpenAITool[];
	systemPrompt: string;
	assistantId?: string;
	model: { provider: string; model: string };
	/**
	 * The billing route captured when the turn or worker started. Every request
	 * built for it carries the same value, so routing never has to guess.
	 */
	source?: ModelSource;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	/** Enables Backboard's built-in image generation for the turn. */
	imageGeneration?: boolean;
	/** Image model to use; falls back to the built-in default when omitted. */
	imageModel?: { provider: string; name: string };
	/** Enables Backboard's built-in video generation for the turn. */
	videoGeneration?: boolean;
	/**
	 * Video model to use. Video generation has no universal default model, so
	 * the turn only enables it when an explicit model was selected.
	 */
	videoModel?: { provider: string; name: string };
	/** Pins an OpenRouter upstream; undefined leaves routing automatic. */
	openRouterProvider?: string;
	/**
	 * Extra metadata merged into the request. The server persists it on the
	 * stored message and returns it on resume, so injected notifications tag
	 * themselves here (see INJECTED_NOTIFICATION_METADATA_KEY) to be prunable
	 * server-side and filterable on resume.
	 */
	metadata?: Record<string, unknown>;
}

export function buildRunMessageRequest(
	content: string,
	context: RunMessageRequestContext,
	thinking?: ThinkingConfig | null,
): SendMessageRequest {
	const metadata = {
		...(context.workspaceId
			? { backboard_workspace_id: context.workspaceId }
			: {}),
		...context.metadata,
	};
	return {
		content,
		thread_id: context.session.threadId ?? undefined,
		assistant_id: context.assistantId,
		llm_provider: context.model.provider,
		model_name: context.model.model,
		...(context.source === undefined ? {} : { source: context.source }),
		system_prompt: context.systemPrompt,
		memory: formatBackboardMemoryMode(context.memory),
		memory_profile: context.memoryProfile,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(thinking === undefined ? {} : { thinking }),
		...(context.model.provider === "openrouter" && context.openRouterProvider
			? {
					openrouter: {
						providers: [context.openRouterProvider],
						allow_fallbacks: false,
					},
				}
			: {}),
		...(context.imageGeneration
			? {
					image_generation: "auto",
					image_model_provider:
						context.imageModel?.provider ?? DEFAULT_IMAGE_MODEL_PROVIDER,
					image_model_name:
						context.imageModel?.name ?? DEFAULT_IMAGE_MODEL_NAME,
				}
			: {}),
		// Video generation is Backboard's built-in hosted tool: like
		// `image_generation: "auto"`, these fields activate the server-side
		// `generate_video` tool inside the run instead of a client function.
		// Declaring our own function with the same name makes the server run
		// the hosted one without this configuration, which fails the turn.
		...(context.videoGeneration && context.videoModel
			? {
					video_generation: "auto",
					video_model_provider: context.videoModel.provider,
					video_model_name: context.videoModel.name,
				}
			: {}),
		tools: context.tools,
	};
}

/**
 * Model used when image generation is on. Mirrors the retired Rust bridge's
 * defaults for the Backboard `image_generation: "auto"` path.
 */
const DEFAULT_IMAGE_MODEL_PROVIDER = "google";
const DEFAULT_IMAGE_MODEL_NAME = "gemini-3.1-flash-image";
