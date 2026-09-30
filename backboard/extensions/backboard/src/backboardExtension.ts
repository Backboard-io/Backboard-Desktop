/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { codiconsStylesheetUri, fontBaseUri, iconBaseUri, panelHtml, webviewLocalResourceRoots } from './panel/panelHtml';
import { initializeBackboardUpdates, readCurrentAppVersion } from './updates';
import type { BackboardAttachment, BackboardConfigJson, BackboardDeviceCodeResponse, BackboardOAuthSaveResult, BackboardOAuthTokens, BridgeEvent, BridgeModel, FileAttachment, FileChangePayload, ImageAttachment, ModelCacheEntry, PanelOptions, PanelPersistedState, PanelStateStore, PanelThreadFile, PendingRequest, ResponseSink, ToolCacheEntry, ToolResultRequest, VoiceAttachment } from './types';
import { BackboardUsagePanel, readLocalUsageSnapshot, type BackboardUsageSnapshot } from './usagePanel';

type BackboardSettings = ReturnType<typeof readSettings>;
const hiddenModelProviders = new Set(['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics']);
const panelStateStorageKeyPrefix = 'backboard.panel.state.';
const backboardOAuthDeviceCodeUrl = 'https://app.backboard.io/api/oauth/device/code';
const backboardOAuthTokenUrl = 'https://app.backboard.io/api/oauth/token';
const backboardOAuthUserInfoUrl = 'https://app.backboard.io/api/oauth/userinfo';
// First-party PUBLIC client (registered with is_public_client=True, no secret).
// The device-code grant only accepts this exact id, so it is safe to ship baked in.
const backboardOAuthClientId = 'Backboard_oauth_q_cli';
// `openid` is required by the /userinfo endpoint (name caching for the greeting).
const backboardOAuthScope = 'openid email profile';
const backboardOAuthDeviceGrantType = 'urn:ietf:params:oauth:grant-type:device_code';
const backboardOAuthTimeoutMs = 5 * 60 * 1000;
const commitMessageModelProvider = 'openai';
const commitMessageModel = 'gpt-4o-mini';
// One-shot generation: hide the chat tools that survive manual mode so the
// model cannot spend extra round trips on todo/read ceremony before answering.
const commitMessageExcludedTools = ['Read', 'Create', 'Grep', 'Glob', 'FetchUrl', 'WebSearch', 'TodoWrite', 'Agent'];
const maxCommitDiffChars = 60_000;
let backboardToolOutput: vscode.OutputChannel | undefined;

interface GitChange {
	readonly uri: vscode.Uri;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly inputBox: { value: string };
	readonly state: {
		readonly HEAD?: { readonly name?: string };
		readonly indexChanges: readonly GitChange[];
		readonly workingTreeChanges: readonly GitChange[];
		readonly untrackedChanges: readonly GitChange[];
	};
	status(): Promise<void>;
	diff(cached?: boolean): Promise<string>;
}

interface GitApi {
	readonly repositories: readonly GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): GitApi;
}

export function activate(context: vscode.ExtensionContext): void {
	backboardToolOutput = vscode.window.createOutputChannel('Backboard Tools');
	const bridge = new BackboardBridge(context);
	const panelProvider = new BackboardPanelProvider(bridge, context);
	const usagePanel = new BackboardUsagePanel(() => fetchUsageSnapshot(bridge), backboardToolOutput);
	context.subscriptions.push(backboardToolOutput);
	context.subscriptions.push(bridge);
	context.subscriptions.push(usagePanel);
	initializeBackboardUpdates(context, backboardToolOutput);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.hasAlternativeCredentials', () => bridge.hasAlternativeCredentials()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.setupProviderKey', async () => {
		const provider = await vscode.window.showQuickPick([
			{ label: 'OpenAI', id: 'openai' }, { label: 'Anthropic', id: 'anthropic' },
			{ label: 'Google', id: 'google' }, { label: 'OpenRouter', id: 'openrouter' },
		], { title: vscode.l10n.t('Bring Your Own Key'), placeHolder: vscode.l10n.t('Choose a provider') });
		if (!provider) { return false; }
		const key = await vscode.window.showInputBox({ title: vscode.l10n.t('{0} API Key', provider.label), password: true, ignoreFocusOut: true, prompt: vscode.l10n.t('Stored encrypted on this device.') });
		if (!key?.trim()) { return false; }
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting {0}…', provider.label) }, () => bridge.configureProviderKey(provider.id, key));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('backboard.configureProviderKey', (provider: string, key: string) => bridge.configureProviderKey(provider, key)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.setApiKey', async () => {
		if (await setApiKey()) {
			bridge.restart();
			bridge.warmUp();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.extension.signIn', () => promptBackboardSso(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.extension.signOut', () => bridge.signOut()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.refreshModels', () => panelProvider.refreshModels()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.generateCommitMessage', (rootUri: vscode.Uri | undefined, _context: unknown, token: vscode.CancellationToken | undefined) => generateBackboardCommitMessage(bridge, rootUri, token)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.openUsage', () => usagePanel.show()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.openRightPanel', () => openBackboardView()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.openPanel', () => openBackboardView()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.newChat', async () => {
		await openBackboardView();
		await panelProvider.postUiCommand('newChat');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.showHistory', async () => {
		await openBackboardView();
		await panelProvider.postUiCommand('showHistory');
	}));
	void updateBackboardAuthContext();
	const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(backboardConfigPath()), path.basename(backboardConfigPath())));
	const refreshBackboardState = () => {
		void updateBackboardAuthContext();
		panelProvider.refreshState();
	};
	context.subscriptions.push(configWatcher);
	context.subscriptions.push(configWatcher.onDidCreate(refreshBackboardState));
	context.subscriptions.push(configWatcher.onDidChange(refreshBackboardState));
	context.subscriptions.push(configWatcher.onDidDelete(refreshBackboardState));
	const panelStateWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(backboardPanelStatePath()), path.basename(backboardPanelStatePath())));
	const panelThreadsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(backboardThreadsDir(), '*.json'));
	let panelHistoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshPanelHistory = () => {
		if (panelHistoryRefreshTimer !== undefined) {
			clearTimeout(panelHistoryRefreshTimer);
		}
		panelHistoryRefreshTimer = setTimeout(() => {
			panelHistoryRefreshTimer = undefined;
			void panelProvider.postPanelStateSnapshot();
		}, 150);
	};
	context.subscriptions.push(new vscode.Disposable(() => {
		if (panelHistoryRefreshTimer !== undefined) {
			clearTimeout(panelHistoryRefreshTimer);
			panelHistoryRefreshTimer = undefined;
		}
	}));
	context.subscriptions.push(panelStateWatcher);
	context.subscriptions.push(panelStateWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidDelete(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher);
	context.subscriptions.push(panelThreadsWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidDelete(refreshPanelHistory));
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('backboard.panel', panelProvider, { webviewOptions: { retainContextWhenHidden: true } }));
}

export function deactivate(): void {
}

async function openBackboardView(): Promise<void> {
	await vscode.commands.executeCommand('workbench.view.extension.backboard');
	try {
		await vscode.commands.executeCommand('backboard.panel.focus');
	} catch {
		// Older workbench states may not have registered the generated focus command yet.
	}
}

async function generateBackboardCommitMessage(bridge: BackboardBridge, rootUri: vscode.Uri | undefined, cancellationToken: vscode.CancellationToken | undefined): Promise<void> {
	if (!configuredBackboardApiKey()) {
		const signIn = 'Sign In to Backboard';
		const selection = await vscode.window.showInformationMessage('Sign in to Backboard before generating a commit message.', signIn);
		if (selection === signIn) {
			await promptBackboardSso(bridge);
		}
		return;
	}

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
		void vscode.window.showErrorMessage('Git is unavailable, so Backboard cannot generate a commit message.');
		return;
	}

	try {
		const git = await gitExtension.activate();
		if (!git.enabled) {
			void vscode.window.showErrorMessage('Git is disabled, so Backboard cannot generate a commit message.');
			return;
		}

		const api = git.getAPI(1);
		const repository = rootUri
			? api.getRepository(rootUri)
			: api.repositories.length === 1 ? api.repositories[0] : undefined;
		if (!repository) {
			void vscode.window.showErrorMessage('Backboard could not find the Git repository for this commit message.');
			return;
		}

		const generated = await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, async () => {
			await repository.status();
			const hasStagedChanges = repository.state.indexChanges.length > 0;
			const changes = hasStagedChanges
				? repository.state.indexChanges
				: [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges];
			if (changes.length === 0) {
				void vscode.window.showInformationMessage('Cannot generate a commit message because there are no changes.');
				return undefined;
			}

			const diff = await commitMessageDiff(repository, hasStagedChanges);
			const prompt = commitMessagePrompt(repository, changes, diff, hasStagedChanges);
			const fallbackTokenSource = cancellationToken ? undefined : new vscode.CancellationTokenSource();
			const token = cancellationToken ?? fallbackTokenSource!.token;
			let responseText = '';
			let responseError: string | undefined;
			try {
				await bridge.send('sendPrompt', `commit-message:${repository.rootUri.toString()}`, {
					content: prompt,
					workspace: repository.rootUri.fsPath,
					provider: commitMessageModelProvider,
					model: commitMessageModel,
					mode: 'manual',
					memory: 'off',
					excludedTools: commitMessageExcludedTools
				}, event => {
					if (event.type === 'assistantTextDelta' && event.text) {
						responseText += event.text;
					} else if (event.type === 'error') {
						responseError = event.message ?? 'Backboard failed to generate a commit message.';
					}
				}, token);
			} finally {
				fallbackTokenSource?.dispose();
			}
			if (responseError) {
				throw new Error(responseError);
			}
			return cleanCommitMessage(responseText);
		});

		if (generated) {
			repository.inputBox.value = generated;
		}
	} catch (error) {
		backboardToolOutput?.appendLine(`[commit-message] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		void vscode.window.showErrorMessage(`Backboard could not generate a commit message: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function commitMessageDiff(repository: GitRepository, cached: boolean): Promise<string> {
	let diff = await repository.diff(cached);
	if (!cached) {
		for (const change of repository.state.untrackedChanges) {
			if (diff.length >= maxCommitDiffChars) {
				break;
			}
			const relativePath = path.relative(repository.rootUri.fsPath, change.uri.fsPath).split(path.sep).join('/');
			try {
				const bytes = await vscode.workspace.fs.readFile(change.uri);
				const contents = Buffer.from(bytes).includes(0)
					? '[binary file]'
					: Buffer.from(bytes).toString('utf8');
				diff += `\n\nUntracked file: ${relativePath}\n${contents}`;
			} catch {
				diff += `\n\nUntracked file: ${relativePath}\n[contents unavailable]`;
			}
		}
	}
	return diff.length > maxCommitDiffChars
		? `${diff.slice(0, maxCommitDiffChars)}\n\n[diff truncated]`
		: diff;
}

function commitMessagePrompt(repository: GitRepository, changes: readonly GitChange[], diff: string, cached: boolean): string {
	const files = changes.map(change => path.relative(repository.rootUri.fsPath, change.uri.fsPath).split(path.sep).join('/'));
	return [
		'Generate a concise Git commit subject for the changes below.',
		'Return exactly one plain-text line, with no quotes, Markdown, explanation, or trailing period.',
		'Use imperative mood, keep it at most 72 characters, and follow Conventional Commits only if the changes clearly support a type.',
		`Repository: ${path.basename(repository.rootUri.fsPath)}`,
		`Branch: ${repository.state.HEAD?.name ?? 'unknown'}`,
		`Changes used: ${cached ? 'staged' : 'working tree'}`,
		`Files: ${files.join(', ')}`,
		'',
		'diff:',
		diff || '[No textual diff is available; infer the subject from the changed file list.]'
	].join('\n');
}

function cleanCommitMessage(value: string): string | undefined {
	let message = value.trim();
	const fenced = /^```(?:text)?\s*([\s\S]*?)\s*```$/i.exec(message);
	if (fenced) {
		message = fenced[1].trim();
	}
	message = message.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
	message = message.replace(/^commit message:\s*/i, '').replace(/^[`"']|[`"']$/g, '').trim();
	return message || undefined;
}

async function setApiKey(): Promise<boolean> {
	const value = await vscode.window.showInputBox({
		title: 'Backboard API Key',
		password: true,
		ignoreFocusOut: true,
		prompt: 'Stored in ~/.backboard_ide/config.json.'
	});
	if (value !== undefined) {
		const apiKey = value.trim();
		if (apiKey.length > 0) {
			await saveBackboardConfigApiKey(apiKey);
			return true;
		}
		await clearBackboardConfigApiKey();
		return true;
	}
	return false;
}

async function promptBackboardSso(bridge: BackboardBridge): Promise<boolean> {
	return signInBackboard(bridge);
}

/**
 * Signs in with the OAuth device authorization grant (RFC 8628), mirroring the
 * Backboard CLI: request a device code, open the verification page in the
 * browser, then poll the token endpoint until the user approves. No localhost
 * redirect or callback server is involved.
 */
async function signInBackboard(bridge: BackboardBridge): Promise<boolean> {
	try {
		const device = await requestBackboardDeviceCode();
		backboardToolOutput?.appendLine(`[oauth] Device login code ${device.user_code}; approve at ${device.verification_uri}`);
		await openBackboardOAuthAuthorizeUrl(device.verification_uri_complete);
		const tokens = await pollBackboardDeviceToken(device);
		const saveResult = await saveBackboardOAuthTokens(tokens);
		await cacheBackboardUserName(stringValueFromRecord(tokens.access_token));
		bridge.restart();
		bridge.warmUp();
		if (saveResult.apiKeySaved) {
			backboardToolOutput?.appendLine(`[oauth] Backboard SSO complete. API key saved to ${backboardConfigPath()}.`);
		}
		void vscode.window.showInformationMessage('Backboard SSO complete.');
		return true;
	} catch (error) {
		backboardToolOutput?.appendLine(`[oauth] sign in failed: ${error instanceof Error ? error.message : String(error)}`);
		await vscode.window.showErrorMessage(`Backboard sign in failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

function openBackboardOAuthAuthorizeUrl(authorizeUrl: string): Promise<void> {
	if (process.platform === 'darwin') {
		return new Promise((resolve, reject) => {
			cp.execFile('/usr/bin/open', [authorizeUrl], error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}
	return Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(authorizeUrl))).then(opened => {
		if (!opened) {
			throw new Error('Could not open the sign-in page in your browser. Please try again.');
		}
	});
}

async function requestBackboardDeviceCode(): Promise<BackboardDeviceCodeResponse> {
	const body = new URLSearchParams({
		client_id: backboardOAuthClientId,
		scope: backboardOAuthScope
	});
	const responseText = await postForm(backboardOAuthDeviceCodeUrl, body, 'Backboard device-code request');
	const value: unknown = JSON.parse(responseText);
	if (!isObjectRecord(value)) {
		throw new Error('Backboard device-code response was not an object.');
	}
	const deviceCode = stringValueFromRecord(value.device_code);
	const userCode = stringValueFromRecord(value.user_code);
	const verificationUri = stringValueFromRecord(value.verification_uri);
	const verificationUriComplete = stringValueFromRecord(value.verification_uri_complete);
	const expiresIn = value.expires_in;
	const interval = value.interval;
	if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete || typeof expiresIn !== 'number' || typeof interval !== 'number') {
		throw new Error('Backboard device-code response was missing required fields.');
	}
	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		verification_uri_complete: verificationUriComplete,
		expires_in: expiresIn,
		interval
	};
}

/**
 * Polls the token endpoint with the device-code grant until the user approves
 * in the browser, following the standard `authorization_pending`/`slow_down`
 * back-off semantics (RFC 8628, section 3.5).
 */
async function pollBackboardDeviceToken(device: BackboardDeviceCodeResponse): Promise<BackboardOAuthTokens> {
	let intervalMs = Math.max(1, device.interval) * 1000;
	const expiresAt = Date.now() + Math.min(backboardOAuthTimeoutMs, device.expires_in * 1000);

	while (Date.now() < expiresAt) {
		await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
		const body = new URLSearchParams({
			grant_type: backboardOAuthDeviceGrantType,
			device_code: device.device_code,
			client_id: backboardOAuthClientId
		});
		const { statusCode, responseText } = await postFormRaw(backboardOAuthTokenUrl, body);
		if (statusCode >= 200 && statusCode < 300) {
			const tokens: unknown = JSON.parse(responseText);
			if (!isObjectRecord(tokens)) {
				throw new Error('Backboard token response was not an object.');
			}
			if (!stringValueFromRecord(tokens.access_token)) {
				throw new Error('Backboard token response did not include an access token.');
			}
			return tokens;
		}
		const errorCode = parseBackboardOAuthErrorCode(responseText);
		if (errorCode === 'authorization_pending') {
			continue;
		}
		if (errorCode === 'slow_down') {
			intervalMs += 5000;
			continue;
		}
		if (errorCode === 'access_denied') {
			throw new Error('Backboard device login was denied.');
		}
		if (errorCode === 'expired_token') {
			throw new Error('Backboard device login code expired.');
		}
		throw new Error(`Backboard token request returned HTTP ${statusCode}: ${responseText}`);
	}

	throw new Error('Timed out waiting for Backboard device login.');
}

function parseBackboardOAuthErrorCode(responseText: string): string | undefined {
	try {
		const value: unknown = JSON.parse(responseText);
		return isObjectRecord(value) ? stringValueFromRecord(value.error) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fetches the signed-in user's display name from the OAuth userinfo endpoint
 * (`profile` scope) and caches it as `oauth.user_name` in the config file so
 * the IDE welcome greeting can show it without a network round-trip. Failures
 * are non-fatal — the greeting simply stays hidden.
 */
async function cacheBackboardUserName(accessToken: string | undefined): Promise<void> {
	if (!accessToken) {
		return;
	}
	try {
		const payload: unknown = JSON.parse(await getJson(backboardOAuthUserInfoUrl, accessToken, 'Backboard userinfo request'));
		if (!isObjectRecord(payload)) {
			return;
		}
		const name = stringValueFromRecord(payload.name)
			?? [stringValueFromRecord(payload.given_name), stringValueFromRecord(payload.family_name)].filter(Boolean).join(' ').trim();
		if (!name) {
			return;
		}
		const config = await readBackboardConfigJson();
		const oauth = isObjectRecord(config.oauth) ? config.oauth : {};
		await writeBackboardConfigJson({ ...config, oauth: { ...oauth, user_name: name } });
		backboardToolOutput?.appendLine('[oauth] Cached signed-in user name for the welcome greeting.');
	} catch (error) {
		backboardToolOutput?.appendLine(`[oauth] Failed to cache user name: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function getJson(urlString: string, bearerToken: string, label: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const request = https.request(new URL(urlString), {
			method: 'GET',
			headers: { 'Authorization': `Bearer ${bearerToken}` }
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => {
				const responseText = Buffer.concat(chunks).toString('utf8');
				if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(`${label} returned HTTP ${response.statusCode}: ${responseText}`));
				} else {
					resolve(responseText);
				}
			});
		});
		request.on('error', reject);
		request.end();
	});
}

async function postForm(urlString: string, body: URLSearchParams, label: string): Promise<string> {
	const { statusCode, responseText } = await postFormRaw(urlString, body);
	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`${label} returned HTTP ${statusCode}: ${responseText}`);
	}
	return responseText;
}

function postFormRaw(urlString: string, body: URLSearchParams): Promise<{ statusCode: number; responseText: string }> {
	return new Promise((resolve, reject) => {
		const requestUrl = new URL(urlString);
		const requestBody = body.toString();
		const request = https.request(requestUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': Buffer.byteLength(requestBody)
			}
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => {
				resolve({ statusCode: response.statusCode ?? 0, responseText: Buffer.concat(chunks).toString('utf8') });
			});
		});
		request.on('error', reject);
		request.write(requestBody);
		request.end();
	});
}

async function handleBackboardError(webview: vscode.Webview, error: unknown, bridge?: BackboardBridge): Promise<void> {
	if (isBackboardAuthError(error)) {
		await webview.postMessage({ type: 'status', text: 'Backboard authentication required.' });
		if (bridge) {
			await promptBackboardSso(bridge);
		}
		return;
	}
	await webview.postMessage({ type: 'status', text: 'Failed.' });
}

function isBackboardAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /api key|auth(?:entication|orization)?|unauthorized|forbidden|\b401\b|\b403\b/i.test(message);
}

function unsupportedVoiceModeMessage(voiceMode: string): string | undefined {
	if (voiceMode === 'tts') {
		return 'Speech synthesis is not available in the public Backboard R-CLI runtime.';
	}
	if (voiceMode === 'stt' || voiceMode === 'conversation') {
		return 'This voice mode needs microphone audio. Click the mic, record, then click it again to send.';
	}
	return undefined;
}

function backboardConfigPath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'config.json');
}

function backboardPanelStatePath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'panel-state.json');
}

function backboardThreadsDir(): string {
	return path.join(os.homedir(), '.backboard_ide', 'threads');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPanelPersistedState(value: unknown): value is PanelPersistedState {
	if (!isObjectRecord(value)) {
		return false;
	}
	return (value.activeView === undefined || typeof value.activeView === 'string')
		&& (value.activeHistoryId === undefined || typeof value.activeHistoryId === 'string')
		&& (value.currentWorkspace === undefined || typeof value.currentWorkspace === 'string')
		&& (value.promptQueue === undefined || Array.isArray(value.promptQueue))
		&& (value.historyEntries === undefined || Array.isArray(value.historyEntries))
		&& (value.savedAt === undefined || typeof value.savedAt === 'number');
}

function isPanelStateStore(value: unknown): value is PanelStateStore {
	if (!isObjectRecord(value)) {
		return false;
	}
	const latest = value.latest;
	const byWorkspace = value.byWorkspace;
	return (latest === undefined || isPanelPersistedState(latest))
		&& (byWorkspace === undefined || (isObjectRecord(byWorkspace) && Object.values(byWorkspace).every(isPanelPersistedState)));
}

function panelStateStorageKey(workspace = workspacePath() ?? 'default'): string {
	const normalizedWorkspace = workspace || 'default';
	const digest = crypto.createHash('sha256').update(normalizedWorkspace).digest('hex').slice(0, 24);
	return `${panelStateStorageKeyPrefix}${digest}`;
}

function hasPanelStateContent(state: PanelPersistedState | undefined): boolean {
	return !!state
		&& (typeof state.activeHistoryId === 'string'
			|| !!state.promptQueue?.length
			|| !!state.historyEntries?.length);
}

function panelStateTimestamp(state: PanelPersistedState | undefined): number {
	if (!state) {
		return 0;
	}
	if (typeof state.savedAt === 'number') {
		return state.savedAt;
	}
	const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
	return entries.reduce<number>((max, entry) => {
		if (!isObjectRecord(entry)) {
			return max;
		}
		const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
		const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : 0;
		return Math.max(max, updatedAt, startedAt);
	}, 0);
}

function mergePanelStates(...states: (PanelPersistedState | undefined)[]): PanelPersistedState | undefined {
	const candidates = states.filter((state): state is PanelPersistedState => hasPanelStateContent(state));
	if (!candidates.length) {
		return undefined;
	}
	let best = candidates[0];
	for (const state of candidates.slice(1)) {
		if (panelStateTimestamp(state) > panelStateTimestamp(best)) {
			best = state;
		}
	}
	const historyEntries = mergePanelStateEntries(best, candidates);
	const activeHistoryId = typeof best.activeHistoryId === 'string'
		? best.activeHistoryId
		: panelHistoryEntryId(historyEntries[0]);
	const currentWorkspace = panelStateWorkspace({
		...best,
		activeHistoryId,
		historyEntries,
	});
	return {
		...best,
		activeHistoryId,
		currentWorkspace,
		historyEntries,
		savedAt: candidates.reduce((max, state) => Math.max(max, panelStateTimestamp(state)), 0),
	};
}

function mergePanelStateEntries(best: PanelPersistedState, states: readonly PanelPersistedState[]): unknown[] {
	const merged = new Map<string, unknown>();
	const order: string[] = [];
	const appendEntries = (entries: unknown[] | undefined) => {
		for (const entry of entries ?? []) {
			if (!isObjectRecord(entry) || typeof entry.id !== 'string') {
				continue;
			}
			if (!merged.has(entry.id)) {
				order.push(entry.id);
				merged.set(entry.id, entry);
				continue;
			}
			const current = merged.get(entry.id);
			const currentTimestamp = isObjectRecord(current)
				? Math.max(typeof current.updatedAt === 'number' ? current.updatedAt : 0, typeof current.startedAt === 'number' ? current.startedAt : 0)
				: 0;
			const nextTimestamp = Math.max(typeof entry.updatedAt === 'number' ? entry.updatedAt : 0, typeof entry.startedAt === 'number' ? entry.startedAt : 0);
			if (nextTimestamp >= currentTimestamp) {
				merged.set(entry.id, entry);
			}
		}
	};
	appendEntries(Array.isArray(best.historyEntries) ? best.historyEntries : []);
	for (const state of states) {
		if (state === best) {
			continue;
		}
		appendEntries(Array.isArray(state.historyEntries) ? state.historyEntries : []);
	}
	return order.map(id => merged.get(id)).filter((entry): entry is unknown => entry !== undefined);
}

function panelHistoryEntryId(entry: unknown): string | undefined {
	return isObjectRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined;
}

function panelEntryWorkspace(entry: unknown): string | undefined {
	return isObjectRecord(entry) && typeof entry.currentWorkspace === 'string' && entry.currentWorkspace.trim()
		? entry.currentWorkspace
		: undefined;
}

function panelStateWorkspace(state: PanelPersistedState | undefined): string | undefined {
	if (!state) {
		return undefined;
	}
	if (typeof state.currentWorkspace === 'string' && state.currentWorkspace.trim()) {
		return state.currentWorkspace;
	}
	const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
	if (typeof state.activeHistoryId === 'string') {
		const activeEntry = entries.find(entry => isObjectRecord(entry) && entry.id === state.activeHistoryId);
		const activeWorkspace = panelEntryWorkspace(activeEntry);
		if (activeWorkspace) {
			return activeWorkspace;
		}
	}
	for (const entry of entries) {
		const workspace = panelEntryWorkspace(entry);
		if (workspace) {
			return workspace;
		}
	}
	return undefined;
}

function readSharedPanelStateStore(): PanelStateStore {
	try {
		const raw = fs.readFileSync(backboardPanelStatePath(), 'utf8');
		const parsed: unknown = JSON.parse(raw);
		return isPanelStateStore(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readSharedPanelState(workspace?: string): PanelPersistedState | undefined {
	const store = readSharedPanelStateStore();
	const scoped = workspace ? store.byWorkspace?.[panelStateStorageKey(workspace)] : undefined;
	const threaded = readSharedPanelThreadsState(workspace);
	if (workspace) {
		return mergePanelStates(scoped, threaded);
	}
	return mergePanelStates(store.latest, threaded);
}

let sharedPanelStateWriteQueue = Promise.resolve();

function writeSharedPanelState(state: PanelPersistedState): Promise<void> {
	const write = sharedPanelStateWriteQueue.then(() => writeSharedPanelStateNow(state));
	sharedPanelStateWriteQueue = write.then(() => undefined, () => undefined);
	return write;
}

async function writeSharedPanelStateNow(state: PanelPersistedState): Promise<void> {
	const persistedState = enrichPanelPersistedState({
		...state,
		currentWorkspace: panelStateWorkspace(state),
	});
	await writeSharedPanelThreads(persistedState);
	const compactState = compactPanelPersistedState(persistedState);
	const existing = readSharedPanelStateStore();
	const key = panelStateStorageKey(compactState.currentWorkspace);
	const byWorkspace = Object.fromEntries(Object.entries(existing.byWorkspace ?? {}).map(([workspaceKey, workspaceState]) => [workspaceKey, compactPanelPersistedState(workspaceState)]));
	byWorkspace[key] = compactState;
	const next: PanelStateStore = {
		byWorkspace,
		latest: hasPanelStateContent(compactState) ? compactState : existing.latest ? compactPanelPersistedState(existing.latest) : undefined,
	};
	const statePath = backboardPanelStatePath();
	logBackboardDocumentDiagnostic('panel_state_write', {
		statePath,
		storageKey: key,
		currentWorkspace: compactState.currentWorkspace,
		activeHistoryId: compactState.activeHistoryId,
		historyEntryCount: compactState.historyEntries?.length,
	});
	await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
	await writeJsonFileAtomic(statePath, next);
	if (process.platform !== 'win32') {
		await fs.promises.chmod(statePath, 0o600);
	}
}

function compactPanelPersistedState(state: PanelPersistedState): PanelPersistedState {
	return {
		...state,
		historyEntries: Array.isArray(state.historyEntries) ? state.historyEntries.map(entry => {
			if (!isObjectRecord(entry)) {
				return entry;
			}
			const { html: _html, messages: _messages, outputText: _outputText, toolOutputs: _toolOutputs, checkpoints: _checkpoints, fileChanges: _fileChanges, promptQueue: _promptQueue, ...summary } = entry;
			return summary;
		}) : state.historyEntries,
	};
}

function enrichPanelPersistedState(state: PanelPersistedState): PanelPersistedState {
	if (!Array.isArray(state.historyEntries)) {
		return state;
	}
	return {
		...state,
		historyEntries: state.historyEntries.map(entry => isObjectRecord(entry) && hasPanelThreadPayload(entry) ? enrichPanelThreadEntry(entry) : entry),
	};
}

function hasPanelThreadPayload(entry: Record<string, unknown>): boolean {
	return typeof entry.html === 'string'
		|| Array.isArray(entry.messages)
		|| typeof entry.outputText === 'string'
		|| Array.isArray(entry.toolOutputs)
		|| Array.isArray(entry.checkpoints)
		|| Array.isArray(entry.fileChanges)
		|| Array.isArray(entry.promptQueue);
}

function enrichPanelThreadEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const html = typeof entry.html === 'string' ? entry.html : '';
	const prompt = typeof entry.prompt === 'string' ? entry.prompt : typeof entry.title === 'string' ? entry.title : '';
	const outputText = typeof entry.outputText === 'string' ? entry.outputText : extractPanelAssistantText(html);
	const toolOutputs = Array.isArray(entry.toolOutputs) ? entry.toolOutputs : extractPanelToolOutputs(html);
	const messages = normalizePanelThreadMessages(entry, prompt, outputText);
	return {
		...entry,
		html: normalizePanelThreadHtml(html, messages, toolOutputs),
		outputText,
		messages,
		toolOutputs,
	};
}

function normalizePanelMessages(value: unknown): { role: string; content: string }[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter(isObjectRecord)
		.map(message => ({
			role: typeof message.role === 'string' ? message.role : 'assistant',
			content: typeof message.content === 'string' ? message.content : '',
		}))
		.filter(message => message.content.trim().length > 0);
}

function normalizePanelThreadMessages(entry: Record<string, unknown>, prompt: string, outputText: string): { role: string; content: string }[] {
	const existingMessages = Array.isArray(entry.messages)
		? entry.messages
			.filter(isObjectRecord)
			.map(message => ({
				role: typeof message.role === 'string' ? message.role : 'assistant',
				content: typeof message.content === 'string' ? message.content : '',
			}))
			.filter(message => message.content.trim().length > 0)
		: [];
	if (existingMessages.length) {
		return existingMessages;
	}
	const htmlMessages = typeof entry.html === 'string'
		? extractPanelMessages(entry.html)
		: [];
	if (htmlMessages.length) {
		return htmlMessages;
	}
	return [
		...(prompt ? [{ role: 'user', content: prompt }] : []),
		...(outputText ? [{ role: 'assistant', content: outputText }] : []),
	];
}

function normalizePanelThreadHtml(
	html: string,
	messages: readonly { role: string; content: string }[],
	toolOutputs: readonly unknown[],
): string {
	const trimmedHtml = html.trim();
	const assistantText = extractPanelAssistantText(trimmedHtml);
	const renderedAssistantText = messages
		.filter(message => message.role === 'assistant')
		.map(message => message.content.trim())
		.filter(Boolean)
		.join('\n\n');
	const existingToolOutputCount = extractPanelToolOutputs(trimmedHtml).length;
	const needsAssistantSnapshot = Boolean(renderedAssistantText) && assistantText.trim() !== renderedAssistantText;
	const needsToolSnapshot = toolOutputs.length > 0 && existingToolOutputCount < toolOutputs.length;
	if (trimmedHtml && !needsAssistantSnapshot && !needsToolSnapshot) {
		return html;
	}
	return renderPanelThreadHtml(messages, toolOutputs);
}

function renderPanelThreadHtml(messages: readonly { role: string; content: string }[], toolOutputs: readonly unknown[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message.content) {
			continue;
		}
		const role = message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant';
		parts.push(role === 'reasoning'
			? `<details class="messageCard reasoning" open><summary>Thinking</summary><div class="reasoningText">${escapePanelHtml(message.content)}</div></details>`
			: `<div class="messageCard ${role}"><div class="messageText">${escapePanelHtml(message.content)}</div></div>`);
	}
	for (const output of toolOutputs) {
		if (!isObjectRecord(output)) {
			continue;
		}
		const status = typeof output.status === 'string' && output.status ? output.status : 'finished';
		const id = typeof output.id === 'string' && output.id ? output.id : `tool-${parts.length}`;
		const label = typeof output.label === 'string' && output.label ? output.label : 'Backboard tool';
		const text = typeof output.text === 'string' && output.text ? output.text : 'No details reported.';
		parts.push(
			`<div class="toolCard ${escapePanelAttribute(status)}" data-tool-key="${escapePanelAttribute(id)}">` +
				`<div class="toolHead"><span class="toolMain"><span class="toolLabel">${escapePanelHtml(label)}</span></span></div>` +
				`<pre class="toolDetails">${escapePanelHtml(text)}</pre></div>`
		);
	}
	return parts.join('');
}

function escapePanelHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/\r?\n/g, '<br>');
}

function escapePanelAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function extractPanelAssistantText(html: string): string {
	const parts: string[] = [];
	const pattern = /<div class="messageCard assistant"[\s\S]*?<div class="messageText">([\s\S]*?)<\/div>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html))) {
		const text = stripPanelHtml(match[1]);
		if (text) {
			parts.push(text);
		}
	}
	return parts.join('\n\n');
}

function extractPanelMessages(html: string): { role: string; content: string }[] {
	const messages: { role: string; content: string }[] = [];
	const pattern = /<(?:div|details) class="messageCard (user|assistant|reasoning)"[\s\S]*?<div class="(?:messageText|reasoningText)">([\s\S]*?)<\/div>[\s\S]*?<\/(?:div|details)>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html))) {
		const content = stripPanelHtml(match[2]);
		if (!content) {
			continue;
		}
		messages.push({ role: match[1], content });
	}
	return messages;
}

function extractPanelToolOutputs(html: string): Record<string, string>[] {
	const outputs: Record<string, string>[] = [];
	const cardPattern = /<div class="toolCard ([^"]*)"[^>]*data-tool-key="([^"]*)"[\s\S]*?<span class="toolLabel">([\s\S]*?)<\/span>[\s\S]*?<pre class="toolDetails">([\s\S]*?)<\/pre>/g;
	let match: RegExpExecArray | null;
	while ((match = cardPattern.exec(html))) {
		outputs.push({
			id: decodePanelHtmlEntities(match[2]),
			status: stripPanelHtml(match[1]),
			label: stripPanelHtml(match[3]),
			text: stripPanelHtml(match[4]),
		});
	}
	return outputs;
}

function stripPanelHtml(html: string): string {
	return decodePanelHtmlEntities(html)
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function decodePanelHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function historyTitleFromPrompt(promptText: string): string {
	const words = promptText.trim().split(/\s+/).filter(Boolean);
	return words.slice(0, 8).join(' ') || 'Untitled chat';
}

function readSharedPanelThreadsState(workspace: string | undefined): PanelPersistedState | undefined {
	const entries = readSharedPanelThreadEntries(workspace);
	if (!entries.length) {
		return undefined;
	}
	let savedAt = 0;
	for (const entry of entries) {
		if (!isObjectRecord(entry)) {
			continue;
		}
		savedAt = Math.max(
			savedAt,
			typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
			typeof entry.startedAt === 'number' ? entry.startedAt : 0,
			typeof entry.savedAt === 'number' ? entry.savedAt : 0,
		);
	}
	const active = entries[0];
	const activeId = isObjectRecord(active) && typeof active.id === 'string' ? active.id : undefined;
	const currentWorkspace = workspace ?? panelEntryWorkspace(active) ?? panelEntryWorkspace(entries[0]);
	return {
		activeView: 'chat',
		activeHistoryId: activeId,
		currentWorkspace,
		historyEntries: entries,
		promptQueue: [],
		savedAt,
	};
}

function readSharedPanelThreadEntries(workspace: string | undefined): unknown[] {
	const entries: unknown[] = [];
	for (const threadPath of listPanelThreadFilesSync()) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
			if (!isObjectRecord(parsed)) {
				continue;
			}
			const thread = parsed as PanelThreadFile;
			if (workspace && thread.workspace !== workspace) {
				continue;
			}
			const rawEntry = thread.entry;
			if (isObjectRecord(rawEntry) && typeof rawEntry.id === 'string') {
				entries.push({ ...rawEntry, currentWorkspace: thread.workspace });
			}
		} catch {
			// Ignore malformed thread snapshots; valid shared thread files remain the source of truth.
		}
	}
	return entries.sort((left, right) => panelThreadEntryTimestamp(right) - panelThreadEntryTimestamp(left));
}

function readSharedPanelThreadWorkspace(id: string | undefined): string | undefined {
	if (!id) {
		return undefined;
	}
	for (const threadPath of listPanelThreadFilesSync()) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
			if (!isObjectRecord(parsed)) {
				continue;
			}
			const entry = isObjectRecord(parsed.entry) ? parsed.entry : undefined;
			const entryId = typeof entry?.id === 'string' ? entry.id : undefined;
			if (entryId === id) {
				return typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
			}
		} catch {
			// Ignore unreadable snapshots.
		}
	}
	return undefined;
}

function readBackboardThreadId(value: unknown): string | undefined {
	if (!isObjectRecord(value)) {
		return undefined;
	}
	for (const candidate of [value.backboardThreadId, value.threadId]) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate;
		}
	}
	return undefined;
}

function panelThreadEntryTimestamp(value: unknown): number {
	if (!isObjectRecord(value)) {
		return 0;
	}
	return Math.max(
		typeof value.updatedAt === 'number' ? value.updatedAt : 0,
		typeof value.startedAt === 'number' ? value.startedAt : 0,
		typeof value.savedAt === 'number' ? value.savedAt : 0,
	);
}

function readPanelHistoryEntry(workspace: string | undefined, id: string | undefined): Record<string, unknown> | undefined {
	if (!id) {
		return undefined;
	}
	const entries = readSharedPanelState(workspace)?.historyEntries;
	if (!Array.isArray(entries)) {
		return undefined;
	}
	const entry = entries.find(candidate => isObjectRecord(candidate) && candidate.id === id);
	return isObjectRecord(entry) ? entry : undefined;
}

const panelThreadWriteVersions = new Map<string, number>();
const panelThreadIdSignatures = new Map<string, string>();

async function writeSharedPanelThreads(state: PanelPersistedState): Promise<void> {
	const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
	const threadsDir = backboardThreadsDir();
	await fs.promises.mkdir(threadsDir, { recursive: true });
	const workspace = panelStateWorkspace(state);
	const currentIds = new Set<string>();
	for (const entry of entries) {
		if (!isObjectRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
			continue;
		}
		currentIds.add(entry.id);
		if (!hasPanelThreadPayload(entry)) {
			continue;
		}
		const entryWorkspace = panelEntryWorkspace(entry) ?? workspace;
		const threadPath = panelThreadPath(entryWorkspace, entry.id);
		const entryVersion = panelThreadEntryTimestamp(entry);
		if (panelThreadWriteVersions.get(threadPath) === entryVersion) {
			continue;
		}
		await fs.promises.mkdir(path.dirname(threadPath), { recursive: true });
		await writeJsonFileAtomic(threadPath, {
			version: 1,
			source: 'panel',
			workspace: entryWorkspace,
			threadId: entry.id,
			savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now(),
			entry,
		});
		if (process.platform !== 'win32') {
			await fs.promises.chmod(threadPath, 0o600);
		}
		panelThreadWriteVersions.set(threadPath, entryVersion);
	}
	const workspaceKey = workspace ?? 'default';
	const idSignature = [...currentIds].sort().join('\n');
	if (panelThreadIdSignatures.get(workspaceKey) !== idSignature) {
		await pruneSharedPanelThreads(state, currentIds);
		panelThreadIdSignatures.set(workspaceKey, idSignature);
	}
}

async function pruneSharedPanelThreads(state: PanelPersistedState, currentIds: Set<string>): Promise<void> {
	const workspace = typeof state.currentWorkspace === 'string' ? state.currentWorkspace : undefined;
	if (!workspace) {
		return;
	}
	await Promise.all((await listPanelThreadFiles()).map(async threadPath => {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(threadPath, 'utf8'));
			if (!isObjectRecord(parsed)) {
				return;
			}
			const entry = isObjectRecord(parsed.entry) ? parsed.entry : undefined;
			const entryId = typeof entry?.id === 'string' ? entry.id : undefined;
			if (parsed.source === 'panel' && parsed.workspace === workspace && entryId && !currentIds.has(entryId)) {
				await fs.promises.unlink(threadPath);
				await removeEmptyAncestorDirectories(path.dirname(threadPath), backboardThreadsDir());
			}
		} catch {
			// Leave unreadable files alone; they may be from a newer format.
		}
	}));
}

function listPanelThreadFilesSync(): string[] {
	const root = backboardThreadsDir();
	const files: string[] = [];
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			const entryPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				for (const threadEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
					const threadEntryPath = path.join(entryPath, threadEntry.name);
					if (threadEntry.isDirectory()) {
						const threadPath = path.join(threadEntryPath, 'thread.json');
						if (fs.existsSync(threadPath)) {
							files.push(threadPath);
						}
					}
				}
			}
		}
	} catch {
		return [];
	}
	return files;
}

async function listPanelThreadFiles(): Promise<string[]> {
	return listPanelThreadFilesSync();
}

async function removeEmptyAncestorDirectories(startDir: string, stopDir: string): Promise<void> {
	let current = startDir;
	while (current.startsWith(stopDir) && current !== stopDir) {
		try {
			await fs.promises.rmdir(current);
		} catch {
			return;
		}
		current = path.dirname(current);
	}
}

function panelThreadPath(workspace: string | undefined, id: string): string {
	return path.join(backboardThreadsDir(), safeWorkspaceThreadDirName(workspace), safePanelThreadFileName(id), 'thread.json');
}

function safeWorkspaceThreadDirName(workspace: string | undefined): string {
	const normalized = workspace || 'default';
	const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
	const label = safePanelThreadFileName(path.basename(normalized) || 'default').slice(0, 40) || 'default';
	return `${label}-${digest}`;
}

function safePanelThreadFileName(id: string): string {
	return id.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	await fs.promises.writeFile(tempPath, `${JSON.stringify(value, undefined, '\t')}\n`, 'utf8');
	await fs.promises.rename(tempPath, filePath);
}

function redactSensitiveValues(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => redactSensitiveValues(item));
	}
	if (!isObjectRecord(value)) {
		return value;
	}
	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		redacted[key] = /api[-_]?key|authorization|password|secret|token/i.test(key)
			? '<redacted>'
			: redactSensitiveValues(item);
	}
	return redacted;
}

function isVoiceAttachment(value: unknown): value is VoiceAttachment {
	return isObjectRecord(value)
		&& Array.isArray(value.data)
		&& value.data.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
		&& typeof value.fileName === 'string'
		&& value.fileName.trim().length > 0
		&& typeof value.mimeType === 'string'
		&& value.mimeType.trim().length > 0;
}

function isImageAttachment(value: unknown): value is ImageAttachment {
	return isObjectRecord(value)
		&& Array.isArray(value.data)
		&& value.data.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
		&& typeof value.fileName === 'string'
		&& value.fileName.trim().length > 0
		&& typeof value.mimeType === 'string'
		&& value.mimeType.trim().length > 0;
}

function isFileAttachment(value: unknown): value is FileAttachment {
	return isObjectRecord(value)
		&& Array.isArray(value.data)
		&& value.data.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
		&& typeof value.fileName === 'string'
		&& value.fileName.trim().length > 0
		&& typeof value.mimeType === 'string'
		&& value.mimeType.trim().length > 0;
}

function fileAttachments(value: unknown): readonly FileAttachment[] {
	return Array.isArray(value) ? value.filter(isFileAttachment) : [];
}

function isBridgeModel(value: unknown): value is BridgeModel {
	if (!isObjectRecord(value)) {
		return false;
	}
	return typeof value.provider === 'string' && value.provider.trim().length > 0
		&& typeof value.name === 'string' && value.name.trim().length > 0;
}

function bridgeProviderKey(provider: string): string {
	return provider.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function isVisibleBridgeModel(model: BridgeModel): boolean {
	return !hiddenModelProviders.has(bridgeProviderKey(model.provider)) && isLlmBridgeModel(model);
}

function isLlmBridgeModel(model: BridgeModel): boolean {
	return !model.modelType || model.modelType.trim().toLowerCase() === 'llm';
}

function isFileNotFoundError(error: unknown): boolean {
	return isObjectRecord(error) && error.code === 'ENOENT';
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function normalizeBackboardEnv(env: string | undefined): string {
	switch ((env || 'prod').trim().toLowerCase()) {
		case '':
			return 'prod';
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (env || 'prod').trim().toLowerCase();
	}
}

function currentBackboardEnv(): string {
	const config = vscode.workspace.getConfiguration('backboard');
	return normalizeBackboardEnv(config.get<string>('env'));
}

function readBackboardConfigJsonSync(): BackboardConfigJson {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(backboardConfigPath(), 'utf8'));
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isFileNotFoundError(error) || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

async function readBackboardConfigJson(): Promise<BackboardConfigJson> {
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(backboardConfigPath(), 'utf8'));
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isFileNotFoundError(error) || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

function backboardConfigEnvKeys(config: BackboardConfigJson): Record<string, string> {
	const envKeys = config.env_keys;
	if (!isObjectRecord(envKeys)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [env, apiKey] of Object.entries(envKeys)) {
		if (typeof apiKey === 'string') {
			result[normalizeBackboardEnv(env)] = apiKey;
		}
	}
	return result;
}

function backboardConfigApiKey(config: BackboardConfigJson): string | undefined {
	const apiKey = stringValueFromRecord(config.api_key);
	if (apiKey) {
		return apiKey;
	}
	const env = normalizeBackboardEnv(config.env);
	return stringValueFromRecord(backboardConfigEnvKeys(config)[env]);
}

function backboardConfigAccessToken(config: BackboardConfigJson): string | undefined {
	const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
	return stringValueFromRecord(oauth?.access_token);
}

function configuredBackboardAccessToken(): string | undefined {
	return backboardConfigAccessToken(readBackboardConfigJsonSync());
}

function configuredBackboardApiKey(): string | undefined {
	const configured = vscode.workspace.getConfiguration('backboard').get<string>('apiKey')?.trim();
	return configured || backboardConfigApiKey(readBackboardConfigJsonSync());
}

function hasBackboardCredentials(): boolean {
	const config = readBackboardConfigJsonSync();
	return Boolean(configuredBackboardApiKey() || backboardConfigAccessToken(config));
}

async function updateBackboardAuthContext(): Promise<void> {
	await vscode.commands.executeCommand('setContext', 'backboard.authenticated', hasBackboardCredentials());
}

async function writeBackboardConfigJson(config: BackboardConfigJson): Promise<void> {
	const configPath = backboardConfigPath();
	const configDir = path.dirname(configPath);
	await fs.promises.mkdir(configDir, { recursive: true });
	const tempPath = path.join(configDir, `config.${process.pid}.${Date.now()}.tmp`);
	const contents = `${JSON.stringify(config, undefined, '\t')}\n`;
	await fs.promises.writeFile(tempPath, contents, { mode: 0o600 });
	await fs.promises.rename(tempPath, configPath);
	if (process.platform !== 'win32') {
		await fs.promises.chmod(configPath, 0o600);
	}
	await updateBackboardAuthContext();
}

async function saveBackboardConfigApiKey(apiKey: string): Promise<void> {
	const config = await readBackboardConfigJson();
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv());
	const envKeys = backboardConfigEnvKeys(config);
	envKeys[env] = apiKey;
	await writeBackboardConfigJson({
		...config,
		env,
		api_key: apiKey,
		env_keys: envKeys
	});
}

async function saveBackboardOAuthTokens(tokens: BackboardOAuthTokens): Promise<BackboardOAuthSaveResult> {
	const accessToken = stringValueFromRecord(tokens.access_token);
	if (!accessToken) {
		throw new Error('Backboard token response did not include an access token.');
	}
	const directApiKey = stringValueFromRecord(tokens.api_key) ?? stringValueFromRecord(tokens.apiKey);
	const backboardApiKey = stringValueFromRecord(tokens.backboard_api_key);
	const personalApiKey = stringValueFromRecord(tokens.personal_api_key);
	const usableApiKey = directApiKey ?? backboardApiKey ?? personalApiKey;
	const assistantId = stringValueFromRecord(tokens.assistant_id);

	const config = await readBackboardConfigJson();
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv());
	const envKeys = backboardConfigEnvKeys(config);
	if (usableApiKey) {
		envKeys[env] = usableApiKey;
	}

	await writeBackboardConfigJson({
		...config,
		env,
		api_key: usableApiKey ?? config.api_key,
		env_keys: envKeys,
		oauth: {
			access_token: accessToken,
			refresh_token: stringValueFromRecord(tokens.refresh_token),
			token_type: stringValueFromRecord(tokens.token_type),
			expires_in: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
			scope: stringValueFromRecord(tokens.scope),
			id_token: stringValueFromRecord(tokens.id_token),
			assistant_id: assistantId,
			api_key: directApiKey,
			backboard_api_key: backboardApiKey,
			personal_api_key: personalApiKey,
			selected_client_name: stringValueFromRecord(tokens.selected_client_name),
			obtained_at: new Date().toISOString()
		}
	});
	await cacheBackboardUserName(accessToken);
	return { apiKeySaved: Boolean(usableApiKey), assistantId };
}

async function clearBackboardConfigApiKey(): Promise<void> {
	const config = await readBackboardConfigJson();
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv());
	const envKeys = backboardConfigEnvKeys(config);
	delete envKeys[env];
	const nextConfig: Record<string, unknown> = {
		...config,
		env,
		env_keys: envKeys
	};
	delete nextConfig.api_key;
	delete nextConfig.oauth;
	await writeBackboardConfigJson(nextConfig);
}


function renderBridgeEvent(event: BridgeEvent, response: ResponseSink, currentToolRequest: ToolResultRequest | undefined): ToolResultRequest | undefined {
	switch (event.type) {
		case 'progress':
			if (event.message) {
				response.progress(event.message);
			}
			return currentToolRequest;
		case 'assistantTextDelta':
			if (event.text) {
				response.markdown(event.text);
			}
			return currentToolRequest;
		case 'reasoningDelta':
			if (event.text) {
				response.event?.('reasoningDelta', { text: event.text });
			}
			return currentToolRequest;
		case 'media':
			response.event?.('media', event.chunk ?? event);
			return currentToolRequest;
		case 'voice':
			response.event?.('voice', event.chunk ?? event);
			return currentToolRequest;
		case 'usage':
			response.event?.('usage', event.usage ?? event);
			return currentToolRequest;
		case 'sessionBinding':
			response.event?.('sessionBinding', event);
			return currentToolRequest;
		case 'toolRequested':
			response.event?.('toolRequested', event.toolCalls ?? []);
			response.progress(`Running ${event.toolCalls?.length ?? 0} local tool call(s).`);
			return { threadId: event.threadId, runId: event.runId, toolCalls: event.toolCalls ?? [] };
		case 'error':
			if (isRecoverableToolOutputSubmissionError(event.message)) {
				response.progress(event.message ?? 'Tool output was already handled.');
				return currentToolRequest;
			}
			response.markdown(`\n\nBackboard error: ${event.message ?? 'request failed'}\n\n`);
			return currentToolRequest;
		default:
			return currentToolRequest;
	}
}

function toolResultRequestKey(request: ToolResultRequest): string {
	const toolCallIds = request.toolCalls.map(toolCallIdentity).join(',');
	return `${request.threadId ?? ''}:${request.runId ?? ''}:${toolCallIds}`;
}

function isRecoverableToolOutputSubmissionError(message: string | undefined): boolean {
	return typeof message === 'string'
		&& (
			(message.includes('Tool outputs for run ID') && message.includes('were already submitted'))
			|| message.includes('No assistant message found requiring action for run ID')
		);
}

function toolCallIdentity(raw: unknown): string {
	const value = isObjectRecord(raw) ? raw : {};
	const fn = isObjectRecord(value.function) ? value.function : {};
	return firstStringProperty(value, ['id', 'tool_call_id', 'toolCallId', 'call_id', 'callId'])
		?? firstStringProperty(fn, ['name'])
		?? safeCompactString(raw);
}

function safeCompactString(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function enqueueToolResultRequest(queue: ToolResultRequest[], request: ToolResultRequest | undefined, seenRequests: Set<string>): void {
	if (!request || request.toolCalls.length === 0) {
		return;
	}
	const key = toolResultRequestKey(request);
	if (seenRequests.has(key)) {
		logToolDiagnostic('duplicate-tool-request-skipped', {
			id: request.runId ?? 'unknown',
			name: 'submit_tool_outputs',
			args: { threadId: request.threadId, runId: request.runId, toolCalls: request.toolCalls.length }
		});
		return;
	}
	seenRequests.add(key);
	queue.push(request);
}

class BackboardPanelProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private runToken: vscode.CancellationTokenSource | undefined;
	private activePromptRun: Promise<void> | undefined;
	private promptRunSerial = 0;
	private pendingPanelState: PanelPersistedState | undefined;
	private panelStateSave: Promise<void> | undefined;

	constructor(private readonly bridge: BackboardBridge, private readonly context: vscode.ExtensionContext) {
	}

	async postUiCommand(command: 'newChat' | 'showHistory' | 'showChat', workspace?: string): Promise<boolean> {
		return this.view?.webview.postMessage({ type: 'command', command, workspace }) ?? false;
	}

	async whenReady(timeoutMs = 2000): Promise<boolean> {
		if (this.view) {
			return true;
		}
		const expires = Date.now() + timeoutMs;
		while (!this.view && Date.now() < expires) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return !!this.view;
	}

	async openHistoryEntry(chatId: string | undefined): Promise<boolean> {
		if (!chatId) {
			return this.postUiCommand('showHistory');
		}
		return this.view?.webview.postMessage({ type: 'command', command: 'openHistoryEntry', chatId }) ?? false;
	}

	refreshState(): void {
		const view = this.view;
		if (view) {
			// Config-file changes can switch accounts or credentials without
			// changing the environment. Revalidate instead of accepting model
			// metadata cached for the previous identity.
			void postPanelState(this.bridge, view.webview, true);
		}
	}

	refreshModels(): void {
		const view = this.view;
		if (view) {
			void postPanelState(this.bridge, view.webview, true);
			return;
		}
		this.bridge.refreshModels();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		// The panel just became visible: start the serve process and resolve
		// the assistant now, while the user is still typing their first
		// message, instead of paying CLI startup on the first send.
		this.bridge.warmUp();
		webviewView.title = '\u200B';
		webviewView.webview.options = { enableScripts: true, localResourceRoots: webviewLocalResourceRoots(this.context) };
		webviewView.webview.html = panelHtml(webviewView.webview, codiconsStylesheetUri(this.context, webviewView.webview), iconBaseUri(this.context, webviewView.webview), fontBaseUri(this.context, webviewView.webview), { showHeader: false, initialState: this.readPanelState() });
		webviewView.webview.onDidReceiveMessage(message => {
			if (message?.type === 'send' && typeof message.prompt === 'string') {
				this.runPrompt(message.prompt, asPanelOptions(message.options), typeof message.chatId === 'string' ? message.chatId : undefined, undefined, typeof message.workspace === 'string' ? message.workspace : undefined, isImageAttachment(message.imageFile) ? message.imageFile : undefined, fileAttachments(message.files));
			} else if (message?.type === 'sendVoice' && isVoiceAttachment(message.audio)) {
				this.runPrompt(typeof message.prompt === 'string' ? message.prompt : '', asPanelOptions(message.options), typeof message.chatId === 'string' ? message.chatId : undefined, message.audio, typeof message.workspace === 'string' ? message.workspace : undefined);
			} else if (message?.type === 'cancel') {
				this.runToken?.cancel();
			} else if (message?.type === 'reviewChanges') {
				void vscode.commands.executeCommand('workbench.view.scm');
				} else if (message?.type === 'setApiKey') {
					void promptBackboardSso(this.bridge).then(changed => {
						if (changed) {
							void postPanelState(this.bridge, webviewView.webview, true);
						}
					});
				} else if (message?.type === 'setupProviderKey' || (process.platform !== 'win32' && message?.type === 'setupSubscription')) {
					const command = message.type === 'setupProviderKey' ? 'backboard.setupProviderKey' : 'backboard.setupSubscription';
					void vscode.commands.executeCommand(command).then(
						() => postPanelState(this.bridge, webviewView.webview, true),
						() => vscode.window.showErrorMessage('Setup failed. Please try again.')
					);
				} else if (message?.type === 'signIn') {
					void promptBackboardSso(this.bridge).then(changed => {
						if (changed) {
							void postPanelState(this.bridge, webviewView.webview, true);
						}
					});
				} else if (message?.type === 'insertActiveFile') {
				void postComposerContext(webviewView.webview, 'activeFile');
			} else if (message?.type === 'insertSelection') {
				void postComposerContext(webviewView.webview, 'selection');
			} else if (message?.type === 'insertBranchDiff') {
				void postBranchDiff(webviewView.webview);
			} else if (message?.type === 'ready' || message?.type === 'refreshModels') {
				// The initial host-side call below can paint cached models quickly,
				// but cache is never authoritative for a newly-created webview. Once
				// its message listener is ready, revalidate so first load cannot stay
				// empty or stale until an unrelated mode change forces a refresh.
				void postPanelState(this.bridge, webviewView.webview, true);
				void this.postPanelStateSnapshot();
			} else if (message?.type === 'refreshUsage') {
				void postUsageSnapshot(this.bridge, webviewView.webview);
			} else if (message?.type === 'saveSettings') {
				void savePanelOptions(asPanelOptions(message.options));
			} else if (message?.type === 'panelState' && isPanelPersistedState(message.state)) {
				void this.savePanelState(message.state);
			} else if (message?.type === 'syncPanelState') {
				void this.postPanelStateSnapshot();
			}
		});
		void postPanelState(this.bridge, webviewView.webview);
		void this.postPanelStateSnapshot();
	}

	private readPanelState(): PanelPersistedState {
		const currentWorkspace = workspacePath();
		return readSharedPanelState(currentWorkspace) ?? {};
	}

	private async savePanelState(state: PanelPersistedState): Promise<void> {
		this.pendingPanelState = state;
		if (!this.panelStateSave) {
			this.panelStateSave = this.flushPanelState().finally(() => {
				this.panelStateSave = undefined;
				if (this.pendingPanelState) {
					void this.savePanelState(this.pendingPanelState);
				}
			});
		}
		await this.panelStateSave;
	}

	private async flushPanelState(): Promise<void> {
		while (this.pendingPanelState) {
			const state = this.pendingPanelState;
			this.pendingPanelState = undefined;
			await writeSharedPanelState(state).catch(error => {
				backboardToolOutput?.appendLine(`[panel-state] failed to save shared state: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}

	async postPanelStateSnapshot(): Promise<void> {
		await this.view?.webview.postMessage({ type: 'panelStateSnapshot', state: this.readPanelState() });
	}

	private runPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string, image?: ImageAttachment, files: readonly FileAttachment[] = []): void {
		if (this.activePromptRun) {
			void this.view?.webview.postMessage({ type: 'sendRejected', text: 'Backboard is still finishing the previous turn. Try Run again in a moment.' });
			return;
		}
		const serial = ++this.promptRunSerial;
		const run = (async () => {
			if (serial !== this.promptRunSerial) {
				return;
			}
			await this.sendPrompt(prompt, options, chatId, audio, workspaceOverride, image, files);
		})();
		this.activePromptRun = run;
		void run.finally(() => {
			if (this.activePromptRun === run) {
				this.activePromptRun = undefined;
			}
		});
	}

	private async sendPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string, image?: ImageAttachment, files: readonly FileAttachment[] = []): Promise<void> {
		const view = this.view;
		if (!view || (!prompt.trim() && !audio)) {
			return;
		}
		const settings = resolveTurnSettings(options);
		const voiceMode = audio && (settings.voiceMode === 'off' || settings.voiceMode === 'tts') ? 'conversation' : settings.voiceMode;
		const voiceBlock = audio ? undefined : unsupportedVoiceModeMessage(voiceMode);
		if (voiceBlock) {
			await view.webview.postMessage({ type: 'status', text: voiceBlock });
			return;
		}
		this.runToken?.cancel();
		this.runToken = new vscode.CancellationTokenSource();
		const token = this.runToken.token;
		const actualWorkspace = workspacePath();
		const requestedWorkspace = workspaceOverride?.trim();
		if (requestedWorkspace && actualWorkspace && requestedWorkspace !== actualWorkspace) {
			backboardToolOutput?.appendLine(`[panel] ignored stale workspace override ${requestedWorkspace}; using open workspace ${actualWorkspace}`);
			await view.webview.postMessage({ type: 'settings', settings: publicSettings(readSettings()), workspace: actualWorkspace });
		}
		const effectiveWorkspace = requestedWorkspace && (!actualWorkspace || requestedWorkspace === actualWorkspace)
			? requestedWorkspace
			: actualWorkspace;
		const chatWorkspace = readSharedPanelThreadWorkspace(chatId);
		const effectiveChatId = chatId && (!chatWorkspace || !effectiveWorkspace || chatWorkspace === effectiveWorkspace) ? chatId : undefined;
		if (chatId && chatWorkspace && effectiveWorkspace && chatWorkspace !== effectiveWorkspace) {
			backboardToolOutput?.appendLine(`[panel] ignored stale chat ${chatId} from ${chatWorkspace}; using fresh chat in ${effectiveWorkspace}`);
		}
		const liveChatId = effectiveChatId ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sessionId = `panel:${effectiveWorkspace ?? 'default'}:${effectiveChatId || 'default'}`;
		const existingEntry = effectiveChatId ? readPanelHistoryEntry(effectiveWorkspace, effectiveChatId) : undefined;
		const sink = this.panelSink(view);
		const content = prompt.trim() || 'Please transcribe this audio and respond.';
		const attachments = backboardAttachments(image, files);
		let boundThreadId = readBackboardThreadId(existingEntry);
		const modelContent = content;
		const imageGeneration = imageGenerationForPrompt(modelContent, settings.imageGeneration);
		const liveStartedAt = Date.now();
		const existingMessages = normalizePanelMessages(existingEntry?.messages);
		const liveMessages: { role: string; content: string }[] = [...existingMessages, { role: 'user', content }];
		const appendLiveAssistantText = (text: string) => {
			const last = liveMessages[liveMessages.length - 1];
			if (last?.role === 'assistant') {
				const spacer = last.content && text && /[.:!?)]$/.test(last.content) && /^[A-Z0-9"'(]/.test(text) ? ' ' : '';
				liveMessages[liveMessages.length - 1] = { role: 'assistant', content: `${last.content}${spacer}${text}` };
			} else {
				liveMessages.push({ role: 'assistant', content: text });
			}
		};
		const appendLiveReasoningText = (text: string) => {
			const last = liveMessages[liveMessages.length - 1];
			if (last?.role === 'reasoning') {
				liveMessages[liveMessages.length - 1] = { role: 'reasoning', content: `${last.content}${text}` };
			} else {
				liveMessages.push({ role: 'reasoning', content: text });
			}
		};
		await view.webview.postMessage({ type: 'runStarted', prompt: content, chatId: liveChatId });
		await view.webview.postMessage({ type: 'status', text: 'Sending to Backboard.' });
		const saveHistory = async (status: string) => {
			const now = Date.now();
			const latestState = readSharedPanelState(effectiveWorkspace);
			const latestEntry = readPanelHistoryEntry(effectiveWorkspace, liveChatId);
			const previousEntry = latestEntry ?? existingEntry ?? {};
			const preservedPromptQueue = Array.isArray(latestEntry?.promptQueue)
				? latestEntry.promptQueue
				: Array.isArray(latestState?.promptQueue) ? latestState.promptQueue : [];
			const nextEntry = {
				...previousEntry,
				id: liveChatId,
				backboardThreadId: boundThreadId,
				title: typeof previousEntry.title === 'string' ? previousEntry.title : historyTitleFromPrompt(content),
				prompt: typeof previousEntry.prompt === 'string' ? previousEntry.prompt : content,
				currentWorkspace: effectiveWorkspace,
				startedAt: typeof previousEntry.startedAt === 'number' ? previousEntry.startedAt : liveStartedAt,
				updatedAt: now,
				status,
				fileChanges: Array.isArray(previousEntry.fileChanges) ? previousEntry.fileChanges : [],
				promptQueue: preservedPromptQueue,
				messages: liveMessages.map(message => ({ ...message })),
				outputText: liveMessages.filter(message => message.role === 'assistant').map(message => message.content).join('\n\n'),
			};
			const existingEntries = Array.isArray(latestState?.historyEntries) ? latestState.historyEntries : [];
			// Update entry in-place instead of moving it to the front
			const existingIdx = existingEntries.findIndex(entry => isObjectRecord(entry) && entry.id === liveChatId);
			let historyEntries;
			if (existingIdx >= 0) {
				historyEntries = [...existingEntries.slice(0, existingIdx), nextEntry, ...existingEntries.slice(existingIdx + 1)];
			} else {
				historyEntries = [nextEntry, ...existingEntries];
			}
			await writeSharedPanelState({
				activeView: 'chat',
				activeHistoryId: liveChatId,
				currentWorkspace: effectiveWorkspace,
				promptQueue: preservedPromptQueue,
				historyEntries,
				savedAt: now,
			});
		};
		const pendingToolRequests: ToolResultRequest[] = [];
		const seenToolRequests = new Set<string>();
		try {
			let currentToolRequest: ToolResultRequest | undefined;
			// The serve submit op carries no tool schemas (cli-ts owns tool
			// execution), so the trimmed tool list only feeds the legacy
			// tool-continuation loop below. Resolve it off the critical path: a
			// cold tool cache would otherwise serialize a full bridge round trip
			// before the prompt even reaches the agent.
			const submitToolsPromise = this.bridge.listTools(settings.mode, token)
				.then(tools => trimBackboardToolsForRequest(tools, modelContent, imageGeneration))
				.catch(() => undefined);
			await this.bridge.send('sendPrompt', sessionId, {
				content: modelContent,
				threadId: boundThreadId,
				workspace: effectiveWorkspace,
				provider: settings.defaultProvider,
				model: settings.defaultModel,
				mode: settings.mode,
				intensity: settings.intensity,
				webSearch: 'Auto',
				imageGeneration: imageGeneration === 'auto' ? 'auto' : undefined,
				voiceMode,
				audioFile: audio,
				files: attachments,
				mcpCalls: mcpCallsPayload(settings),
				config: settings.config
			}, event => {
				if (event.type === 'sessionBinding' && event.threadId) {
					boundThreadId = event.threadId;
				}
				if (event.type === 'assistantTextDelta') {
					const text = typeof event.text === 'string' ? event.text : '';
					if (text) {
						appendLiveAssistantText(text);
					}
				} else if (event.type === 'reasoningDelta') {
					const text = typeof event.text === 'string' ? event.text : '';
					if (text) {
						appendLiveReasoningText(text);
					}
				} else if (event.type === 'error') {
					const message = event.message ?? 'Backboard request failed.';
					liveMessages.push({ role: 'error', content: message });
				}
				const toolRequest = renderBridgeEvent(event, sink, currentToolRequest);
				if (toolRequest && toolRequest !== currentToolRequest) {
					currentToolRequest = toolRequest;
					enqueueToolResultRequest(pendingToolRequests, toolRequest, seenToolRequests);
				}
			}, token);

			// Long resolved by now: the turn above finished before this await.
			const submitTools = await submitToolsPromise;
			let nextToolRequest = pendingToolRequests.shift();
			while (nextToolRequest && !token.isCancellationRequested) {
				const toolOutputs = await executeToolCalls(this.bridge, nextToolRequest.toolCalls, settings.mode, sink, token);
				if (token.isCancellationRequested) {
					break;
				}
				if (toolOutputs.length !== nextToolRequest.toolCalls.length) {
					await view.webview.postMessage({ type: 'status', text: 'Stopped before submitting incomplete tool outputs.' });
					break;
				}
				let currentContinuationToolRequest: ToolResultRequest | undefined;
				await this.bridge.send('submitToolResult', sessionId, {
					threadId: nextToolRequest.threadId,
					runId: nextToolRequest.runId,
					toolOutputs,
					tools: submitTools,
					config: settings.config
				}, event => {
					if (event.type === 'sessionBinding' && event.threadId) {
						boundThreadId = event.threadId;
					}
					if (event.type === 'assistantTextDelta') {
						const text = typeof event.text === 'string' ? event.text : '';
						if (text) {
							appendLiveAssistantText(text);
						}
					} else if (event.type === 'reasoningDelta') {
						const text = typeof event.text === 'string' ? event.text : '';
						if (text) {
							appendLiveReasoningText(text);
						}
					} else if (event.type === 'error') {
						const message = event.message ?? 'Backboard request failed.';
						liveMessages.push({ role: 'error', content: message });
					}
					const followupToolRequest = renderBridgeEvent(event, sink, currentContinuationToolRequest);
					if (followupToolRequest && followupToolRequest !== currentContinuationToolRequest) {
						currentContinuationToolRequest = followupToolRequest;
						enqueueToolResultRequest(pendingToolRequests, followupToolRequest, seenToolRequests);
					}
				}, token);
				nextToolRequest = pendingToolRequests.shift();
			}
			await view.webview.postMessage({ type: 'runFinished', chatId: liveChatId });
			await view.webview.postMessage({ type: 'status', text: token.isCancellationRequested ? 'Cancelled.' : 'Done.' });
			await saveHistory(token.isCancellationRequested ? 'Cancelled' : 'Done');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			liveMessages.push({ role: 'error', content: message });
			await view.webview.postMessage({ type: 'append', role: 'error', text: message });
			await view.webview.postMessage({ type: 'runFinished', chatId: liveChatId });
			await saveHistory('Failed').catch(saveError => {
				backboardToolOutput?.appendLine(`[panel] failed to save history: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
			});
			await handleBackboardError(view.webview, error, this.bridge);
		}
	}

	private panelSink(view: vscode.WebviewView): ResponseSink {
		return {
			markdown: value => {
				void view.webview.postMessage({ type: 'delta', role: 'assistant', text: typeof value === 'string' ? value : value.value });
			},
			progress: value => {
				void view.webview.postMessage({ type: 'status', text: value });
				},
				event: (type, payload) => {
					void view.webview.postMessage({ type, payload });
				}
			};
		}
	}

class BackboardBridge implements vscode.Disposable {
	private static readonly modelCacheTtl = 24 * 60 * 60 * 1000;
	private activeTurnRequestId: string | undefined;
	private currentCwd: string | undefined;
	private static readonly modelCacheVersion = 3;
	private static readonly toolCacheTtl = 24 * 60 * 60 * 1000;
	private static readonly toolCacheVersion = 2;
	private readonly cacheIdeVersion = readCurrentAppVersion();
	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly output = vscode.window.createOutputChannel('Backboard Bridge');
	private pendingModelRefresh: Promise<BridgeModel[]> | undefined;
	private readonly pendingToolRefreshes = new Map<string, Promise<unknown[]>>();

	constructor(private readonly context: vscode.ExtensionContext) {
	}

	dispose(): void {
		for (const pending of this.pending.values()) {
			pending.reject(new Error('Backboard bridge disposed.'));
		}
		this.pending.clear();
		this.child?.kill();
		this.output.dispose();
	}

	restart(): void {
		this.pendingModelRefresh = undefined;
		this.pendingToolRefreshes.clear();
		const child = this.child;
		this.child = undefined;
		if (!child || child.killed) {
			this.pending.clear();
			return;
		}
		this.output.appendLine(`[${new Date().toISOString()}] Restarting Backboard bridge after credential change`);
		for (const pending of this.pending.values()) {
			pending.reject(new Error('Backboard bridge restarted after credential change.'));
		}
		this.pending.clear();
		child.kill();
		const forceKillTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, 2000);
		forceKillTimer.unref();
	}

	refreshModels(): void {
		void this.listModels(new vscode.CancellationTokenSource().token, true);
	}

	/**
	 * Best-effort warm-up during user think-time: spawns the serve process (so
	 * CLI boot and session/MCP/LSP init happen before the first send) and asks
	 * it to pre-resolve the Backboard assistant. The `warmup` op is sent
	 * without a requestId, so it needs no response bookkeeping and cannot trip
	 * the inactivity timeout; any failure simply surfaces on the real first
	 * send.
	 */
	warmUp(): void {
		if (!hasBackboardCredentials() || this.activeTurnRequestId !== undefined) {
			return;
		}
		try {
			const child = this.ensureProcess();
			child.stdin.write(`${JSON.stringify({ op: 'warmup' })}\n`);
		} catch (error) {
			this.output.appendLine(`[${new Date().toISOString()}] Backboard warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async cachedModels(): Promise<BridgeModel[] | undefined> {
		const entry = await this.readModelCache();
		return entry?.models.length ? entry.models : undefined;
	}

	async cachedTools(mode: string): Promise<unknown[] | undefined> {
		const entry = await this.readToolCache(mode);
		return entry?.tools;
	}

	async hasFreshPanelMetadata(mode: string): Promise<boolean> {
		const [modelCache, toolCache] = await Promise.all([this.readModelCache(), this.readToolCache(mode)]);
		const now = Date.now();
		return Boolean(
			modelCache && modelCache.models.length > 0 && now - modelCache.fetchedAt < BackboardBridge.modelCacheTtl
			&& toolCache && now - toolCache.fetchedAt < BackboardBridge.toolCacheTtl
		);
	}

	async listModels(token: vscode.CancellationToken, forceRefresh = false): Promise<BridgeModel[]> {
		const cached = await this.readModelCache();
		if (!forceRefresh && cached?.models.length && Date.now() - cached.fetchedAt < BackboardBridge.modelCacheTtl) {
			return cached.models;
		}
		if (this.pendingModelRefresh) {
			return this.pendingModelRefresh;
		}
		this.pendingModelRefresh = this.fetchAndCacheModels(token);
		try {
			return await this.pendingModelRefresh;
		} finally {
			this.pendingModelRefresh = undefined;
		}
	}

	private async fetchAndCacheModels(token: vscode.CancellationToken): Promise<BridgeModel[]> {
		const events = await this.send('listModels', undefined, { config: readSettings().config }, undefined, token);
		const models = (events.find(event => event.type === 'models')?.models ?? []).filter(isVisibleBridgeModel);
		await this.writeModelCache(models);
		return models;
	}

	private modelCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'models.json');
	}

	private async readModelCache(): Promise<ModelCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.modelCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			const apiUrl = isObjectRecord(parsed) ? stringValueFromRecord(parsed.apiUrl) : undefined;
			if (!isObjectRecord(parsed)
				|| env !== currentBackboardEnv()
				|| parsed.version !== BackboardBridge.modelCacheVersion
				|| parsed.ideVersion !== this.cacheIdeVersion
				|| apiUrl !== readSettings().config.apiUrl
				|| typeof parsed.fetchedAt !== 'number'
				|| !Array.isArray(parsed.models)) {
				return undefined;
			}
			return { env, version: parsed.version, ideVersion: parsed.ideVersion, apiUrl, fetchedAt: parsed.fetchedAt, models: parsed.models.filter(isBridgeModel).filter(isVisibleBridgeModel) };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeModelCache(models: BridgeModel[]): Promise<void> {
		const cachePath = this.modelCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `models.${process.pid}.${Date.now()}.tmp`);
		const entry: ModelCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.modelCacheVersion,
			ideVersion: this.cacheIdeVersion,
			apiUrl: readSettings().config.apiUrl,
			fetchedAt: Date.now(),
			models: models.filter(isBridgeModel).filter(isVisibleBridgeModel)
		};
		await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(tempPath, cachePath);
	}

	async listTools(mode: string, token: vscode.CancellationToken, forceRefresh = false): Promise<unknown[]> {
		const cached = await this.readToolCache(mode);
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.toolCacheTtl) {
			return cached.tools;
		}
		const pending = this.pendingToolRefreshes.get(mode);
		if (pending) {
			return pending;
		}
		const refresh = this.fetchAndCacheTools(mode, token);
		this.pendingToolRefreshes.set(mode, refresh);
		try {
			return await refresh;
		} finally {
			this.pendingToolRefreshes.delete(mode);
		}
	}

	private async fetchAndCacheTools(mode: string, token: vscode.CancellationToken): Promise<unknown[]> {
		const events = await this.send('listTools', undefined, { mode }, undefined, token);
		const tools = events.find(event => event.type === 'tools')?.tools ?? [];
		await this.writeToolCache(mode, tools);
		return tools;
	}

	private toolCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'tools.json');
	}

	private async readToolCache(mode: string): Promise<ToolCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.toolCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			const apiUrl = isObjectRecord(parsed) ? stringValueFromRecord(parsed.apiUrl) : undefined;
			if (!isObjectRecord(parsed)
				|| env !== currentBackboardEnv()
				|| parsed.version !== BackboardBridge.toolCacheVersion
				|| parsed.ideVersion !== this.cacheIdeVersion
				|| apiUrl !== readSettings().config.apiUrl
				|| parsed.mode !== mode
				|| typeof parsed.fetchedAt !== 'number'
				|| !Array.isArray(parsed.tools)) {
				return undefined;
			}
			return { env, version: parsed.version, ideVersion: parsed.ideVersion, apiUrl, mode, fetchedAt: parsed.fetchedAt, tools: parsed.tools };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeToolCache(mode: string, tools: unknown[]): Promise<void> {
		const cachePath = this.toolCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `tools.${process.pid}.${Date.now()}.tmp`);
		const entry: ToolCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.toolCacheVersion,
			ideVersion: this.cacheIdeVersion,
			apiUrl: readSettings().config.apiUrl,
			mode,
			fetchedAt: Date.now(),
			tools
		};
		await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(tempPath, cachePath);
	}

	async runRustTool(name: string, args: Record<string, unknown>, token: vscode.CancellationToken): Promise<unknown> {
		const events = await this.send('runTool', undefined, { name, args }, undefined, token);
		const result = [...events].reverse().find(event => event.type === 'toolFinished' && event.status === 'finished');
		return result?.output ?? { success: false, error: `Rust tool ${name} did not return output.` };
	}

	async callApi(command: string, params: Record<string, unknown>, token: vscode.CancellationToken): Promise<unknown> {
		const request = { ...params, config: readSettings().config };
		logBackboardDocumentDiagnostic('bridge_call_api_start', { command, params: request });
		const events = await this.send(command, undefined, request, undefined, token);
		const response = events.find(event => event.type === 'apiResponse')?.data;
		logBackboardDocumentDiagnostic('bridge_call_api_response', { command, response, eventTypes: events.map(event => event.type) });
		return response;
	}

	async send(command: string, sessionId: string | undefined, params: unknown, onEvent: ((event: BridgeEvent) => void | Promise<void>) | undefined, token: vscode.CancellationToken): Promise<BridgeEvent[]> {
		const requestId = newId();
		// Commands without a cli-ts serve equivalent resolve synthetically:
		// tool execution moved into cli-ts (no submitToolResult/runTool round
		// trips) and the legacy document CRUD proxy was already non-functional.
		const immediate = immediateServeEvents(command, requestId, sessionId);
		if (immediate) {
			for (const event of immediate) {
				void onEvent?.(event);
			}
			return immediate;
		}
		const child = this.ensureProcess(command === 'sendPrompt' ? serveWorkspaceFromParams(params) : undefined);
		this.logBridgeRequest(requestId, command, sessionId, params);
		const timeoutMs = bridgeInactivityTimeoutMs(command);
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const clearTimeoutHandle = (): void => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
		};
		const resetTimeout = (): void => {
			clearTimeoutHandle();
			if (timeoutMs <= 0) {
				return;
			}
			timeoutHandle = setTimeout(() => {
				const pending = this.pending.get(requestId);
				if (!pending) {
					return;
				}
				const message = `Backboard bridge did not respond to ${command} for ${Math.round(timeoutMs / 1000)}s.`;
				this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
				this.pending.delete(requestId);
				pending.reject(new Error(message));
				this.child?.kill();
			}, timeoutMs);
		};
		const cancelRequest = () => {
			clearTimeoutHandle();
			this.write({ op: 'cancel' });
			const pending = this.pending.get(requestId);
			if (!pending) {
				return;
			}
			this.pending.delete(requestId);
			pending.events.push({ type: 'done', requestId, sessionId, stopReason: 'cancelled' });
			pending.resolve(pending.events);
		};
		const promise = new Promise<BridgeEvent[]>((resolve, reject) => {
			let disposable: vscode.Disposable | undefined;
			this.pending.set(requestId, {
				events: [],
				// Prompt deltas are consumed by the live callback. Retaining every
				// token until the turn ends makes memory grow with the full response.
				collectEvents: command !== 'sendPrompt',
				onEvent,
				resetTimeout,
				resolve: events => {
					clearTimeoutHandle();
					disposable?.dispose();
					resolve(events);
				},
				reject: error => {
					clearTimeoutHandle();
					disposable?.dispose();
					reject(error);
				}
			});
			resetTimeout();
			disposable = token.onCancellationRequested(cancelRequest);
			if (token.isCancellationRequested) {
				cancelRequest();
			}
		});
		if (!token.isCancellationRequested) {
			if (command === 'sendPrompt') {
				this.activeTurnRequestId = requestId;
			}
			child.stdin.write(`${JSON.stringify(buildServeOp(command, requestId, params))}\n`);
		}
		return promise;
	}

	private ensureProcess(workspaceOverride?: string): cp.ChildProcessWithoutNullStreams {
		const cwd = workspaceOverride ?? workspacePath() ?? os.homedir();
		if (this.child && !this.child.killed && this.currentCwd === cwd) {
			return this.child;
		}
		if (this.child && !this.child.killed) {
			// The serve process binds its working directory at spawn; a
			// workspace change needs a fresh process.
			this.output.appendLine(`[${new Date().toISOString()}] Restarting Backboard agent for new workspace ${cwd}`);
			this.child.kill();
			this.child = undefined;
		}
		const cliPath = this.resolveCliPath();
		if (!fs.existsSync(cliPath)) {
			throw new Error(`Backboard agent binary not found at ${cliPath}. Build it with: npm --prefix extensions/backboard run package-cli-ts. Or set backboard.cliPath to a prebuilt backboard-cli-ts binary.`);
		}
		this.output.appendLine(`[${new Date().toISOString()}] Starting Backboard agent (cli-ts serve)`);
		this.output.appendLine(`  cliPath: ${cliPath}`);
		this.output.appendLine(`  cwd: ${cwd}`);
		this.output.appendLine(`  workspaceRoot: ${workspacePath() ?? '<none>'}`);
		this.output.appendLine(`  configuredWorkspaceRoot: ${configuredWorkspaceRoot() ?? '<none>'}`);
		this.currentCwd = cwd;
		const child = cp.spawn(cliPath, ['--serve', '--cwd', cwd], {
			cwd,
			env: { ...process.env, ...serveCredentialEnv() },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		this.child = child;
		readline.createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
		child.stderr.on('data', chunk => this.output.append(chunk.toString()));
		child.on('error', error => {
			this.output.appendLine(`Bridge process error: ${error.message}`);
			for (const pending of this.pending.values()) {
				pending.reject(error);
			}
			this.pending.clear();
			if (this.child === child) {
				this.child = undefined;
			}
		});
		child.on('exit', (code, signal) => {
			this.output.appendLine(`Bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
			for (const pending of this.pending.values()) {
				pending.reject(new Error('Backboard bridge exited.'));
			}
			this.pending.clear();
			if (this.child === child) {
				this.child = undefined;
			}
		});
		return child;
	}

	/**
	 * Signs out of everything the chat can bill to, so the sign-in gate shows:
	 * the IDE's Backboard key, the CLI's saved key, and both subscription
	 * connections. Claude Code and ChatGPT themselves stay signed in; only
	 * Backboard's link to them is removed.
	 */
	async signOut(): Promise<void> {
		await clearBackboardConfigApiKey();
		const failures: string[] = [];
		for (const args of [['logout'], ['subscription', 'logout'], ['claude-subscription', 'logout']]) {
			await new Promise<void>(resolve => {
				cp.execFile(this.resolveCliPath(), args, { timeout: 15000, maxBuffer: 64 * 1024 }, error => {
					if (error) { failures.push(args.join(' ')); }
					resolve();
				});
			});
		}
		this.restart();
		await updateBackboardAuthContext();
		if (failures.length) {
			throw new Error(vscode.l10n.t('Signed out of Backboard, but could not finish: {0}.', failures.join(', ')));
		}
	}

	async hasAlternativeCredentials(): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			cp.execFile(this.resolveCliPath(), ['--alternative-auth-status'], { timeout: 10000, maxBuffer: 4096 }, (error, stdout) => {
				if (error) { reject(new Error('Could not check alternative credentials.')); return; }
				try {
					const status = JSON.parse(stdout);
					if (typeof status.configured !== 'boolean') { throw new Error('Invalid credential status.'); }
					resolve(status.configured);
				} catch { reject(new Error('Invalid alternative credential status.')); }
			});
		});
	}

	async configureProviderKey(provider: string, key: string): Promise<boolean> {
		if (!['openai', 'anthropic', 'google', 'openrouter'].includes(provider) || typeof key !== 'string' || !key.trim()) {
			throw new Error(vscode.l10n.t('Choose a provider and enter an API key.'));
		}
		// Keep secrets out of command arguments, bridge diagnostics and output logs.
		await new Promise<void>((resolve, reject) => {
			const child = cp.spawn(this.resolveCliPath(), ['--configure-provider-key'], { stdio: ['pipe', 'ignore', 'pipe'] });
			const timeout = setTimeout(() => child.kill(), 45000);
			child.stderr.resume();
			child.stdin.on('error', () => { /* Process errors are handled below. */ });
			child.once('error', () => {
				clearTimeout(timeout);
				reject(new Error(vscode.l10n.t('Could not start provider setup. Rebuild or update the bundled agent.')));
			});
			child.once('close', code => {
				clearTimeout(timeout);
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(vscode.l10n.t('Could not verify and save the key. Check the provider, key and network connection, then try again.')));
				}
			});
			child.stdin.end(JSON.stringify({ provider, key }));
		});
		this.restart();
		return true;
	}

	private resolveCliPath(): string {
		const configured = vscode.workspace.getConfiguration('backboard').get<string>('cliPath')?.trim();
		if (configured) {
			return configured;
		}
		return path.join(this.context.extensionPath, 'bin', process.platform === 'win32' ? 'backboard-cli-ts.exe' : 'backboard-cli-ts');
	}

	private write(payload: unknown): void {
		this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private logBridgeRequest(requestId: string, command: string, sessionId: string | undefined, params: unknown): void {
		const payload = {
			requestId,
			command,
			sessionId,
			workspaceRoot: workspacePath() ?? null,
			configuredWorkspaceRoot: configuredWorkspaceRoot() ?? null,
			processCwd: process.cwd(),
			params: redactSensitiveValues(params)
		};
		this.output.appendLine(`[${new Date().toISOString()}] Backboard Studio -> Backboard bridge`);
		if (backboardVerboseBridgeLogging()) {
			this.output.appendLine(JSON.stringify(payload, undefined, '\t'));
		} else {
			this.output.appendLine(JSON.stringify({
				requestId,
				command,
				sessionId,
				workspaceRoot: payload.workspaceRoot,
				configuredWorkspaceRoot: payload.configuredWorkspaceRoot,
				processCwd: payload.processCwd,
				params: bridgeRequestSummary(params),
			}));
		}
	}

	private handleLine(line: string): void {
		let record: ServeStdoutRecord;
		try {
			record = JSON.parse(line) as ServeStdoutRecord;
		} catch {
			this.output.appendLine(line);
			return;
		}
		if (record.source === 'serve') {
			this.handleServeRecord(record);
			return;
		}
		if (record.source === 'client') {
			this.handleAgentEvent(record.payload as ServeAgentEvent | undefined);
			return;
		}
		this.output.appendLine(line);
	}

	private handleServeRecord(record: ServeStdoutRecord): void {
		const requestId = record.requestId;
		if (!requestId) {
			if (record.type === 'serve:error') {
				this.output.appendLine(`[cli-ts] serve error: ${JSON.stringify(record.payload)}`);
			}
			return;
		}
		const payload = isObjectRecord(record.payload) ? record.payload : {};
		switch (record.type) {
			case 'serve:turn':
				if (typeof payload.threadId === 'string' && payload.threadId) {
					this.deliver({ type: 'sessionBinding', requestId, threadId: payload.threadId });
				}
				this.deliver({ type: 'done', requestId, stopReason: typeof payload.status === 'string' ? payload.status : 'end_turn' });
				return;
			case 'serve:models':
				this.deliver({ type: 'models', requestId, models: Array.isArray(payload.models) ? payload.models as BridgeModel[] : [] });
				this.deliver({ type: 'done', requestId, stopReason: 'end_turn' });
				return;
			case 'serve:tools':
				this.deliver({ type: 'tools', requestId, tools: Array.isArray(payload.tools) ? payload.tools : [] });
				this.deliver({ type: 'done', requestId, stopReason: 'end_turn' });
				return;
			case 'serve:error':
				this.deliver({ type: 'error', requestId, message: typeof payload.error === 'string' ? payload.error : 'Backboard agent request failed.' });
				this.deliver({ type: 'done', requestId, stopReason: 'error' });
				return;
			default:
				return;
		}
	}

	/** Translates streamed cli-ts agent events into the legacy event shapes the panel renders. */
	private handleAgentEvent(event: ServeAgentEvent | undefined): void {
		const requestId = this.activeTurnRequestId;
		if (!event || typeof event.type !== 'string' || !requestId) {
			return;
		}
		switch (event.type) {
			case 'assistant:delta':
				if (event.text) {
					this.deliver({ type: 'assistantTextDelta', requestId, text: event.text });
				}
				return;
			case 'assistant:reasoning':
				if (event.text) {
					this.deliver({ type: 'reasoningDelta', requestId, text: event.text });
				}
				return;
			case 'session:created':
				if (event.threadId) {
					this.deliver({ type: 'sessionBinding', requestId, threadId: event.threadId });
				}
				return;
			case 'usage':
				this.deliver({ type: 'usage', requestId, usage: event.usage });
				return;
			case 'turn:status':
				this.deliver({
					type: 'progress',
					requestId,
					message: event.phase === 'generating' ? 'Waiting for model.' : 'Preparing request.',
				});
				return;
			case 'assistant:voice':
				this.deliver({ type: 'voice', requestId, chunk: event.records ?? [] });
				return;
			case 'system:warning':
				if (event.message) {
					this.deliver({ type: 'progress', requestId, message: event.message });
				}
				return;
			case 'run:error':
				this.deliver({ type: 'error', requestId, message: event.error ?? 'Backboard request failed.' });
				return;
			case 'tool:pending':
				this.deliver({ type: 'progress', requestId, message: `Starting ${event.name ?? 'tool'}.` });
				return;
			case 'tool:start':
				this.deliver({ type: 'progress', requestId, message: `${event.name ?? 'Tool'}: ${event.inputSummary ?? ''}` });
				return;
			case 'tool:result':
				this.deliver({ type: 'progress', requestId, message: `${event.name ?? 'Tool'} finished${event.title ? `: ${event.title}` : '.'}` });
				return;
			case 'tool:error':
				this.deliver({ type: 'progress', requestId, message: `${event.name ?? 'Tool'} failed: ${event.error ?? 'unknown error'}` });
				return;
			case 'input:request':
				if (event.request?.id) {
					this.write({ op: 'respondInput', id: event.request.id, answers: [] });
					this.deliver({ type: 'progress', requestId, message: 'Skipped an agent question (not supported in this panel).' });
				}
				return;
			default:
				return;
		}
	}

	private deliver(event: BridgeEvent): void {
		const pending = this.pending.get(event.requestId);
		if (!pending) {
			return;
		}
		pending.resetTimeout();
		if (pending.collectEvents || event.type === 'done') {
			pending.events.push(event);
		}
		void pending.onEvent?.(event);
		if (event.type === 'done') {
			this.pending.delete(event.requestId);
			if (this.activeTurnRequestId === event.requestId) {
				this.activeTurnRequestId = undefined;
			}
			pending.resolve(pending.events);
		}
	}
}

interface ServeStdoutRecord {
	readonly source?: string;
	readonly type?: string;
	readonly requestId?: string;
	readonly payload?: unknown;
}

interface ServeAgentEvent {
	readonly type: string;
	readonly text?: string;
	readonly threadId?: string | null;
	readonly message?: string;
	readonly error?: string;
	readonly name?: string;
	readonly inputSummary?: string;
	readonly title?: string;
	readonly usage?: unknown;
	readonly records?: unknown[];
	readonly phase?: 'preparing' | 'generating';
	readonly request?: {
		readonly id?: string;
		readonly questions?: readonly { readonly header?: string; readonly question: string; readonly options: readonly string[] }[];
	};
}

/** Serve ops for commands that still cross the wire; the rest resolve synthetically. */
function buildServeOp(command: string, requestId: string, params: unknown): Record<string, unknown> {
	if (command === 'sendPrompt') {
		const record = isObjectRecord(params) ? params : {};
		const provider = typeof record.provider === 'string' ? record.provider : 'openrouter';
		const model = typeof record.model === 'string' ? record.model : 'deepseek/deepseek-v4-flash';
		const mode = typeof record.mode === 'string' ? record.mode : 'free';
		const intensity = typeof record.intensity === 'string' ? record.intensity : undefined;
		const audioFile = serveFileAttachment(record.audioFile);
		const files = [
			...(Array.isArray(record.files) ? record.files.map(serveFileAttachment).filter((file): file is Record<string, string> => !!file) : []),
			...(audioFile ? [audioFile] : []),
		];
		// No approval or question UI exists in this panel: run in bypass mode,
		// hide AskUser, and in manual/ask modes hide write tools entirely
		// (parity with the old bridge's manual-mode denials). Callers may
		// exclude further tools for the turn on top of the mode-derived set.
		const modeExcludedTools = mode === 'manual' || mode === 'ask'
			? ['AskUser', 'Write', 'Edit', 'ApplyPatch', 'Execute']
			: ['AskUser'];
		const extraExcludedTools = Array.isArray(record.excludedTools)
			? record.excludedTools.filter((name): name is string => typeof name === 'string')
			: [];
		const excludedTools = [...new Set([...modeExcludedTools, ...extraExcludedTools])];
		// setMemory persists on the serve session, so every submit asserts a
		// value: the cli-ts default unless the caller overrides for the turn.
		const memory = typeof record.memory === 'string' ? record.memory : 'auto';
		const thinking = intensity === 'balanced' ? 'medium' : intensity === 'deep' ? 'high' : intensity === 'fast' ? 'low' : undefined;
		return {
			op: 'submit',
			requestId,
			prompt: typeof record.content === 'string' ? record.content : '',
			...(typeof record.threadId === 'string' && record.threadId ? { threadId: record.threadId } : {}),
			model: `${provider}/${model}`,
			permission: 'bypass',
			excludedTools,
			memory,
			...(thinking ? { thinking } : {}),
			...(files.length ? { files } : {}),
		};
	}
	if (command === 'listModels') {
		return { op: 'listModels', requestId };
	}
	if (command === 'listTools') {
		return { op: 'listTools', requestId };
	}
	return { op: command, requestId };
}

function serveFileAttachment(value: unknown): Record<string, string> | undefined {
	if (!isObjectRecord(value) || !Array.isArray(value.data) || typeof value.fileName !== 'string' || typeof value.mimeType !== 'string') {
		return undefined;
	}
	const bytes = value.data.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255);
	if (!bytes.length || bytes.length !== value.data.length) {
		return undefined;
	}
	return {
		fileName: value.fileName,
		mimeType: value.mimeType,
		dataBase64: Buffer.from(bytes).toString('base64'),
	};
}

/** Terminal events for commands with no serve equivalent. */
function immediateServeEvents(command: string, requestId: string, sessionId: string | undefined): BridgeEvent[] | undefined {
	switch (command) {
		case 'sendPrompt':
		case 'listModels':
		case 'listTools':
			return undefined;
		case 'submitToolResult':
			// cli-ts executes tools itself; the panel's tool loop never runs.
			return [{ type: 'done', requestId, sessionId, stopReason: 'end_turn' }];
		default:
			// Legacy runTool / document CRUD proxy commands. The old bridge
			// already returned no data for the CRUD commands; callers treat an
			// absent payload as "unsupported".
			return [{ type: 'done', requestId, sessionId, stopReason: 'end_turn' }];
	}
}

function serveWorkspaceFromParams(params: unknown): string | undefined {
	return isObjectRecord(params) && typeof params.workspace === 'string' && params.workspace ? params.workspace : undefined;
}

/** Maps the extension's persisted credentials onto the env vars cli-ts reads. */
function serveCredentialEnv(): Record<string, string> {
	const out: Record<string, string> = {
		// Keep cli-ts session logs out of the user's workspace.
		BACKBOARD_SESSION_ROOT: path.join(os.homedir(), '.backboard_ide', 'cli-ts-sessions'),
	};
	const settings = readSettings().config;
	const apiKey = configuredBackboardApiKey();
	if (apiKey) {
		out['BACKBOARD_API_KEY'] = apiKey;
	}
	if (settings.apiUrl) {
		out['BACKBOARD_API_URL'] = settings.apiUrl;
	}
	return out;
}

function bridgeInactivityTimeoutMs(command: string): number {
	switch (command) {
		case 'submitToolResult':
			return 2 * 60_000;
		case 'sendPrompt':
			// This is an inactivity timeout, reset by every streamed event. It
			// permits arbitrarily long active turns without retaining a stalled
			// request forever when a live child stops producing output.
			return 5 * 60_000;
		case 'listModels':
			return 30_000;
		default:
			return 20_000;
	}
}

async function executeToolCalls(bridge: BackboardBridge, toolCalls: unknown[], mode: string, response: ResponseSink, token: vscode.CancellationToken, attachments: readonly BackboardAttachment[] = []): Promise<unknown[]> {
	if (toolCalls.length > 1 && toolCalls.every(rawCall => {
		const call = parseToolCall(rawCall);
		return (mode === 'free' || isReadOnlyTool(call.name)) && isParallelSafeTool(call.name);
	})) {
		const calls = toolCalls.map(parseToolCall);
		return Promise.all(calls.map(call => executeOneToolCall(bridge, call, mode, response, token, attachments)));
	}
	const outputs: unknown[] = [];
	for (const rawCall of toolCalls) {
		if (token.isCancellationRequested) {
			break;
		}
		const call = parseToolCall(rawCall);
		outputs.push(await executeOneToolCall(bridge, call, mode, response, token, attachments));
	}
	return outputs;
}

async function executeOneToolCall(bridge: BackboardBridge, call: { id: string; name: string; args: Record<string, unknown> }, mode: string, response: ResponseSink, token: vscode.CancellationToken, attachments: readonly BackboardAttachment[]): Promise<unknown> {
	if (isBackboardAttachmentTool(call.name)) {
		try {
			logToolDiagnostic('started', call);
			response.event?.('toolFinished', { status: 'started', key: call.id, name: call.name, args: call.args });
			const result = backboardAttachmentToolResult(attachments, call.args);
			logToolDiagnostic('finished', call, result);
			response.event?.('toolFinished', { status: 'finished', key: call.id, name: call.name, args: call.args, output: result });
			return successfulToolOutput(call.id, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logToolDiagnostic('failed', call, undefined, error);
			response.event?.('toolFinished', { status: 'failed', key: call.id, name: call.name, args: call.args, error: message });
			return toolOutput(call.id, { success: false, content: message });
		}
	}
	const allowed = await approveTool(call.name, call.args, mode);
	if (!allowed) {
		logToolDiagnostic('denied', call);
		response.event?.('toolFinished', { status: 'denied', key: call.id, name: call.name, args: call.args });
		return toolOutput(call.id, { success: false, content: 'User denied this tool call.' });
	}
	try {
		logToolDiagnostic('started', call);
		response.event?.('toolFinished', { status: 'started', key: call.id, name: call.name, args: call.args });
		const result = await executeTool(bridge, call.name, call.args, response, token, call.id);
		logToolDiagnostic('finished', call, result);
		response.event?.('toolFinished', { status: 'finished', key: call.id, name: call.name, args: call.args, output: result });
		return successfulToolOutput(call.id, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logToolDiagnostic('failed', call, undefined, error);
		response.event?.('toolFinished', { status: 'failed', key: call.id, name: call.name, args: call.args, error: message });
		return toolOutput(call.id, { success: false, content: message });
	}
}

function isParallelSafeTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search', backboardAttachmentToolName].includes(name);
}

function logToolDiagnostic(status: string, call: { id: string; name: string; args: Record<string, unknown> }, output?: unknown, error?: unknown): void {
	const channel = backboardToolOutput;
	if (!channel) {
		return;
	}
	const timestamp = new Date().toISOString();
	channel.appendLine(`[${timestamp}] ${status.toUpperCase()} ${call.name} (${call.id})`);
	channel.appendLine(`args: ${safeDiagnosticJson(call.args)}`);
	if (output !== undefined) {
		channel.appendLine(`output: ${safeDiagnosticJson(output)}`);
	}
	if (error !== undefined) {
		channel.appendLine(`error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	}
	channel.appendLine('');
}

function safeDiagnosticJson(value: unknown): string {
	try {
		return JSON.stringify(redactDiagnosticValue(value), undefined, 2);
	} catch {
		return String(value);
	}
}

function logBackboardDocumentDiagnostic(stage: string, details?: Record<string, unknown>): void {
	const channel = backboardToolOutput;
	if (!channel) {
		return;
	}
	channel.appendLine(`[${new Date().toISOString()}] [document-flow] ${stage}`);
	if (details) {
		channel.appendLine(safeDiagnosticJson(details));
	}
	channel.appendLine('');
}

function redactDiagnosticValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactDiagnosticValue);
	}
	if (!isObjectRecord(value)) {
		return value;
	}
	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		redacted[key] = key === '__image_base64'
			? `<redacted image base64, ${typeof item === 'string' ? item.length : 0} chars>`
			: redactDiagnosticValue(item);
	}
	return redacted;
}

function backboardVerboseBridgeLogging(): boolean {
	const value = process.env.BACKBOARD_BRIDGE_VERBOSE_REQUESTS || process.env.BACKBOARD_PANEL_VERBOSE_REQUESTS;
	return value === '1' || value?.toLowerCase() === 'true';
}

function bridgeRequestSummary(params: unknown): unknown {
	if (!isObjectRecord(params)) {
		return typeof params;
	}
	return {
		keys: Object.keys(params),
		provider: stringValueFromRecord(params.provider),
		model: stringValueFromRecord(params.model),
		mode: stringValueFromRecord(params.mode),
		contentChars: typeof params.content === 'string' ? params.content.length : undefined,
		toolCount: Array.isArray(params.tools) ? params.tools.length : undefined,
		toolOutputCount: Array.isArray(params.toolOutputs) ? params.toolOutputs.length : undefined,
		hasAudio: Boolean(params.audioFile),
		fileCount: Array.isArray(params.files) ? params.files.length : undefined,
		hasConfig: Boolean(params.config),
	};
}

async function approveTool(name: string, args: Record<string, unknown>, mode: string): Promise<boolean> {
	if (mode === 'free' || isReadOnlyTool(name)) {
		return true;
	}
	const command = typeof args.command === 'string' ? `\n\n${args.command}` : '';
	const choice = await vscode.window.showWarningMessage(`Backboard wants to run ${name}.${command}`, { modal: true }, 'Allow');
	return choice === 'Allow';
}

async function executeTool(bridge: BackboardBridge, name: string, args: Record<string, unknown>, response: ResponseSink, token: vscode.CancellationToken, toolKey?: string): Promise<string> {
	switch (name) {
		case 'read_file':
			return readFile(args);
		case 'list_dir':
			return listDir(args);
		case 'glob':
			return globFiles(args);
		case 'grep':
			return grepFiles(args);
		case 'codebase_search':
			return codebaseSearch(args);
		case 'web_search':
		case 'web_fetch':
		case 'computer':
			return asCompactJson(await bridge.runRustTool(name, args, token));
		case 'generate_image':
		case 'image_generate':
			return generateImageTool(args);
		case 'read_lints':
			return readLints(args, token);
		case 'write':
		case 'write_file':
		case 'create_file':
		case 'overwrite_file':
			return writeFileTool(name, args, response);
		case 'append_file':
			return appendFileTool(args, response);
		case 'edit':
		case 'edit_file':
		case 'search_replace':
			return editFileTool(args, response);
		case 'delete_file':
			return deleteFileTool(args, response);
		case 'create_directory':
			return createDirectoryTool(args);
		case 'bash':
		case 'run_terminal_cmd':
			return runShellTool(args, response, token, toolKey);
		case 'run_code':
		case 'repl':
			return runCodeTool(args, response, token, toolKey);
		case 'todo_write':
			return `Todo list updated: ${asCompactJson(args.todos ?? [])}`;
		case 'sleep':
			return sleepTool(args, token);
		case 'task':
			return taskTool(args);
		case 'enter_plan_mode':
			return `Plan mode requested: ${stringArg(args, 'reason')}`;
		case 'exit_plan_mode':
			return `Plan proposed:\n${stringArg(args, 'plan')}`;
		case 'persistence_decide':
			return `Persistence decision: ${asCompactJson(args)}`;
		default:
			throw new Error(`Unsupported tool: ${name}`);
	}
}

async function readFile(args: Record<string, unknown>): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const bytes = await vscode.workspace.fs.readFile(uri);
	const text = Buffer.from(bytes).toString('utf8');
	const offset = numberArg(args, 'offset');
	const limit = numberArg(args, 'limit');
	if (!offset && !limit) {
		return text;
	}
	const lines = text.split(/\r?\n/);
	const start = Math.max((offset ?? 1) - 1, 0);
	const end = limit ? start + limit : lines.length;
	return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
}

async function listDir(args: Record<string, unknown>): Promise<string> {
	const uri = resolveWorkspaceUri(stringArg(args, 'path', 'relative_workspace_path', 'target_directory', 'targetDirectory') || '.');
	const entries = await vscode.workspace.fs.readDirectory(uri);
	const rows = await Promise.all(entries.map(async ([name, type]) => {
		const child = vscode.Uri.joinPath(uri, name);
		const stat = await tryStat(child);
		return `${type === vscode.FileType.Directory ? 'dir ' : 'file'} ${name}${stat ? ` ${stat.size}b` : ''}`;
	}));
	return rows.join('\n');
}

async function globFiles(args: Record<string, unknown>): Promise<string> {
	const pattern = stringArg(args, 'pattern') || '**/*';
	const base = stringArg(args, 'target_directory');
	const fullPattern = base ? path.posix.join(base.replace(/\\/g, '/'), pattern) : pattern;
	const files = await vscode.workspace.findFiles(workspacePattern(fullPattern), '**/{node_modules,.git,target,out,dist}/**', 300);
	return files.map(uri => vscode.workspace.asRelativePath(uri)).join('\n');
}

async function grepFiles(args: Record<string, unknown>): Promise<string> {
	const pattern = stringArg(args, 'pattern');
	if (!pattern) {
		throw new Error('grep requires pattern');
	}
	const include = stringArg(args, 'glob', 'include') || '**/*';
	const rootPath = stringArg(args, 'path');
	const fullPattern = rootPath ? path.posix.join(rootPath.replace(/\\/g, '/'), include) : include;
	const files = await vscode.workspace.findFiles(workspacePattern(fullPattern), '**/{node_modules,.git,target,out,dist}/**', 500);
	const matches: string[] = [];
	const flags = boolArg(args, 'case_insensitive') ? 'i' : '';
	const regex = new RegExp(pattern, flags);
	const outputMode = stringArg(args, 'output_mode') || 'content';
	let count = 0;
	for (const uri of files) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		const lines = text.split(/\r?\n/);
		let fileMatched = false;
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				count++;
				fileMatched = true;
				if (outputMode === 'content') {
					matches.push(`${vscode.workspace.asRelativePath(uri)}:${i + 1}: ${lines[i]}`);
					if (matches.length >= 100) {
						return matches.join('\n');
					}
				}
			}
		}
		if (outputMode === 'files_with_matches' && fileMatched) {
			matches.push(vscode.workspace.asRelativePath(uri));
		}
	}
	if (outputMode === 'count') {
		return String(count);
	}
	return matches.join('\n');
}

async function codebaseSearch(args: Record<string, unknown>): Promise<string> {
	const query = stringArg(args, 'query');
	if (!query) {
		throw new Error('codebase_search requires query');
	}
	const limit = numberArg(args, 'num_results') ?? 15;
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const files = await vscode.workspace.findFiles(workspacePattern('**/*'), '**/{node_modules,.git,target,out,dist}/**', 800);
	const scored: { uri: vscode.Uri; score: number; preview: string }[] = [];
	for (const uri of files) {
		const bytes = await tryReadFile(uri);
		if (!bytes || bytes.byteLength > 512_000) {
			continue;
		}
		const text = Buffer.from(bytes).toString('utf8');
		const lower = text.toLowerCase();
		const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
		if (score > 0) {
			const line = text.split(/\r?\n/).find(value => terms.some(term => value.toLowerCase().includes(term))) ?? '';
			scored.push({ uri, score, preview: line.trim().slice(0, 240) });
		}
	}
	return scored
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map(item => `${vscode.workspace.asRelativePath(item.uri)}: ${item.preview}`)
		.join('\n');
}

function generateImageTool(args: Record<string, unknown>): string {
	const prompt = stringArg(args, 'prompt', 'description', 'query', 'input') || 'the requested image';
	return asCompactJson({
		success: true,
		content: `Image generation request acknowledged for: ${prompt}. Backboard media generation is enabled for this turn; continue by returning or streaming the generated image media instead of calling another local image tool.`
	});
}

async function readLints(args: Record<string, unknown>, token: vscode.CancellationToken): Promise<string> {
	const commands = arrayStringArg(args, 'commands');
	const command = stringArg(args, 'command', 'cmd');
	if (command) {
		commands.unshift(command);
	}
	if (commands.length) {
		const outputs: string[] = [];
		for (const item of commands) {
			outputs.push(`$ ${item}\n${await runShellTool({ ...args, command: item }, { markdown() {}, progress() {} }, token)}`);
		}
		return outputs.join('\n\n');
	}
	const target = stringArg(args, 'path', 'file_path', 'filePath');
	const diagnostics = target ? vscode.languages.getDiagnostics(resolveWorkspaceUri(target)) : vscode.languages.getDiagnostics().flatMap(([_uri, items]) => items);
	return diagnostics.map(item => `${item.source ?? 'diagnostic'}: ${item.message}`).join('\n');
}

const BACKBOARD_PANEL_LARGE_WRITE_PROGRESS_CHARS = 8_000;
const BACKBOARD_PANEL_LARGE_WRITE_CHUNK_CHARS = 4_000;

function panelLargeWriteChunkCount(content: string): number {
	return Math.max(1, Math.ceil(content.length / BACKBOARD_PANEL_LARGE_WRITE_CHUNK_CHARS));
}

async function writeWorkspaceTextInChunks(uri: vscode.Uri, content: string, append: boolean, response: ResponseSink, verb: string): Promise<number> {
	await vscode.workspace.fs.createDirectory(parentUri(uri));
	const relative = vscode.workspace.asRelativePath(uri);
	const chunks = panelLargeWriteChunkCount(content);
	response.progress(`${verb} ${relative}: 0/${content.length} chars`);
	if (uri.scheme === 'file') {
		if (!append) {
			await fs.promises.writeFile(uri.fsPath, '', 'utf8');
		}
		let written = 0;
		for (let offset = 0; offset < content.length; offset += BACKBOARD_PANEL_LARGE_WRITE_CHUNK_CHARS) {
			const chunk = content.slice(offset, offset + BACKBOARD_PANEL_LARGE_WRITE_CHUNK_CHARS);
			await fs.promises.appendFile(uri.fsPath, chunk, 'utf8');
			written += chunk.length;
			response.progress(`${verb} ${relative}: ${written}/${content.length} chars`);
		}
		return chunks;
	}
	const before = append ? Buffer.from((await tryReadFile(uri)) ?? new Uint8Array()).toString('utf8') : '';
	await vscode.workspace.fs.writeFile(uri, Buffer.from(`${before}${content}`, 'utf8'));
	response.progress(`${verb} ${relative}: ${content.length}/${content.length} chars`);
	return chunks;
}

async function writeFileTool(_toolName: string, args: Record<string, unknown>, response: ResponseSink): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	const relative = vscode.workspace.asRelativePath(uri);
	await vscode.workspace.fs.createDirectory(parentUri(uri));
	if (content.length > BACKBOARD_PANEL_LARGE_WRITE_PROGRESS_CHARS) {
		const before = await tryReadFile(uri);
		const beforeText = before ? Buffer.from(before).toString('utf8') : undefined;
		await writeWorkspaceTextInChunks(uri, content, false, response, 'Writing');
		await vscode.workspace.saveAll(false);
		response.event?.('fileChange', summarizeFileChange(uri, beforeText, content));
		return `Wrote ${relative} (${content.length} chars)`;
	}
	const edit = new vscode.WorkspaceEdit();
	let before: string | undefined;
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const source = document.getText();
		before = source;
		edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(source.length)), content);
	} catch {
		edit.createFile(uri, { ignoreIfExists: true });
		edit.insert(uri, new vscode.Position(0, 0), content);
	}
	const ok = await vscode.workspace.applyEdit(edit);
	await vscode.workspace.saveAll(false);
	if (ok) {
		response.event?.('fileChange', summarizeFileChange(uri, before, content));
	}
	return ok ? `Wrote ${relative}` : `Failed to write ${relative}`;
}

async function appendFileTool(args: Record<string, unknown>, response: ResponseSink): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	const relative = vscode.workspace.asRelativePath(uri);
	await vscode.workspace.fs.createDirectory(parentUri(uri));
	const before = await tryReadFile(uri);
	const beforeText = before ? Buffer.from(before).toString('utf8') : '';
	const afterText = `${beforeText}${content}`;
	if (content.length > BACKBOARD_PANEL_LARGE_WRITE_PROGRESS_CHARS) {
		await writeWorkspaceTextInChunks(uri, content, true, response, 'Appending');
		await vscode.workspace.saveAll(false);
		response.event?.('fileChange', summarizeFileChange(uri, beforeText || undefined, afterText));
		return `Appended ${content.length} chars to ${relative}`;
	}
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(uri, document.positionAt(document.getText().length), content);
		const ok = await vscode.workspace.applyEdit(edit);
		await document.save();
		if (ok) {
			response.event?.('fileChange', summarizeFileChange(uri, beforeText || undefined, afterText));
		}
		return ok ? `Appended ${content.length} chars to ${relative}` : `Failed to append to ${relative}`;
	} catch {
		await vscode.workspace.fs.writeFile(uri, Buffer.from(afterText, 'utf8'));
		response.event?.('fileChange', summarizeFileChange(uri, beforeText || undefined, afterText));
		return `Appended ${content.length} chars to ${relative}`;
	}
}

async function editFileTool(args: Record<string, unknown>, response: ResponseSink): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const oldText = stringArg(args, 'old_string', 'oldString', 'oldText');
	const newText = stringArg(args, 'new_string', 'newString', 'newText');
	const document = await vscode.workspace.openTextDocument(uri);
	const source = document.getText();
	if (!source.includes(oldText)) {
		throw new Error(`Target text not found in ${vscode.workspace.asRelativePath(uri)}`);
	}
	const replaceAll = boolArg(args, 'replace_all', 'replaceAll');
	const edited = replaceAll ? source.split(oldText).join(newText) : source.replace(oldText, newText);
	const edit = new vscode.WorkspaceEdit();
	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
	edit.replace(uri, fullRange, edited);
	const ok = await vscode.workspace.applyEdit(edit);
	await document.save();
	await vscode.window.showTextDocument(document);
	if (ok) {
		response.event?.('fileChange', summarizeFileChange(uri, source, edited));
	}
	return ok ? `Edited ${vscode.workspace.asRelativePath(uri)}` : `Failed to edit ${vscode.workspace.asRelativePath(uri)}`;
}

async function deleteFileTool(args: Record<string, unknown>, response: ResponseSink): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const before = await tryReadFile(uri);
	const edit = new vscode.WorkspaceEdit();
	edit.deleteFile(uri, { ignoreIfNotExists: true });
	const ok = await vscode.workspace.applyEdit(edit);
	if (ok) {
		response.event?.('fileChange', summarizeFileChange(uri, before ? Buffer.from(before).toString('utf8') : undefined, undefined));
	}
	return ok ? `Deleted ${vscode.workspace.asRelativePath(uri)}` : `Failed to delete ${vscode.workspace.asRelativePath(uri)}`;
}

function summarizeFileChange(uri: vscode.Uri, before: string | undefined, after: string | undefined): FileChangePayload {
	const beforeLines = splitChangedLines(before);
	const afterLines = splitChangedLines(after);
	let prefix = 0;
	while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < beforeLines.length - prefix
		&& suffix < afterLines.length - prefix
		&& beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
	const added = afterLines.slice(prefix, afterLines.length - suffix);
	const contextBefore = beforeLines.slice(Math.max(0, prefix - 2), prefix);
	const contextAfter = afterLines.slice(afterLines.length - suffix, Math.min(afterLines.length, afterLines.length - suffix + 2));
	const previewLines = [
		...contextBefore.map(text => ({ type: 'context' as const, text })),
		...removed.map(text => ({ type: 'remove' as const, text })),
		...added.map(text => ({ type: 'add' as const, text })),
		...contextAfter.map(text => ({ type: 'context' as const, text }))
	].slice(0, 8);
	return {
		path: vscode.workspace.asRelativePath(uri),
		status: before === undefined ? 'created' : after === undefined ? 'deleted' : 'edited',
		added: added.length,
		removed: removed.length,
		previewLines
	};
}

function splitChangedLines(value: string | undefined): string[] {
	return value ? value.split(/\r?\n/) : [];
}

async function createDirectoryTool(args: Record<string, unknown>): Promise<string> {
	const uri = resolveWorkspaceUri(stringArg(args, 'path', 'dir_path', 'dirPath', 'target_directory', 'targetDirectory'));
	await vscode.workspace.fs.createDirectory(uri);
	return `Created ${vscode.workspace.asRelativePath(uri)}`;
}

async function runShellTool(args: Record<string, unknown>, response: ResponseSink, token: vscode.CancellationToken, toolKey?: string): Promise<string> {
	const command = stringArg(args, 'command', 'cmd');
	if (!command) {
		throw new Error('shell tool requires command');
	}
	const cwd = resolveShellCwd(stringArg(args, 'working_directory', 'cwd'));
	response.progress(command);
	const isBackground = boolArg(args, 'is_background');
	const timeout = numberArg(args, 'timeout_ms', 'timeout') ?? 120_000;
	const maxBuffer = 1024 * 1024;
	let child: cp.ChildProcessWithoutNullStreams | undefined;
	let settled = false;
	let buffered = '';
	let truncated = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const cancelDisposables: vscode.Disposable[] = [];
	const streamToolOutput = (text: string): void => {
		if (toolKey) {
			response.event?.('toolOutput', { key: toolKey, text });
		}
	};
	const appendOutput = (chunk: Buffer | string): void => {
		const text = chunk.toString();
		if (!truncated) {
			if (buffered.length + text.length > maxBuffer) {
				buffered += text.slice(0, Math.max(0, maxBuffer - buffered.length));
				buffered += '\n[Output truncated]\n';
				truncated = true;
			} else {
				buffered += text;
			}
		}
		streamToolOutput(text);
	};
	let finish: (value: string) => void = () => {};
	const result = new Promise<string>(resolve => {
		finish = (value: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			cancelDisposables.splice(0).forEach(disposable => disposable.dispose());
			resolve(value);
		};
	});
	streamToolOutput(`$ ${command}\n`);
	child = cp.spawn(command, [], { cwd, shell: true, env: process.env });
	child.stdout.on('data', appendOutput);
	child.stderr.on('data', appendOutput);
	child.on('error', error => {
		appendOutput(`\n[Command failed: ${error.message}]\n`);
		finish(buffered);
	});
	child.on('close', (code, signal) => {
		const exitText = code === 0 || code === null && !signal
			? ''
			: `\n[Command exited ${signal ? `with signal ${signal}` : `with code ${code}`}]\n`;
		if (exitText) {
			appendOutput(exitText);
		}
		finish(buffered);
	});
	if (!isBackground) {
		timeoutHandle = setTimeout(() => {
			appendOutput(`\n[Command timed out after ${Math.round(timeout / 1000)}s]\n`);
			child?.kill();
			finish(buffered);
		}, timeout);
	}
	cancelDisposables.push(token.onCancellationRequested(() => {
		child?.kill();
		appendOutput(buffered ? '\n[Command cancelled]\n' : 'Command cancelled.');
		finish(buffered || 'Command cancelled.');
	}));
	if (isBackground) {
		void result;
		return `Started background command: ${command}`;
	}
	return result;
}

function resolveShellCwd(rawCwd: string | undefined): string {
	const root = workspaceFolderUri();
	if (!root) {
		return os.homedir();
	}
	const rootPath = path.resolve(root.fsPath);
	if (!rawCwd) {
		return rootPath;
	}
	const resolved = path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : path.resolve(rootPath, rawCwd);
	const relative = path.relative(rootPath, resolved);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return rootPath;
	}
	return resolved;
}

async function runCodeTool(args: Record<string, unknown>, response: ResponseSink, token: vscode.CancellationToken, toolKey?: string): Promise<string> {
	const code = stringArg(args, 'code');
	if (!code) {
		throw new Error('run_code/repl requires code');
	}
	const language = (stringArg(args, 'language') || 'python').toLowerCase();
	if (language === 'shell') {
		return runShellTool({ ...args, command: code }, response, token, toolKey);
	}
	const command = language === 'node' || language === 'typescript'
		? `node -e ${shellQuote(code)}`
		: `python3 -c ${shellQuote(code)}`;
	return runShellTool({ ...args, command }, response, token, toolKey);
}

async function sleepTool(args: Record<string, unknown>, token: vscode.CancellationToken): Promise<string> {
	const seconds = Math.max(0, numberArg(args, 'seconds') ?? 1);
	await new Promise<void>(resolve => {
		const handle = setTimeout(resolve, seconds * 1000);
		token.onCancellationRequested(() => {
			clearTimeout(handle);
			resolve();
		});
	});
	return `Waited ${seconds} second(s).`;
}

async function taskTool(args: Record<string, unknown>): Promise<string> {
	const prompt = stringArg(args, 'prompt', 'description');
	return `Sub-task requested: ${prompt}\n\nBackboard Studio bridge recorded the task request. Parallel sub-agent execution is not available in this host yet.`;
}

async function tryStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

async function tryReadFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
	try {
		return await vscode.workspace.fs.readFile(uri);
	} catch {
		return undefined;
	}
}

function parseToolCall(raw: unknown): { id: string; name: string; args: Record<string, unknown> } {
	const value = isObjectRecord(raw) ? raw : {};
	const fn = isObjectRecord(value.function) ? value.function : {};
	const rawArgs = firstPresent(fn, ['arguments', 'args', 'parameters', 'input'])
		?? firstPresent(value, ['arguments', 'args', 'parameters', 'input'])
		?? {};
	const args = parseToolArgs(rawArgs);
	return {
		id: firstStringProperty(value, ['id', 'tool_call_id', 'toolCallId', 'call_id', 'callId']) ?? `call_${newId()}`,
		name: firstStringProperty(fn, ['name'])
			?? firstStringProperty(value, ['name', 'tool_name', 'toolName', 'function_name', 'functionName'])
			?? 'unknown',
		args
	};
}

function firstPresent(source: Record<string, unknown>, names: readonly string[]): unknown {
	for (const name of names) {
		if (source[name] !== undefined) {
			return source[name];
		}
	}
	return undefined;
}

function firstStringProperty(source: Record<string, unknown>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = stringValueFromRecord(source[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parseToolArgs(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(text);
			return isObjectRecord(parsed) ? parsed : { input: parsed };
		} catch {
			return { input: text };
		}
	}
	return isObjectRecord(value) ? value : {};
}

function filePathArg(args: Record<string, unknown>): string {
	return stringArg(args, 'path', 'file_path', 'filePath', 'target_file', 'targetFile');
}

function toolOutput(toolCallId: string, output: unknown): unknown {
	return { tool_call_id: toolCallId, toolCallId, output: JSON.stringify(output) };
}

function successfulToolOutput(toolCallId: string, content: unknown): unknown {
	return toolOutput(toolCallId, multimodalToolOutputContent(content) ?? { success: true, content });
}

const backboardAttachmentToolName = 'backboard_read_attachment';
const maxBackboardToolImageBytes = 5 * 1024 * 1024;

function backboardAttachments(image: ImageAttachment | undefined, files: readonly FileAttachment[]): BackboardAttachment[] {
	return [
		...(image ? [{ data: image.data, fileName: image.fileName, mimeType: image.mimeType }] : []),
		...files.map(file => ({ data: file.data, fileName: file.fileName, mimeType: file.mimeType })),
	];
}

function isBackboardAttachmentTool(name: string): boolean {
	return name === backboardAttachmentToolName;
}

function backboardAttachmentToolResult(attachments: readonly BackboardAttachment[], args: Record<string, unknown>): unknown {
	if (!attachments.length) {
		throw new Error('No user attachments are available for this turn.');
	}
	const attachment = selectBackboardAttachment(attachments, args);
	const buffer = Buffer.from(attachment.data);
	if (attachment.mimeType.toLowerCase().startsWith('image/')) {
		return {
			success: true,
			content: `Attached image: ${attachment.fileName}. The continuation turn receives this image as visual input. Inspect the image directly and answer the user. Do not mention base64 or attempt to decode it with tools.`,
			file_name: attachment.fileName,
			mime_type: attachment.mimeType,
			__image_base64: buffer.toString('base64'),
			__image_media_type: attachment.mimeType,
		};
	}
	const text = decodeAttachmentText(buffer, attachment);
	return {
		success: true,
		content: text ?? `Attached file ${attachment.fileName} is ${attachment.data.length} bytes of ${attachment.mimeType} data and is not a supported text or image attachment.`,
		file_name: attachment.fileName,
		mime_type: attachment.mimeType,
		bytes: attachment.data.length,
	};
}

function selectBackboardAttachment(attachments: readonly BackboardAttachment[], args: Record<string, unknown>): BackboardAttachment {
	const byIndex = numberArg(args, 'index', 'attachment_index', 'attachmentIndex');
	if (typeof byIndex === 'number' && Number.isFinite(byIndex)) {
		const attachment = attachments[Math.max(1, Math.trunc(byIndex)) - 1];
		if (attachment) {
			return attachment;
		}
	}
	const requestedName = stringArg(args, 'file_name', 'fileName', 'name');
	if (requestedName) {
		const attachment = attachments.find(item => item.fileName === requestedName);
		if (attachment) {
			return attachment;
		}
	}
	if (attachments.length === 1) {
		return attachments[0];
	}
	throw new Error(`Attachment not found. Available attachments: ${attachments.map((item, index) => `${index + 1}: ${item.fileName}`).join(', ')}`);
}

function decodeAttachmentText(buffer: Buffer, attachment: BackboardAttachment): string | undefined {
	const lowerName = attachment.fileName.toLowerCase();
	const lowerMime = attachment.mimeType.toLowerCase();
	if (!lowerMime.startsWith('text/')
		&& !/\/(json|xml|javascript|typescript|x-yaml|yaml|csv|markdown)$/.test(lowerMime)
		&& !/\.(txt|md|markdown|json|jsonl|csv|tsv|js|jsx|ts|tsx|css|html|xml|yaml|yml|toml|ini|log|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|sql|sh|zsh|bash)$/i.test(lowerName)) {
		return undefined;
	}
	return buffer.toString('utf8');
}

function multimodalToolOutputContent(content: unknown): unknown | undefined {
	const parsed = typeof content === 'string' ? parseJsonObject(content) : content;
	if (!isObjectRecord(parsed)) {
		return undefined;
	}
	const imageBase64 = stringValueFromRecord(parsed.__image_base64);
	const mediaType = stringValueFromRecord(parsed.__image_media_type);
	if (!imageBase64 || !mediaType) {
		return undefined;
	}
	if (!mediaType.toLowerCase().startsWith('image/')) {
		throw new Error(`Unsupported image media type in tool output: ${mediaType}`);
	}
	if (estimatedBase64DecodedBytes(imageBase64) > maxBackboardToolImageBytes) {
		throw new Error('Image tool output exceeds the 5 MB Backboard limit.');
	}
	return parsed;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return isObjectRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function estimatedBase64DecodedBytes(value: string): number {
	const normalized = value.replace(/\s/g, '');
	const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

function isReadOnlyTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search', 'web_search', 'web_fetch'].includes(name);
}

function trimBackboardToolsForRequest(tools: unknown[] | undefined, prompt: string, imageGeneration: string): unknown[] | undefined {
	if (!tools?.length) {
		return tools;
	}
	const trimmed = tools.filter(tool => {
		const name = backboardFunctionToolName(tool);
		if (!name) {
			return true;
		}
		if (name === 'computer' || name === 'sleep' || name === 'persistence_decide') {
			return false;
		}
		if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
			return promptMentionsPlan(prompt);
		}
		if (name === 'generate_image' || name === 'image_generate') {
			return imageGeneration === 'auto' || promptMentionsImage(prompt);
		}
		return true;
	});
	return trimmed.length ? trimmed : tools;
}

function backboardFunctionToolName(tool: unknown): string | undefined {
	if (!isObjectRecord(tool)) {
		return undefined;
	}
	const fn = isObjectRecord(tool.function) ? tool.function : undefined;
	return stringValueFromRecord(fn?.name) || stringValueFromRecord(tool.name);
}

function promptMentionsPlan(prompt: string): boolean {
	return /\b(plan|planning|roadmap|steps|strategy)\b/i.test(prompt);
}

function promptMentionsImage(prompt: string): boolean {
	return /\b(image|picture|photo|draw|drawing|illustration|logo|icon|sprite|visual|render)\b/i.test(prompt);
}

function readSettings(): {
	readonly defaultProvider: string;
	readonly defaultModel: string;
	readonly mode: string;
	readonly intensity: string;
	readonly imageGeneration: string;
	readonly voiceMode: string;
	readonly mcpFigma: boolean;
	readonly mcpNotion: boolean;
	readonly mcpGoogle: boolean;
	readonly config: { readonly env: string; readonly apiUrl?: string; readonly accessToken?: string };
} {
	const config = vscode.workspace.getConfiguration('backboard');
	const apiUrl = config.get<string>('apiUrl')?.trim() || undefined;
	const accessToken = configuredBackboardAccessToken();
	return {
		defaultProvider: config.get<string>('defaultProvider') || 'openrouter',
		defaultModel: config.get<string>('defaultModel') || 'deepseek/deepseek-v4-flash',
		mode: config.get<string>('mode') || 'free',
		intensity: config.get<string>('intensity') || 'fast',
		imageGeneration: config.get<string>('imageGeneration') || 'off',
		voiceMode: config.get<string>('voiceMode') || 'off',
		mcpFigma: config.get<boolean>('mcpFigma') ?? false,
		mcpNotion: config.get<boolean>('mcpNotion') ?? false,
		mcpGoogle: config.get<boolean>('mcpGoogle') ?? false,
		config: {
			env: config.get<string>('env') || 'prod',
			apiUrl,
			accessToken
		}
	};
}

function resolveTurnSettings(options: PanelOptions): BackboardSettings {
	const settings = readSettings();
	return {
		...settings,
		defaultProvider: options.provider || settings.defaultProvider,
		defaultModel: options.model || settings.defaultModel,
		mode: options.mode || settings.mode,
		intensity: options.intensity || settings.intensity,
		imageGeneration: options.imageGeneration || settings.imageGeneration,
		voiceMode: options.voiceMode || settings.voiceMode,
		mcpFigma: options.mcpFigma ?? settings.mcpFigma,
		mcpNotion: options.mcpNotion ?? settings.mcpNotion,
		mcpGoogle: options.mcpGoogle ?? settings.mcpGoogle
	};
}

function mcpCallsPayload(settings: BackboardSettings): string[] | undefined {
	const enabled = [
		settings.mcpFigma ? 'figma' : undefined,
		settings.mcpNotion ? 'notion' : undefined,
		settings.mcpGoogle ? 'google' : undefined
	].filter((value): value is string => Boolean(value));
	return enabled.length ? enabled : undefined;
}

function imageGenerationForPrompt(prompt: string, configured: string): string {
	if (configured === 'auto') {
		return configured;
	}
	return /\b(generate|create|make|draw|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|artwork)\b/i.test(prompt)
		|| /\b(image|picture|photo|illustration|artwork)\b[\s\S]{0,80}\b(of|for|showing)\b/i.test(prompt)
		? 'auto'
		: configured;
}

function asPanelOptions(value: unknown): PanelOptions {
	if (!value || typeof value !== 'object') {
		return {};
	}
	const raw = value as Record<string, unknown>;
	return {
		provider: stringValue(raw.provider),
		model: stringValue(raw.model),
		mode: stringValue(raw.mode),
		intensity: stringValue(raw.intensity),
		imageGeneration: stringValue(raw.imageGeneration),
		voiceMode: stringValue(raw.voiceMode),
		mcpFigma: booleanValue(raw.mcpFigma),
		mcpNotion: booleanValue(raw.mcpNotion),
		mcpGoogle: booleanValue(raw.mcpGoogle)
	};
}

async function savePanelOptions(options: PanelOptions): Promise<void> {
	const config = vscode.workspace.getConfiguration('backboard');
	const updates: [string, string | boolean | undefined][] = [
		['defaultProvider', options.provider],
		['defaultModel', options.model],
		['mode', options.mode],
		['intensity', options.intensity],
		['imageGeneration', options.imageGeneration],
		['voiceMode', options.voiceMode],
		['mcpFigma', options.mcpFigma],
		['mcpNotion', options.mcpNotion],
		['mcpGoogle', options.mcpGoogle]
	];
	await Promise.all(updates
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => config.update(key, value, vscode.ConfigurationTarget.Global)));
}

async function postPanelState(bridge: BackboardBridge, webview: vscode.Webview, forceModelRefresh = false): Promise<void> {
	const settings = readSettings();
	const publicPanelSettings = publicSettings(settings);
	const alternativeConfigured = await bridge.hasAlternativeCredentials().catch(() => false);
	await webview.postMessage({ type: 'settings', settings: { ...publicPanelSettings, authenticated: publicPanelSettings.authenticated || alternativeConfigured }, workspace: workspacePath() });
	const cachedModels = forceModelRefresh ? undefined : await bridge.cachedModels();
	const cachedTools = forceModelRefresh ? undefined : await bridge.cachedTools(settings.mode);
	if (cachedModels) {
		await webview.postMessage({ type: 'models', models: cachedModels });
	}
	if (cachedTools) {
		await webview.postMessage({ type: 'tools', tools: cachedTools });
	}
	if (cachedModels && cachedTools && !forceModelRefresh && await bridge.hasFreshPanelMetadata(settings.mode)) {
		await webview.postMessage({ type: 'status', text: 'Ready.' });
		return;
	}
	try {
		await webview.postMessage({ type: 'status', text: cachedModels && !forceModelRefresh ? 'Checking Backboard models.' : 'Loading Backboard models.' });
		const models = await bridge.listModels(new vscode.CancellationTokenSource().token, forceModelRefresh);
		await webview.postMessage({ type: 'models', models });
		await webview.postMessage({ type: 'status', text: 'Ready.' });
	} catch (error) {
		const cachedModels = await bridge.cachedModels();
		if (cachedModels) {
			await webview.postMessage({ type: 'models', models: cachedModels });
			await webview.postMessage({ type: 'status', text: 'Using cached Backboard models.' });
		} else {
				await webview.postMessage({ type: 'append', role: 'error', text: error instanceof Error ? error.message : String(error) });
				if (isBackboardAuthError(error)) {
					await webview.postMessage({ type: 'status', text: 'Connect your AI to load models.' });
				} else {
					await webview.postMessage({ type: 'status', text: 'Could not load models.' });
				}
		}
	}
	try {
		const tools = await bridge.listTools(settings.mode, new vscode.CancellationTokenSource().token, forceModelRefresh);
		await webview.postMessage({ type: 'tools', tools });
	} catch {
		await webview.postMessage({ type: 'tools', tools: cachedTools ?? [] });
	}
}

async function postUsageSnapshot(bridge: BackboardBridge, webview: vscode.Webview): Promise<void> {
	try {
		await webview.postMessage({ type: 'usageSnapshot', payload: await fetchUsageSnapshot(bridge) });
	} catch (error) {
		await webview.postMessage({ type: 'status', text: error instanceof Error ? error.message : String(error) });
	}
}

async function fetchUsageSnapshot(bridge: BackboardBridge): Promise<BackboardUsageSnapshot> {
	const tokenSource = new vscode.CancellationTokenSource();
	try {
		const api = backboardUsageApiConfig();
		const [balanceResult, summaryResult, recentResult] = await Promise.all([
			api ? captureUsageRequest(() => getBackboardUsageJson(api, '/billing/balance', tokenSource.token)) : undefined,
			api ? captureUsageRequest(() => getBackboardUsageJson(api, '/billing/usage/summary?range=period', tokenSource.token)) : undefined,
			api ? captureUsageRequest(() => getBackboardRecentUsage(api, tokenSource.token)) : undefined,
		]);
		logUsageRequestError('balance', balanceResult);
		logUsageRequestError('summary', summaryResult);
		logUsageRequestError('recent', recentResult);
		const needsLocalUsage = !summaryResult?.ok || !recentResult?.ok;
		const models = needsLocalUsage ? await bridge.cachedModels().catch(() => undefined) : undefined;
		const local = needsLocalUsage ? await readLocalUsageSnapshot(models ?? []) : undefined;
		return {
			balance: balanceResult?.ok ? balanceResult.value : {},
			summary: summaryResult?.ok ? summaryResult.value : local!.summary,
			recent: recentResult?.ok ? recentResult.value : local!.recent,
			fetchedAt: Date.now(),
		};
	} finally {
		tokenSource.dispose();
	}
}

interface BackboardUsageApiConfig {
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
}

type UsageRequestResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

function backboardUsageApiConfig(): BackboardUsageApiConfig | undefined {
	const savedConfig = readBackboardConfigJsonSync();
	const apiKey = configuredBackboardApiKey();
	const accessToken = backboardConfigAccessToken(savedConfig);
	if (!apiKey && !accessToken) {
		return undefined;
	}
	const configuredUrl = readSettings().config.apiUrl
		?? stringValueFromRecord(savedConfig.api_url)
		?? stringValueFromRecord(savedConfig.apiUrl);
	const env = normalizeBackboardEnv(stringValueFromRecord(savedConfig.env) ?? currentBackboardEnv());
	const baseUrl = (configuredUrl ?? (env === 'local' ? 'http://localhost:8000' : env === 'prod' ? 'https://app.backboard.io/api' : 'https://dev.app.backboard.io/api')).replace(/\/+$/, '');
	return {
		baseUrl,
		headers: apiKey ? { 'X-API-Key': apiKey } : { 'Authorization': `Bearer ${accessToken}` },
	};
}

async function captureUsageRequest(request: () => Promise<unknown>): Promise<UsageRequestResult> {
	try {
		return { ok: true, value: await request() };
	} catch (error) {
		return { ok: false, error };
	}
}

function logUsageRequestError(label: string, result: UsageRequestResult | undefined): void {
	if (result && !result.ok) {
		backboardToolOutput?.appendLine(`[usage] ${label}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
	}
}

async function getBackboardRecentUsage(api: BackboardUsageApiConfig, token: vscode.CancellationToken): Promise<unknown> {
	const pageSize = 100;
	const maxPages = 100;
	const pageConcurrency = 8;
	const firstPayload = await getBackboardUsageJson(api, `/billing/usage/recent?page=1&page_size=${pageSize}`, token);
	const firstPageEvents = usageEventsFromPayload(firstPayload);
	if (!firstPageEvents || firstPageEvents.length < pageSize) {
		return firstPageEvents ? { data: [...firstPageEvents] } : firstPayload;
	}
	const events: unknown[] = [...firstPageEvents];
	const totalPages = usageTotalPages(firstPayload);
	if (totalPages !== undefined) {
		if (totalPages > maxPages) {
			throw new Error(`Backboard usage exceeded ${maxPages * pageSize} events.`);
		}
		for (let start = 2; start <= totalPages; start += pageConcurrency) {
			const pages = Array.from({ length: Math.min(pageConcurrency, totalPages - start + 1) }, (_, index) => start + index);
			const payloads = await Promise.all(pages.map(page => getBackboardUsageJson(api, `/billing/usage/recent?page=${page}&page_size=${pageSize}`, token)));
			for (const payload of payloads) {
				const pageEvents = usageEventsFromPayload(payload);
				if (!pageEvents) {
					throw new Error('Backboard usage returned an invalid page.');
				}
				events.push(...pageEvents);
			}
		}
		return { data: events };
	}

	const pageSignatures = new Set<string>();
	pageSignatures.add(JSON.stringify([firstPageEvents.length, firstPageEvents[0], firstPageEvents[firstPageEvents.length - 1]]));
	for (let page = 2; page <= maxPages; page++) {
		const payload = await getBackboardUsageJson(api, `/billing/usage/recent?page=${page}&page_size=${pageSize}`, token);
		const pageEvents = usageEventsFromPayload(payload);
		if (!pageEvents) {
			return { data: events };
		}
		if (pageEvents.length === 0) {
			return { data: events };
		}
		const signature = JSON.stringify([pageEvents.length, pageEvents[0], pageEvents[pageEvents.length - 1]]);
		if (pageSignatures.has(signature)) {
			throw new Error('Backboard usage pagination repeated a page.');
		}
		pageSignatures.add(signature);
		events.push(...pageEvents);
		if (pageEvents.length < pageSize || usagePaginationComplete(payload, page, events.length)) {
			return { data: events };
		}
	}
	throw new Error(`Backboard usage exceeded ${maxPages * pageSize} events.`);
}

function usageEventsFromPayload(value: unknown): readonly unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (!isObjectRecord(value)) {
		return undefined;
	}
	for (const key of ['usage', 'results', 'items', 'events']) {
		if (Array.isArray(value[key])) {
			return value[key];
		}
	}
	if (Array.isArray(value.data)) {
		return value.data;
	}
	return isObjectRecord(value.data) ? usageEventsFromPayload(value.data) : undefined;
}

function usagePaginationComplete(value: unknown, page: number, received: number): boolean {
	const pagination = usagePagination(value);
	if (!pagination) {
		return false;
	}
	const totalPages = usageNumber(pagination.total_pages) ?? usageNumber(pagination.totalPages) ?? usageNumber(pagination.pages);
	const total = usageNumber(pagination.total) ?? usageNumber(pagination.total_items) ?? usageNumber(pagination.totalItems) ?? usageNumber(pagination.count);
	return (totalPages !== undefined && page >= totalPages) || (total !== undefined && received >= total);
}

function usageTotalPages(value: unknown): number | undefined {
	const pagination = usagePagination(value);
	return pagination ? usageNumber(pagination.total_pages) ?? usageNumber(pagination.totalPages) ?? usageNumber(pagination.pages) : undefined;
}

function usagePagination(value: unknown): Record<string, unknown> | undefined {
	if (!isObjectRecord(value)) {
		return undefined;
	}
	const data = isObjectRecord(value.data) ? value.data : undefined;
	return isObjectRecord(value.pagination) ? value.pagination : isObjectRecord(data?.pagination) ? data.pagination : undefined;
}

function usageNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function getBackboardUsageJson(api: BackboardUsageApiConfig, requestPath: string, token: vscode.CancellationToken): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${api.baseUrl}${requestPath}`);
		const transport = url.protocol === 'http:' ? http : https;
		const request = transport.request(url, {
			method: 'GET',
			headers: { ...api.headers, 'Accept': 'application/json' },
		}, response => {
			const chunks: Buffer[] = [];
			let length = 0;
			response.on('data', chunk => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += buffer.length;
				if (length > 20 * 1024 * 1024) {
					request.destroy(new Error('Backboard usage response was larger than 20 MB.'));
					return;
				}
				chunks.push(buffer);
			});
			response.on('end', () => {
				cancellation.dispose();
				const text = Buffer.concat(chunks).toString('utf8');
				if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(`Backboard usage request returned HTTP ${response.statusCode}: ${text.slice(0, 1000)}`));
					return;
				}
				try {
					resolve(text.trim() ? JSON.parse(text) : {});
				} catch {
					reject(new Error('Backboard usage request returned invalid JSON.'));
				}
			});
		});
		request.on('error', error => {
			cancellation.dispose();
			reject(error);
		});
		const cancellation = token.onCancellationRequested(() => request.destroy(new Error('Backboard usage request was cancelled.')));
		if (token.isCancellationRequested) {
			request.destroy(new Error('Backboard usage request was cancelled.'));
			return;
		}
		request.end();
	});
}

async function postComposerContext(webview: vscode.Webview, kind: 'activeFile' | 'selection'): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		await webview.postMessage({ type: 'status', text: 'No active editor.' });
		return;
	}
	const text = composerContextText(editor, kind);
	if (!text) {
		await webview.postMessage({ type: 'status', text: kind === 'selection' ? 'No selected text.' : 'No active file.' });
		return;
	}
	await webview.postMessage({ type: 'insertText', text });
}

async function postBranchDiff(webview: vscode.Webview): Promise<void> {
	const cwd = workspacePath();
	if (!cwd) {
		await webview.postMessage({ type: 'status', text: 'No workspace folder for branch diff.' });
		return;
	}
	try {
		const diff = await execFileText('git', ['diff', '--'], cwd, 1_000_000);
		if (!diff.trim()) {
			await webview.postMessage({ type: 'status', text: 'No branch diff to add.' });
			return;
		}
		const trimmed = diff.length > 80_000 ? `${diff.slice(0, 80_000)}\n\n[Diff truncated]` : diff;
		await webview.postMessage({ type: 'insertText', text: `Branch diff\n\n\`\`\`diff\n${trimmed}\n\`\`\`` });
	} catch (error) {
		await webview.postMessage({ type: 'status', text: error instanceof Error ? error.message : String(error) });
	}
}

function execFileText(command: string, args: string[], cwd: string, maxBuffer: number): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile(command, args, { cwd, maxBuffer }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

function composerContextText(editor: vscode.TextEditor, kind: 'activeFile' | 'selection'): string | undefined {
	const document = editor.document;
	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	if (kind === 'activeFile') {
		return `@${relativePath}`;
	}
	const selection = editor.selection;
	const selectedText = document.getText(selection);
	if (!selectedText.trim()) {
		return undefined;
	}
	const start = selection.start.line + 1;
	const end = selection.end.line + 1;
	const language = document.languageId || 'text';
	return `Selected text from ${relativePath}:${start}${end !== start ? `-${end}` : ''}\n\n\`\`\`${language}\n${selectedText}\n\`\`\``;
}

function publicSettings(settings: BackboardSettings): PanelOptions {
	return {
		provider: settings.defaultProvider,
		model: settings.defaultModel,
		mode: settings.mode,
		intensity: settings.intensity,
		imageGeneration: settings.imageGeneration,
		voiceMode: settings.voiceMode,
		mcpFigma: settings.mcpFigma,
		mcpNotion: settings.mcpNotion,
		mcpGoogle: settings.mcpGoogle,
		authenticated: hasBackboardCredentials()
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function workspacePath(): string | undefined {
	return workspaceFolderUri()?.fsPath;
}

function workspaceFolderUri(): vscode.Uri | undefined {
	const configuredRoot = configuredWorkspaceRoot();
	if (configuredRoot) {
		return vscode.Uri.file(configuredRoot);
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		const rememberedRoot = rememberedWorkspaceRoot();
		return rememberedRoot ? vscode.Uri.file(rememberedRoot) : undefined;
	}
	const activeEditorFolder = vscode.window.activeTextEditor
		? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
		: undefined;
	if (activeEditorFolder) {
		return activeEditorFolder.uri;
	}
	for (const editor of vscode.window.visibleTextEditors) {
		const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (folder) {
			return folder.uri;
		}
	}
	return folders[0].uri;
}

function rememberedWorkspaceRoot(): string | undefined {
	const store = readSharedPanelStateStore();
	const candidates: PanelPersistedState[] = [];
	if (isPanelPersistedState(store.latest)) {
		candidates.push(store.latest);
	}
	if (isObjectRecord(store.byWorkspace)) {
		for (const value of Object.values(store.byWorkspace)) {
			if (isPanelPersistedState(value)) {
				candidates.push(value);
			}
		}
	}
	let bestWorkspace: string | undefined;
	let bestTimestamp = 0;
	for (const candidate of candidates) {
		const workspace = panelStateWorkspace(candidate);
		if (!workspace) {
			continue;
		}
		const timestamp = panelStateTimestamp(candidate);
		if (!bestWorkspace || timestamp >= bestTimestamp) {
			bestWorkspace = workspace;
			bestTimestamp = timestamp;
		}
	}
	return bestWorkspace;
}

function configuredWorkspaceRoot(): string | undefined {
	const raw = vscode.workspace.getConfiguration('backboard').get<string>('workspaceRoot')?.trim()
		|| process.env.BACKBOARD_WORKSPACE_ROOT?.trim()
		|| process.env.BACKBOARD_IDE_WORKSPACE_ROOT?.trim();
	const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configured = raw
		?.replace(/\$\{workspaceFolder\}/g, firstFolder ?? '')
		.replace(/\$\{userHome\}/g, os.homedir());
	if (!configured) {
		return undefined;
	}
	return path.resolve(firstFolder ?? os.homedir(), configured);
}

function workspacePattern(pattern: string): vscode.GlobPattern {
	const root = workspaceFolderUri();
	return root ? new vscode.RelativePattern(root, pattern) : pattern;
}

function resolveWorkspaceUri(rawPath: string): vscode.Uri {
	if (!rawPath) {
		throw new Error('tool requires a path');
	}
	const root = workspaceFolderUri();
	if (!root) {
		throw new Error('No workspace folder is open.');
	}
	const rootPath = path.resolve(root.fsPath);
	const resolvedPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootPath, rawPath);
	const relativePath = path.relative(rootPath, resolvedPath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		throw new Error(`Tool path is outside the workspace. Path: ${rawPath}. Workspace: ${rootPath}.`);
	}
	return vscode.Uri.file(resolvedPath);
}

function parentUri(uri: vscode.Uri): vscode.Uri {
	const nextPath = path.posix.dirname(uri.path);
	return uri.with({ path: nextPath === '.' ? '/' : nextPath });
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'string') {
			return value;
		}
	}
	return '';
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'number') {
			return value;
		}
		if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

function boolArg(args: Record<string, unknown>, ...names: string[]): boolean {
	return names.some(name => args[name] === true);
}

function arrayStringArg(args: Record<string, unknown>, name: string): string[] {
	const value = args[name];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asCompactJson(value: unknown): string {
	return JSON.stringify(value).slice(0, 2000);
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
