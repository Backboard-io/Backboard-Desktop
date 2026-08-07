import { canonicalToolName } from "../core/tools/names.ts";
import { ToolPolicy } from "../core/tools/ToolPolicy.ts";
import { readBackboardConfig, saveBackboardConfig } from "./backboardConfig.ts";
import {
	DEFAULTS,
	formatModel,
	type MemoryMode,
	type MemoryProfile,
	type ModelRef,
	type OutputFormat,
	parseExcludedTools,
	parseMemoryMode,
	parseMemoryProfile,
	parseModel,
	parseOutputFormat,
	parseThinking,
	type ThinkingIntent,
} from "./defaults.ts";
import { type BackboardEnv, loadEnv } from "./env.ts";
import { type CliFlags, parseFlags } from "./flags.ts";
import {
	type ModelProfile,
	resolveModelProfile,
} from "./modelProfiles/index.ts";
import {
	type HookConfigPaths,
	type McpConfigPaths,
	qProjectHookConfigPath,
	qProjectMcpConfigPath,
	qUserHookConfigPath,
	qUserMcpConfigPath,
} from "./paths.ts";
import { getProfile, type Profile } from "./profiles/index.ts";

export interface ConfigOptions {
	env?: BackboardEnv;
	argv?: string[];
	homeDir?: string;
}

/**
 * Central runtime configuration. Merges, in priority order:
 *   defaults  <  active profile  <  CLI flags.
 * Holds the live model selection, which `/model` mutates at runtime.
 */
export class Config {
	readonly env: BackboardEnv;
	readonly flags: CliFlags;
	readonly cwd: string;
	readonly profile: Profile;
	readonly mcpConfigPaths: McpConfigPaths;
	readonly hookConfigPaths: HookConfigPaths;
	private readonly homeDir: string | undefined;

	private currentModel: ModelRef;
	private currentModelProfile: ModelProfile;
	private readonly currentFormat: OutputFormat;
	private currentMemory: MemoryMode;
	private computerUseEnabled = false;
	private browserUseEnabled = false;
	private notifyEnabled = false;
	// Reserved for a future image-generation tool. The host can toggle this per
	// turn today; no tool consumes it yet, so it is inert until that lands.
	private imageGenerationEnabled = false;
	private readonly currentMemoryProfile: MemoryProfile;
	private currentThinking: ThinkingIntent | null | undefined;
	private readonly currentFinalVerificationNudge: boolean;
	private excludedToolNames: string[];
	private readonly persistedConfigHomeDir: string | undefined;

	constructor(options: ConfigOptions = {}) {
		this.flags = parseFlags(options.argv ?? process.argv.slice(2));
		this.homeDir = options.homeDir;
		this.env = options.env ?? loadEnv({ homeDir: options.homeDir });
		this.persistedConfigHomeDir = options.homeDir;
		const persistedConfig =
			options.homeDir !== undefined || options.env === undefined
				? readBackboardConfig(options.homeDir)
				: {};

		const profileName = this.flags.profile ?? DEFAULTS.profile;
		this.profile = getProfile(profileName);

		this.cwd = this.flags.cwd ?? process.cwd();
		this.mcpConfigPaths = {
			project: qProjectMcpConfigPath(this.cwd),
			user: qUserMcpConfigPath(),
		};
		this.hookConfigPaths = {
			project: qProjectHookConfigPath(this.cwd),
			user: qUserHookConfigPath(options.homeDir),
		};
		this.currentModel = this.flags.model
			? parseModel(this.flags.model)
			: (persistedConfig.model ?? this.profile.model);
		this.currentModelProfile = resolveModelProfile(this.currentModel);
		this.currentFormat = this.flags.format
			? parseOutputFormat(this.flags.format)
			: "default";
		this.currentMemory = this.flags.memory
			? parseMemoryMode(this.flags.memory)
			: (persistedConfig.memory ?? this.profile.memory);
		this.currentMemoryProfile = this.flags.memoryProfile
			? parseMemoryProfile(this.flags.memoryProfile)
			: (persistedConfig.memoryProfile ?? this.profile.memoryProfile);
		this.currentThinking =
			this.flags.thinking === undefined
				? persistedConfig.thinking
				: parseThinking(this.flags.thinking);
		this.currentFinalVerificationNudge =
			this.flags.finalVerification ?? DEFAULTS.finalVerificationNudge;
		this.notifyEnabled = persistedConfig.notify ?? false;
		this.excludedToolNames = parseExcludedTools(this.flags.excludedTools).map(
			canonicalToolName,
		);
	}

	get model(): ModelRef {
		return this.currentModel;
	}

	get modelString(): string {
		return formatModel(this.currentModel);
	}

	setModel(ref: ModelRef): void {
		this.currentModel = ref;
		this.currentModelProfile = resolveModelProfile(ref);
	}

	get modelProfile(): ModelProfile {
		return this.currentModelProfile;
	}

	get format(): OutputFormat {
		return this.currentFormat;
	}

	get memory(): MemoryMode {
		return this.currentMemory;
	}

	setMemory(mode: MemoryMode): void {
		this.currentMemory = mode;
	}

	get enabledTools(): string[] {
		return this.toolPolicy.enabledNames();
	}

	get excludedTools(): string[] {
		return this.excludedToolNames;
	}

	/** Replaces the runtime tool exclusion list, e.g. per serve-mode submit. */
	setExcludedTools(names: string[]): void {
		this.excludedToolNames = parseExcludedTools(names).map(canonicalToolName);
	}

	get toolSchemaExcludedNames(): string[] {
		return this.toolPolicy.schemaExcludedNames();
	}

	isToolEnabled(name: string): boolean {
		return this.toolPolicy.isRuntimeAllowed(name);
	}

	get toolPolicy(): ToolPolicy {
		return new ToolPolicy({
			profileTools: this.profile.tools,
			modelTools: this.currentModelProfile.tools,
			excludedTools: this.excludedToolNames,
			modelExcludedTools: this.currentModelProfile.excludedTools,
			computerUseEnabled: this.computerUseEnabled,
			browserUseEnabled: this.browserUseEnabled,
		});
	}

	enableComputerUse(): void {
		this.computerUseEnabled = true;
	}

	/** Toggles computer-use tools on or off, e.g. per serve-mode submit. */
	setComputerUse(enabled: boolean): void {
		this.computerUseEnabled = enabled;
	}

	get isComputerUseEnabled(): boolean {
		return this.computerUseEnabled;
	}

	enableBrowserUse(): void {
		this.browserUseEnabled = true;
	}

	/** Toggles the browser-use tool on or off, e.g. per serve-mode submit. */
	setBrowserUse(enabled: boolean): void {
		this.browserUseEnabled = enabled;
	}

	get isBrowserUseEnabled(): boolean {
		return this.browserUseEnabled;
	}

	get isNotifyEnabled(): boolean {
		return this.notifyEnabled;
	}

	setNotifyEnabled(enabled: boolean): void {
		this.notifyEnabled = enabled;
	}

	get isImageGenerationEnabled(): boolean {
		return this.imageGenerationEnabled;
	}

	/**
	 * Toggles image-generation intent for this session. Currently inert — no
	 * tool reads it yet — but wired end-to-end so a future image tool can honor
	 * it without additional host/protocol changes.
	 */
	setImageGeneration(enabled: boolean): void {
		this.imageGenerationEnabled = enabled;
	}

	get memoryProfile(): MemoryProfile {
		return this.currentMemoryProfile;
	}

	get thinking(): ThinkingIntent | null | undefined {
		return this.currentThinking;
	}

	get thinkingIntent(): ThinkingIntent | null | undefined {
		return this.currentThinking;
	}

	get finalVerificationNudge(): boolean {
		return this.currentFinalVerificationNudge;
	}

	get fresh(): boolean {
		return this.flags.fresh ?? false;
	}

	setThinking(thinking: ThinkingIntent | null | undefined): void {
		this.currentThinking = thinking;
	}

	setExcludeReasoning(excludeReasoning: boolean): void {
		if (this.currentThinking) {
			this.currentThinking = { ...this.currentThinking, excludeReasoning };
		}
	}

	async saveRuntimeSelection(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				...(this.flags.model === undefined ? { model: this.currentModel } : {}),
				...(this.flags.thinking === undefined
					? { thinking: this.currentThinking }
					: {}),
				...(this.flags.memory === undefined
					? { memory: this.currentMemory }
					: {}),
				...(this.flags.memoryProfile === undefined
					? { memoryProfile: this.currentMemoryProfile }
					: {}),
			},
			this.persistedConfigHomeDir,
		);
	}

	async saveNotifyPreference(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				notify: this.notifyEnabled,
			},
			this.persistedConfigHomeDir,
		);
	}

	reloadEnv(): void {
		const next = loadEnv({ homeDir: this.homeDir });
		this.env.apiKey = next.apiKey;
		this.env.apiUrl = next.apiUrl;
	}
}
