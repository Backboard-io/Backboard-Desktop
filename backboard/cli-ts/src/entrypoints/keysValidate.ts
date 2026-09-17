import { validationMessage } from "../core/keys/ProviderKeyController.ts";
import {
	BYOK_PROVIDER_IDS,
	type ByokProviderId,
	isByokProviderId,
} from "../core/keys/ProviderKeyTypes.ts";
import type { ModelCatalogItem } from "../providers/backboard/types.ts";
import { ByokError } from "../providers/byok/ByokError.ts";
import type { ProviderAdapter } from "../providers/byok/ByokTypes.ts";
import { byokAdapter } from "../providers/byok/registry.ts";
import { scrubSecret } from "../providers/byok/scrubSecret.ts";

/**
 * Why a key could not be verified. The IDE maps these to guidance without
 * ever seeing the vendor's raw response.
 */
export type KeyValidationCategory =
	| "invalid-key"
	| "insufficient-permissions"
	| "offline-or-timeout"
	| "rate-limited"
	| "provider-error";

export type KeyValidationResult =
	| { ok: true; provider: ByokProviderId; models: ModelCatalogItem[] }
	| {
			ok: false;
			provider: ByokProviderId;
			category: KeyValidationCategory;
			error: string;
			status?: number;
	  };

/** A vendor that takes longer than this is treated as unreachable, not slow. */
export const KEY_VALIDATION_TIMEOUT_MS = 15_000;

export interface ValidateProviderKeyOptions {
	provider: ByokProviderId;
	key: string;
	/** Overridable for tests; defaults to the registered vendor adapter. */
	adapter?: ProviderAdapter;
	timeoutMs?: number;
}

/**
 * Checks a key the way `/keys` does - shape, then an authenticated call - and
 * also discovers the models it can reach, so the host learns the catalog in
 * the same round trip. Never throws for a vendor outcome; the result carries a
 * category and a message with the key scrubbed out.
 */
export async function validateProviderKey(
	options: ValidateProviderKeyOptions,
): Promise<KeyValidationResult> {
	const { provider } = options;
	const adapter = options.adapter ?? byokAdapter(provider);
	const key = options.key.trim();
	const fail = (
		category: KeyValidationCategory,
		error: string,
		status?: number,
	): KeyValidationResult => ({
		ok: false,
		provider,
		category,
		error: scrubSecret(error, key),
		...(status === undefined ? {} : { status }),
	});

	if (!key) return fail("invalid-key", `Enter a ${adapter.label} API key.`);
	if (!adapter.looksLikeKey(key)) {
		return fail(
			"invalid-key",
			`That does not look like a ${adapter.label} key (expected ${adapter.keyHint}).`,
		);
	}

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("timed out")),
		options.timeoutMs ?? KEY_VALIDATION_TIMEOUT_MS,
	);
	try {
		await adapter.validateKey(key, controller.signal);
		const models = await adapter.listModels(key, controller.signal);
		return { ok: true, provider, models };
	} catch (err) {
		const status = err instanceof ByokError ? err.status : undefined;
		return fail(
			categorize(err, controller.signal.aborted),
			validationMessage(adapter.label, err),
			status,
		);
	} finally {
		clearTimeout(timer);
	}
}

function categorize(err: unknown, aborted: boolean): KeyValidationCategory {
	if (aborted) return "offline-or-timeout";
	if (err instanceof ByokError) {
		if (err.status === 401) return "invalid-key";
		if (err.status === 403) return "insufficient-permissions";
		if (err.status === 429) return "rate-limited";
		return "provider-error";
	}
	return isNetworkError(err) ? "offline-or-timeout" : "provider-error";
}

/** Bun/undici surface unreachable hosts as a TypeError with a coded cause. */
function isNetworkError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError" || err.name === "TimeoutError") return true;
	const cause = (err as Error & { cause?: unknown }).cause;
	const code =
		typeof cause === "object" && cause !== null
			? (cause as { code?: unknown }).code
			: undefined;
	return (
		/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(
			err.message,
		) ||
		(typeof code === "string" &&
			/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(code))
	);
}

/**
 * `keys validate --provider <id>`: the key arrives on stdin, never in argv or
 * the environment, and the result is one JSON line. A vendor rejection is a
 * structured result with exit code 0; only a usage error exits non-zero.
 */
export async function runKeysValidateCommand(
	provider: string | undefined,
	readKey: () => Promise<string>,
	write: (line: string) => void = (line) => process.stdout.write(line),
	writeError: (line: string) => void = (line) => process.stderr.write(line),
): Promise<number> {
	if (!provider || !isByokProviderId(provider)) {
		writeError(
			`keys validate requires --provider <${BYOK_PROVIDER_IDS.join("|")}>\n`,
		);
		return 2;
	}
	const result = await validateProviderKey({ provider, key: await readKey() });
	write(`${JSON.stringify(result)}\n`);
	return 0;
}
