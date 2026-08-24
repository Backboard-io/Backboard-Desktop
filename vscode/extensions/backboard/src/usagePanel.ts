/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { BridgeModel } from './types';

export interface BackboardUsageSnapshot {
	readonly balance: unknown;
	readonly summary: unknown;
	readonly recent: unknown;
	readonly fetchedAt: number;
}

export type BackboardUsageFetcher = () => Promise<BackboardUsageSnapshot>;

interface LocalUsageEvent {
	readonly created_at: string;
	readonly provider: string;
	readonly model: string;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly total_tokens: number;
	readonly cost_usd: number;
}

interface LocalUsageRecord extends Omit<LocalUsageEvent, 'cost_usd'> {
	readonly key: string;
}

interface CachedUsageLog {
	readonly size: number;
	readonly mtimeMs: number;
	readonly events: readonly LocalUsageRecord[];
}

const localUsageLogCache = new Map<string, CachedUsageLog>();
const localUsageReadConcurrency = 8;
let localModelCatalogCache: { readonly mtimeMs: number; readonly models: readonly BridgeModel[] } | undefined;

export async function readLocalUsageSnapshot(models: readonly BridgeModel[]): Promise<Pick<BackboardUsageSnapshot, 'summary' | 'recent'>> {
	const pricingModels = [...await readLocalModelCatalog(), ...models];
	const roots = [
		path.join(os.homedir(), '.backboard_ide', 'cli-ts-sessions'),
		path.join(os.homedir(), '.backboard', 'sessions'),
	];
	const logPaths = (await Promise.all(roots.map(findUsageLogPaths))).flat();

	const records: LocalUsageRecord[] = [];
	const activeLogPaths = new Set<string>();
	for (let start = 0; start < logPaths.length; start += localUsageReadConcurrency) {
		const batch = logPaths.slice(start, start + localUsageReadConcurrency);
		const results = await Promise.all(batch.map(logPath => readCachedUsageLog(logPath)));
		for (let index = 0; index < batch.length; index++) {
			const result = results[index];
			if (!result) {
				continue;
			}
			activeLogPaths.add(batch[index]);
			records.push(...result);
		}
	}
	for (const cachedPath of localUsageLogCache.keys()) {
		if (!activeLogPaths.has(cachedPath)) {
			localUsageLogCache.delete(cachedPath);
		}
	}
	const uniqueRecords = [...new Map(records.map(event => [event.key, event])).values()];
	const events: LocalUsageEvent[] = uniqueRecords.map(event => ({
		created_at: event.created_at,
		provider: event.provider,
		model: event.model,
		input_tokens: event.input_tokens,
		output_tokens: event.output_tokens,
		total_tokens: event.total_tokens,
		cost_usd: estimateUsageCost(pricingModels, event.provider, event.model, event.input_tokens, event.output_tokens),
	}));
	const inputTokens = events.reduce((sum, event) => sum + event.input_tokens, 0);
	const outputTokens = events.reduce((sum, event) => sum + event.output_tokens, 0);
	const spending = events.reduce((sum, event) => sum + event.cost_usd, 0);
	return {
		summary: {
			total_spending_usd: spending,
			token_usage_usd: spending,
			token_input_tokens: inputTokens,
			token_output_tokens: outputTokens,
			events_count: events.length,
		},
		recent: { data: events },
	};
}

async function findUsageLogPaths(root: string): Promise<string[]> {
	const logPaths: string[] = [];
	const directories = [root];
	while (directories.length > 0) {
		const directory = directories.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				continue;
			}
			throw error;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(entryPath);
			} else if (entry.isFile() && entry.name === 'server.jsonl') {
				logPaths.push(entryPath);
			}
		}
	}
	return logPaths;
}

async function readLocalModelCatalog(): Promise<readonly BridgeModel[]> {
	const catalogPath = path.join(os.homedir(), '.backboard_ide', 'models-cache.json');
	try {
		const stat = await fs.promises.stat(catalogPath);
		if (localModelCatalogCache?.mtimeMs === stat.mtimeMs) {
			return localModelCatalogCache.models;
		}
		const parsed = objectRecord(JSON.parse(await fs.promises.readFile(catalogPath, 'utf8')));
		const models = Array.isArray(parsed.models)
			? parsed.models.filter((model): model is BridgeModel => {
				const record = objectRecord(model);
				return Boolean(nonEmptyString(record.provider) && nonEmptyString(record.name));
			})
			: [];
		localModelCatalogCache = { mtimeMs: stat.mtimeMs, models };
		return models;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
			return [];
		}
		throw error;
	}
}

async function readCachedUsageLog(logPath: string): Promise<readonly LocalUsageRecord[] | undefined> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(logPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	const cached = localUsageLogCache.get(logPath);
	if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached.events;
	}
	const events = await readUsageEventsFromLog(logPath);
	localUsageLogCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, events });
	return events;
}

async function readUsageEventsFromLog(logPath: string): Promise<readonly LocalUsageRecord[]> {
	const events: LocalUsageRecord[] = [];
	let input: fs.ReadStream;
	try {
		input = fs.createReadStream(logPath, { encoding: 'utf8' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return events;
		}
		throw error;
	}
	input.on('error', () => undefined);
	const lines = readline.createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			const entry = objectRecord(record);
			if (entry.type !== 'response') {
				continue;
			}
			const body = objectRecord(entry.body);
			const lastEvent = objectRecord(body.lastEvent);
			const usage = objectRecord(lastEvent.usage);
			const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens) ?? 0;
			const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens) ?? 0;
			const totalTokens = finiteNumber(usage.totalTokens ?? usage.total_tokens) ?? inputTokens + outputTokens;
			if (totalTokens <= 0) {
				continue;
			}
			const provider = nonEmptyString(usage.provider) ?? 'backboard';
			const model = nonEmptyString(usage.model) ?? 'Unknown model';
			const createdAt = nonEmptyString(entry.timestamp) ?? new Date(0).toISOString();
			events.push({
				key: [nonEmptyString(entry.session_id), nonEmptyString(entry.endpoint), createdAt, provider, model, inputTokens, outputTokens, totalTokens].join('\u0000'),
				created_at: createdAt,
				provider,
				model,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				total_tokens: totalTokens,
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return events;
}

function estimateUsageCost(models: readonly BridgeModel[], provider: string, modelName: string, inputTokens: number, outputTokens: number): number {
	const model = models.find(candidate => candidate.provider === provider && candidate.name === modelName)
		?? models.find(candidate => candidate.name === modelName);
	if (!model) {
		return 0;
	}
	const rawModel = objectRecord(model);
	const inputPerMillion = firstFinite(
		model.inputCostPer1mTokens,
		model.inputPricePerMillion,
		model.inputPrice,
		model.promptPrice,
		rawModel.input_cost_per_1m_tokens,
		rawModel.input_price,
		rawModel.prompt_price_per_million,
	) ?? 0;
	const outputPerMillion = firstFinite(
		model.outputCostPer1mTokens,
		model.outputPricePerMillion,
		model.outputPrice,
		model.completionPrice,
		rawModel.output_cost_per_1m_tokens,
		rawModel.output_price,
		rawModel.completion_price_per_million,
	) ?? 0;
	return inputTokens / 1_000_000 * inputPerMillion + outputTokens / 1_000_000 * outputPerMillion;
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstFinite(...values: readonly unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class BackboardUsagePanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private loadGeneration = 0;

	constructor(
		private readonly fetchUsage: BackboardUsageFetcher,
		private readonly output: vscode.OutputChannel | undefined,
	) { }

	show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			void this.load();
			return;
		}

		const panel = this.panel = vscode.window.createWebviewPanel(
			'backboard.usage',
			'Usage',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true },
		);
		panel.webview.html = usageHtml(panel.webview);
		panel.onDidDispose(() => {
			this.panel = undefined;
			this.loadGeneration++;
		});
		panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'ready' || message?.type === 'refresh') {
				void this.load();
			}
		});
	}

	private async load(): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const generation = ++this.loadGeneration;
		await panel.webview.postMessage({ type: 'loading' });
		try {
			const snapshot = await this.fetchUsage();
			if (this.panel === panel && generation === this.loadGeneration) {
				await panel.webview.postMessage({ type: 'snapshot', snapshot });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.output?.appendLine(`[usage] ${message}`);
			if (this.panel === panel && generation === this.loadGeneration) {
				await panel.webview.postMessage({ type: 'error', message });
			}
		}
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}
}

function usageHtml(webview: vscode.Webview): string {
	const nonce = cryptoNonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Usage</title>
	<style>
		:root {
			--usage-accent: var(--vscode-textLink-foreground);
			--usage-border: var(--vscode-panel-border, var(--vscode-widget-border));
			--usage-muted: var(--vscode-descriptionForeground);
			--usage-soft: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
			--usage-softer: color-mix(in srgb, var(--vscode-foreground) 2.5%, transparent);
		}
		* { box-sizing: border-box; }
		html, body { min-height: 100%; }
		body {
			margin: 0;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		button { font: inherit; }
		.usage-shell { max-width: 1180px; margin: 0 auto; padding: 26px 34px 48px; }
		.usage-header {
			display: flex;
			align-items: center;
			gap: 18px;
			min-height: 40px;
			margin-bottom: 26px;
		}
		.usage-header h1 { margin: 0 auto 0 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
		.period { color: var(--usage-muted); font-size: 12px; white-space: nowrap; }
		.segmented { display: inline-flex; border: 1px solid var(--usage-border); border-radius: 7px; overflow: hidden; }
		.segmented button, .refresh {
			height: 30px;
			border: 0;
			background: transparent;
			color: var(--usage-muted);
			cursor: pointer;
		}
		.segmented button { min-width: 58px; padding: 0 12px; border-right: 1px solid var(--usage-border); }
		.segmented button:last-child { border-right: 0; }
		.segmented button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.segmented button:hover, .refresh:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
		.segmented button:focus-visible, .refresh:focus-visible, .breakdown-toggle button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
		.refresh { width: 32px; flex: 0 0 32px; border: 1px solid var(--usage-border); border-radius: 7px; font-size: 17px; line-height: 28px; }
		.refresh.loading { animation: usage-spin 0.9s linear infinite; }
		@keyframes usage-spin { to { transform: rotate(360deg); } }
		.status {
			display: none;
			min-height: 44px;
			margin-bottom: 18px;
			padding: 12px 14px;
			border: 1px solid var(--usage-border);
			border-radius: 8px;
			background: var(--usage-softer);
			color: var(--usage-muted);
		}
		.status.visible { display: block; }
		.status.error { border-color: var(--vscode-inputValidation-errorBorder); color: var(--vscode-errorForeground); }
		.overview {
			display: grid;
			grid-template-columns: minmax(260px, 0.78fr) minmax(420px, 1.6fr);
			gap: 34px;
			padding-bottom: 28px;
			border-bottom: 1px solid var(--usage-border);
		}
		.eyebrow { margin-bottom: 7px; color: var(--usage-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.055em; text-transform: uppercase; }
		.cost-value { margin-bottom: 4px; font-size: clamp(32px, 4vw, 48px); font-weight: 650; letter-spacing: -0.045em; line-height: 1; font-variant-numeric: tabular-nums; }
		.cost-note { margin-bottom: 24px; color: var(--usage-muted); font-size: 11px; }
		.provider-list { display: flex; flex-direction: column; gap: 15px; }
		.provider-row { min-width: 0; }
		.provider-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
		.provider-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--usage-accent); }
		.provider-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.provider-cost { margin-left: auto; font-variant-numeric: tabular-nums; }
		.provider-bar { height: 3px; overflow: hidden; background: var(--usage-soft); }
		.provider-bar span { display: block; height: 100%; background: var(--usage-accent); }
		.provider-meta { margin-top: 5px; color: var(--usage-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
		.chart-card { min-width: 0; }
		.chart-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
		.chart-head h2, .breakdown-head h2 { margin: 0 auto 0 0; font-size: 13px; font-weight: 600; }
		.mode-toggle button { min-width: 64px; height: 26px; padding: 0 10px; font-size: 11px; }
		.chart-wrap { position: relative; min-height: 228px; border-top: 1px solid var(--usage-border); border-bottom: 1px solid var(--usage-border); }
		#chart { display: block; width: 100%; height: 228px; overflow: visible; }
		.chart-empty { position: absolute; inset: 0; display: none; place-items: center; color: var(--usage-muted); font-size: 12px; }
		.chart-empty.visible { display: grid; }
		.grid-line { stroke: var(--usage-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
		.chart-area { fill: color-mix(in srgb, var(--usage-accent) 12%, transparent); }
		.chart-line { fill: none; stroke: var(--usage-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
		.axis-label { fill: var(--usage-muted); font: 10px var(--vscode-font-family); }
		.metrics {
			display: grid;
			grid-template-columns: repeat(5, minmax(0, 1fr));
			border-bottom: 1px solid var(--usage-border);
		}
		.metric { min-width: 0; padding: 18px 16px 17px; border-right: 1px solid var(--usage-border); }
		.metric:first-child { padding-left: 0; }
		.metric:last-child { border-right: 0; }
		.metric-label { margin-bottom: 6px; color: var(--usage-muted); font-size: 11px; }
		.metric-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; letter-spacing: -0.025em; font-variant-numeric: tabular-nums; }
		.metric-meta { margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--usage-muted); font-size: 10px; }
		.breakdown { padding-top: 28px; }
		.breakdown-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
		.breakdown-toggle { display: inline-flex; overflow: hidden; border-radius: 7px; background: var(--usage-soft); }
		.breakdown-toggle button { height: 26px; padding: 0 13px; border: 0; background: transparent; color: var(--usage-muted); font-size: 11px; cursor: pointer; }
		.breakdown-toggle button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		table { width: 100%; border-collapse: collapse; table-layout: fixed; }
		th, td { height: 38px; padding: 0 12px; border-bottom: 1px solid var(--usage-border); text-align: right; font-variant-numeric: tabular-nums; }
		th { color: var(--usage-muted); font-size: 11px; font-weight: 500; }
		th:first-child, td:first-child { width: 55%; padding-left: 0; text-align: left; }
		td:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.table-empty { display: none; padding: 36px 0; color: var(--usage-muted); text-align: center; }
		.table-empty.visible { display: block; }
		@media (max-width: 820px) {
			.usage-shell { padding: 22px 20px 40px; }
			.usage-header { flex-wrap: wrap; }
			.usage-header h1 { width: 100%; }
			.overview { grid-template-columns: 1fr; }
			.metrics { grid-template-columns: repeat(2, 1fr); }
			.metric:nth-child(2n) { border-right: 0; }
			.metric:first-child { padding-left: 16px; }
		}
		@media (prefers-reduced-motion: reduce) { .refresh.loading { animation: none; } }
	</style>
</head>
<body>
	<div class="usage-shell">
		<header class="usage-header">
			<h1>Usage</h1>
			<div class="period" id="period"></div>
			<div class="segmented" aria-label="Usage period">
				<button data-range="7" aria-pressed="false">7 days</button>
				<button data-range="30" aria-pressed="true">30 days</button>
				<button data-range="90" aria-pressed="false">90 days</button>
			</div>
			<button class="refresh" id="refresh" aria-label="Refresh usage" title="Refresh usage">↻</button>
		</header>
		<div class="status" id="status" role="status"></div>
		<section class="overview">
			<div>
				<div class="eyebrow">Period spend</div>
				<div class="cost-value" id="cost">—</div>
				<div class="cost-note" id="cost-note">Backboard billing usage</div>
				<div class="provider-list" id="providers"></div>
			</div>
			<div class="chart-card">
				<div class="chart-head">
					<h2 id="chart-title">Daily cost</h2>
					<div class="segmented mode-toggle">
						<button data-mode="cost" aria-pressed="true">COST</button>
						<button data-mode="tokens" aria-pressed="false">TOKENS</button>
					</div>
				</div>
				<div class="chart-wrap"><svg id="chart" viewBox="0 0 680 228" preserveAspectRatio="none" aria-label="Daily usage"></svg><div class="chart-empty" id="chart-empty">No dated usage events in this period.</div></div>
			</div>
		</section>
		<section class="metrics" id="metrics"></section>
		<section class="breakdown">
			<div class="breakdown-head">
				<h2>Breakdown</h2>
				<div class="breakdown-toggle">
					<button data-breakdown="model" aria-pressed="true">MODEL</button>
					<button data-breakdown="day" aria-pressed="false">DAY</button>
				</div>
			</div>
			<table id="breakdown-table"><thead><tr><th id="first-column">Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead><tbody id="breakdown-body"></tbody></table>
			<div class="table-empty" id="table-empty">No itemized usage is available for this period.</div>
		</section>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = { snapshot: undefined, range: 30, mode: 'cost', breakdown: 'model', loading: true };
		const $ = id => document.getElementById(id);
		const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		const number = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
		const firstNumber = (source, keys) => { const item = record(source); for (const key of keys) { const value = number(item[key]); if (value !== undefined) return value; } return undefined; };
		const firstString = (source, keys) => { const item = record(source); for (const key of keys) { if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim(); } return undefined; };
		const compact = value => value === undefined ? '—' : new Intl.NumberFormat(undefined, { notation: Math.abs(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(value) < 100 ? 1 : 0 }).format(value);
		const money = value => value === undefined ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(value) < .01 ? 6 : Math.abs(value) < 1 ? 4 : Math.abs(value) < 100 ? 2 : 0 }).format(value);
		const percent = value => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value || 0);
		const titleCase = value => String(value || 'Backboard').replace(/[_-]+/g, ' ').replace(/\\b\\w/g, char => char.toUpperCase());
		const localDayKey = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
		const unwrapped = value => { const item = record(value); return Object.keys(record(item.data)).length ? record(item.data) : item; };
		function recentItems(value) {
			const source = unwrapped(value);
			for (const key of ['data', 'usage', 'results', 'items', 'events']) if (Array.isArray(source[key])) return source[key];
			return [];
		}
		function eventFrom(raw, index) {
			const item = record(raw);
			const usage = record(item.usage);
			const source = { ...usage, ...item };
			const rawDate = firstString(source, ['created_at', 'createdAt', 'timestamp', 'date', 'occurred_at', 'occurredAt', 'period_start', 'periodStart']);
			const date = rawDate ? new Date(rawDate) : undefined;
			const input = firstNumber(source, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'token_input_tokens']);
			const output = firstNumber(source, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'token_output_tokens']);
			const cachedRead = firstNumber(source, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadTokens']);
			const cachedWrite = firstNumber(source, ['cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens']);
			const cached = firstNumber(source, ['cached_tokens', 'cachedTokens', 'cache_tokens', 'cacheTokens']) ?? (cachedRead || 0) + (cachedWrite || 0);
			return {
				index,
				date: date && !Number.isNaN(date.getTime()) ? date : undefined,
				provider: firstString(source, ['provider', 'provider_name', 'providerName', 'model_provider', 'modelProvider']) || 'Backboard',
				model: firstString(source, ['model', 'model_name', 'modelName']) || 'Unknown model',
				cost: firstNumber(source, ['cost_usd', 'costUsd', 'total_cost', 'totalCost', 'cost', 'spendage', 'spend', 'amount_usd', 'amountUsd', 'amount_deducted_usd', 'amountDeductedUsd', 'token_usage_usd']) || 0,
				input: input || 0,
				output: output || 0,
				cached: cached || 0,
				tokens: firstNumber(source, ['total_tokens', 'totalTokens', 'tokens']) || (input || 0) + (output || 0),
			};
		}
		function normalized() {
			const snapshot = record(state.snapshot);
			const summary = unwrapped(snapshot.summary);
			const balance = unwrapped(snapshot.balance);
			const allEvents = recentItems(snapshot.recent).map(eventFrom);
			const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - (state.range - 1));
			const dated = allEvents.some(event => event.date);
			const events = dated ? allEvents.filter(event => event.date && event.date.getTime() >= cutoff.getTime()) : allEvents;
			const hasItemizedUsage = allEvents.length > 0;
			const eventCost = events.reduce((sum, event) => sum + event.cost, 0);
			const summaryCost = firstNumber(summary, ['total_spending_usd', 'totalSpendingUsd', 'token_usage_usd', 'tokenUsageUsd', 'spending', 'cost']);
			const input = hasItemizedUsage ? events.reduce((sum, event) => sum + event.input, 0) : firstNumber(summary, ['token_input_tokens', 'tokenInputTokens', 'input_tokens', 'inputTokens']) || 0;
			const output = hasItemizedUsage ? events.reduce((sum, event) => sum + event.output, 0) : firstNumber(summary, ['token_output_tokens', 'tokenOutputTokens', 'output_tokens', 'outputTokens']) || 0;
			const cached = hasItemizedUsage ? events.reduce((sum, event) => sum + event.cached, 0) : firstNumber(summary, ['cached_tokens', 'cachedTokens', 'cache_read_tokens']) || 0;
			return {
				events,
				cost: hasItemizedUsage ? eventCost : summaryCost,
				input,
				output,
				cached,
				balance: firstNumber(balance, ['balance_usd', 'balanceUsd', 'balance']),
				recentCount: hasItemizedUsage ? events.length : firstNumber(summary, ['events_count', 'eventsCount', 'request_count', 'requestCount']) || 0,
				fetchedAt: number(snapshot.fetchedAt),
			};
		}
		function aggregate(events, key) {
			const map = new Map();
			for (const event of events) {
				let label;
				if (key === 'day') label = event.date ? localDayKey(event.date) : 'Undated';
				else label = event[key];
				const row = map.get(label) || { label, cost: 0, tokens: 0, input: 0, output: 0, count: 0 };
				row.cost += event.cost; row.tokens += event.tokens; row.input += event.input; row.output += event.output; row.count++;
				map.set(label, row);
			}
			return [...map.values()].sort(key === 'day' ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.cost - a.cost || b.tokens - a.tokens);
		}
		function renderProviders(data) {
			const providers = aggregate(data.events, 'provider');
			if (!providers.length && data.cost !== undefined) providers.push({ label: 'Backboard', cost: data.cost, tokens: data.input + data.output, count: data.recentCount });
			const total = providers.reduce((sum, row) => sum + row.cost, 0) || data.cost || 0;
			$('providers').innerHTML = providers.slice(0, 5).map(row => {
				const share = total ? row.cost / total : 0;
				return '<div class="provider-row"><div class="provider-head"><span class="provider-dot"></span><span class="provider-name">' + escapeHtml(titleCase(row.label)) + '</span><span class="provider-cost">' + money(row.cost) + '</span></div><div class="provider-bar"><span style="width:' + Math.max(2, share * 100) + '%"></span></div><div class="provider-meta">' + percent(share) + ' of cost · ' + compact(row.tokens) + ' tokens</div></div>';
			}).join('');
		}
		function renderChart(data) {
			const rows = aggregate(data.events.filter(event => event.date), 'day');
			const svg = $('chart');
			const empty = $('chart-empty');
			$('chart-title').textContent = state.mode === 'cost' ? 'Daily cost' : 'Daily tokens';
			if (!rows.length) { svg.innerHTML = ''; empty.classList.add('visible'); return; }
			empty.classList.remove('visible');
			const values = rows.map(row => state.mode === 'cost' ? row.cost : row.tokens);
			const max = Math.max(...values, 1);
			const left = 48, right = 668, top = 18, bottom = 194;
			const x = index => rows.length === 1 ? (left + right) / 2 : left + index / (rows.length - 1) * (right - left);
			const y = value => bottom - value / max * (bottom - top);
			const points = values.map((value, index) => [x(index), y(value)]);
			const line = points.map((point, index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ',' + point[1].toFixed(1)).join(' ');
			const area = line + ' L' + points[points.length - 1][0].toFixed(1) + ',' + bottom + ' L' + points[0][0].toFixed(1) + ',' + bottom + ' Z';
			const labels = [0, .5, 1].map(fraction => '<line class="grid-line" x1="' + left + '" x2="' + right + '" y1="' + y(max * fraction) + '" y2="' + y(max * fraction) + '"></line><text class="axis-label" x="0" y="' + (y(max * fraction) + 3) + '">' + (state.mode === 'cost' ? money(max * fraction) : compact(max * fraction)) + '</text>').join('');
			const dateIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
			const dates = dateIndexes.map(index => '<text class="axis-label" x="' + x(index) + '" y="216" text-anchor="middle">' + new Date(rows[index].label + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</text>').join('');
			svg.innerHTML = labels + '<path class="chart-area" d="' + area + '"></path><path class="chart-line" d="' + line + '"></path>' + dates;
		}
		function renderMetrics(data) {
			const total = data.input + data.output;
			const metrics = [
				['Processed tokens', compact(total), compact(data.input) + ' input'],
				['Output', compact(data.output), total ? percent(data.output / total) + ' of tokens' : 'No output reported'],
				['Cached input', compact(data.cached), data.cached ? percent(data.cached / Math.max(1, data.input)) + ' of input' : 'Not reported'],
				['Usage events', compact(data.recentCount), state.range + '-day view'],
				['Balance', money(data.balance), 'Available credit'],
			];
			$('metrics').innerHTML = metrics.map(metric => '<div class="metric"><div class="metric-label">' + metric[0] + '</div><div class="metric-value">' + metric[1] + '</div><div class="metric-meta">' + metric[2] + '</div></div>').join('');
		}
		function renderBreakdown(data) {
			const rows = aggregate(data.events, state.breakdown === 'day' ? 'day' : 'model');
			const total = rows.reduce((sum, row) => sum + row.cost, 0);
			$('first-column').textContent = state.breakdown === 'day' ? 'Day' : 'Model';
			$('breakdown-table').style.display = rows.length ? 'table' : 'none';
			$('table-empty').classList.toggle('visible', !rows.length);
			$('breakdown-body').innerHTML = rows.map(row => '<tr><td>' + escapeHtml(state.breakdown === 'day' && row.label !== 'Undated' ? new Date(row.label + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : row.label) + '</td><td>' + money(row.cost) + '</td><td>' + percent(total ? row.cost / total : 0) + '</td><td>' + compact(row.tokens) + '</td></tr>').join('');
		}
		function render() {
			for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed', String(Number(button.dataset.range) === state.range));
			for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
			for (const button of document.querySelectorAll('[data-breakdown]')) button.setAttribute('aria-pressed', String(button.dataset.breakdown === state.breakdown));
			const end = new Date(); const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (state.range - 1));
			$('period').textContent = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' to ' + end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
			$('refresh').classList.toggle('loading', state.loading);
			if (!state.snapshot) return;
			const data = normalized();
			$('cost').textContent = money(data.cost);
			$('cost-note').textContent = data.fetchedAt ? 'Updated ' + new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Backboard billing usage';
			renderProviders(data); renderChart(data); renderMetrics(data); renderBreakdown(data);
		}
		function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
		document.addEventListener('click', event => {
			const button = event.target.closest('button'); if (!button) return;
			if (button.dataset.range) { state.range = Number(button.dataset.range); render(); }
			else if (button.dataset.mode) { state.mode = button.dataset.mode; render(); }
			else if (button.dataset.breakdown) { state.breakdown = button.dataset.breakdown; render(); }
			else if (button.id === 'refresh' && !state.loading) { state.loading = true; render(); vscode.postMessage({ type: 'refresh' }); }
		});
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'loading') { state.loading = true; $('status').className = 'status visible'; $('status').textContent = 'Loading Backboard usage…'; render(); }
			else if (message.type === 'snapshot') { state.snapshot = message.snapshot; state.loading = false; $('status').className = 'status'; $('status').textContent = ''; render(); }
			else if (message.type === 'error') { state.loading = false; $('status').className = 'status visible error'; $('status').textContent = message.message || 'Could not load usage.'; render(); }
		});
		vscode.postMessage({ type: 'ready' });
		render();
	</script>
</body>
</html>`;
}

function cryptoNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return value;
}
