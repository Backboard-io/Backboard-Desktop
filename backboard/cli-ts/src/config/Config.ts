import type {
	ByokProviderId,
	ResolvedProviderKey,
} from "../core/keys/ProviderKeyTypes.ts";
import { canonicalToolName } from "../core/tools/names.ts";
import { ToolPolicy } from "../core/tools/ToolPolicy.ts";
import type { ModelSource } from "../providers/backboard/types.ts";
import {
	CredentialChangedError,
	type ProviderCredential,
} from "../providers/byok/ProviderCredential.ts";
import {
	type AuthState,
	hasAnyCredentials,
	hostManagedProviderKeys,
	NO_CREDENTIALS_MESSAGE,
	resolveAuth,
} from "./auth.ts";
import { readBackboardConfig, saveBackboardConfig } from "./backboardConfig.ts";
import {
	DEFAULTS,
	formatModel,
	keyOnlyDefaultModel,
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
import { type BackboardEnv, resolveApiUrl } from "./env.ts";
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
	qProjectWorkspaceId,
	qUserHookConfigPath,
	qUserMcpConfigPath,
} from "./paths.ts";
import { getProfile, type Profile } from "./profiles/index.ts";

export interface ConfigOptions {
	env?: BackboardEnv;
	argv?: string[];
	homeDir?: string;
}

/** Placeholder env used when the run authenticates with provider keys only. */
function anonymousEnv(): BackboardEnv {
	return { apiKey: "", apiUrl: resolveApiUrl() };
}

/**
 * Central runtime configuration. Merges, in priority order:
 *   defaults  <  active profile  <  CLI flags.
 * Holds the live model selection, which `/model` mutates at runtime.
 */
export class Config {
	readonly env: BackboardEnv;
	/** Credentials this run may use: a Backboard sign-in, provider keys, or both. */
	auth: AuthState;
	readonly flags: CliFlags;
	readonly cwd: string;
	readonly profile: Profile;
	readonly mcpConfigPaths: McpConfigPaths;
	readonly hookConfigPaths: HookConfigPaths;
	private readonly homeDir: string | undefined;
	private workspaceId: string | null = null;

	private currentModel: ModelRef;
	/** Explicit billing route for the live model; only set by a host-managed runtime. */
	private currentModelSource: ModelSource | undefined;
	/** Keys pushed by the IDE host; they replace file keys on every auth refresh. */
	private readonly credentialGenerations = new Map<ByokProviderId, number>();
	private hostProviderKeys: ResolvedProviderKey[] | null = null;
	private successfulModelRefs: ModelRef[];
	private currentModelProfile: ModelProfile;
	private readonly currentFormat: OutputFormat;
	private currentMemory: MemoryMode;
	private computerUseEnabled = false;
	private browserUseEnabled = false;
	private skillDiscoveryEnabled = false;
	private notifyEnabled = false;
	private imageGenerationEnabled = false;
	private openRouterProvider: string | undefined;
	private verboseEnabled = true;
	private readonly currentMemoryProfile: MemoryProfile;
	private currentThinking: ThinkingIntent | null | undefined;
	private readonly currentFinalVerificationNudge: boolean;
	private excludedToolNames: string[];
	private readonly persistedConfigHomeDir: string | undefined;
	private readonly recoveryPersistenceEnabled: boolean;

	constructor(options: ConfigOptions = {}) {
		this.flags = parseFlags(options.argv ?? process.argv.slice(2));
		this.homeDir = options.homeDir;
		this.auth = resolveAuth(
			options.homeDir === undefined ? {} : { homeDir: options.homeDir },
		);
		if (options.env) {
			// An injected env is an explicit Backboard credential (tests, evals).
			this.auth = { ...this.auth, backboard: options.env };
		} else if (!hasAnyCredentials(this.auth)) {
			throw new Error(NO_CREDENTIALS_MESSAGE);
		}
		this.env = this.auth.backboard ?? anonymousEnv();
		this.persistedConfigHomeDir = options.homeDir;
		this.recoveryPersistenceEnabled =
			options.homeDir !== undefined || options.env === undefined;
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
		const keyOnlyDefault =
			this.auth.backboard === null && persistedConfig.model === undefined
				? keyOnlyDefaultModel(this.auth.providerKeys[0]?.provider)
				: null;
		const subscriptionOnlyDefault =
			this.auth.backboard === null &&
			this.auth.providerKeys.length === 0 &&
			this.auth.chatgptSubscription !== null &&
			persistedConfig.model === undefined
				? { provider: "openai-subscription", model: "auto" }
				: null;
		const claudeSubscriptionOnlyDefault =
			this.auth.backboard === null &&
			this.auth.providerKeys.length === 0 &&
			this.auth.chatgptSubscription === null &&
			this.auth.claudeSubscription !== null &&
			persistedConfig.model === undefined
				? { provider: "anthropic-subscription", model: "default" }
				: null;
		this.currentModel = this.flags.model
			? parseModel(this.flags.model)
			: (persistedConfig.model ??
				subscriptionOnlyDefault ??
				claudeSubscriptionOnlyDefault ??
				keyOnlyDefault ??
				this.profile.model);
		this.successfulModelRefs = persistedConfig.successfulModels ?? [];
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
		this.verboseEnabled = persistedConfig.verbose ?? true;
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

	/**
	 * Selects the live model. `source` is the explicit billing route a host-managed
	 * runtime attaches to every selection; omitting it clears the route, so a
	 * recovery fallback never inherits a key-billed source it did not ask for.
	 */
	setModel(ref: ModelRef, source?: ModelSource): void {
		this.currentModel = ref;
		this.currentModelSource = source;
		this.currentModelProfile = resolveModelProfile(ref);
	}

	/** The explicit billing route for the live model, if the host attached one. */
	get modelSource(): ModelSource | undefined {
		return this.currentModelSource;
	}

	/** True when provider keys come only from the IDE host (BACKBOARD_HOST_MANAGED_KEYS). */
	get hostManagedProviderKeys(): boolean {
		return hostManagedProviderKeys();
	}

	/**
	 * Replaces the provider keys with the host's snapshot. The snapshot is the
	 * whole set, so an absent provider is a removal. Read at request time by the
	 * BYOK client and the router, so no client is rebuilt.
	 */
	setHostProviderKeys(keys: readonly ResolvedProviderKey[]): void {
		this.updateCredentialGenerations(keys);
		this.hostProviderKeys = keys.map((entry) => ({ ...entry }));
		this.auth = { ...this.auth, providerKeys: this.hostProviderKeys };
	}

	/** Captures a lease, invalidated synchronously by every key mutation. */
	providerCredential(provider: ByokProviderId): ProviderCredential | null {
		const key = this.auth.providerKeys.find(
			(entry) => entry.provider === provider,
		)?.key;
		if (!key) return null;
		const generation = this.credentialGenerations.get(provider) ?? 0;
		return {
			key,
			generation,
			assertCurrent: () => {
				if (
					(this.credentialGenerations.get(provider) ?? 0) !== generation ||
					this.auth.providerKeys.find((entry) => entry.provider === provider)
						?.key !== key
				) {
					throw new CredentialChangedError(provider);
				}
			},
		};
	}

	private updateCredentialGenerations(
		keys: readonly ResolvedProviderKey[],
	): void {
		const providers = new Set(
			[...this.auth.providerKeys, ...keys].map((entry) => entry.provider),
		);
		for (const provider of providers) {
			if (
				this.auth.providerKeys.find((entry) => entry.provider === provider)
					?.key !== keys.find((entry) => entry.provider === provider)?.key
			) {
				this.credentialGenerations.set(
					provider,
					(this.credentialGenerations.get(provider) ?? 0) + 1,
				);
			}
		}
	}

	/** Working models, newest first, for automatic recovery from provider capacity. */
	get successfulModels(): ModelRef[] {
		return this.successfulModelRefs.map((model) => ({ ...model }));
	}

	async recordSuccessfulModel(ref: ModelRef): Promise<void> {
		const key = formatModel(ref).toLowerCase();
		if (
			this.successfulModelRefs[0] &&
			formatModel(this.successfulModelRefs[0]).toLowerCase() === key
		) {
			return;
		}
		this.successfulModelRefs = [
			{ ...ref },
			...this.successfulModelRefs.filter(
				(model) => formatModel(model).toLowerCase() !== key,
			),
		].slice(0, 10);
		if (!this.recoveryPersistenceEnabled) return;
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{ ...existing, successfulModels: this.successfulModelRefs },
			this.persistedConfigHomeDir,
		);
	}

	async saveRecoverySelection(): Promise<void> {
		if (!this.recoveryPersistenceEnabled) return;
		await this.saveRuntimeSelection();
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
		return [...this.excludedToolNames];
	}

	/** Replace the per-turn exclusions supplied by Backboard Studio. */
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
			skillDiscoveryEnabled: this.skillDiscoveryEnabled,
		});
	}

	enableComputerUse(): void {
		this.computerUseEnabled = true;
	}

	setComputerUseEnabled(enabled: boolean): void {
		this.computerUseEnabled = enabled;
	}

	get isComputerUseEnabled(): boolean {
		return this.computerUseEnabled;
	}

	setSkillDiscoveryEnabled(enabled: boolean): void {
		this.skillDiscoveryEnabled = enabled;
	}

	get isSkillDiscoveryEnabled(): boolean {
		return this.skillDiscoveryEnabled;
	}

	enableBrowserUse(): void {
		this.browserUseEnabled = true;
	}

	setBrowserUseEnabled(enabled: boolean): void {
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

	setImageGenerationEnabled(enabled: boolean): void {
		this.imageGenerationEnabled = enabled;
	}

	get selectedOpenRouterProvider(): string | undefined {
		return this.openRouterProvider;
	}

	setOpenRouterProvider(provider: string | undefined): void {
		const normalized = provider?.trim();
		this.openRouterProvider =
			normalized && normalized.toLowerCase() !== "auto"
				? normalized
				: undefined;
	}

	get isVerbose(): boolean {
		return this.verboseEnabled;
	}

	setVerbose(enabled: boolean): void {
		this.verboseEnabled = enabled;
	}

	get memoryProfile(): MemoryProfile {
		return this.currentMemoryProfile;
	}

	getWorkspaceId(): string {
		this.workspaceId ??= qProjectWorkspaceId(this.cwd);
		return this.workspaceId;
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

	async saveVerbosePreference(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				verbose: this.verboseEnabled,
			},
			this.persistedConfigHomeDir,
		);
	}

	get hasBackboardAuth(): boolean {
		return this.auth.backboard !== null;
	}

	get hasProviderKeys(): boolean {
		return this.auth.providerKeys.length > 0;
	}

	/**
	 * Re-reads credentials after `/login`, `/logout`, or a `/keys` change so the
	 * running session picks them up without a restart.
	 */
	refreshAuth(): AuthState {
		const previous = this.auth;
		this.auth = resolveAuth(
			this.homeDir === undefined ? {} : { homeDir: this.homeDir },
		);
		if (this.hostProviderKeys) {
			this.auth = { ...this.auth, providerKeys: this.hostProviderKeys };
		}
		const refreshed = this.auth;
		this.auth = previous;
		this.updateCredentialGenerations(refreshed.providerKeys);
		this.auth = refreshed;
		const next = this.auth.backboard ?? anonymousEnv();
		this.env.apiKey = next.apiKey;
		this.env.apiUrl = next.apiUrl;
		return this.auth;
	}

	reloadEnv(): void {
		this.refreshAuth();
	}
}
