import {
	formatBackboardMemoryMode,
	type MemoryMode,
	type MemoryProfile,
	type ThinkingConfig,
} from "../../config/defaults.ts";
import type {
	BackboardAudioFile,
	BackboardVoiceConfig,
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
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	voice?: BackboardVoiceConfig;
	audioFile?: BackboardAudioFile;
}

export function buildRunMessageRequest(
	content: string,
	context: RunMessageRequestContext,
	thinking?: ThinkingConfig | null,
): SendMessageRequest {
	return {
		content,
		thread_id: context.session.threadId ?? undefined,
		assistant_id: context.assistantId,
		llm_provider: context.model.provider,
		model_name: context.model.model,
		system_prompt: context.systemPrompt,
		memory: formatBackboardMemoryMode(context.memory),
		memory_profile: context.memoryProfile,
		...(thinking === undefined ? {} : { thinking }),
		tools: context.tools,
		...(context.voice ? { voice: context.voice } : {}),
		...(context.audioFile ? { audioFile: context.audioFile } : {}),
	};
}
