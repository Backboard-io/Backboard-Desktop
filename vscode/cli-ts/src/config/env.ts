import type { LoadEnvOptions } from "./BackboardConfigTypes.ts";
import { readBackboardConfig } from "./backboardConfig.ts";

export interface BackboardEnv {
	apiKey: string;
	apiUrl: string;
}

export interface BrowserEnv {
	browserPath?: string;
	chromePath?: string;
	browserCdpUrl?: string;
	browserWsUrl?: string;
	home?: string;
	localAppData?: string;
	path?: string;
	programFiles?: string;
	programFilesX86?: string;
}

export type RuntimeEnv = Record<string, string | undefined>;

export const DEFAULT_API_URL = "https://app.backboard.io/api";
const PLACEHOLDER_API_KEYS = new Set([
	"your_key_here",
	"<your-api-key>",
	"replace_me",
]);

export function loadRuntimeEnv(): RuntimeEnv {
	return process.env;
}

export type { LoadEnvOptions } from "./BackboardConfigTypes.ts";

export function normalizeApiUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

/**
 * Resolves the API URL with precedence: the BACKBOARD_API_URL env var (a
 * whitespace-only value is treated as unset), then the saved config file, then
 * the built-in default. Single source of truth for both `loadEnv` and the SSO
 * login flow.
 */
export function resolveApiUrl(fileApiUrl?: string): string {
	return normalizeApiUrl(
		process.env.BACKBOARD_API_URL?.trim() || fileApiUrl || DEFAULT_API_URL,
	);
}

/**
 * Reads Backboard credentials from env first, then ~/.backboard/config.json.
 * Bun auto-loads `.env`, so no dotenv dependency is needed.
 */
export function loadEnv(options: LoadEnvOptions = {}): BackboardEnv {
	const envApiKey = process.env.BACKBOARD_API_KEY;
	if (isUsableApiKey(envApiKey)) {
		return {
			apiKey: envApiKey,
			apiUrl: resolveApiUrl(),
		};
	}

	const fileConfig = readBackboardConfig(options.homeDir);
	const apiKey = fileConfig.apiKey;
	const apiUrl = resolveApiUrl(fileConfig.apiUrl);

	if (!apiKey) {
		throw new Error(
			"BACKBOARD_API_KEY is not set. Add it to your .env file before running.",
		);
	}

	return { apiKey, apiUrl };
}

export function loadBrowserEnv(
	source: Record<string, string | undefined> = process.env,
): BrowserEnv {
	return {
		browserPath: optionalTrimmed(source.Q_BROWSER_PATH),
		chromePath: optionalTrimmed(source.CHROME_PATH),
		browserCdpUrl:
			optionalTrimmed(source.Q_BROWSER_CDP_URL) ??
			optionalTrimmed(source.BROWSER_CDP_URL),
		browserWsUrl: optionalTrimmed(source.Q_BROWSER_WS_URL),
		home: optionalTrimmed(source.HOME),
		localAppData: optionalTrimmed(source.LOCALAPPDATA),
		path: source.PATH,
		programFiles: optionalTrimmed(
			source.ProgramFiles ?? source.PROGRAMFILES ?? source.ProgramW6432,
		),
		programFilesX86: optionalTrimmed(source["ProgramFiles(x86)"]),
	};
}

function optionalTrimmed(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isUsableApiKey(value: string | undefined): value is string {
	const trimmed = value?.trim();
	return Boolean(trimmed && !PLACEHOLDER_API_KEYS.has(trimmed));
}
