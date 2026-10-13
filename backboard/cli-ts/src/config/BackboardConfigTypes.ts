import type { JsonObject } from "../utils/JsonTypes.ts";
import type { MemoryMode, MemoryProfile, ThinkingIntent } from "./defaults.ts";

export interface BackboardConfigFile {
	apiKey?: string;
	apiUrl?: string;
	/** Backboard-owned or explicitly imported ChatGPT subscription token file. */
	chatgptSubscriptionAuthFile?: string;
	/** Whether Claude Code subscription routing is enabled for this install. */
	claudeSubscriptionEnabled?: boolean;
	model?: {
		provider: string;
		model: string;
	};
	/** Most recently working models, newest first, used for capacity failover. */
	successfulModels?: Array<{
		provider: string;
		model: string;
	}>;
	thinking?: ThinkingIntent | null;
	memory?: MemoryMode;
	memoryProfile?: MemoryProfile;
	notify?: boolean;
	verbose?: boolean;
}

export interface LoadEnvOptions {
	homeDir?: string;
}

export type BackboardConfigJson = JsonObject;
