/**
 * Refreshes the bundled Backboard model-catalog snapshot that ships in the
 * build, so the model picker is fully populated on first launch before any
 * live fetch completes.
 *
 * Fetches every provider's catalog concurrently from the Backboard API and
 * writes two generated artifacts:
 *  - cli-ts/src/providers/backboard/bundledModels.json (imported by the
 *    cli-ts runtime; inlined into the packaged binary by bun)
 *  - src/vs/platform/agentHost/node/cliTs/backboardBundledModels.ts
 *    (compiled into the IDE, seeds the picker at window start)
 *
 * Usage:
 *   bun run scripts/refresh-bundled-models.ts [--from-file <models.json>]
 *
 * Credentials resolve like the runtime: BACKBOARD_API_URL / BACKBOARD_API_KEY
 * env vars first, then ~/.backboard_ide/config.json. --from-file skips the
 * network and reads a previously fetched catalog (e.g. the runtime's
 * ~/.backboard_ide/models-cache.json).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_API_URL = "https://app.backboard.io/api";
const PAGE_LIMIT = 500;

/** Mirrors EXCLUDED_MODEL_PROVIDERS in src/providers/backboard/constants.ts. */
const EXCLUDED_PROVIDERS = new Set(["elevenlabs", "featherless"]);

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const cliTsRoot = path.dirname(scriptDir);
const repoRoot = path.dirname(cliTsRoot);
const jsonOutPath = path.join(
	cliTsRoot,
	"src/providers/backboard/bundledModels.json",
);
const tsOutPath = path.join(
	repoRoot,
	"src/vs/platform/agentHost/node/cliTs/backboardBundledModels.ts",
);

/** Raw catalog fields kept in the bundled JSON snapshot. */
const JSON_FIELDS = [
	"provider",
	"name",
	"model_type",
	"context_limit",
	"max_output_tokens",
	"supports_vision",
	"supports_thinking",
	"thinking_controls",
	"input_cost_per_1m_tokens",
	"output_cost_per_1m_tokens",
	"cached_input_cost_per_1m_tokens",
	"cache_write_input_cost_per_1m_tokens",
	"last_updated",
] as const;

/** Subset emitted into the IDE-side TypeScript module (BridgeModel fields). */
const TS_FIELDS = [
	"provider",
	"name",
	"model_type",
	"context_limit",
	"supports_vision",
	"input_cost_per_1m_tokens",
	"output_cost_per_1m_tokens",
	"cached_input_cost_per_1m_tokens",
	"cache_write_input_cost_per_1m_tokens",
] as const;

type RawModel = Record<string, unknown>;

function resolveCredentials(): { apiUrl: string; apiKey: string } {
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(
			fs.readFileSync(
				path.join(os.homedir(), ".backboard_ide", "config.json"),
				"utf8",
			),
		);
	} catch {
		// No local config — env vars must carry the credentials.
	}
	const env = typeof config.env === "string" ? config.env : "prod";
	const envKeys =
		config.env_keys && typeof config.env_keys === "object"
			? (config.env_keys as Record<string, unknown>)
			: {};
	const apiUrl =
		process.env.BACKBOARD_API_URL?.trim() ||
		(typeof config.api_url === "string" && config.api_url.trim()) ||
		(typeof config.apiUrl === "string" && config.apiUrl.trim()) ||
		DEFAULT_API_URL;
	const apiKey =
		process.env.BACKBOARD_API_KEY?.trim() ||
		(typeof config.api_key === "string" && config.api_key.trim()) ||
		(typeof config.apiKey === "string" && config.apiKey.trim()) ||
		(typeof envKeys[env] === "string" && (envKeys[env] as string).trim()) ||
		"";
	if (!apiKey) {
		throw new Error(
			"No Backboard API key found (BACKBOARD_API_KEY or ~/.backboard_ide/config.json).",
		);
	}
	return { apiUrl, apiKey };
}

async function apiGet(
	apiUrl: string,
	apiKey: string,
	endpoint: string,
): Promise<unknown> {
	const res = await fetch(`${apiUrl}${endpoint}`, {
		headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
	});
	if (!res.ok) {
		throw new Error(`GET ${endpoint} failed: HTTP ${res.status}`);
	}
	return res.json();
}

async function fetchProviderModels(
	apiUrl: string,
	apiKey: string,
	provider: string,
): Promise<RawModel[]> {
	const models: RawModel[] = [];
	let skip = 0;
	while (true) {
		const page = (await apiGet(
			apiUrl,
			apiKey,
			`/models/provider/${encodeURIComponent(provider)}?skip=${skip}&limit=${PAGE_LIMIT}`,
		)) as { models?: RawModel[]; total?: number };
		const pageModels = page.models ?? [];
		models.push(...pageModels);
		const total = typeof page.total === "number" ? page.total : models.length;
		if (models.length >= total || pageModels.length === 0) {
			return models;
		}
		skip += pageModels.length;
	}
}

async function fetchCatalog(): Promise<RawModel[]> {
	const { apiUrl, apiKey } = resolveCredentials();
	console.log(`Fetching model catalog from ${apiUrl}`);
	const providersResponse = (await apiGet(
		apiUrl,
		apiKey,
		"/models/providers",
	)) as { providers?: string[] };
	const providers = (providersResponse.providers ?? []).filter(
		(provider) =>
			typeof provider === "string" &&
			provider.trim() &&
			!EXCLUDED_PROVIDERS.has(provider.trim().toLowerCase()),
	);
	if (!providers.length) {
		throw new Error("Backboard API returned no model providers.");
	}
	console.log(`Providers (${providers.length}): ${providers.join(", ")}`);
	const results = await Promise.allSettled(
		providers.map((provider) =>
			fetchProviderModels(apiUrl, apiKey, provider).then((models) => {
				console.log(`  ${provider}: ${models.length} models`);
				return models;
			}),
		),
	);
	const failed = results.flatMap((result, index) =>
		result.status === "rejected" ? [providers[index]] : [],
	);
	if (failed.length) {
		throw new Error(
			`Refusing to write a partial snapshot — provider fetch failed for: ${failed.join(", ")}`,
		);
	}
	return results.flatMap((result) =>
		result.status === "fulfilled" ? result.value : [],
	);
}

function loadFromFile(filePath: string): RawModel[] {
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	const models = Array.isArray(parsed) ? parsed : parsed.models;
	if (!Array.isArray(models)) {
		throw new Error(`${filePath} does not contain a "models" array.`);
	}
	return models as RawModel[];
}

function slim(model: RawModel, fields: readonly string[]): RawModel {
	const out: RawModel = {};
	for (const field of fields) {
		const value = model[field];
		if (value !== null && value !== undefined) {
			out[field] = value;
		}
	}
	return out;
}

function sortModels(models: RawModel[]): RawModel[] {
	return [...models].sort((a, b) => {
		const provider = String(a.provider).localeCompare(String(b.provider));
		if (provider !== 0) return provider;
		return String(a.name).localeCompare(String(b.name));
	});
}

function tsLiteral(value: unknown): string {
	if (typeof value === "string") {
		return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
	}
	return JSON.stringify(value);
}

function emitTsModule(models: RawModel[]): string {
	const rows = models.map((model) => {
		const props = TS_FIELDS.filter(
			(field) => model[field] !== undefined && model[field] !== null,
		).map((field) => `${field}: ${tsLiteral(model[field])}`);
		return `\t{ ${props.join(", ")} },`;
	});
	return [
		"/*---------------------------------------------------------------------------------------------",
		" *  Copyright (c) Microsoft Corporation. All rights reserved.",
		" *  Licensed under the MIT License. See License.txt in the project root for license information.",
		" *--------------------------------------------------------------------------------------------*/",
		"",
		"// GENERATED FILE — do not edit by hand.",
		"// Snapshot of the Backboard model catalog bundled into the build so the model",
		"// picker is fully populated on first launch, before any live fetch lands.",
		"// Regenerate with: cd cli-ts && bun run refresh-bundled-models",
		"",
		"export const BUNDLED_CATALOG_MODELS = [",
		...rows,
		"];",
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const fromFileIndex = process.argv.indexOf("--from-file");
	const models =
		fromFileIndex !== -1
			? loadFromFile(process.argv[fromFileIndex + 1] ?? "")
			: await fetchCatalog();
	const llmModels = sortModels(models).filter(
		(model) =>
			typeof model.provider === "string" &&
			typeof model.name === "string" &&
			!EXCLUDED_PROVIDERS.has(model.provider.trim().toLowerCase()) &&
			String(model.model_type ?? "llm").toLowerCase() === "llm",
	);
	if (llmModels.length < 50) {
		throw new Error(
			`Catalog looks too small (${llmModels.length} LLM models) — refusing to overwrite the snapshot.`,
		);
	}

	const jsonModels = llmModels.map((model) => slim(model, JSON_FIELDS));
	fs.writeFileSync(
		jsonOutPath,
		`${JSON.stringify({ models: jsonModels }, null, "\t")}\n`,
	);
	fs.writeFileSync(tsOutPath, emitTsModule(llmModels));
	console.log(`Wrote ${jsonModels.length} models to:`);
	console.log(`  ${jsonOutPath}`);
	console.log(`  ${tsOutPath}`);
}

await main();
