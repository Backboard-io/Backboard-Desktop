/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { applyLiveManifest, connectLiveUpdateEvents, fetchLiveUpdateBuffer, installedAppMismatch, LiveComponentPointer, LiveConfigRecord, LiveEventSource, LiveUpdateConfig, LiveUpdateEnvelope, liveAgentDir, liveAgentProtocolVersion, liveUpdateBuildId, readDesiredApp, readLiveJson, recordLiveAppRunning, releaseLiveUpdateLeadership, tryAcquireLiveUpdateLeadership, verifyLiveUpdateEnvelope } from './liveUpdatesCore';

/** A restart the user can take to switch the app to (or off) a live update. */
export interface LiveRestartState {
	/** Overlay the restart switches to; undefined goes back to the installed app. */
	readonly targetId?: string;
	readonly urgent: boolean;
	readonly notes?: string;
}

export interface LiveUpdatesOptions {
	readonly appVersion: string;
	readonly channel: string;
	readonly userAgent: string;
	readonly onRestartStateChange: (state: LiveRestartState | undefined) => void;
}

export interface LiveUpdatesController extends vscode.Disposable {
	/** Fetches the manifest and stages what it asks for. */
	check(): Promise<void>;
	/** Offers the pending restart, if there is one. */
	promptRestart(): Promise<void>;
	readonly restartState: LiveRestartState | undefined;
}

interface LiveUpdateProductConfig {
	readonly manifestUrl?: string;
	readonly eventsUrl?: string;
	readonly publicKeys?: readonly string[];
	readonly backboardVersion?: string;
	/** `liveUpdateBuildId` of the installed app. */
	readonly backboardBuild?: string;
}

const startupCheckDelayMs = 5_000;
const defaultPollIntervalSeconds = 300;
const focusCheckThrottleMs = 60_000;
/** Spreads the fetches that one pushed event causes across clients. */
const pushedCheckJitterMs = 20_000;
/**
 * How often every window re-reads the staged state. The file watcher on the
 * live updates folder (outside the workspace) does not fire reliably, and
 * only the leading window fetches, so the others would miss a staged update.
 */
const localRefreshIntervalMs = 15_000;
const flagContextPrefix = 'backboard.flag.';

let currentLiveConfig: LiveUpdateConfig | undefined;

/** A server-controlled flag from the live update manifest. */
export function getLiveUpdateFlag(name: string): string | number | boolean | undefined {
	return currentLiveConfig?.flags?.[name];
}

/** The installed app root, also while the app runs from an overlay. */
export function installedAppRoot(): string {
	return process.env.BACKBOARD_LIVE_BASE_APP_ROOT || vscode.env.appRoot;
}

function readLiveProductConfig(): LiveUpdateProductConfig | undefined {
	const product = readLiveJson<{ backboardVersion?: string; backboardBuildInfo?: { sourceCommit?: unknown; sourceDirtySha256?: unknown }; backboardLiveUpdate?: LiveUpdateProductConfig }>(path.join(vscode.env.appRoot, 'product.json'));
	// Development builds take their keys from product.overrides.json, which the
	// main process merges the same way (bootstrap-meta.ts).
	const overrides = process.env.VSCODE_DEV ? readLiveJson<{ backboardLiveUpdate?: LiveUpdateProductConfig }>(path.join(vscode.env.appRoot, 'product.overrides.json')) : undefined;
	const config = overrides?.backboardLiveUpdate ?? product?.backboardLiveUpdate;
	return config ? { ...config, backboardVersion: product?.backboardVersion, backboardBuild: liveUpdateBuildId(product?.backboardBuildInfo) } : undefined;
}

function liveUpdatesDirectory(context: vscode.ExtensionContext): string {
	// globalStorage is <userData>/User/globalStorage/<extension id>.
	return process.env.BACKBOARD_LIVE_UPDATES_DIR || path.join(context.globalStorageUri.fsPath, '..', '..', '..', 'LiveUpdates');
}

/**
 * The live cli-ts bundle for this extension's own runtime commands, matching
 * what the agent host picks (src/vs/platform/backboardLiveUpdate/node/liveAgent.ts).
 */
export function liveCliInvocation(packagedCliPath: string): { command: string; args: string[]; env: Record<string, string> } | undefined {
	const config = readLiveProductConfig();
	const liveUpdatesDir = process.env.BACKBOARD_LIVE_UPDATES_DIR;
	if (!liveUpdatesDir || !config?.publicKeys?.length || !config.backboardVersion) {
		return undefined;
	}
	const pointer = readLiveJson<LiveComponentPointer>(path.join(liveAgentDir(liveUpdatesDir), 'current.json'));
	const component = verifyLiveUpdateEnvelope(pointer?.manifest, config.publicKeys)?.components.agent;
	if (!pointer?.entry || component?.id !== pointer.id || component.protocolVersion !== liveAgentProtocolVersion
		|| installedAppMismatch(component, { appVersion: config.backboardVersion, appBuild: config.backboardBuild })) {
		return undefined;
	}
	const entry = path.join(liveAgentDir(liveUpdatesDir), pointer.id, ...component.entry.split('/'));
	try {
		if (entry !== pointer.entry || crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') !== component.entrySha256) {
			return undefined;
		}
	} catch {
		return undefined;
	}
	return { command: packagedCliPath, args: ['run', entry], env: { BUN_BE_BUN: '1' } };
}

export function initializeBackboardLiveUpdates(context: vscode.ExtensionContext, output: vscode.OutputChannel | undefined, options: LiveUpdatesOptions): LiveUpdatesController | undefined {
	const log = (line: string) => output?.appendLine(line);
	const liveUpdatesDir = liveUpdatesDirectory(context);
	const runningAppId = process.env.BACKBOARD_LIVE_APP_ID || undefined;
	log(`[live] started from ${runningAppId ? `overlay ${runningAppId}` : 'the installed app'} (${process.env.BACKBOARD_LIVE_APP_SELECTION ?? 'no boot loader'})`);
	const config = readLiveProductConfig();
	if (!config?.manifestUrl || !config.publicKeys?.length) {
		log('[live] off: product.json has no backboardLiveUpdate manifest URL and keys');
		return undefined;
	}
	if (process.env.BACKBOARD_LIVE_APP_SELECTION && !process.env.VSCODE_DEV) {
		// The extension host only runs once main, the window and the extension
		// host itself have started, so a running overlay counts as healthy. Its
		// parent is the app's main process.
		void recordLiveAppRunning(liveUpdatesDir, runningAppId, process.ppid).catch(error => log(`[live] could not record the running app: ${error}`));
	}
	const controller = new LiveUpdates(context, liveUpdatesDir, runningAppId, { ...config, manifestUrl: config.manifestUrl, publicKeys: config.publicKeys }, options, log);
	context.subscriptions.push(controller);
	return controller;
}

class LiveUpdates implements LiveUpdatesController {
	private readonly disposables: vscode.Disposable[] = [];
	private events: LiveEventSource | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private pollIntervalSeconds = defaultPollIntervalSeconds;
	private etag: string | undefined;
	private lastCheck = 0;
	private running: Promise<void> | undefined;
	private flagKeys = new Set<string>();
	private appliedConfig: string | undefined;
	private notifiedUrgentId: string | undefined;
	/** Withdrawn as broken: leaving such an overlay is urgent. */
	private revokedIds: ReadonlySet<string> = new Set();
	private _restartState: LiveRestartState | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly liveUpdatesDir: string,
		private readonly runningAppId: string | undefined,
		private readonly config: LiveUpdateProductConfig & { readonly manifestUrl: string; readonly publicKeys: readonly string[] },
		private readonly options: LiveUpdatesOptions,
		private readonly log: (line: string) => void,
	) {
		fs.mkdirSync(liveUpdatesDir, { recursive: true });
		this.refreshRestartState();
		this.applyConfigFromDisk();
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(liveUpdatesDir), '{config.json,app/current.json}'));
		const onChange = () => {
			this.refreshRestartState();
			this.applyConfigFromDisk();
		};
		this.disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
		const localRefresh = setInterval(onChange, localRefreshIntervalMs);
		this.disposables.push({ dispose: () => clearInterval(localRefresh) });
		// Spread so windows restored together do not all check at once.
		const startup = setTimeout(() => void this.tick(false), startupCheckDelayMs + Math.random() * startupCheckDelayMs);
		this.disposables.push({ dispose: () => clearTimeout(startup) });
		this.schedulePolling();
		this.disposables.push(vscode.window.onDidChangeWindowState(state => {
			if (state.focused && Date.now() - this.lastCheck >= focusCheckThrottleMs) {
				void this.tick(false);
			}
		}));
	}

	get restartState(): LiveRestartState | undefined {
		return this._restartState;
	}

	dispose(): void {
		clearInterval(this.pollTimer);
		this.events?.dispose();
		this.disposables.forEach(disposable => disposable.dispose());
		try {
			releaseLiveUpdateLeadership(this.liveUpdatesDir);
		} catch {
			// The next leader treats the lock as stale.
		}
	}

	check(): Promise<void> {
		return this.tick(true);
	}

	async promptRestart(): Promise<void> {
		if (this._restartState) {
			await this.offerRestart(this._restartState);
		}
	}

	private schedulePolling(): void {
		clearInterval(this.pollTimer);
		this.pollTimer = setInterval(() => void this.tick(false), this.pollIntervalSeconds * 1000);
	}

	private async tick(manual: boolean): Promise<void> {
		if (this.running) {
			return this.running;
		}
		this.running = this.runTick(manual).finally(() => this.running = undefined);
		return this.running;
	}

	private async runTick(manual: boolean): Promise<void> {
		this.lastCheck = Date.now();
		let leader = false;
		try {
			leader = tryAcquireLiveUpdateLeadership(this.liveUpdatesDir);
		} catch (error) {
			this.log(`[live] cannot use ${this.liveUpdatesDir}: ${error}`);
		}
		if (!leader) {
			this.events?.dispose();
			this.events = undefined;
			// Background checks belong to the leader; a check the user asked for
			// runs in whichever window they asked in.
			if (!manual) {
				return;
			}
		}
		if (leader && this.config.eventsUrl && !this.events) {
			const eventsUrl = new URL(this.config.eventsUrl);
			eventsUrl.searchParams.set('channel', this.options.channel);
			eventsUrl.searchParams.set('platform', `${process.platform}-${process.arch}`);
			this.events = connectLiveUpdateEvents(eventsUrl.toString(), this.options.userAgent, sequence => {
				this.log(`[live] pushed manifest ${sequence ?? '(no sequence)'}`);
				setTimeout(() => void this.tick(false), Math.random() * pushedCheckJitterMs);
			}, this.log);
		}
		try {
			const response = await fetchLiveUpdateBuffer(this.config.manifestUrl, { etag: manual ? undefined : this.etag, maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000, userAgent: this.options.userAgent });
			if (response.status === 304) {
				return;
			}
			const envelope = JSON.parse(response.body.toString('utf8')) as LiveUpdateEnvelope;
			const result = await applyLiveManifest({
				liveUpdatesDir: this.liveUpdatesDir,
				baseAppRoot: installedAppRoot(),
				userAgent: this.options.userAgent,
				log: this.log,
				publicKeys: this.config.publicKeys,
				channel: this.options.channel,
				appVersion: this.options.appVersion,
				appBuild: this.config.backboardBuild,
				electronVersion: process.versions.electron ?? '',
				machineId: vscode.env.machineId,
				runningAppId: this.runningAppId,
			}, this.config.manifestUrl, envelope);
			// Only a fully applied manifest may be skipped next time.
			this.etag = result.errors.length ? undefined : response.etag;
			for (const error of result.errors) {
				this.log(`[live] ${error}`);
			}
			this.revokedIds = new Set(result.revoked);
			this.refreshRestartState();
			this.applyConfigFromDisk();
			this.showAnnouncement(result.config);
		} catch (error) {
			this.etag = undefined;
			this.log(`[live] check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private refreshRestartState(): void {
		// Without the boot loader (development builds) a restart changes nothing.
		if (process.env.VSCODE_DEV || !process.env.BACKBOARD_LIVE_APP_SELECTION) {
			return;
		}
		const app = readDesiredApp(this.liveUpdatesDir, this.config.publicKeys, { appVersion: this.options.appVersion, appBuild: this.config.backboardBuild }, process.versions.electron ?? '');
		const leavingRevoked = !!this.runningAppId && this.revokedIds.has(this.runningAppId);
		const next: LiveRestartState | undefined = app?.id !== this.runningAppId ? { targetId: app?.id, urgent: !!app?.urgent || leavingRevoked, notes: app?.notes } : undefined;
		if (next?.targetId === this._restartState?.targetId && next?.urgent === this._restartState?.urgent && !!next === !!this._restartState) {
			return;
		}
		this._restartState = next;
		this.log(next ? `[live] restart to ${next.targetId ? `apply update ${next.targetId}` : 'return to the installed app'}` : '[live] running the latest update');
		this.options.onRestartStateChange(next);
		const urgentKey = next?.targetId ?? 'installed';
		if (next?.urgent && this.notifiedUrgentId !== urgentKey) {
			this.notifiedUrgentId = urgentKey;
			void this.offerRestart(next);
		}
	}

	private async offerRestart(state: LiveRestartState): Promise<void> {
		const restart = 'Restart Now';
		const message = state.notes
			? `A Backboard Studio update is ready: ${state.notes}`
			: 'A Backboard Studio update is ready. Restarting takes a few seconds.';
		if (await vscode.window.showInformationMessage(message, restart, 'Later') === restart) {
			await vscode.commands.executeCommand('backboard.relaunchApp');
		}
	}

	private applyConfigFromDisk(): void {
		const record = readLiveJson<LiveConfigRecord>(path.join(this.liveUpdatesDir, 'config.json'));
		const config = record?.config ?? {};
		const serialized = JSON.stringify(config);
		if (serialized === this.appliedConfig) {
			return;
		}
		this.appliedConfig = serialized;
		currentLiveConfig = config;
		const flags = config.flags ?? {};
		const keys = new Set(Object.keys(flags));
		for (const key of this.flagKeys) {
			if (!keys.has(key)) {
				void vscode.commands.executeCommand('setContext', `${flagContextPrefix}${key}`, undefined);
			}
		}
		this.flagKeys = keys;
		for (const [key, value] of Object.entries(flags)) {
			void vscode.commands.executeCommand('setContext', `${flagContextPrefix}${key}`, value);
		}
		const interval = Math.min(3600, Math.max(60, config.pollIntervalSeconds ?? defaultPollIntervalSeconds));
		if (interval !== this.pollIntervalSeconds) {
			this.pollIntervalSeconds = interval;
			this.schedulePolling();
		}
	}

	/** Shown once per announcement id, by the window that fetched it. */
	private showAnnouncement(config: LiveUpdateConfig | undefined): void {
		const announcement = config?.announcement;
		if (!announcement?.id || !announcement.message) {
			return;
		}
		const key = `backboard.liveAnnouncement.${announcement.id}`;
		if (this.context.globalState.get<boolean>(key)) {
			return;
		}
		void this.context.globalState.update(key, true);
		const learnMore = 'Learn More';
		const url = announcement.url && /^https:\/\//.test(announcement.url) ? announcement.url : undefined;
		const actions = url ? [learnMore] : [];
		const shown = announcement.severity === 'warning'
			? vscode.window.showWarningMessage(announcement.message, ...actions)
			: vscode.window.showInformationMessage(announcement.message, ...actions);
		void shown.then(choice => {
			if (choice === learnMore && url) {
				void vscode.env.openExternal(vscode.Uri.parse(url));
			}
		});
	}
}
