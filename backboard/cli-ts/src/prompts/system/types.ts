import type { SystemPromptLayout } from "../../config/modelProfiles/index.ts";
import type { SkillCatalog } from "../../core/skills/SkillCatalog.ts";
import type { PromptProfileId } from "../profiles/ids.ts";

export interface SystemPromptOptions {
	layout?: SystemPromptLayout;
	computerUseEnabled?: boolean;
	browserUseEnabled?: boolean;
	/** True when the connected IDE contributed client tools this turn. */
	clientToolsEnabled?: boolean;
	skillDiscoveryEnabled?: boolean;
	skillCatalog?: SkillCatalog;
	activatedSkillsPrompt?: string;
	hookContext?: string;
	/** Reminder segment shown until the session's first TodoWrite call. */
	todoReminderPrompt?: string;
	/** Which built-in image/video tools the composer enabled, and their models. */
	mediaGenerationPrompt?: string;
	startupEnvironmentPrompt?: string;
	/** Authoritative prior turns when the current provider thread is a branch. */
	conversationContext?: string;
	enabledTools?: readonly string[];
	/** Selects which prompt profile builds the prompt. Defaults to `default`. */
	profile?: PromptProfileId;
}
