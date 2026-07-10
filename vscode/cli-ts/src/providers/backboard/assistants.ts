import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_PACKAGE_NAME } from "../../config/branding.ts";
import { qUserConfigDir } from "../../config/paths.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import { shortId } from "../../utils/id.ts";
import { logger } from "../../utils/logger.ts";
import type { BackboardClient, RequestOptions } from "./BackboardClient.ts";

export interface EnsureAssistantOptions extends RequestOptions {
	/**
	 * Force a brand-new assistant instead of reusing one that matches the
	 * system-prompt/tools fingerprint. Used to keep eval trials isolated.
	 */
	fresh?: boolean;
}

const ASSISTANT_CACHE_FILE = "assistants-cache.json";

function assistantCachePath(): string {
	return join(qUserConfigDir(), ASSISTANT_CACHE_FILE);
}

/**
 * Cache key: the assistant is namespaced by backend, account, prompt, and
 * tools. The account fingerprint matters — assistants belong to the signed-in
 * account, so after a re-login (new API key) a cached id from the previous
 * account would 404 with "Assistant not found" on every turn.
 */
function cacheKey(
	apiUrl: string | undefined,
	accountFingerprint: string,
	name: string,
): string {
	return createHash("sha256")
		.update(apiUrl ?? "")
		.update(" ")
		.update(accountFingerprint)
		.update(" ")
		.update(name)
		.digest("hex")
		.slice(0, 16);
}

function assistantCacheDisabled(): boolean {
	return process.env.BACKBOARD_DISABLE_ASSISTANT_CACHE === "1";
}

function readAssistantCache(): Record<string, string> {
	if (assistantCacheDisabled()) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(assistantCachePath(), "utf8"),
		);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

function writeAssistantCache(key: string, assistantId: string): void {
	if (assistantCacheDisabled()) {
		return;
	}
	try {
		const cache = readAssistantCache();
		cache[key] = assistantId;
		const path = assistantCachePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cache, null, "\t")}\n`, "utf8");
	} catch (err) {
		logger.warn(
			`Failed to persist assistant cache: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Drops every cache entry that resolves to the given assistant id. Called when
 * the backend reports the assistant gone (e.g. deleted server-side, or created
 * under credentials that no longer exist) so the next turn re-creates one
 * instead of failing forever.
 */
export function invalidateAssistantCache(assistantId: string): void {
	if (assistantCacheDisabled()) {
		return;
	}
	try {
		const cache = readAssistantCache();
		const remaining = Object.fromEntries(
			Object.entries(cache).filter(([, id]) => id !== assistantId),
		);
		if (Object.keys(remaining).length === Object.keys(cache).length) {
			return;
		}
		writeFileSync(
			assistantCachePath(),
			`${JSON.stringify(remaining, null, "\t")}\n`,
			"utf8",
		);
	} catch (err) {
		logger.warn(
			`Failed to invalidate assistant cache: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function ensureAssistant(
	client: BackboardClient,
	systemPrompt: string,
	tools: OpenAITool[],
	options: EnsureAssistantOptions = {},
): Promise<string> {
	const { fresh, ...requestOptions } = options;
	const fingerprint = createHash("sha256")
		.update(systemPrompt)
		.update(JSON.stringify(tools))
		.digest("hex")
		.slice(0, 12);
	const name = fresh
		? `${APP_PACKAGE_NAME} coding ${fingerprint} ${shortId()}`
		: `${APP_PACKAGE_NAME} coding ${fingerprint}`;

	// A repeat prompt/tools/backend combination resolves to the same stable
	// assistant. Cache the id locally so subsequent sessions skip the ~1s
	// `GET /assistants` list scan (the dominant first-token latency).
	const key = cacheKey(client.apiUrl, client.accountFingerprint, name);
	if (!fresh) {
		const cached = readAssistantCache()[key];
		if (cached) {
			return cached;
		}
		const assistants = await client.listAssistants(requestOptions);
		const existing = assistants.find((a) => a.name === name);
		if (existing?.assistant_id) {
			writeAssistantCache(key, existing.assistant_id);
			return existing.assistant_id;
		}
	}

	const created = await client.createAssistant(
		{
			name,
			system_prompt: systemPrompt,
			tools,
		},
		requestOptions,
	);
	if (!created.assistant_id) {
		throw new Error("Backboard did not return an assistant id.");
	}
	if (!fresh) {
		writeAssistantCache(key, created.assistant_id);
	}
	return created.assistant_id;
}
