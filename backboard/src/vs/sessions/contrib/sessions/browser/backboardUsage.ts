/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IEditorService, MODAL_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { WebviewInput } from '../../../../workbench/contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../../workbench/contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { backboardConfigAccessToken, backboardConfigApiKey, backboardConfigResource, normalizeBackboardEnv, readBackboardConfigJson } from '../../../../workbench/contrib/chat/common/backboardAuth.js';

export interface IBackboardUsageSnapshot {
	readonly balance: unknown;
	readonly summary: unknown;
	readonly recent: unknown;
	readonly fetchedAt: number;
}

interface IUsageApiConfig {
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
}

interface ILocalUsageEvent {
	readonly created_at: string;
	readonly provider: string;
	readonly model: string;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly total_tokens: number;
	readonly cost_usd: number;
}

interface ILocalUsageRecord extends ILocalUsageEvent {
	readonly key: string;
}

type UsageRequestResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

export class BackboardUsageView extends Disposable {

	private input: WebviewInput | undefined;
	private loadGeneration = 0;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
	}

	show(): void {
		if (this.input) {
			this.webviewWorkbenchService.revealWebview(this.input, MODAL_GROUP, false);
			void this.load();
			return;
		}

		const title = 'Usage';
		const input = this.input = this.webviewWorkbenchService.openWebview({
			title,
			options: {
				tryRestoreScrollPosition: true,
				enableFindWidget: true,
				disableServiceWorker: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
			providedViewType: 'backboard.usage.simple',
		}, 'backboard.usage.simple', title, Codicon.graph, { group: MODAL_GROUP, preserveFocus: false, modalOptions: { fullWindow: true } });
		this.inputDisposables.clear();
		this.inputDisposables.add(input.webview.onMessage(event => {
			if (event.message?.type === 'ready' || event.message?.type === 'refresh') {
				void this.load();
			} else if (event.message?.type === 'back' && input.group !== undefined) {
				void this.editorService.closeEditor({ editor: input, groupId: input.group });
			}
		}));
		this.inputDisposables.add(input.onWillDispose(() => {
			if (this.input === input) {
				this.input = undefined;
				this.loadGeneration++;
				this.inputDisposables.clear();
			}
		}));
		input.webview.setHtml(usageHtml());
	}

	private async load(): Promise<void> {
		const input = this.input;
		if (!input) {
			return;
		}
		const generation = ++this.loadGeneration;
		void input.webview.postMessage({ type: 'loading' });
		try {
			const snapshot = await fetchBackboardUsageSnapshot(this.configurationService, this.fileService, this.pathService, this.requestService, this.logService);
			if (this.input === input && generation === this.loadGeneration) {
				void input.webview.postMessage({ type: 'snapshot', snapshot });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[Backboard] Could not load usage: ${message}`);
			if (this.input === input && generation === this.loadGeneration) {
				void input.webview.postMessage({ type: 'error', message });
			}
		}
	}
}

export async function fetchBackboardUsageSnapshot(configurationService: IConfigurationService, fileService: IFileService, pathService: IPathService, requestService: IRequestService, logService: ILogService): Promise<IBackboardUsageSnapshot> {
	const configResource = await backboardConfigResource(pathService);
	const config = await readBackboardConfigJson(fileService, configResource);
	const apiKey = stringValue(configurationService.getValue('backboard.apiKey')) ?? backboardConfigApiKey(config);
	const accessToken = backboardConfigAccessToken(config);
	const configuredUrl = stringValue(configurationService.getValue('backboard.apiUrl')) ?? stringValue(config.api_url) ?? stringValue(config.apiUrl);
	const env = normalizeBackboardEnv(stringValue(config.env) ?? stringValue(configurationService.getValue('backboard.env')));
	const api: IUsageApiConfig | undefined = apiKey || accessToken ? {
		baseUrl: (configuredUrl ?? (env === 'local' ? 'http://localhost:8000' : env === 'prod' ? 'https://app.backboard.io/api' : 'https://dev.app.backboard.io/api')).replace(/\/+$/, ''),
		headers: apiKey ? { 'X-API-Key': apiKey } : { 'Authorization': `Bearer ${accessToken}` },
	} : undefined;
	const [balance, summary, recent] = await Promise.all([
		api ? capture(() => requestUsageJson(api, '/billing/balance', requestService)) : undefined,
		api ? capture(() => requestUsageJson(api, '/billing/usage/summary?range=period', requestService)) : undefined,
		api ? capture(() => requestRecentUsage(api, requestService)) : undefined,
	]);
	logRequestError('balance', balance, logService);
	logRequestError('summary', summary, logService);
	logRequestError('recent', recent, logService);

	let local: Pick<IBackboardUsageSnapshot, 'summary' | 'recent'> | undefined;
	if (!summary?.ok || !recent?.ok) {
		local = await readLocalUsageSnapshot(fileService, pathService, logService);
	}
	return {
		balance: balance?.ok ? balance.value : {},
		summary: summary?.ok ? summary.value : local?.summary ?? {},
		recent: recent?.ok ? recent.value : local?.recent ?? { data: [] },
		fetchedAt: Date.now(),
	};
}

async function capture(request: () => Promise<unknown>): Promise<UsageRequestResult> {
	try {
		return { ok: true, value: await request() };
	} catch (error) {
		return { ok: false, error };
	}
}

function logRequestError(label: string, result: UsageRequestResult | undefined, logService: ILogService): void {
	if (result && !result.ok) {
		logService.warn(`[Backboard] Usage ${label} request failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
	}
}

async function requestUsageJson(api: IUsageApiConfig, path: string, requestService: IRequestService): Promise<unknown> {
	const context = await requestService.request({
		type: 'GET',
		url: `${api.baseUrl}${path}`,
		headers: api.headers,
		callSite: 'backboardUsage.request',
	}, CancellationToken.None);
	const status = context.res.statusCode;
	const body = (await streamToBuffer(context.stream)).toString();
	if (!status || status < 200 || status >= 300) {
		throw new Error(`Backboard usage request failed with status ${status ?? 'unknown'}.`);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new Error('Backboard usage returned an invalid response.');
	}
}

async function requestRecentUsage(api: IUsageApiConfig, requestService: IRequestService): Promise<unknown> {
	const pageSize = 100;
	const maxPages = 100;
	const pageConcurrency = 8;
	const firstPayload = await requestUsageJson(api, `/billing/usage/recent?page=1&page_size=${pageSize}`, requestService);
	const firstPage = usageEvents(firstPayload);
	if (!firstPage || firstPage.length < pageSize) {
		return firstPage ? { data: [...firstPage] } : firstPayload;
	}
	const events: unknown[] = [...firstPage];
	const totalPages = usageTotalPages(firstPayload);
	if (totalPages !== undefined) {
		if (totalPages > maxPages) {
			throw new Error(`Backboard usage exceeded ${maxPages * pageSize} events.`);
		}
		for (let start = 2; start <= totalPages; start += pageConcurrency) {
			const pages = Array.from({ length: Math.min(pageConcurrency, totalPages - start + 1) }, (_, index) => start + index);
			const payloads = await Promise.all(pages.map(page => requestUsageJson(api, `/billing/usage/recent?page=${page}&page_size=${pageSize}`, requestService)));
			for (const payload of payloads) {
				const pageEvents = usageEvents(payload);
				if (!pageEvents) {
					throw new Error('Backboard usage returned an invalid page.');
				}
				events.push(...pageEvents);
			}
		}
		return { data: events };
	}

	const signatures = new Set([pageSignature(firstPage)]);
	for (let page = 2; page <= maxPages; page++) {
		const payload = await requestUsageJson(api, `/billing/usage/recent?page=${page}&page_size=${pageSize}`, requestService);
		const pageEvents = usageEvents(payload);
		if (!pageEvents?.length) {
			return { data: events };
		}
		const signature = pageSignature(pageEvents);
		if (signatures.has(signature)) {
			throw new Error('Backboard usage pagination repeated a page.');
		}
		signatures.add(signature);
		events.push(...pageEvents);
		if (pageEvents.length < pageSize || usagePaginationComplete(payload, page, events.length)) {
			return { data: events };
		}
	}
	throw new Error(`Backboard usage exceeded ${maxPages * pageSize} events.`);
}

function usageEvents(value: unknown): readonly unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	const record = objectRecord(value);
	for (const key of ['usage', 'results', 'items', 'events', 'data']) {
		if (Array.isArray(record[key])) {
			return record[key];
		}
	}
	return record.data && typeof record.data === 'object' ? usageEvents(record.data) : undefined;
}

function usageTotalPages(value: unknown): number | undefined {
	const record = objectRecord(value);
	const pagination = objectRecord(record.pagination ?? objectRecord(record.data).pagination ?? record.meta);
	return firstNumber(pagination.total_pages, pagination.totalPages, pagination.pages);
}

function usagePaginationComplete(value: unknown, page: number, received: number): boolean {
	const record = objectRecord(value);
	const pagination = objectRecord(record.pagination ?? objectRecord(record.data).pagination ?? record.meta);
	const totalPages = firstNumber(pagination.total_pages, pagination.totalPages, pagination.pages);
	const total = firstNumber(pagination.total, pagination.total_items, pagination.totalItems, pagination.count);
	return (totalPages !== undefined && page >= totalPages) || (total !== undefined && received >= total);
}

function pageSignature(events: readonly unknown[]): string {
	return JSON.stringify([events.length, events[0], events[events.length - 1]]);
}

async function readLocalUsageSnapshot(fileService: IFileService, pathService: IPathService, logService: ILogService): Promise<Pick<IBackboardUsageSnapshot, 'summary' | 'recent'>> {
	const home = await pathService.userHome({ preferLocal: true });
	const roots = [URI.joinPath(home, '.backboard_ide', 'cli-ts-sessions'), URI.joinPath(home, '.backboard', 'sessions')];
	const logResources = (await Promise.all(roots.map(root => findUsageLogs(root, fileService)))).flat();
	const pricing = await readPricingCatalog(URI.joinPath(home, '.backboard_ide', 'models-cache.json'), fileService);
	const records = new Map<string, ILocalUsageRecord>();
	for (const resource of logResources) {
		try {
			const content = (await fileService.readFile(resource)).value.toString();
			for (const line of content.split(/\r?\n/)) {
				const event = localUsageEvent(line, pricing);
				if (event) {
					records.set(event.key, event);
				}
			}
		} catch (error) {
			logService.debug(`[Backboard] Could not read local usage log ${resource.toString()}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const events: ILocalUsageEvent[] = [...records.values()].map(({ key: _key, ...event }) => event);
	const input = events.reduce((total, event) => total + event.input_tokens, 0);
	const output = events.reduce((total, event) => total + event.output_tokens, 0);
	const spending = events.reduce((total, event) => total + event.cost_usd, 0);
	return {
		summary: { total_spending_usd: spending, token_usage_usd: spending, token_input_tokens: input, token_output_tokens: output, events_count: events.length },
		recent: { data: events },
	};
}

async function findUsageLogs(root: URI, fileService: IFileService): Promise<URI[]> {
	const result: URI[] = [];
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop()!;
		try {
			const stat = await fileService.resolve(directory);
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					pending.push(child.resource);
				} else if (child.name === 'server.jsonl') {
					result.push(child.resource);
				}
			}
		} catch {
			// A missing local session root is expected before the first local run.
		}
	}
	return result;
}

async function readPricingCatalog(resource: URI, fileService: IFileService): Promise<readonly Record<string, unknown>[]> {
	try {
		const parsed = objectRecord(JSON.parse((await fileService.readFile(resource)).value.toString()));
		return Array.isArray(parsed.models) ? parsed.models.map(objectRecord) : [];
	} catch {
		return [];
	}
}

function localUsageEvent(line: string, pricing: readonly Record<string, unknown>[]): ILocalUsageRecord | undefined {
	try {
		const entry = objectRecord(JSON.parse(line));
		if (entry.type !== 'response') {
			return undefined;
		}
		const usage = objectRecord(objectRecord(objectRecord(entry.body).lastEvent).usage);
		const input = firstNumber(usage.inputTokens, usage.input_tokens) ?? 0;
		const output = firstNumber(usage.outputTokens, usage.output_tokens) ?? 0;
		const total = firstNumber(usage.totalTokens, usage.total_tokens) ?? input + output;
		if (total <= 0) {
			return undefined;
		}
		const provider = stringValue(usage.provider) ?? 'backboard';
		const model = stringValue(usage.model) ?? 'Unknown model';
		const modelPricing = pricing.find(candidate => candidate.provider === provider && candidate.name === model)
			?? pricing.find(candidate => candidate.name === model);
		const inputPrice = firstNumber(modelPricing?.inputCostPer1mTokens, modelPricing?.inputPricePerMillion, modelPricing?.inputPrice, modelPricing?.promptPrice, modelPricing?.input_cost_per_1m_tokens, modelPricing?.input_price, modelPricing?.prompt_price_per_million) ?? 0;
		const outputPrice = firstNumber(modelPricing?.outputCostPer1mTokens, modelPricing?.outputPricePerMillion, modelPricing?.outputPrice, modelPricing?.completionPrice, modelPricing?.output_cost_per_1m_tokens, modelPricing?.output_price, modelPricing?.completion_price_per_million) ?? 0;
		const createdAt = stringValue(entry.timestamp) ?? new Date(0).toISOString();
		return {
			key: [stringValue(entry.session_id), stringValue(entry.endpoint), createdAt, provider, model, input, output, total].join('\u0000'),
			created_at: createdAt,
			provider,
			model,
			input_tokens: input,
			output_tokens: output,
			total_tokens: total,
			cost_usd: input / 1_000_000 * inputPrice + output / 1_000_000 * outputPrice,
		};
	} catch {
		return undefined;
	}
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstNumber(...values: readonly unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function usageHtml(): string {
	const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Usage</title>
	<style>
		:root { --accent: var(--vscode-textLink-foreground); --border: var(--vscode-panel-border, var(--vscode-widget-border)); --muted: var(--vscode-descriptionForeground); --soft: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
		* { box-sizing: border-box; } html, body { min-height: 100%; }
		body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
		button { font: inherit; }
		.app-bar { height: 56px; display: flex; align-items: center; justify-content: flex-end; padding: 10px 24px; border-bottom: 1px solid var(--border); }
		.back { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; }
		.back:hover { color: var(--vscode-foreground); background: var(--soft); }
		.back:focus-visible { color: var(--vscode-foreground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.back-arrow { font-size: 18px; line-height: 1; }
		.shell { max-width: 1120px; margin: 0 auto; padding: 28px 34px 48px; }
		header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; } h1 { margin: 0 auto 0 0; font-size: 16px; }
		.period, .muted { color: var(--muted); font-size: 11px; }
		.segmented { display: flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
		.segmented button, .refresh { height: 30px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
		.segmented button { padding: 0 12px; border-right: 1px solid var(--border); } .segmented button:last-child { border: 0; }
		.segmented button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.refresh { width: 32px; border: 1px solid var(--border); border-radius: 7px; font-size: 17px; }
		.status { display: none; margin-bottom: 18px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); }
		.status.visible { display: block; } .status.error { color: var(--vscode-errorForeground); border-color: var(--vscode-inputValidation-errorBorder); }
		.overview { display: grid; grid-template-columns: minmax(230px, .7fr) minmax(420px, 1.5fr); gap: 34px; padding-bottom: 28px; border-bottom: 1px solid var(--border); }
		.eyebrow { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
		.cost { margin: 8px 0 5px; font-size: 46px; font-weight: 650; letter-spacing: -.04em; }
		.providers { margin-top: 25px; display: grid; gap: 14px; }
		.provider-head { display: flex; gap: 8px; margin-bottom: 5px; } .provider-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .provider-cost { margin-left: auto; }
		.bar { height: 3px; background: var(--soft); } .bar span { display: block; height: 100%; background: var(--accent); }
		.chart-head { display: flex; align-items: center; margin-bottom: 10px; } h2 { margin: 0 auto 0 0; font-size: 13px; }
		.chart { position: relative; min-height: 228px; border-block: 1px solid var(--border); } svg { width: 100%; height: 228px; overflow: visible; }
		.grid { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; } .area { fill: color-mix(in srgb, var(--accent) 12%, transparent); } .line { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; } .axis { fill: var(--muted); font: 10px var(--vscode-font-family); }
		.empty { display: none; place-items: center; color: var(--muted); } .chart .empty { position: absolute; inset: 0; } .empty.visible { display: grid; }
		.metrics { display: grid; grid-template-columns: repeat(5, 1fr); border-bottom: 1px solid var(--border); }
		.metric { padding: 18px 14px; border-right: 1px solid var(--border); min-width: 0; } .metric:last-child { border: 0; } .metric-value { margin: 6px 0 4px; font-size: 20px; overflow: hidden; text-overflow: ellipsis; }
		.breakdown { padding-top: 28px; } .breakdown-head { display: flex; align-items: center; margin-bottom: 14px; }
		table { width: 100%; border-collapse: collapse; table-layout: fixed; } th, td { height: 38px; padding: 0 12px; border-bottom: 1px solid var(--border); text-align: right; } th { color: var(--muted); font-size: 11px; font-weight: 500; } th:first-child, td:first-child { width: 55%; padding-left: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		@media(max-width: 800px) { .app-bar { padding-inline: 12px; } .shell { padding: 22px 20px 40px; } header { flex-wrap: wrap; } h1 { width: 100%; } .overview { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, 1fr); } }
	</style>
</head>
<body>
	<nav class="app-bar"><button class="back" id="back" type="button" aria-label="Back to app"><span class="back-arrow" aria-hidden="true">←</span><span>Back to app</span></button></nav>
	<div class="shell">
		<header><h1>Usage</h1><span class="period" id="period"></span><div class="segmented"><button data-range="7">7 days</button><button data-range="30" aria-pressed="true">30 days</button><button data-range="90">90 days</button></div><button class="refresh" id="refresh" title="Refresh usage">↻</button></header>
		<div class="status" id="status"></div>
		<section class="overview"><div><div class="eyebrow">Period spend</div><div class="cost" id="cost">—</div><div class="muted" id="updated">Backboard billing usage</div><div class="providers" id="providers"></div></div><div><div class="chart-head"><h2 id="chart-title">Daily cost</h2><div class="segmented"><button data-mode="cost" aria-pressed="true">COST</button><button data-mode="tokens">TOKENS</button></div></div><div class="chart"><svg id="chart" viewBox="0 0 680 228" preserveAspectRatio="none"></svg><div class="empty" id="chart-empty">No dated usage in this period.</div></div></div></section>
		<section class="metrics" id="metrics"></section>
		<section class="breakdown"><div class="breakdown-head"><h2>Breakdown</h2><div class="segmented"><button data-breakdown="model" aria-pressed="true">MODEL</button><button data-breakdown="day">DAY</button></div></div><table id="table"><thead><tr><th id="first-column">Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead><tbody id="rows"></tbody></table><div class="empty" id="table-empty">No itemized usage in this period.</div></section>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = { snapshot: undefined, range: 30, mode: 'cost', breakdown: 'model', loading: true };
		const byId = id => document.getElementById(id);
		const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		const number = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
		const firstNumber = (value, keys) => { const source = record(value); for (const key of keys) { const result = number(source[key]); if (result !== undefined) return result; } };
		const firstString = (value, keys) => { const source = record(value); for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim(); };
		const unwrap = value => { const source = record(value); return Object.keys(record(source.data)).length ? record(source.data) : source; };
		const money = value => value === undefined ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(value) < .01 ? 6 : Math.abs(value) < 1 ? 4 : 2 }).format(value);
		const compact = value => new Intl.NumberFormat(undefined, { notation: Math.abs(value || 0) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
		const percent = value => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value || 0);
		const dayKey = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
		function recent(value) { const source = unwrap(value); for (const key of ['data', 'usage', 'results', 'items', 'events']) if (Array.isArray(source[key])) return source[key]; return []; }
		function eventFrom(raw) { const item = record(raw), source = { ...record(item.usage), ...item }; const rawDate = firstString(source, ['created_at', 'createdAt', 'timestamp', 'date']); const date = rawDate ? new Date(rawDate) : undefined; const input = firstNumber(source, ['input_tokens', 'inputTokens', 'prompt_tokens', 'token_input_tokens']) || 0; const output = firstNumber(source, ['output_tokens', 'outputTokens', 'completion_tokens', 'token_output_tokens']) || 0; const cachedRead = firstNumber(source, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens']) || 0; const cachedWrite = firstNumber(source, ['cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_creation_input_tokens']) || 0; return { date: date && !Number.isNaN(date.getTime()) ? date : undefined, provider: firstString(source, ['provider', 'provider_name']) || 'Backboard', model: firstString(source, ['model', 'model_name']) || 'Unknown model', cost: firstNumber(source, ['cost_usd', 'costUsd', 'total_cost', 'cost', 'amount_usd', 'amount_deducted_usd', 'token_usage_usd']) || 0, input, output, cached: firstNumber(source, ['cached_tokens', 'cachedTokens']) || cachedRead + cachedWrite, tokens: firstNumber(source, ['total_tokens', 'totalTokens']) || input + output }; }
		function data() { const snapshot = record(state.snapshot), summary = unwrap(snapshot.summary), balance = unwrap(snapshot.balance), all = recent(snapshot.recent).map(eventFrom); const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - state.range + 1); const events = all.some(event => event.date) ? all.filter(event => event.date && event.date >= cutoff) : all; const itemized = all.length > 0; const input = itemized ? events.reduce((sum, event) => sum + event.input, 0) : firstNumber(summary, ['token_input_tokens', 'input_tokens']) || 0; const output = itemized ? events.reduce((sum, event) => sum + event.output, 0) : firstNumber(summary, ['token_output_tokens', 'output_tokens']) || 0; return { events, cost: itemized ? events.reduce((sum, event) => sum + event.cost, 0) : firstNumber(summary, ['total_spending_usd', 'token_usage_usd', 'spending', 'cost']), input, output, cached: itemized ? events.reduce((sum, event) => sum + event.cached, 0) : firstNumber(summary, ['cached_tokens', 'cache_read_tokens']) || 0, count: itemized ? events.length : firstNumber(summary, ['events_count', 'request_count']) || 0, balance: firstNumber(balance, ['balance_usd', 'balance']), fetchedAt: number(snapshot.fetchedAt) }; }
		function aggregate(events, key) { const map = new Map(); for (const event of events) { const label = key === 'day' ? event.date ? dayKey(event.date) : 'Undated' : event[key]; const row = map.get(label) || { label, cost: 0, tokens: 0, count: 0 }; row.cost += event.cost; row.tokens += event.tokens; row.count++; map.set(label, row); } return [...map.values()].sort(key === 'day' ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.cost - a.cost || b.tokens - a.tokens); }
		function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
		function render() { document.querySelectorAll('[data-range]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.range) === state.range))); document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode))); document.querySelectorAll('[data-breakdown]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.breakdown === state.breakdown))); const end = new Date(), start = new Date(); start.setDate(start.getDate() - state.range + 1); byId('period').textContent = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' to ' + end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); if (!state.snapshot) return; const value = data(); byId('cost').textContent = money(value.cost); byId('updated').textContent = value.fetchedAt ? 'Updated ' + new Date(value.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Backboard billing usage'; renderProviders(value); renderChart(value); renderMetrics(value); renderTable(value); }
		function renderProviders(value) { const rows = aggregate(value.events, 'provider'); if (!rows.length && value.cost !== undefined) rows.push({ label: 'Backboard', cost: value.cost, tokens: value.input + value.output }); const total = rows.reduce((sum, row) => sum + row.cost, 0) || value.cost || 0; byId('providers').innerHTML = rows.slice(0, 5).map(row => '<div><div class="provider-head"><span class="provider-name">' + escapeHtml(row.label) + '</span><span class="provider-cost">' + money(row.cost) + '</span></div><div class="bar"><span style="width:' + Math.max(2, total ? row.cost / total * 100 : 0) + '%"></span></div><div class="muted">' + percent(total ? row.cost / total : 0) + ' of cost · ' + compact(row.tokens) + ' tokens</div></div>').join(''); }
		function renderChart(value) { const rows = aggregate(value.events.filter(event => event.date), 'day'), svg = byId('chart'); byId('chart-title').textContent = state.mode === 'cost' ? 'Daily cost' : 'Daily tokens'; if (!rows.length) { svg.innerHTML = ''; byId('chart-empty').classList.add('visible'); return; } byId('chart-empty').classList.remove('visible'); const values = rows.map(row => state.mode === 'cost' ? row.cost : row.tokens), max = Math.max(...values, 1), left = 48, right = 668, top = 18, bottom = 194, x = index => rows.length === 1 ? (left + right) / 2 : left + index / (rows.length - 1) * (right - left), y = item => bottom - item / max * (bottom - top), points = values.map((item, index) => [x(index), y(item)]), line = points.map((point, index) => (index ? 'L' : 'M') + point[0] + ',' + point[1]).join(' '), area = line + ' L' + points.at(-1)[0] + ',' + bottom + ' L' + points[0][0] + ',' + bottom + ' Z'; const grid = [0, .5, 1].map(fraction => '<line class="grid" x1="' + left + '" x2="' + right + '" y1="' + y(max * fraction) + '" y2="' + y(max * fraction) + '"></line><text class="axis" x="0" y="' + (y(max * fraction) + 3) + '">' + (state.mode === 'cost' ? money(max * fraction) : compact(max * fraction)) + '</text>').join(''); const labels = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].map(index => '<text class="axis" x="' + x(index) + '" y="216" text-anchor="middle">' + new Date(rows[index].label + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</text>').join(''); svg.innerHTML = grid + '<path class="area" d="' + area + '"></path><path class="line" d="' + line + '"></path>' + labels; }
		function renderMetrics(value) { const total = value.input + value.output; const metrics = [['Processed tokens', compact(total), compact(value.input) + ' input'], ['Output', compact(value.output), total ? percent(value.output / total) + ' of tokens' : 'No output reported'], ['Cached input', compact(value.cached), value.cached ? percent(value.cached / Math.max(1, value.input)) + ' of input' : 'Not reported'], ['Usage events', compact(value.count), state.range + '-day view'], ['Balance', money(value.balance), 'Available credit']]; byId('metrics').innerHTML = metrics.map(metric => '<div class="metric"><div class="muted">' + metric[0] + '</div><div class="metric-value">' + metric[1] + '</div><div class="muted">' + metric[2] + '</div></div>').join(''); }
		function renderTable(value) { const rows = aggregate(value.events, state.breakdown), total = rows.reduce((sum, row) => sum + row.cost, 0); byId('first-column').textContent = state.breakdown === 'day' ? 'Day' : 'Model'; byId('table').style.display = rows.length ? 'table' : 'none'; byId('table-empty').classList.toggle('visible', !rows.length); byId('rows').innerHTML = rows.map(row => '<tr><td>' + escapeHtml(state.breakdown === 'day' && row.label !== 'Undated' ? new Date(row.label + 'T00:00:00').toLocaleDateString() : row.label) + '</td><td>' + money(row.cost) + '</td><td>' + percent(total ? row.cost / total : 0) + '</td><td>' + compact(row.tokens) + '</td></tr>').join(''); }
		document.addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; if (button.id === 'back') { vscode.postMessage({ type: 'back' }); return; } if (button.dataset.range) state.range = Number(button.dataset.range); else if (button.dataset.mode) state.mode = button.dataset.mode; else if (button.dataset.breakdown) state.breakdown = button.dataset.breakdown; else if (button.id === 'refresh' && !state.loading) { state.loading = true; vscode.postMessage({ type: 'refresh' }); } render(); });
		window.addEventListener('message', event => { const message = event.data; if (message.type === 'loading') { state.loading = true; byId('status').className = 'status visible'; byId('status').textContent = 'Loading Backboard usage…'; } else if (message.type === 'snapshot') { state.snapshot = message.snapshot; state.loading = false; byId('status').className = 'status'; } else if (message.type === 'error') { state.loading = false; byId('status').className = 'status visible error'; byId('status').textContent = message.message || 'Could not load usage.'; } render(); });
		vscode.postMessage({ type: 'ready' }); render();
	</script>
</body>
</html>`;
}
