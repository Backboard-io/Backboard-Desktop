import bundled from "./bundledModels.json";
import type { ModelCatalogItem, ModelsListResponse } from "./types.ts";

/**
 * Build-time snapshot of the Backboard model catalog (see
 * `scripts/refresh-bundled-models.ts`). Inlined into the packaged binary so a
 * full catalog is available even when the live fetch fails.
 */
export function bundledModelCatalog(): ModelsListResponse {
	// JSON imports widen literal-union fields (e.g. thinking allowed_fields)
	// to string[], so the cast has to go through unknown.
	const models = bundled.models as unknown as ModelCatalogItem[];
	return { models, total: models.length };
}
