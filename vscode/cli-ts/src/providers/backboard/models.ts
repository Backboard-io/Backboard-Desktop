import type { BackboardClient } from "./BackboardClient.ts";
import { bundledModelCatalog } from "./bundledCatalog.ts";
import { MODEL_CACHE_TTL_MS } from "./constants.ts";
import { normalizeSelectableModels } from "./modelCatalog.ts";
import type { ModelInfo } from "./types.ts";

const modelCache = new WeakMap<
	Pick<BackboardClient, "listModels">,
	{
		expiresAt: number;
		models?: ModelInfo[];
		pending?: Promise<ModelInfo[]>;
	}
>();

/** Fetches and normalizes the Backboard model catalog for the model picker. */
export async function fetchModels(
	client: Pick<BackboardClient, "listModels">,
): Promise<ModelInfo[]> {
	const now = Date.now();
	const cached = modelCache.get(client);
	if (cached && cached.expiresAt > now) {
		if (cached.models) return [...cached.models];
		if (cached.pending) return [...(await cached.pending)];
	}

	const pending = fetchFreshModels(client);
	modelCache.set(client, {
		expiresAt: now + MODEL_CACHE_TTL_MS,
		pending,
	});

	try {
		const models = await pending;
		modelCache.set(client, {
			expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
			models,
		});
		return [...models];
	} catch (err) {
		modelCache.delete(client);
		throw err;
	}
}

async function fetchFreshModels(
	client: Pick<BackboardClient, "listModels">,
): Promise<ModelInfo[]> {
	const catalog = await client.listModels();
	const models = normalizeSelectableModels(catalog.models);
	// Fall back to the build-time snapshot when the live fetch yields nothing,
	// so the picker is never empty. The cache TTL still triggers live retries.
	return models.length
		? models
		: normalizeSelectableModels(bundledModelCatalog().models);
}
