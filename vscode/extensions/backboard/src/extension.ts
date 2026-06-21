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

interface BridgeEvent {
	readonly type: string;
	readonly requestId: string;
	readonly sessionId?: string;
	readonly message?: string;
	readonly text?: string;
	readonly models?: BridgeModel[];
	readonly tools?: unknown[];
	readonly toolCalls?: unknown[];
	readonly threadId?: string;
	readonly runId?: string;
	readonly stopReason?: string;
	readonly usage?: unknown;
	readonly chunk?: unknown;
	readonly assistantId?: string;
	readonly output?: unknown;
	readonly status?: string;
	readonly name?: string;
	readonly data?: unknown;
}

interface BridgeModel {
	readonly provider: string;
	readonly name: string;
	readonly modelType?: string;
	readonly displayName?: string;
	readonly contextLimit?: number;
	readonly supportsThinking?: boolean;
	readonly pricing?: string;
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly inputPricePerMillion?: number;
	readonly outputPricePerMillion?: number;
	readonly inputCostPer1mTokens?: number;
	readonly outputCostPer1mTokens?: number;
	readonly promptPrice?: number;
	readonly completionPrice?: number;
}

interface ModelCacheEntry {
	readonly env: string;
	readonly version?: number;
	readonly fetchedAt: number;
	readonly models: BridgeModel[];
}

interface ToolCacheEntry {
	readonly env: string;
	readonly version?: number;
	readonly mode: string;
	readonly fetchedAt: number;
	readonly tools: unknown[];
}

interface UpdateManifest {
	readonly version: string;
	readonly url: string;
	readonly sha256?: string;
	readonly size_bytes?: number;
}

interface PendingRequest {
	readonly events: BridgeEvent[];
	readonly onEvent?: (event: BridgeEvent) => void | Promise<void>;
	readonly resetTimeout: () => void;
	readonly resolve: (events: BridgeEvent[]) => void;
	readonly reject: (error: Error) => void;
}

interface ToolResultRequest {
	readonly threadId?: string;
	readonly runId?: string;
	readonly toolCalls: unknown[];
}

interface FileChangePayload {
	readonly path: string;
	readonly status: 'edited' | 'created' | 'deleted';
	readonly added: number;
	readonly removed: number;
	readonly previewLines: readonly { readonly type: 'add' | 'remove' | 'context'; readonly text: string }[];
}

interface VoiceAttachment {
	readonly data: readonly number[];
	readonly fileName: string;
	readonly mimeType: string;
}

interface PanelOptions {
	readonly provider?: string;
	readonly model?: string;
	readonly mode?: string;
	readonly intensity?: string;
	readonly webSearch?: string;
	readonly imageGeneration?: string;
	readonly voiceMode?: string;
	readonly mcpFigma?: boolean;
	readonly mcpNotion?: boolean;
	readonly mcpGoogle?: boolean;
	readonly authenticated?: boolean;
}

interface PanelPersistedState {
	readonly activeView?: string;
	readonly activeHistoryId?: string;
	readonly promptQueue?: unknown[];
	readonly currentWorkspace?: string;
	readonly historyEntries?: unknown[];
	readonly savedAt?: number;
}

interface PanelStateStore {
	readonly latest?: PanelPersistedState;
	readonly byWorkspace?: Record<string, PanelPersistedState>;
}

interface PanelThreadFile {
	readonly version?: number;
	readonly source?: string;
	readonly workspace?: string;
	readonly savedAt?: number;
	readonly entry?: unknown;
}

interface OptimusPanelCommand {
	readonly id: string;
	readonly type: string;
	readonly createdAt?: number;
	readonly prompt?: string;
	readonly chatId?: string;
	readonly workspace?: string;
	readonly provider?: string;
	readonly options?: unknown;
}

type BackboardSettings = ReturnType<typeof readSettings>;
const hiddenModelProviders = new Set(['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics']);
const defaultUpdateManifestBaseUrl = 'https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases';
const stableUpdateChannel = 'stable';
const sandboxUpdateChannel = 'sandbox';
const supportedUpdateChannels = new Set([stableUpdateChannel, sandboxUpdateChannel]);
const promptedUpdateVersions = new Set<string>();
const panelStateStorageKeyPrefix = 'backboard.panel.state.';
const backboardOAuthAuthorizeUrl = 'https://app.backboard.io/api/oauth/authorize';
const backboardOAuthTokenUrl = 'https://app.backboard.io/api/oauth/token';
const backboardOAuthClientId = 'Backboard_oauth_BGmuDtqCPmPgmIqWZ2ORvdqpl8fdKFQY';
const defaultBackboardOAuthRedirectUri = 'http://127.0.0.1:49321/auth/callback';
const backboardOAuthScope = 'openid email profile';
let backboardToolOutput: vscode.OutputChannel | undefined;
let backboardUpdateInstallInProgress = false;
let availableBackboardUpdate: UpdateManifest | undefined;
let backboardUpdateStatusItem: vscode.StatusBarItem | undefined;
let pendingBackboardOAuth: BackboardOAuthPending | undefined;
let lastOptimusPanelCommandId: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
	backboardToolOutput = vscode.window.createOutputChannel('Backboard Tools');
	const bridge = new BackboardBridge(context);
	const panelProvider = new BackboardPanelProvider(bridge, context);
	context.subscriptions.push(backboardToolOutput);
	context.subscriptions.push(bridge);
	backboardUpdateStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
	context.subscriptions.push(backboardUpdateStatusItem);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.setApiKey', async () => {
		if (await setApiKey()) {
			bridge.restart();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.extension.signIn', () => promptBackboardSso(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.copyOAuthRedirectUri', () => copyBackboardOAuthRedirectUri()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.completeOAuthCallback', () => completeBackboardOAuthCallbackFromInput()));
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: uri => handleBackboardOAuthCallback(uri)
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.refreshModels', () => bridge.refreshModels()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(true)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.installAvailableUpdate', () => installAvailableBackboardUpdate()));
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
	const optimusCommandWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(optimusPanelCommandPath()), path.basename(optimusPanelCommandPath())));
	const refreshPanelHistory = () => {
		void panelProvider.postPanelStateSnapshot();
	};
	context.subscriptions.push(panelStateWatcher);
	context.subscriptions.push(panelStateWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidDelete(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher);
	context.subscriptions.push(panelThreadsWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidDelete(refreshPanelHistory));
	const handleOptimusCommand = () => {
		void handleOptimusPanelCommand(panelProvider);
	};
	context.subscriptions.push(optimusCommandWatcher);
	context.subscriptions.push(optimusCommandWatcher.onDidCreate(handleOptimusCommand));
	context.subscriptions.push(optimusCommandWatcher.onDidChange(handleOptimusCommand));
	handleOptimusCommand();
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('backboard.panel', panelProvider, { webviewOptions: { retainContextWhenHidden: true } }));
	startBackboardUpdateChecks(context);
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

async function signInBackboard(bridge: BackboardBridge): Promise<boolean> {
	const state = crypto.randomBytes(24).toString('base64url');
	const nonce = crypto.randomBytes(24).toString('base64url');
	const codeVerifier = crypto.randomBytes(32).toString('base64url');
	const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
	let callbackServer: vscode.Disposable | undefined;

	try {
		const redirectUri = await backboardOAuthCallbackUri();
		backboardToolOutput?.appendLine(`[oauth] Redirect URI: ${redirectUri}`);
		callbackServer = await startBackboardOAuthCallbackServer(redirectUri);
		const codePromise = waitForBackboardOAuthCode(state);
		const params = new URLSearchParams({
			client_id: backboardOAuthClientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: backboardOAuthScope,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			nonce
		});
		const authorizeUrl = `${backboardOAuthAuthorizeUrl}?${params}`;
		backboardToolOutput?.appendLine(`[oauth] Opening Backboard authorize URL first: ${authorizeUrl}`);
		backboardToolOutput?.appendLine(`[oauth] After Allow, Backboard redirects to the registered callback URI above.`);
		await openBackboardOAuthAuthorizeUrl(authorizeUrl);

		const code = await codePromise;
		callbackServer?.dispose();
		callbackServer = undefined;
		backboardToolOutput?.appendLine('[oauth] Received Backboard authorization code; exchanging for tokens.');
		const tokens = await exchangeBackboardOAuthCode(code, redirectUri, codeVerifier);
		const saveResult = await saveBackboardOAuthTokens(tokens);
		bridge.restart();
		if (saveResult.apiKeySaved) {
			backboardToolOutput?.appendLine(`[oauth] Backboard SSO complete. API key saved to ${backboardConfigPath()}.`);
		}
		void vscode.window.showInformationMessage('Backboard SSO complete.');
		return true;
	} catch (error) {
		backboardToolOutput?.appendLine(`[oauth] sign in failed: ${error instanceof Error ? error.message : String(error)}`);
		await vscode.window.showErrorMessage(`Backboard sign in failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	} finally {
		callbackServer?.dispose();
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
	return Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(authorizeUrl))).then(() => undefined);
}

async function copyBackboardOAuthRedirectUri(): Promise<void> {
	const redirectUri = defaultBackboardOAuthRedirectUri;
	await vscode.env.clipboard.writeText(redirectUri);
	backboardToolOutput?.appendLine(`[oauth] Copied redirect URI: ${redirectUri}`);
	await vscode.window.showInformationMessage(`Copied Backboard OAuth redirect URI. Register this exact URI in Backboard: ${redirectUri}`);
}

async function completeBackboardOAuthCallbackFromInput(): Promise<void> {
	const value = await vscode.window.showInputBox({
		title: 'Backboard OAuth Callback URL',
		ignoreFocusOut: true,
		prompt: 'Paste the full callback URL from the browser, including code and state.'
	});
	if (value === undefined) {
		return;
	}
	try {
		const uri = vscode.Uri.parse(value.trim());
		if (!completeBackboardOAuthCallback(uri.query)) {
			await vscode.window.showErrorMessage('Backboard sign in failed: no pending sign in or invalid callback URL.');
		}
	} catch (error) {
		await vscode.window.showErrorMessage(`Backboard sign in failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function waitForBackboardOAuthCode(state: string): Promise<string> {
	pendingBackboardOAuth?.reject(new Error('A new Backboard sign in was started.'));
	if (pendingBackboardOAuth) {
		clearTimeout(pendingBackboardOAuth.timeout);
	}

	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (pendingBackboardOAuth?.state === state) {
				pendingBackboardOAuth = undefined;
			}
			reject(new Error('Timed out waiting for Backboard sign in callback.'));
		}, 5 * 60 * 1000);
		pendingBackboardOAuth = { state, resolve, reject, timeout };
	});
}

async function backboardOAuthCallbackUri(): Promise<string> {
	const configured = vscode.workspace.getConfiguration('backboard').get<string>('oauthRedirectUri')?.trim();
	if (configured) {
		return configured;
	}
	return defaultBackboardOAuthRedirectUri;
}

function startBackboardOAuthCallbackServer(redirectUri: string): Promise<vscode.Disposable | undefined> {
	const parsed = new URL(redirectUri);
	if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
		return Promise.resolve(undefined);
	}
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		return Promise.reject(new Error(`Backboard OAuth redirect URI must include a valid localhost port: ${redirectUri}`));
	}

	return new Promise((resolve, reject) => {
		const server = http.createServer((request, response) => {
			const requestUrl = new URL(request.url ?? '/', redirectUri);
			if (requestUrl.pathname !== parsed.pathname) {
				response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				response.end('Not Found');
				return;
			}

				const handled = completeBackboardOAuthCallback(requestUrl.searchParams.toString());
				response.writeHead(handled ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
				const title = handled ? 'Backboard sign in complete' : 'Backboard sign in could not be completed';
				const message = handled ? 'Returning you to Backboard Studio. This tab may close automatically.' : 'Return to Backboard Studio and start sign in again.';
				const accentColor = handled ? '#1677ff' : '#dc2626';
				const iconPath = handled
					? '<path d="M8.8 12.2 11 14.4 15.7 9.6" /><circle cx="12" cy="12" r="8.5" />'
					: '<path d="M12 7.8v4.7" /><path d="M12 16.2h.01" /><circle cx="12" cy="12" r="8.5" />';
				const closeScript = handled ? `<script>
	window.setTimeout(() => {
		window.close();
	}, 1200);
</script>` : '';
				response.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
	color-scheme: light dark;
	--bg: #f6f8fb;
	--panel: #ffffff;
	--text: #101828;
	--muted: #5f6b7a;
	--border: #d8dee8;
	--accent: ${accentColor};
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0e1116;
		--panel: #161b22;
		--text: #f4f7fb;
		--muted: #a7b0bd;
		--border: #2b3440;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100vh;
	display: grid;
	place-items: center;
	padding: 32px;
	background: var(--bg);
	color: var(--text);
	font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main {
	width: min(520px, 100%);
	padding: 32px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--panel);
	box-shadow: 0 16px 48px rgba(15, 23, 42, 0.12);
}
.mark {
	width: 48px;
	height: 48px;
	display: grid;
	place-items: center;
	border-radius: 8px;
	background: color-mix(in srgb, var(--accent) 12%, transparent);
	color: var(--accent);
}
svg {
	width: 28px;
	height: 28px;
	stroke: currentColor;
	stroke-width: 2;
	fill: none;
	stroke-linecap: round;
	stroke-linejoin: round;
}
h1 {
	margin: 24px 0 10px;
	font-size: 28px;
	line-height: 1.2;
	letter-spacing: 0;
}
p {
	margin: 0;
	color: var(--muted);
	font-size: 16px;
	line-height: 1.5;
}
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24">${iconPath}</svg></div>
<h1>${title}</h1>
<p>${message}</p>
</main>
${closeScript}
</body>
</html>`);
		});
		server.once('error', error => reject(new Error(`Could not start Backboard OAuth callback server on ${redirectUri}: ${error.message}`)));
		server.listen(port, parsed.hostname, () => {
			backboardToolOutput?.appendLine(`[oauth] Listening for callback on ${redirectUri}`);
			resolve({
				dispose: () => {
					server.close();
				}
			});
		});
	});
}

function handleBackboardOAuthCallback(uri: vscode.Uri): void {
	if (uri.path !== '/auth/callback') {
		return;
	}

	completeBackboardOAuthCallback(uri.query);
}

function completeBackboardOAuthCallback(queryString: string): boolean {
	const pending = pendingBackboardOAuth;
	if (!pending) {
		backboardToolOutput?.appendLine('[oauth] Ignoring Backboard callback because no sign in is pending.');
		return false;
	}

	const query = new URLSearchParams(queryString);
	const state = query.get('state')?.trim();
	if (state !== pending.state) {
		pendingBackboardOAuth = undefined;
		clearTimeout(pending.timeout);
		pending.reject(new Error('OAuth state did not match.'));
		return true;
	}

	const error = query.get('error')?.trim();
	if (error) {
		const description = query.get('error_description')?.trim();
		pendingBackboardOAuth = undefined;
		clearTimeout(pending.timeout);
		pending.reject(new Error(description ? `${error}: ${description}` : error));
		return true;
	}

	const code = query.get('code')?.trim();
	if (!code) {
		pendingBackboardOAuth = undefined;
		clearTimeout(pending.timeout);
		pending.reject(new Error('Missing Backboard authorization code.'));
		return true;
	}

	pendingBackboardOAuth = undefined;
	clearTimeout(pending.timeout);
	pending.resolve(code);
	return true;
}

async function exchangeBackboardOAuthCode(code: string, redirectUri: string, codeVerifier: string): Promise<BackboardOAuthTokens> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: backboardOAuthClientId,
		code_verifier: codeVerifier
	});
	const responseText = await postForm(backboardOAuthTokenUrl, body, 'Backboard token request');
	const tokens: unknown = JSON.parse(responseText);
	if (!isObjectRecord(tokens)) {
		throw new Error('Backboard token response was not an object.');
	}
	if (!stringValueFromRecord(tokens.access_token)) {
		throw new Error('Backboard token response did not include an access token.');
	}
	return tokens;
}

function postForm(urlString: string, body: URLSearchParams, label: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
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
				const responseText = Buffer.concat(chunks).toString('utf8');
				const statusCode = response.statusCode ?? 0;
				if (statusCode < 200 || statusCode >= 300) {
					reject(new Error(`${label} returned HTTP ${statusCode}: ${responseText}`));
					return;
				}
				resolve(responseText);
			});
		});
		request.on('error', reject);
		request.write(requestBody);
		request.end();
	});
}

function startBackboardUpdateChecks(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('backboard').get<boolean>('updates.enabled', true)) {
		return;
	}

	const initialTimer = setTimeout(() => {
		void checkBackboardUpdates(false);
	}, 10_000);
	context.subscriptions.push({ dispose: () => clearTimeout(initialTimer) });

	const configuredMinutes = vscode.workspace.getConfiguration('backboard').get<number>('updates.checkIntervalMinutes', 360);
	const intervalMinutes = Number.isFinite(configuredMinutes) ? Math.max(15, configuredMinutes) : 360;
	const timer = setInterval(() => {
		void checkBackboardUpdates(false);
	}, intervalMinutes * 60 * 1000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function checkBackboardUpdates(manual: boolean): Promise<void> {
	try {
		const manifestUrl = getBackboardUpdateManifestUrl();
		if (!manifestUrl) {
			if (manual) {
				await vscode.window.showWarningMessage('Backboard Studio updates are not supported on this platform.');
			}
			return;
		}

		backboardToolOutput?.appendLine(`[updates] checking ${manifestUrl}`);
		const manifest = await fetchBackboardUpdateManifest(manifestUrl);
		const currentVersion = readCurrentAppVersion();
		backboardToolOutput?.appendLine(`[updates] current=${currentVersion} remote=${manifest.version}`);
		if (!isNewerVersion(manifest.version, currentVersion)) {
			await setAvailableBackboardUpdate(undefined);
			if (manual) {
				await vscode.window.showInformationMessage(`Backboard Studio is up to date. Current version: ${currentVersion}.`);
			}
			return;
		}

		await setAvailableBackboardUpdate(manifest);
		if (!manual && promptedUpdateVersions.has(manifest.version)) {
			return;
		}
		if (!manual) {
			promptedUpdateVersions.add(manifest.version);
		}

		const canInstall = canInstallBackboardUpdate();
		const message = `Backboard Studio ${manifest.version} is available from S3. Current version: ${currentVersion}.`;
		const actions = canInstall ? ['Install and Restart', 'Download DMG', 'Copy Link', 'Later'] : ['Download DMG', 'Copy Link', 'Later'];
		const choice = await vscode.window.showInformationMessage(message, ...actions);
		if (choice === 'Install and Restart') {
			await installBackboardUpdate(manifest);
		} else if (choice === 'Download DMG') {
			await vscode.env.openExternal(vscode.Uri.parse(manifest.url));
		} else if (choice === 'Copy Link') {
			await vscode.env.clipboard.writeText(manifest.url);
			await vscode.window.showInformationMessage('Backboard Studio update link copied.');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		backboardToolOutput?.appendLine(`[updates] ${message}`);
		if (manual) {
			await vscode.window.showWarningMessage(`Could not check for Backboard Studio updates: ${message}`);
		}
	}
}

async function setAvailableBackboardUpdate(manifest: UpdateManifest | undefined): Promise<void> {
	availableBackboardUpdate = manifest;
	await vscode.commands.executeCommand('setContext', 'backboard.updateAvailable', Boolean(manifest));
	if (!backboardUpdateStatusItem) {
		return;
	}
	if (!manifest) {
		backboardUpdateStatusItem.hide();
		return;
	}
	backboardUpdateStatusItem.text = `$(cloud-download) Update ${manifest.version}`;
	backboardUpdateStatusItem.tooltip = `Install Backboard Studio ${manifest.version}`;
	backboardUpdateStatusItem.show();
}

async function installAvailableBackboardUpdate(): Promise<void> {
	if (!availableBackboardUpdate) {
		await checkBackboardUpdates(true);
		return;
	}
	if (canInstallBackboardUpdate()) {
		await installBackboardUpdate(availableBackboardUpdate);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(availableBackboardUpdate.url));
}

function canInstallBackboardUpdate(): boolean {
	if (process.platform !== 'darwin') {
		return false;
	}
	const appPath = currentMacAppPath();
	return Boolean(appPath && path.basename(appPath) === 'Backboard Studio.app');
}

async function installBackboardUpdate(manifest: UpdateManifest): Promise<void> {
	if (backboardUpdateInstallInProgress) {
		await vscode.window.showInformationMessage('Backboard Studio update installation is already running.');
		return;
	}
	const appPath = currentMacAppPath();
	if (!appPath || path.basename(appPath) !== 'Backboard Studio.app') {
		await vscode.window.showWarningMessage('Automatic update install is only available from the packaged Backboard Studio app.');
		return;
	}

	backboardUpdateInstallInProgress = true;
	try {
		const updateDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backboard-studio-update-'));
		const dmgPath = path.join(updateDirectory, `Backboard-Studio-${manifest.version}.dmg`);
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Downloading Backboard Studio ${manifest.version}`,
			cancellable: false
		}, async progress => {
			await downloadBackboardUpdate(manifest.url, dmgPath, progress);
		});
		await verifyBackboardUpdate(dmgPath, manifest);
		await stageMacBackboardInstaller(dmgPath, appPath, manifest.version);
		await vscode.window.showInformationMessage(`Backboard Studio ${manifest.version} is verified. Restarting to install.`);
		await vscode.commands.executeCommand('workbench.action.quit');
	} catch (error) {
		backboardUpdateInstallInProgress = false;
		const message = error instanceof Error ? error.message : String(error);
		backboardToolOutput?.appendLine(`[updates] install failed: ${message}`);
		await vscode.window.showWarningMessage(`Could not install Backboard Studio update: ${message}`);
	}
}

function currentMacAppPath(): string | undefined {
	const match = /^(.+?\.app)(?:\/|$)/.exec(process.execPath);
	return match?.[1];
}

function downloadBackboardUpdate(rawUrl: string, destination: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = downloadWithRedirects(rawUrl, destination, progress, 5, resolve, reject);
		request.on('error', reject);
	});
}

function downloadWithRedirects(
	rawUrl: string,
	destination: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	redirectLimit: number,
	resolve: () => void,
	reject: (error: Error) => void
): http.ClientRequest {
	const url = new URL(rawUrl);
	const client = url.protocol === 'http:' ? http : https;
	const request = client.get(url, { headers: { 'User-Agent': `Backboard-Studio/${readCurrentAppVersion()}` } }, response => {
		const statusCode = response.statusCode ?? 0;
		const location = response.headers.location;
		if (statusCode >= 300 && statusCode < 400 && location && redirectLimit > 0) {
			response.resume();
			const nextRequest = downloadWithRedirects(new URL(location, url).toString(), destination, progress, redirectLimit - 1, resolve, reject);
			nextRequest.on('error', reject);
			return;
		}
		if (statusCode < 200 || statusCode >= 300) {
			response.resume();
			reject(new Error(`Update download failed with HTTP ${statusCode}.`));
			return;
		}

		const expectedBytes = Number(response.headers['content-length']) || undefined;
		let downloadedBytes = 0;
		let lastPercent = 0;
		const file = fs.createWriteStream(destination, { mode: 0o600 });
		response.on('data', chunk => {
			const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
			downloadedBytes += size;
			if (expectedBytes) {
				const percent = Math.min(100, Math.floor((downloadedBytes / expectedBytes) * 100));
				if (percent > lastPercent) {
					progress.report({ increment: percent - lastPercent, message: `${percent}%` });
					lastPercent = percent;
				}
			} else {
				progress.report({ message: `${Math.round(downloadedBytes / 1024 / 1024)} MB` });
			}
		});
		response.pipe(file);
		file.on('finish', () => file.close(error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		}));
		file.on('error', error => {
			response.destroy();
			reject(error);
		});
	});
	request.setTimeout(120_000, () => {
		request.destroy(new Error('Update download timed out.'));
	});
	return request;
}

async function verifyBackboardUpdate(dmgPath: string, manifest: UpdateManifest): Promise<void> {
	const stat = await fs.promises.stat(dmgPath);
	if (manifest.size_bytes !== undefined && stat.size !== manifest.size_bytes) {
		throw new Error(`Downloaded update size mismatch. Expected ${manifest.size_bytes} bytes, got ${stat.size}.`);
	}
	if (manifest.sha256) {
		const actualSha256 = await sha256File(dmgPath);
		if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
			throw new Error(`Downloaded update SHA-256 mismatch. Expected ${manifest.sha256}, got ${actualSha256}.`);
		}
	}
}

function sha256File(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

async function stageMacBackboardInstaller(dmgPath: string, appPath: string, version: string): Promise<void> {
	const installerPath = path.join(path.dirname(dmgPath), 'install-backboard-update.sh');
	const logPath = path.join(os.tmpdir(), 'backboard-studio-update.log');
	await fs.promises.writeFile(installerPath, macUpdateInstallerScript(), { mode: 0o700 });
	const child = cp.spawn('/bin/zsh', [installerPath, dmgPath, appPath, String(process.pid), version, logPath], {
		detached: true,
		stdio: 'ignore'
	});
	child.unref();
}

function macUpdateInstallerScript(): string {
	return `#!/bin/zsh
set -euo pipefail

DMG_PATH="$1"
APP_PATH="$2"
CURRENT_PID="$3"
VERSION="$4"
LOG_PATH="$5"
APP_NAME="Backboard Studio.app"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/backboard-studio-update-mount.XXXXXX)"

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installing Backboard Studio $VERSION"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

/usr/bin/hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
SOURCE_APP="$MOUNT_POINT/$APP_NAME"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Mounted DMG did not contain $APP_NAME"
  exit 1
fi

/usr/bin/osascript -e 'tell application id "io.backboard.studio" to quit' >/dev/null 2>&1 || true
for _ in {1..120}; do
  if ! /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done
/usr/bin/pkill -f "$APP_PATH/Contents/" >/dev/null 2>&1 || true

replace_app() {
  /bin/rm -rf "$APP_PATH"
  /usr/bin/ditto "$SOURCE_APP" "$APP_PATH"
  /bin/chmod -R u+rwX "$APP_PATH" >/dev/null 2>&1 || true
  /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true
}

if [[ -w "$(dirname "$APP_PATH")" || -w "$APP_PATH" ]]; then
  replace_app
else
  HELPER="$(/usr/bin/mktemp /tmp/backboard-studio-update-elevated.XXXXXX.sh)"
  shell_quote() {
    /usr/bin/python3 -c 'import shlex, sys; print(shlex.quote(sys.argv[1]))' "$1"
  }
  {
    echo '#!/bin/zsh'
    echo 'set -euo pipefail'
    printf 'SOURCE_APP=%s\\n' "$(shell_quote "$SOURCE_APP")"
    printf 'APP_PATH=%s\\n' "$(shell_quote "$APP_PATH")"
    echo '/bin/rm -rf "$APP_PATH"'
    echo '/usr/bin/ditto "$SOURCE_APP" "$APP_PATH"'
    echo '/bin/chmod -R a+rX "$APP_PATH" >/dev/null 2>&1 || true'
    echo '/usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true'
  } > "$HELPER"
  /bin/chmod 700 "$HELPER"
  /usr/bin/osascript -e "do shell script \\"/bin/zsh $HELPER\\" with administrator privileges"
  /bin/rm -f "$HELPER"
fi

cleanup
/usr/bin/open "$APP_PATH"
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installed Backboard Studio $VERSION"
`;
}

function getBackboardUpdateManifestUrl(): string | undefined {
	const config = vscode.workspace.getConfiguration('backboard');
	const configuredManifestUrl = config.get<string>('updates.manifestUrl', '').trim();
	const manifestUrlOverride = process.env.BBIDE_UPDATE_MANIFEST_URL || process.env.BACKBOARD_UPDATE_MANIFEST_URL || configuredManifestUrl;
	if (manifestUrlOverride.trim()) {
		return manifestUrlOverride.trim();
	}

	const platform = getUpdatePlatform();
	const arch = getUpdateArch();
	if (!platform || !arch) {
		return undefined;
	}

	const configuredBaseUrl = config.get<string>('updates.manifestBaseUrl', defaultUpdateManifestBaseUrl).trim();
	const manifestBaseUrl = (process.env.BBIDE_UPDATE_MANIFEST_BASE_URL || process.env.BACKBOARD_UPDATE_MANIFEST_BASE_URL || configuredBaseUrl || defaultUpdateManifestBaseUrl)
		.trim()
		.replace(/\/+$/, '');
	const channel = getBackboardUpdateChannel(config);
	return `${manifestBaseUrl}/${channel}/latest/bbide/${platform}-${arch}.json`;
}

function getBackboardUpdateChannel(config: vscode.WorkspaceConfiguration): string {
	const configuredChannel = process.env.BBIDE_UPDATE_CHANNEL
		|| process.env.BACKBOARD_UPDATE_CHANNEL
		|| config.get<string>('updates.channel', '').trim();
	const configured = normalizeBackboardUpdateChannel(configuredChannel);
	if (configured) {
		return configured;
	}

	const packagedChannel = normalizeBackboardUpdateChannel(
		readBackboardReleaseMetadataString('channel', 'backboardUpdateChannel', 'productJsonBackboardUpdateChannel')
		|| readBackboardProductMetadataString('backboardUpdateChannel')
	);
	if (packagedChannel) {
		return packagedChannel;
	}

	return isBackboardDevelopmentBuild() ? sandboxUpdateChannel : stableUpdateChannel;
}

function normalizeBackboardUpdateChannel(channel: string | undefined): string | undefined {
	const normalized = channel?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (supportedUpdateChannels.has(normalized)) {
		return normalized;
	}
	backboardToolOutput?.appendLine(`[updates] unsupported channel "${channel}", falling back to automatic channel selection.`);
	return undefined;
}

function isBackboardDevelopmentBuild(): boolean {
	const metadataVersion = readBackboardReleaseMetadataString('version', 'backboardStudioVersion')
		|| readBackboardProductMetadataString('backboardStudioVersion');
	if (metadataVersion) {
		return false;
	}

	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes('dev')) {
		return true;
	}

	const productName = readBackboardProductMetadataString('nameShort', 'nameLong', 'applicationName');
	if (productName?.toLowerCase().includes('dev')) {
		return true;
	}

	return readCurrentAppVersion() === 'development build';
}

function getUpdatePlatform(): string | undefined {
	switch (process.platform) {
		case 'darwin':
			return 'macos';
		case 'win32':
			return 'windows';
		default:
			return undefined;
	}
}

function getUpdateArch(): string | undefined {
	switch (process.arch) {
		case 'arm64':
			return 'aarch64';
		case 'x64':
			return 'x86_64';
		default:
			return undefined;
	}
}

async function fetchBackboardUpdateManifest(manifestUrl: string): Promise<UpdateManifest> {
	const body = await fetchText(manifestUrl, 5);
	const parsed = JSON.parse(body) as unknown;
	if (!isObjectRecord(parsed)) {
		throw new Error('Update manifest is not an object.');
	}
	const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
	const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
	if (!version || !url) {
		throw new Error('Update manifest is missing version or url.');
	}
	return {
		version,
		url,
		sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : undefined,
		size_bytes: typeof parsed.size_bytes === 'number' ? parsed.size_bytes : undefined
	};
}

function fetchText(rawUrl: string, redirectLimit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const url = new URL(rawUrl);
		const client = url.protocol === 'http:' ? http : https;
		const request = client.get(url, { headers: { 'User-Agent': `Backboard-Studio/${readCurrentAppVersion()}` } }, response => {
			const statusCode = response.statusCode ?? 0;
			const location = response.headers.location;
			if (statusCode >= 300 && statusCode < 400 && location && redirectLimit > 0) {
				response.resume();
				resolve(fetchText(new URL(location, url).toString(), redirectLimit - 1));
				return;
			}
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				reject(new Error(`Update manifest request failed with HTTP ${statusCode}.`));
				return;
			}

			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		request.setTimeout(15_000, () => {
			request.destroy(new Error('Update manifest request timed out.'));
		});
		request.on('error', reject);
	});
}

function readCurrentAppVersion(): string {
	const envVersion = process.env.BACKBOARD_STUDIO_VERSION || process.env.BBIDE_VERSION;
	if (envVersion?.trim()) {
		return envVersion.trim();
	}

	const metadataVersion = readBackboardReleaseMetadataString('version', 'backboardStudioVersion');
	if (metadataVersion) {
		return metadataVersion;
	}

	const productVersion = readBackboardProductMetadataString('backboardStudioVersion');
	if (productVersion) {
		return productVersion;
	}

	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	const releaseMetadataPaths = [
		appRoot ? path.join(appRoot, 'backboard-build-info.json') : undefined,
		appRoot ? path.join(appRoot, 'product.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'backboard-build-info.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'product.json') : undefined,
		path.join(process.cwd(), 'backboard-build-info.json'),
		path.join(process.cwd(), 'product.json')
	].filter((value): value is string => Boolean(value));
	for (const releaseMetadataPath of releaseMetadataPaths) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(releaseMetadataPath, 'utf8'));
			if (isObjectRecord(parsed)) {
				const backboardBuildInfo = isObjectRecord(parsed.backboardBuildInfo) ? parsed.backboardBuildInfo : undefined;
				const isBuildInfoFile = path.basename(releaseMetadataPath) === 'backboard-build-info.json';
				const value =
					stringValueFromRecord(parsed.backboardStudioVersion) ||
					(backboardBuildInfo ? stringValueFromRecord(backboardBuildInfo.version) : undefined) ||
					(isBuildInfoFile ? stringValueFromRecord(parsed.version) : undefined);
				if (value) {
					return value;
				}
			}
		} catch {
			// Development hosts may not have packaged Backboard release metadata.
		}
	}

	const appPath = currentMacAppPath();
	const infoPlistPaths = [
		appPath ? path.join(appPath, 'Contents', 'Info.plist') : undefined,
		path.join(path.dirname(process.execPath), '..', 'Info.plist')
	].filter((value): value is string => Boolean(value));
	for (const infoPlist of infoPlistPaths) {
		try {
			const plist = fs.readFileSync(infoPlist, 'utf8');
			const value = readPlistString(plist, 'CFBundleShortVersionString') || readPlistString(plist, 'CFBundleVersion');
			if (value && value !== vscode.version) {
				return value;
			}
		} catch {
			// Development hosts may not run from a packaged macOS app bundle.
		}
	}

	return 'development build';
}

function readBackboardReleaseMetadataString(...keys: string[]): string | undefined {
	for (const metadataPath of backboardReleaseMetadataPaths()) {
		const value = readBackboardMetadataString(metadataPath, keys, true);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function readBackboardProductMetadataString(...keys: string[]): string | undefined {
	for (const metadataPath of backboardProductMetadataPaths()) {
		const value = readBackboardMetadataString(metadataPath, keys, false);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function readBackboardMetadataString(metadataPath: string, keys: readonly string[], includeBuildInfo: boolean): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
		if (!isObjectRecord(parsed)) {
			return undefined;
		}
		const buildInfo = includeBuildInfo && isObjectRecord(parsed.backboardBuildInfo) ? parsed.backboardBuildInfo : undefined;
		for (const key of keys) {
			const rootValue = stringValueFromRecord(parsed[key]);
			if (rootValue) {
				return rootValue;
			}
			const buildInfoValue = buildInfo ? stringValueFromRecord(buildInfo[key]) : undefined;
			if (buildInfoValue) {
				return buildInfoValue;
			}
		}
	} catch {
		// Development hosts may not have packaged Backboard release metadata.
	}
	return undefined;
}

function backboardReleaseMetadataPaths(): string[] {
	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	return [
		appRoot ? path.join(appRoot, 'backboard-build-info.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'backboard-build-info.json') : undefined,
		path.join(process.cwd(), 'backboard-build-info.json')
	].filter((value): value is string => Boolean(value));
}

function backboardProductMetadataPaths(): string[] {
	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	return [
		appRoot ? path.join(appRoot, 'product.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'product.json') : undefined,
		path.join(process.cwd(), 'product.json')
	].filter((value): value is string => Boolean(value));
}

function readPlistString(plist: string, key: string): string | undefined {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`).exec(plist);
	return match?.[1]?.trim();
}

function isNewerVersion(candidate: string, current: string): boolean {
	const candidateParts = parseVersion(candidate);
	const currentParts = parseVersion(current);
	if (!candidateParts || !currentParts) {
		return candidate !== current;
	}

	for (let index = 0; index < Math.max(candidateParts.length, currentParts.length); index++) {
		const candidatePart = candidateParts[index] ?? 0;
		const currentPart = currentParts[index] ?? 0;
		if (candidatePart > currentPart) {
			return true;
		}
		if (candidatePart < currentPart) {
			return false;
		}
	}
	return false;
}

function parseVersion(version: string): number[] | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
	if (!match) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
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
	if (voiceMode === 'stt' || voiceMode === 'conversation') {
		return 'Audio input is not implemented in the Backboard Studio host yet. Use TTS or turn voice off.';
	}
	return undefined;
}

interface BackboardConfigJson {
	readonly [key: string]: unknown;
	readonly env?: string;
	readonly api_key?: string;
	readonly env_keys?: Record<string, string>;
}

interface BackboardOAuthTokens {
	readonly api_key?: string | null;
	readonly apiKey?: string | null;
	readonly access_token?: string;
	readonly refresh_token?: string;
	readonly token_type?: string;
	readonly expires_in?: number;
	readonly scope?: string;
	readonly id_token?: string | null;
	readonly assistant_id?: string | null;
	readonly backboard_api_key?: string | null;
	readonly personal_api_key?: string | null;
	readonly selected_client_name?: string | null;
}

interface BackboardOAuthPending {
	readonly state: string;
	readonly resolve: (code: string) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
}

interface BackboardOAuthSaveResult {
	readonly apiKeySaved: boolean;
	readonly assistantId?: string;
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

function optimusPanelCommandPath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'optimus-command.json');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptimusPanelCommand(value: unknown): value is OptimusPanelCommand {
	return isObjectRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.type === 'string'
		&& (value.createdAt === undefined || typeof value.createdAt === 'number')
		&& (value.prompt === undefined || typeof value.prompt === 'string')
		&& (value.chatId === undefined || typeof value.chatId === 'string')
		&& (value.workspace === undefined || typeof value.workspace === 'string')
		&& (value.provider === undefined || typeof value.provider === 'string');
}

async function handleOptimusPanelCommand(panelProvider: BackboardPanelProvider): Promise<void> {
	let command: OptimusPanelCommand | undefined;
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(optimusPanelCommandPath(), 'utf8'));
		command = isOptimusPanelCommand(parsed) ? parsed : undefined;
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			backboardToolOutput?.appendLine(`[optimus] failed to read command: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}
	if (!command || command.id === lastOptimusPanelCommandId) {
		return;
	}
	if (typeof command.createdAt === 'number' && Date.now() - command.createdAt > 10 * 60 * 1000) {
		return;
	}
	lastOptimusPanelCommandId = command.id;
	backboardToolOutput?.appendLine(`[optimus] received ${command.type}`);
	switch (command.type) {
		case 'newChat':
			await openBackboardView();
			await panelProvider.postUiCommand('newChat', command.workspace);
			break;
		case 'showHistory':
			await openBackboardView();
			await panelProvider.postUiCommand('showHistory', command.workspace);
			break;
		case 'showChat':
			await openBackboardView();
			await panelProvider.postUiCommand('showChat', command.workspace);
			break;
		case 'openHistoryEntry':
			await openBackboardView();
			await panelProvider.openHistoryEntry(command.chatId);
			break;
		case 'sendPrompt':
			await openBackboardView();
			panelProvider.submitPromptFromOptimus(command.prompt ?? '', asPanelOptions(command.options), command.chatId, command.workspace);
			break;
		case 'cancel':
			panelProvider.cancelActiveRun();
			break;
		case 'reviewChanges':
			await panelProvider.reviewChanges();
			break;
		default:
			backboardToolOutput?.appendLine(`[optimus] ignored unknown command: ${command.type}`);
	}
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

function newerPanelState(...states: (PanelPersistedState | undefined)[]): PanelPersistedState | undefined {
	let best: PanelPersistedState | undefined;
	for (const state of states) {
		if (!hasPanelStateContent(state)) {
			continue;
		}
		if (!best || panelStateTimestamp(state) >= panelStateTimestamp(best)) {
			best = state;
		}
	}
	return best;
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
		return newerPanelState(scoped, threaded);
	}
	return newerPanelState(store.latest, threaded);
}

async function writeSharedPanelState(state: PanelPersistedState): Promise<void> {
	const persistedState = enrichPanelPersistedState(state);
	const existing = readSharedPanelStateStore();
	const key = panelStateStorageKey(persistedState.currentWorkspace);
	const byWorkspace = { ...(existing.byWorkspace ?? {}), [key]: persistedState };
	const next: PanelStateStore = {
		byWorkspace,
		latest: hasPanelStateContent(persistedState) ? persistedState : existing.latest,
	};
	const statePath = backboardPanelStatePath();
	await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
	await writeJsonFileAtomic(statePath, next);
	if (process.platform !== 'win32') {
		await fs.promises.chmod(statePath, 0o600);
	}
	await writeSharedPanelThreads(persistedState);
}

function enrichPanelPersistedState(state: PanelPersistedState): PanelPersistedState {
	if (!Array.isArray(state.historyEntries)) {
		return state;
	}
	return {
		...state,
		historyEntries: state.historyEntries.map(entry => isObjectRecord(entry) ? enrichPanelThreadEntry(entry) : entry),
	};
}

function enrichPanelThreadEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const html = typeof entry.html === 'string' ? entry.html : '';
	const prompt = typeof entry.prompt === 'string' ? entry.prompt : typeof entry.title === 'string' ? entry.title : '';
	const outputText = typeof entry.outputText === 'string' ? entry.outputText : extractPanelAssistantText(html);
	const toolOutputs = Array.isArray(entry.toolOutputs) ? entry.toolOutputs : extractPanelToolOutputs(html);
	return {
		...entry,
		outputText,
		messages: [
			{ role: 'user', content: prompt },
			...(outputText ? [{ role: 'assistant', content: outputText }] : []),
		],
		toolOutputs,
	};
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
	return {
		activeView: 'chat',
		activeHistoryId: activeId,
		currentWorkspace: workspace,
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

async function writeSharedPanelThreads(state: PanelPersistedState): Promise<void> {
	const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
	const threadsDir = backboardThreadsDir();
	await fs.promises.mkdir(threadsDir, { recursive: true });
	const workspace = typeof state.currentWorkspace === 'string' ? state.currentWorkspace : undefined;
	const currentIds = new Set<string>();
	for (const entry of entries) {
		if (!isObjectRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
			continue;
		}
		currentIds.add(entry.id);
		const threadPath = panelThreadPath(workspace, entry.id);
		await fs.promises.mkdir(path.dirname(threadPath), { recursive: true });
		await writeJsonFileAtomic(threadPath, {
			version: 1,
			source: 'panel',
			workspace,
			threadId: entry.id,
			savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now(),
			entry,
		});
		if (process.platform !== 'win32') {
			await fs.promises.chmod(threadPath, 0o600);
		}
	}
	await pruneSharedPanelThreads(state, currentIds);
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

function scriptJson(value: unknown): string {
	return JSON.stringify(value ?? null)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
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

function hasBackboardCredentials(): boolean {
	const config = readBackboardConfigJsonSync();
	return Boolean(backboardConfigApiKey(config) || backboardConfigAccessToken(config));
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
	return { apiKeySaved: Boolean(usableApiKey), assistantId };
}

async function clearBackboardConfigApiKey(): Promise<void> {
	const config = await readBackboardConfigJson();
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv());
	const envKeys = backboardConfigEnvKeys(config);
	delete envKeys[env];
	const nextConfig = {
		...config,
		env,
		env_keys: envKeys
	};
	delete nextConfig.api_key;
	await writeBackboardConfigJson(nextConfig);
}

interface ResponseSink {
	markdown(value: string | vscode.MarkdownString): void;
	progress(value: string): void;
	event?(type: string, payload: unknown): void;
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
				response.progress(event.text.slice(0, 180));
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

	constructor(private readonly bridge: BackboardBridge, private readonly context: vscode.ExtensionContext) {
	}

	async postUiCommand(command: 'newChat' | 'showHistory' | 'showChat', workspace?: string): Promise<boolean> {
		return this.view?.webview.postMessage({ type: 'command', command, workspace }) ?? false;
	}

	async openHistoryEntry(chatId: string | undefined): Promise<boolean> {
		if (!chatId) {
			return this.postUiCommand('showHistory');
		}
		return this.view?.webview.postMessage({ type: 'command', command: 'openHistoryEntry', chatId }) ?? false;
	}

	submitPromptFromOptimus(prompt: string, options: PanelOptions, chatId: string | undefined, workspaceOverride: string | undefined): void {
		if (!prompt.trim()) {
			return;
		}
		this.runPrompt(prompt, options, chatId, undefined, workspaceOverride);
	}

	cancelActiveRun(): void {
		this.runToken?.cancel();
	}

	async reviewChanges(): Promise<void> {
		await vscode.commands.executeCommand('workbench.view.scm');
	}

	refreshState(): void {
		const view = this.view;
		if (view) {
			void postPanelState(this.bridge, view.webview);
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.title = '\u200B';
		webviewView.webview.options = { enableScripts: true, localResourceRoots: webviewLocalResourceRoots(this.context) };
		webviewView.webview.html = panelHtml(webviewView.webview, codiconsStylesheetUri(this.context, webviewView.webview), iconBaseUri(this.context, webviewView.webview), fontBaseUri(this.context, webviewView.webview), { showHeader: false, initialState: this.readPanelState() });
		webviewView.webview.onDidReceiveMessage(message => {
			if (message?.type === 'send' && typeof message.prompt === 'string') {
				this.runPrompt(message.prompt, asPanelOptions(message.options), typeof message.chatId === 'string' ? message.chatId : undefined, undefined, typeof message.workspace === 'string' ? message.workspace : undefined);
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
				void postPanelState(this.bridge, webviewView.webview, message?.type === 'refreshModels');
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
		await writeSharedPanelState(state).catch(error => {
			backboardToolOutput?.appendLine(`[panel-state] failed to save shared state: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async postPanelStateSnapshot(): Promise<void> {
		await this.view?.webview.postMessage({ type: 'panelStateSnapshot', state: this.readPanelState() });
	}

	private runPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string): void {
		const serial = ++this.promptRunSerial;
		const previousRun = this.activePromptRun;
		if (previousRun) {
			this.runToken?.cancel();
			void this.view?.webview.postMessage({ type: 'status', text: 'Waiting for the current Backboard turn to stop.' });
		}
		const run = (async () => {
			if (previousRun) {
				try {
					await previousRun;
				} catch {
					// The previous run already reported its error to the webview.
				}
			}
			if (serial !== this.promptRunSerial) {
				return;
			}
			await this.sendPrompt(prompt, options, chatId, audio, workspaceOverride);
		})();
		this.activePromptRun = run;
		void run.finally(() => {
			if (this.activePromptRun === run) {
				this.activePromptRun = undefined;
			}
		});
	}

	private async sendPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string): Promise<void> {
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
		const sessionId = `panel:${effectiveWorkspace ?? 'default'}:${effectiveChatId || 'default'}`;
		const sink = this.panelSink(view);
		const content = prompt.trim() || 'Please transcribe this audio and respond.';
		const imageGeneration = imageGenerationForPrompt(content, settings.imageGeneration);
		await view.webview.postMessage({ type: 'runStarted', prompt: content, chatId: effectiveChatId });
		await view.webview.postMessage({ type: 'status', text: 'Sending to Backboard.' });
		const pendingToolRequests: ToolResultRequest[] = [];
		const seenToolRequests = new Set<string>();
		try {
			let currentToolRequest: ToolResultRequest | undefined;
			await this.bridge.send('sendPrompt', sessionId, {
				content,
				workspace: effectiveWorkspace,
				provider: settings.defaultProvider,
				model: settings.defaultModel,
				mode: settings.mode,
				intensity: settings.intensity,
				webSearch: settings.webSearch,
				imageGeneration: imageGeneration === 'auto' ? 'auto' : undefined,
				voiceMode,
				audioFile: audio,
				mcpCalls: mcpCallsPayload(settings),
				config: settings.config
			}, event => {
				const toolRequest = renderBridgeEvent(event, sink, currentToolRequest);
				if (toolRequest && toolRequest !== currentToolRequest) {
					currentToolRequest = toolRequest;
					enqueueToolResultRequest(pendingToolRequests, toolRequest, seenToolRequests);
				}
			}, token);

			const submitTools = await this.bridge.listTools(settings.mode, token).catch(() => undefined);
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
					const followupToolRequest = renderBridgeEvent(event, sink, currentContinuationToolRequest);
					if (followupToolRequest && followupToolRequest !== currentContinuationToolRequest) {
						currentContinuationToolRequest = followupToolRequest;
						enqueueToolResultRequest(pendingToolRequests, followupToolRequest, seenToolRequests);
					}
				}, token);
				nextToolRequest = pendingToolRequests.shift();
			}
			await view.webview.postMessage({ type: 'runFinished', chatId: effectiveChatId });
			await view.webview.postMessage({ type: 'status', text: token.isCancellationRequested ? 'Cancelled.' : 'Done.' });
		} catch (error) {
			await view.webview.postMessage({ type: 'append', role: 'error', text: error instanceof Error ? error.message : String(error) });
			await view.webview.postMessage({ type: 'runFinished', chatId: effectiveChatId });
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

function webviewLocalResourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {
	return [
		context.extensionUri,
		vscode.Uri.file(path.join(context.extensionPath, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist'))
	];
}

function codiconsStylesheetUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')));
}

function iconBaseUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icons'));
}

function fontBaseUri(context: vscode.ExtensionContext, webview: vscode.Webview): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'fonts'));
}

function panelHtml(webview: vscode.Webview, codiconsStylesheet: vscode.Uri, iconBase: vscode.Uri, fontBase: vscode.Uri, options: { readonly showHeader: boolean; readonly initialState?: PanelPersistedState }): string {
	const nonce = newId();
	const csp = `default-src 'none'; img-src ${webview.cspSource} https: data: blob:; media-src ${webview.cspSource} https: data: blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	const backboardLogo = `${iconBase.toString()}/backboard_logo.svg`;
	const interFont = `${fontBase.toString()}/inter/Inter-VariableFont_opsz,wght.ttf`;
	const interItalicFont = `${fontBase.toString()}/inter/Inter-Italic-VariableFont_opsz,wght.ttf`;
	const jetBrainsMonoFont = `${fontBase.toString()}/jetbrains-mono/JetBrainsMono-VariableFont_wght.ttf`;
	const jetBrainsMonoItalicFont = `${fontBase.toString()}/jetbrains-mono/JetBrainsMono-Italic-VariableFont_wght.ttf`;
	const rootRows = `${options.showHeader ? '42px ' : ''}35px 24px minmax(0, 1fr) auto`;
	const logLabel = options.showHeader ? 'aria-labelledby="chatTab"' : 'aria-label="Chat"';
	const initialStateJson = scriptJson(options.initialState ?? {});
	const header = options.showHeader ? `
			<div class="panelHeader">
				<div class="brandMark"><span class="codicon codicon-sparkle"></span></div>
				<div class="brandTitle">Backboard</div>
				<div class="headerSpacer"></div>
				<div id="headerBadge" class="headerBadge">Full Access</div>
				<div class="headerActions" role="tablist" aria-label="Backboard panel">
					<button id="chatTab" class="headerIconButton active" type="button" role="tab" aria-selected="true" aria-controls="log" title="Chat" aria-label="Chat"><span class="codicon codicon-comment-discussion"></span></button>
					<button id="newChatBtn" class="headerIconButton" type="button" title="New Chat" aria-label="New Chat"><span class="codicon codicon-add"></span></button>
					<button id="historyTab" class="headerIconButton historyHeaderButton" type="button" role="tab" aria-selected="false" aria-controls="historyPane" title="History" aria-label="History"><span class="codicon codicon-history"></span><span id="historyCount" class="tabCount">0</span></button>
				</div>
			</div>` : '<div id="headerBadge" class="headerBadge hidden">Full Access</div>';
	const recentTabs = `
				<div class="recentTabsShell">
					<div id="recentTabs" class="recentTabs" role="tablist" aria-label="Recent chats"></div>
					<div class="recentTabsActions">
						<button id="inlineNewChatBtn" class="recentActionButton" type="button" title="New Chat" aria-label="New Chat"><span class="codicon codicon-add"></span></button>
						<button id="inlineHistoryBtn" class="recentActionButton" type="button" title="History" aria-label="History"><span class="codicon codicon-history"></span><span id="inlineHistoryCount" class="tabCount">0</span></button>
					</div>
				</div>`;
	const checkpointStrip = `
				<div id="checkpointStrip" class="checkpointStrip" aria-label="Checkpoints">
					<span class="checkpointTitle">Checkpoints</span>
					<div id="checkpointList" class="checkpointList"></div>
				</div>`;
	const historyPane = `
				<div id="historyPane" class="historyPane viewPane" role="tabpanel" aria-label="History">
					<div id="historyEmpty" class="historyEmpty">No history yet.</div>
					<div id="historyList" class="historyList"></div>
				</div>`;
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<link href="${codiconsStylesheet}" rel="stylesheet">
		<style>
			@font-face { font-family: 'Inter'; src: url('${interFont}') format('truetype'); font-weight: 100 900; font-style: normal; font-display: swap; }
			@font-face { font-family: 'Inter'; src: url('${interItalicFont}') format('truetype'); font-weight: 100 900; font-style: italic; font-display: swap; }
			@font-face { font-family: 'JetBrains Mono'; src: url('${jetBrainsMonoFont}') format('truetype'); font-weight: 100 800; font-style: normal; font-display: swap; }
			@font-face { font-family: 'JetBrains Mono'; src: url('${jetBrainsMonoItalicFont}') format('truetype'); font-weight: 100 800; font-style: italic; font-display: swap; }
			:root {
			--bb-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #ffffff));
			--bb-surface: color-mix(in srgb, var(--vscode-sideBar-background, #fbfcfd) 88%, var(--vscode-editor-background, #ffffff));
			--bb-card: color-mix(in srgb, var(--vscode-editorWidget-background, #ffffff) 86%, var(--bb-bg));
			--bb-border: color-mix(in srgb, var(--vscode-widget-border, #e6eaf0) 72%, var(--vscode-sideBar-border, #e9edf2));
			--bb-primary: var(--vscode-focusBorder, #5b8cff);
			--bb-text: var(--vscode-foreground, #242833);
			--bb-muted: var(--vscode-descriptionForeground, #7c8797);
			--bb-subtle: color-mix(in srgb, var(--vscode-descriptionForeground, #8f9bad) 62%, transparent);
			--bb-success: #2f9f5b;
			--bb-danger: #d83e64;
			--bb-danger-bg: color-mix(in srgb, #fff2f4 82%, var(--vscode-editor-background, #ffffff));
			--bb-success-bg: color-mix(in srgb, #f0fbf4 82%, var(--vscode-editor-background, #ffffff));
			--bb-shadow: color-mix(in srgb, var(--vscode-widget-shadow, #000000) 8%, transparent);
			--bb-radius: 8px;
			--bb-composer-safe-bottom: 0px;
		}
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; min-width: 0; overflow: hidden; }
			body { padding: 0; margin: 0; color: var(--bb-text); background: var(--bb-bg); font-family: var(--vscode-font-family, "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: var(--vscode-font-size); }
			.root { position: relative; display: grid; grid-template-rows: ${rootRows}; height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; background: var(--bb-bg); }
			.root > :not(.authOverlay) { transition: filter .18s ease, opacity .18s ease; }
			.root.authRequired > :not(.authOverlay) { filter: blur(4px); opacity: .48; pointer-events: none; user-select: none; }
			.authOverlay { position: absolute; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center; padding: 22px; background: color-mix(in srgb, var(--bb-bg) 38%, transparent); }
			.root.authRequired .authOverlay { display: flex; }
			.authCard { width: min(280px, 100%); display: grid; justify-items: center; gap: 12px; padding: 22px 18px; border: 1px solid color-mix(in srgb, var(--bb-border) 82%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--bb-card) 94%, var(--bb-bg)); box-shadow: 0 18px 48px color-mix(in srgb, var(--bb-shadow) 80%, transparent); text-align: center; }
			.authLogo { width: 52px; height: 68px; display: block; color: color-mix(in srgb, var(--vscode-icon-foreground, var(--bb-text)) 62%, var(--bb-primary)); background: currentColor; -webkit-mask: url('${backboardLogo}') center / contain no-repeat; mask: url('${backboardLogo}') center / contain no-repeat; }
			.authTitle { color: var(--bb-text); font-size: 15px; font-weight: 650; line-height: 20px; }
			.authText { max-width: 230px; color: var(--bb-muted); font-size: 12px; line-height: 17px; }
			.authButton { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border-radius: 5px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); font-size: 12px; font-weight: 600; }
			.authButton:hover { background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--bb-primary) 84%, var(--bb-text))); }
			.authButton .codicon { font-size: 14px; }
		.panelHeader { min-height: 42px; box-sizing: border-box; display: flex; align-items: center; gap: 9px; padding: 6px 12px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-surface) 86%, var(--bb-bg)); }
		.brandMark { width: 24px; height: 24px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--bb-primary) 30%, var(--bb-border)); border-radius: 6px; color: var(--bb-primary); background: color-mix(in srgb, var(--bb-primary) 10%, transparent); }
		.brandMark .codicon { font-size: 14px; }
		.brandTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-size: 12px; font-weight: 650; line-height: 16px; letter-spacing: .02em; text-transform: uppercase; }
		.headerSpacer { flex: 1; min-width: 0; }
		.headerBadge { max-width: 112px; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border: 1px solid var(--bb-border); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-card) 72%, transparent); font-size: 10.5px; line-height: 14px; }
		.headerBadge.hidden { display: none; }
		.headerActions { min-width: 0; max-width: 45%; display: flex; align-items: center; justify-content: flex-end; gap: 4px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
		.headerIconButton { width: 24px; height: 24px; flex: 0 0 auto; display: inline-grid; place-items: center; padding: 0; border-radius: 5px; color: var(--bb-muted); background: transparent; }
		.headerIconButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.headerIconButton.active { color: var(--bb-text); background: color-mix(in srgb, var(--bb-primary) 12%, transparent); }
		.headerIconButton .codicon { font-size: 15px; }
		.historyHeaderButton { width: auto; min-width: 34px; grid-auto-flow: column; column-gap: 3px; padding: 0 5px; }
		.tabCount { min-width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0 3px; border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-border) 58%, transparent); font-size: 10px; line-height: 14px; }
		.recentTabsShell { position: relative; min-width: 0; min-height: 32px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; overflow: hidden; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.recentTabsShell::after { content: ''; position: absolute; top: 0; right: 54px; bottom: 0; width: 22px; pointer-events: none; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--bb-bg) 84%, transparent) 58%, var(--bb-bg)); }
		.recentTabs { min-width: 0; display: flex; align-items: center; gap: 1px; overflow-x: auto; overflow-y: hidden; padding: 4px 26px 4px 7px; scrollbar-width: none; }
		.recentTabs::-webkit-scrollbar { display: none; }
		.recentTab { width: max-content; min-width: 34px; max-width: min(176px, calc(50vw - 50px)); height: 23px; flex: 0 1 auto; display: inline-flex; align-items: center; gap: 4px; padding: 0 3px 0 7px; border: 1px solid transparent; border-radius: 4px; color: var(--bb-muted); background: transparent; font-size: 11.5px; line-height: 15px; text-align: left; cursor: pointer; }
		.recentTab:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.recentTab.active { color: var(--bb-text); border-color: color-mix(in srgb, var(--bb-border) 82%, transparent); background: color-mix(in srgb, var(--vscode-editor-background, var(--bb-card)) 88%, var(--bb-bg)); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--bb-primary) 34%, transparent); }
		.recentTab:focus-visible { outline: 1px solid color-mix(in srgb, var(--bb-primary) 70%, transparent); outline-offset: 2px; }
		.recentTab.running { color: var(--bb-muted); }
		.recentTabLabel { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.recentTabClose { width: 16px; height: 16px; flex: 0 0 auto; display: inline-grid; place-items: center; padding: 0; border-radius: 4px; color: var(--bb-muted); background: transparent; opacity: 0; }
		.recentTab:hover .recentTabClose, .recentTab:focus-within .recentTabClose, .recentTab.active .recentTabClose { opacity: 1; }
		.recentTabClose:hover { color: var(--bb-text); background: color-mix(in srgb, var(--bb-border) 62%, transparent); }
		.recentTabClose .codicon { font-size: 12px; }
		.recentTabsActions { position: relative; z-index: 1; display: flex; align-items: center; gap: 1px; padding: 4px 7px 4px 2px; background: var(--bb-bg); }
		.recentActionButton { height: 22px; min-width: 22px; display: inline-flex; align-items: center; justify-content: center; gap: 2px; padding: 0 4px; border-radius: 4px; color: var(--bb-muted); background: transparent; }
		.recentActionButton:hover, .recentActionButton.active { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.recentActionButton .codicon { font-size: 14px; }
			.checkpointStrip { display: none; min-width: 0; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-bg) 94%, var(--bb-surface)); }
			.checkpointStrip.visible { display: none; }
		.checkpointTitle { flex: 0 0 auto; color: var(--bb-muted); font-size: 10px; font-weight: 650; text-transform: uppercase; }
		.checkpointList { min-width: 0; display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
		.checkpointList::-webkit-scrollbar { display: none; }
		.checkpointButton { height: 20px; min-width: 0; max-width: 135px; display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 0 6px; border-radius: 5px; color: var(--bb-muted); background: transparent; font-size: 11px; }
		.checkpointButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.checkpointButton .codicon { font-size: 12px; }
		.checkpointLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.viewStack { min-width: 0; min-height: 0; display: flex; overflow: hidden; background: var(--bb-bg); }
		.viewPane { display: none; width: 100%; min-width: 0; min-height: 0; height: 100%; }
		.viewPane.active { display: flex; }
		.composer { position: relative; min-width: 0; min-height: 0; padding: 0 10px calc(10px + var(--bb-composer-safe-bottom) + env(safe-area-inset-bottom, 0px)); border-top: 1px solid color-mix(in srgb, var(--bb-border) 58%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.changeStack { display: none; width: 100%; max-height: min(24vh, 168px); flex-direction: column; gap: 4px; overflow-x: hidden; overflow-y: auto; padding: 5px 0 6px; scrollbar-width: thin; }
		.changeStack.visible { display: flex; }
		.stateControl { display: none; }
			.log { overflow-y: auto; overflow-x: hidden; min-width: 0; min-height: 0; padding: 14px 12px 18px; flex-direction: column; align-items: stretch; gap: 10px; background: var(--bb-bg); scrollbar-width: thin; overscroll-behavior: contain; }
			.log > * { flex: 0 0 auto; }
		.emptyState { margin: auto; display: grid; place-items: center; gap: 12px; transform: translateY(-8%); padding: 0 20px; }
		.emptyIcon { width: 48px; height: 64px; display: block; color: color-mix(in srgb, var(--vscode-icon-foreground, var(--bb-text)) 62%, var(--bb-primary)); background: currentColor; opacity: .72; -webkit-mask: url('${backboardLogo}') center / contain no-repeat; mask: url('${backboardLogo}') center / contain no-repeat; transition: opacity .2s ease; }
		.emptyState:hover .emptyIcon { opacity: .9; }
		.emptyTagline { color: var(--bb-muted); font-size: 13px; line-height: 20px; text-align: center; max-width: 220px; }
		.emptyHints { display: grid; gap: 4px; margin-top: 4px; }
		.emptyHint { color: var(--bb-subtle); font-size: 11px; line-height: 16px; text-align: center; }
			.messageCard { display: flex; flex-direction: column; gap: 7px; width: 100%; max-width: 100%; min-width: 0; padding: 0; border-radius: 6px; overflow-wrap: anywhere; word-break: normal; animation: bbFadeIn .16s ease; }
			.messageCard.user { position: relative; align-self: stretch; padding: 2px 2px 4px; color: var(--bb-text); border: 0; background: transparent; box-shadow: none; }
			.messageCard.user:hover { background: transparent; }
			.messageCard.assistant { align-self: stretch; width: 100%; max-width: 100%; padding: 2px 2px 4px 10px; border-left: 2px solid color-mix(in srgb, var(--bb-border) 82%, transparent); border-radius: 0; background: transparent; box-shadow: none; }
			@keyframes bbFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
			.messageHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
			.messageRole { color: var(--bb-muted); font-size: 11px; font-weight: 600; white-space: nowrap; }
			.messageActions { display: none; align-items: center; gap: 3px; }
			.messageCard.user:hover .messageActions, .messageCard.user:focus-within .messageActions { display: flex; }
			.messageAction { width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; border-radius: 4px; color: var(--bb-muted); background: transparent; }
			.messageAction:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
			.messageAction .codicon { font-size: 13px; }
			.messageText { min-width: 0; color: var(--bb-text); font-size: var(--vscode-font-size); line-height: 1.48; white-space: pre-wrap; overflow-wrap: anywhere; }
			.messageCard.user .messageText, .messageCard.user .messageRole { color: inherit; }
			.messageCard.assistant .messageHeader { display: none; }
			.messageMeta { align-self: flex-start; min-height: 17px; display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--bb-border) 70%, transparent); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 72%, transparent); font-size: 10.5px; line-height: 14px; font-variant-numeric: tabular-nums; }
		.queueBlock { width: 100%; box-sizing: border-box; display: grid; gap: 6px; padding: 8px; border: 1px solid var(--bb-border); border-radius: 8px; background: color-mix(in srgb, var(--bb-card) 84%, transparent); }
		.queueHeader { display: flex; align-items: center; gap: 7px; color: var(--bb-muted); font-size: 12px; font-weight: 600; }
		.queueCard { display: grid; gap: 6px; padding: 7px; border: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); border-radius: 7px; background: var(--bb-bg); }
			.queueTextarea { width: 100%; min-height: 42px; max-height: 110px; box-sizing: border-box; resize: vertical; padding: 6px; border: 1px solid var(--bb-border); border-radius: 6px; color: var(--bb-text); background: var(--vscode-input-background, transparent); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 12px; line-height: 17px; }
		.queueActions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
		.queueButton { min-height: 22px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 3px 7px; border-radius: 4px; color: var(--bb-muted); background: transparent; font-size: 11px; }
		.queueButton:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.statusRow { width: 100%; min-height: 26px; display: flex; align-items: flex-start; gap: 8px; color: var(--bb-success); font-size: 12px; line-height: 17px; padding: 5px 2px; transition: color .2s ease; }
		.statusRow.error { color: var(--vscode-errorForeground, var(--bb-danger)); }
		.statusRow.muted { color: var(--bb-muted); }
		.statusRow.muted .statusIcon { animation: bbPulse 1.6s ease-in-out infinite; }
		@keyframes bbPulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
		.statusIcon { width: 12px; height: 12px; flex: 0 0 auto; display: grid; place-items: center; }
		.statusIcon .codicon { font-size: 12px; }
		.toolGroup { width: 100%; overflow: hidden; border: 1px solid color-mix(in srgb, var(--bb-border) 48%, transparent); border-radius: 5px; color: var(--bb-text); background: transparent; }
		.toolGroup.failed { border-color: color-mix(in srgb, var(--bb-danger) 28%, var(--bb-border)); background: color-mix(in srgb, var(--bb-danger) 4%, transparent); }
		.toolGroupHead { width: 100%; min-height: 24px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 6px; color: var(--bb-text); background: transparent; text-align: left; }
		.toolGroupStatus { width: 14px; height: 14px; display: grid; place-items: center; color: var(--bb-muted); }
		.toolGroupStatus .codicon { font-size: 12px; }
		.toolGroup.running .toolGroupStatus .codicon { animation: bbSpin 1.2s linear infinite; }
		.toolGroup.failed .toolGroupStatus { color: var(--bb-danger); }
		.toolGroupMain { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
		.toolGroupTitle { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; line-height: 15px; }
		.toolGroupMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-muted); font-size: 10.5px; line-height: 14px; }
		.toolGroupToggle { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border-radius: 3px; color: var(--bb-muted); background: transparent; }
		.toolGroupToggle .codicon { font-size: 12px; }
		.toolGroupToggle:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.toolGroupBody { display: none; gap: 0; padding: 2px 5px 5px 20px; border-top: 1px solid color-mix(in srgb, var(--bb-border) 38%, transparent); }
		.toolGroup.open .toolGroupBody { display: grid; }
		.toolCard { width: 100%; align-self: stretch; overflow: hidden; border: 0; border-radius: 4px; color: var(--bb-text); background: transparent; font-size: 10.5px; line-height: 14px; }
		.toolCard:hover { background: color-mix(in srgb, var(--bb-border) 22%, transparent); }
		.toolCard.started, .toolCard.finished { background: transparent; }
		.toolCard.failed, .toolCard.denied { background: color-mix(in srgb, var(--bb-danger) 5%, transparent); }
		.toolHead { min-height: 21px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 5px; padding: 1px 3px; }
		.toolStatusIcon { width: 14px; height: 14px; display: grid; place-items: center; color: var(--bb-muted); }
		.toolCard.started .toolStatusIcon { color: var(--bb-muted); }
		.toolCard.started .toolStatusIcon .codicon { animation: bbSpin 1.2s linear infinite; }
		@keyframes bbSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
		.toolCard.failed .toolStatusIcon, .toolCard.denied .toolStatusIcon { color: var(--bb-danger); }
		.toolStatusIcon .codicon { font-size: 12px; }
		.toolMain { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
		.toolLabel { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 600; line-height: 14px; }
		.toolMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-muted); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 10.5px; line-height: 14px; }
		.toolDuration { min-width: 34px; flex: 0 0 auto; padding: 0 4px; border: 0; border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-border) 18%, transparent); font-size: 10px; line-height: 14px; text-align: center; font-variant-numeric: tabular-nums; }
		.toolToggle { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border-radius: 3px; color: var(--bb-muted); background: transparent; }
		.toolToggle .codicon { font-size: 12px; }
		.toolToggle:hover { color: var(--bb-text); background: var(--vscode-toolbar-hoverBackground); }
		.toolDetails { display: none; max-height: 160px; overflow: auto; border-top: 1px solid color-mix(in srgb, var(--bb-border) 36%, transparent); padding: 5px 7px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 78%, transparent); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 10.5px; line-height: 14px; white-space: pre-wrap; word-break: break-word; }
		.toolCard.open .toolDetails { display: block; }
		.usageRow { width: 100%; box-sizing: border-box; display: flex; align-items: flex-start; gap: 8px; padding: 3px 2px; color: var(--bb-muted); font-size: 12px; line-height: 16px; }
		.usageToggle { --usage-percent: 0; position: relative; width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; padding: 0; border-radius: 50%; color: var(--bb-text); background: conic-gradient(var(--bb-primary) calc(var(--usage-percent) * 1%), color-mix(in srgb, var(--bb-border) 60%, transparent) 0); }
		.usageToggle::before { content: ''; position: absolute; inset: 4px; border-radius: 50%; background: var(--bb-bg); }
		.usageToggle:hover { box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-primary) 48%, transparent); }
		.usageWheelValue { position: relative; z-index: 1; color: var(--bb-text); font-size: 9px; font-weight: 700; line-height: 1; }
		.usageMain { min-width: 0; flex: 1; display: grid; gap: 4px; }
		.usageSummary { min-height: 30px; display: flex; align-items: center; gap: 6px; min-width: 0; }
		.usageTitle { color: var(--bb-text); font-weight: 600; white-space: nowrap; }
		.usageMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.usageDetails { display: none; grid-template-columns: repeat(auto-fit, minmax(94px, 1fr)); gap: 6px; padding: 7px; border: 1px solid var(--bb-border); border-radius: 7px; background: var(--bb-card); }
		.usageRow.open .usageDetails { display: grid; }
		.usageMetric { min-width: 0; display: grid; gap: 2px; }
		.usageMetricLabel { color: var(--bb-muted); font-size: 10px; line-height: 13px; text-transform: uppercase; }
		.usageMetricValue { color: var(--bb-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; }
		.fileCard { width: 100%; overflow: hidden; border: 1px solid color-mix(in srgb, var(--bb-border) 72%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--bb-card) 54%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--bb-primary) 34%, transparent); }
		.fileHeader { min-height: 34px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 7px 9px 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 70%, transparent); }
		.fileName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11.5px; font-weight: 600; }
		.fileCount { flex: 0 0 auto; font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
		.fileCount.add { color: var(--bb-success); }
		.fileCount.remove { color: var(--bb-danger); }
		.diffLine { min-height: 18px; padding: 1px 10px; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
		.diffLine.add { color: var(--bb-success); background: var(--bb-success-bg); }
		.diffLine.remove { color: var(--bb-danger); background: var(--bb-danger-bg); }
		.reviewWrap { width: 100%; padding: 0; }
		.reviewCard { width: 100%; display: flex; flex-direction: column; gap: 1px; padding: 7px 8px; border: 1px solid color-mix(in srgb, var(--bb-border) 78%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--bb-card) 70%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--bb-primary) 50%, transparent); }
		.reviewHeader { min-height: 28px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; }
		.reviewFile { min-height: 25px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; overflow: hidden; padding: 2px 0; border-top: 1px solid color-mix(in srgb, var(--bb-border) 46%, transparent); }
		.typeDot { width: 16px; height: 16px; flex: 0 0 auto; display: grid; place-items: center; color: var(--bb-muted); }
		.typeDot .codicon { font-size: 14px; }
		.reviewTitle { min-width: 0; color: var(--bb-text); font-size: 12.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.reviewFileName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 11.5px; font-weight: 600; }
		.reviewButton { min-width: 52px; min-height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 3px 9px; border-radius: 4px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); font-size: 11.5px; font-weight: 600; }
		.reviewButton.secondary { color: var(--bb-muted); background: transparent; }
		.reviewButton:disabled { cursor: default; color: var(--bb-muted); background: transparent; }
		.changeStack .reviewCard, .changeStack .fileCard { border-color: color-mix(in srgb, var(--bb-border) 50%, transparent); border-radius: 5px; background: transparent; box-shadow: none; }
		.changeStack .reviewCard { padding: 4px 6px; }
		.changeStack .reviewHeader { min-height: 22px; grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; }
		.changeStack .reviewTitle { font-size: 11px; font-weight: 600; color: var(--bb-muted); }
		.changeStack .fileCard { flex: 0 0 auto; }
		.changeStack .fileHeader { min-height: 24px; gap: 6px; padding: 4px 6px; border-bottom-color: color-mix(in srgb, var(--bb-border) 40%, transparent); }
		.changeStack .fileName, .changeStack .reviewFileName { font-size: 11px; }
		.changeStack .diffLine { min-height: 14px; padding: 0 8px; color: var(--bb-muted); background: transparent; font-size: 10.5px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.changeStack .diffLine.add { color: color-mix(in srgb, var(--bb-success) 76%, var(--bb-text)); background: transparent; }
		.changeStack .diffLine.remove { color: color-mix(in srgb, var(--bb-danger) 76%, var(--bb-text)); background: transparent; }
		.changeStack .typeDot { width: 14px; height: 14px; }
		.changeStack .typeDot .codicon { font-size: 12px; }
		.changeStack .reviewButton { min-width: 0; min-height: 20px; padding: 0 6px; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; font-size: 11px; font-weight: 600; }
		.changeStack .reviewButton:hover { background: var(--vscode-toolbar-hoverBackground); }
		.questionCard { width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 7px; padding: 10px; border: 1px solid var(--bb-border); border-radius: 10px; background: var(--bb-bg); }
		.questionHeader { display: flex; align-items: flex-start; gap: 7px; }
		.questionTitle { flex: 1; min-width: 0; color: var(--bb-text); font-size: 13px; font-weight: 600; line-height: 18px; }
		.questionNav { display: flex; align-items: center; gap: 5px; color: var(--bb-muted); font-size: 11px; white-space: nowrap; }
		.questionOption { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 3px; border: 0; border-radius: 7px; color: var(--bb-text); background: transparent; text-align: left; }
		.questionOption:hover { background: color-mix(in srgb, var(--bb-border) 45%, transparent); }
		.questionNumber { width: 24px; height: 24px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 7px; color: #fff; background: color-mix(in srgb, var(--bb-text) 92%, #111722); font-size: 12px; font-weight: 600; }
		.questionDivider { height: 1px; background: var(--bb-border); }
		.questionInputRow { min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 3px; }
		.questionInput { flex: 1; min-width: 0; height: 24px; color: var(--bb-text); background: transparent; border: 0; outline: 0; font-size: 13px; }
		.questionSkip { min-width: 48px; min-height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--bb-border) 76%, var(--bb-muted)); border-radius: 4px; color: var(--bb-text); background: var(--bb-card); font-size: 11px; }
		.mediaBlock { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--bb-border); border-radius: 7px; color: var(--bb-muted); background: var(--bb-card); font-size: 12px; }
		.mediaBlock img { display: block; max-width: 100%; margin-top: 6px; border: 1px solid var(--bb-border); border-radius: 6px; }
		.mediaBlock audio { width: 100%; margin-top: 6px; }
		.historyPane { overflow: auto; flex-direction: column; gap: 7px; padding: 8px 10px 10px; background: var(--bb-bg); scrollbar-width: thin; }
		.historyList { display: flex; flex-direction: column; gap: 4px; }
		.historyEmpty { margin: auto; max-width: 240px; color: var(--bb-muted); text-align: center; font-size: 12px; line-height: 18px; }
		.historyItem { width: 100%; min-height: 46px; box-sizing: border-box; display: grid; gap: 3px; padding: 7px 8px; border: 1px solid transparent; border-radius: 7px; color: var(--bb-text); background: transparent; text-align: left; transition: border-color .15s ease, background .15s ease; }
		.historyItem:hover { border-color: var(--bb-border); background: color-mix(in srgb, var(--bb-card) 74%, transparent); }
		.historyItem.active { border-color: color-mix(in srgb, var(--bb-primary) 48%, var(--bb-border)); background: color-mix(in srgb, var(--bb-primary) 10%, transparent); }
		.historyItemTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; line-height: 16px; }
		.historyItemMeta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--bb-muted); font-size: 11px; line-height: 15px; }
		.historyItemStatus { flex: 0 0 auto; color: var(--bb-success); }
		.historyItemStatus.running { color: var(--bb-muted); }
		.historyItemStatus.failed, .historyItemStatus.cancelled { color: var(--bb-danger); }
		.statusBar { width: 100%; min-width: 0; min-height: 24px; display: flex; align-items: center; gap: 7px; padding: 3px 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--bb-border) 68%, transparent); background: color-mix(in srgb, var(--bb-bg) 96%, var(--bb-surface)); }
		.runClock { flex: 0 0 auto; min-width: 42px; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--bb-border) 62%, transparent); border-radius: 999px; color: var(--bb-muted); background: color-mix(in srgb, var(--bb-bg) 72%, transparent); font-size: 10.5px; line-height: 14px; font-variant-numeric: tabular-nums; }
		.status { flex: 1 1 auto; min-width: 0; color: var(--bb-muted); font-size: 11px; min-height: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		form { display: block; width: 100%; margin: 0 auto; }
		.composerCard { min-height: 98px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--bb-border); border-radius: 10px; background: color-mix(in srgb, var(--vscode-input-background, var(--bb-card)) 92%, var(--bb-bg)); overflow: hidden; box-shadow: 0 1px 3px color-mix(in srgb, var(--bb-shadow) 40%, transparent); transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
		.composerCard:hover { border-color: color-mix(in srgb, var(--bb-border) 60%, var(--bb-primary) 20%); box-shadow: 0 2px 8px color-mix(in srgb, var(--bb-shadow) 60%, transparent); }
		.composerCard:focus-within { border-color: color-mix(in srgb, var(--bb-primary) 62%, var(--bb-border)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bb-primary) 14%, transparent), 0 2px 8px color-mix(in srgb, var(--bb-shadow) 50%, transparent); }
		textarea { width: 100%; min-height: 44px; max-height: 132px; box-sizing: border-box; resize: vertical; padding: 0; border: 0; outline: 0; line-height: 20px; background: transparent; color: var(--bb-text); font-family: var(--vscode-editor-font-family, "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-size: 13px; }
		textarea::placeholder { color: var(--bb-muted); }
		.composerRule { display: none; }
		.composerBar { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 24px; padding: 0; overflow: hidden; }
		.barLeft, .barRight { display: flex; align-items: center; min-width: 0; }
		.barLeft { flex: 1 1 auto; gap: 8px; overflow: hidden; }
		.barRight { flex: 0 0 auto; justify-content: flex-end; gap: 11px; overflow: hidden; }
		button { border: 0; cursor: pointer; font-family: var(--vscode-font-family, "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
		.iconButton { width: 20px; height: 22px; min-width: 20px; display: inline-grid; place-items: center; padding: 0; border-radius: 0; color: var(--bb-muted); background: transparent; line-height: 1; flex: 0 0 auto; }
		.iconButton .codicon { font-size: 16px; }
		.iconButton:hover { color: var(--bb-text); background: transparent; }
		.iconButton.active { color: var(--bb-primary); background: transparent; }
		.iconButton.recording { color: var(--bb-danger); background: transparent; }
		.iconButton:disabled { cursor: default; color: var(--vscode-disabledForeground); background: transparent; outline: 0; }
		.stopButton { display: none; color: var(--bb-danger); }
		.stopButton.visible { display: inline-grid; }
		.stopButton:hover { color: var(--vscode-errorForeground, var(--bb-danger)); background: color-mix(in srgb, var(--bb-danger) 12%, transparent); border-radius: 4px; }
		.featureButton.active { color: var(--bb-primary); }
		.usageFeatureButton.hasUsage { color: var(--bb-text); }
		.composerCard.recording { border-color: var(--bb-danger); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-danger) 32%, transparent); }
		.sendButton.ready { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, var(--bb-primary)); box-shadow: 0 1px 3px color-mix(in srgb, var(--bb-primary) 28%, transparent); transition: background .15s ease, box-shadow .15s ease; }
		.sendButton.ready:hover { background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--bb-primary) 86%, var(--bb-text))); box-shadow: 0 2px 6px color-mix(in srgb, var(--bb-primary) 36%, transparent); }
		.modelButton, .modeButton { min-width: 0; height: 22px; display: flex; align-items: center; gap: 5px; padding: 0; border-radius: 0; color: var(--bb-muted); background: transparent; font-size: 12px; overflow: hidden; flex: 0 1 auto; }
		.modeButton { max-width: 128px; }
		.modelButton { max-width: min(320px, 46vw); }
		.modelButton:hover, .modeButton:hover { color: var(--bb-text); background: transparent; }
		.modelButton.active, .modeButton.active { color: var(--bb-primary); background: transparent; }
		.modeGlyph { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 2px; background: currentColor; opacity: .85; }
		.modelIcon { width: 13px; height: 13px; flex: 0 0 auto; display: inline-grid; place-items: center; overflow: hidden; border-radius: 3px; }
		.modelIcon img, .choiceIcon img, .providerSwitchIcon img { width: 100%; height: 100%; display: block; object-fit: contain; }
		.modelIcon .codicon { font-size: 13px; }
		.modeLabel, .modelPrefix, .modelValue { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.modelPrefix { color: var(--bb-muted); }
		.modelValue { color: color-mix(in srgb, var(--bb-text) 80%, var(--bb-muted)); }
		.modelLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		@media (max-width: 520px) {
			.composerBar { gap: 8px; }
			.barLeft { gap: 6px; }
			.barRight { gap: 8px; }
			.modeButton { max-width: 92px; }
			.modelButton { max-width: min(210px, 42vw); }
			.modelPrefix { display: none; }
		}
		.drawerButton { min-height: 22px; display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; border: 0; border-radius: 0; padding: 0; font-size: 11.5px; }
		.drawerButton:hover { color: var(--vscode-textLink-activeForeground, var(--bb-text)); background: transparent; }
		.popover { position: fixed; z-index: 20; width: min(390px, calc(100vw - 8px)); max-height: min(390px, calc(100vh - 8px)); display: none; overflow: hidden; border: 1px solid var(--vscode-focusBorder, var(--bb-border)); border-radius: 8px; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--bb-bg))); color: var(--bb-text); box-shadow: 0 16px 36px color-mix(in srgb, var(--vscode-widget-shadow, #000) 34%, transparent); }
		.popover.open { display: flex; flex-direction: column; }
		.popoverHeader { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--bb-border); background: color-mix(in srgb, var(--bb-card) 74%, transparent); }
		.popoverHeader { display: none; }
		.popoverTitle { font-size: 13px; font-weight: 650; }
		.popoverBody { overflow: auto; overflow-x: hidden; padding: 0; display: grid; gap: 0; }
		.popoverSection { display: grid; gap: 4px; }
		.popoverSection { padding: 1px 3px 3px; border-top: 0; }
		.popoverSectionTitle { color: var(--bb-muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px 3px; }
		.popoverSectionTitle { padding: 3px 6px 2px; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10.5px; font-weight: 600; line-height: 13px; text-transform: none; letter-spacing: 0; }
		.choiceRow { width: 100%; min-height: 24px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 5px 0 8px; border: 1px solid transparent; border-radius: 3px; color: var(--bb-text); background: transparent; text-align: left; }
		.choiceRow:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); border-color: transparent; }
		.choiceRow.selected { background: var(--vscode-list-focusBackground, color-mix(in srgb, var(--bb-primary) 14%, transparent)); border-color: transparent; color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.choiceRow.disabled { cursor: default; color: var(--vscode-disabledForeground); }
		.choiceRow.disabled:hover { background: transparent; border-color: transparent; }
		.choiceIcon { width: 13px; height: 13px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 0; color: var(--vscode-descriptionForeground, var(--bb-muted)); background: transparent; }
		.choiceIcon .codicon { font-size: 12px; }
		.choiceMain { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 0; }
		.choiceLabel { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 16px; }
		.choiceMeta { min-width: 0; max-width: 54%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10px; line-height: 14px; text-align: right; }
		.choiceRow.selected .choiceMeta { color: var(--vscode-list-focusForeground, var(--bb-text)); opacity: .78; }
		.choiceRow > .codicon-check { width: 12px; flex: 0 0 auto; color: var(--vscode-focusBorder, var(--bb-primary)); font-size: 12px; }
		.popoverActions { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px 8px 5px; }
		.popoverSearch { width: 100%; height: 32px; box-sizing: border-box; padding: 5px 9px; border: 1px solid var(--bb-border); border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); outline: 0; font-size: 12px; }
		.popoverSearch:focus { border-color: var(--bb-primary); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bb-primary) 30%, transparent); }
		.popoverSearch { height: 28px; padding: 0 8px; border: 0; border-radius: 0; color: var(--vscode-input-foreground, var(--bb-text)); background: transparent; font-size: 12px; }
		.popoverSearch:focus { border-color: transparent; box-shadow: inset 2px 0 0 var(--vscode-focusBorder, var(--bb-primary)); }
		.modelFilterWrap { position: sticky; top: 0; z-index: 5; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--bb-bg))); border-bottom: 1px solid var(--bb-border); }
		.modelFilterBar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3px; min-height: 28px; padding: 0; }
		.modelFilterButton { min-width: 40px; height: 22px; display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; padding: 0 6px; border: 1px solid transparent; border-radius: 4px; color: var(--bb-text); background: transparent; font-size: 11.5px; font-weight: 600; }
		.modelFilterButton:hover, .modelFilterButton.active { color: var(--bb-text); border-color: var(--vscode-focusBorder, var(--bb-border)); background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--bb-primary) 10%, transparent)); }
		.providerFilterPane { display: grid; gap: 0; padding: 5px 0 3px; }
		.filterHeader { display: grid; gap: 2px; padding: 4px 10px 5px; }
		.filterTitle { color: var(--bb-text); font-size: 12px; font-weight: 600; line-height: 15px; }
		.filterMeta { color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 11px; line-height: 14px; }
		.providerSwitchList { display: grid; gap: 0; }
		.providerSwitch { width: 100%; min-height: 24px; display: flex; align-items: center; gap: 7px; padding: 0 8px; border: 0; border-radius: 0; color: var(--bb-text); background: transparent; text-align: left; font-size: 12px; }
		.providerSwitch:hover { color: var(--bb-text); background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); }
		.providerSwitch.active { color: var(--bb-text); background: transparent; }
		.providerSwitch.focused { background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 12%, transparent))); color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.providerSwitchIcon { width: 13px; height: 13px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 3px; }
		.providerSwitchName { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.providerSwitchToggle { width: 12px; height: 12px; flex: 0 0 auto; display: grid; place-items: center; order: -1; border: 1px solid var(--bb-border); border-radius: 2px; color: transparent; background: var(--vscode-input-background, transparent); }
		.providerSwitch.active .providerSwitchToggle { color: var(--vscode-focusBorder, var(--bb-primary)); border-color: var(--vscode-focusBorder, var(--bb-primary)); }
		.providerSwitchToggle .codicon { font-size: 10px; }
		.providerFilterDone { min-height: 24px; justify-self: start; margin: 4px 8px 0; padding: 0; color: var(--vscode-textLink-foreground, var(--bb-primary)); background: transparent; font-size: 11.5px; }
		.providerFilterDone:hover { color: var(--vscode-textLink-activeForeground, var(--bb-text)); }
		.modelChoice { min-height: 24px; padding: 0 5px 0 8px; border-radius: 3px; gap: 6px; }
		.modelChoice:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--bb-primary) 8%, transparent)); border-color: transparent; }
		.modelChoice.selected { background: var(--vscode-list-focusBackground, color-mix(in srgb, var(--bb-primary) 14%, transparent)); border-color: transparent; color: var(--vscode-list-focusForeground, var(--bb-text)); }
		.modelChoice .choiceIcon { width: 13px; height: 13px; color: var(--vscode-descriptionForeground, var(--bb-muted)); background: transparent; border-radius: 0; }
		.modelChoice .choiceIcon .codicon { font-size: 12px; }
		.modelChoice .choiceMain { display: block; min-width: 0; flex: 1 1 0; }
		.modelChoice .choiceLabel { font-size: 12px; font-weight: 500; line-height: 16px; }
		.modelChoice .choiceMeta { display: none; }
		.modelChoiceMeta { min-width: 0; width: 158px; overflow: hidden; text-overflow: clip; white-space: nowrap; flex: 0 0 158px; color: var(--vscode-descriptionForeground, var(--bb-muted)); font-size: 10px; line-height: 14px; text-align: right; }
		.modelChoice .codicon-check { width: 12px; flex: 0 0 auto; color: var(--vscode-focusBorder, var(--bb-primary)); font-size: 12px; }
		.modelChoiceCheckSpacer { width: 12px; flex: 0 0 auto; }
		.modelProviderPill { display: none; }
	</style>
	</head>
		<body>
			<div class="root">
				${header}
				${recentTabs}
				<div class="statusBar">
					<div id="runClock" class="runClock" hidden>00:00</div>
					<div id="status" class="status">Ready.</div>
				</div>
				${checkpointStrip}
				<div class="viewStack">
				<div id="log" class="log viewPane active" role="tabpanel" ${logLabel}>
					<div id="emptyState" class="emptyState">
						<div class="emptyIcon" aria-hidden="true"></div>
						<div class="emptyTagline">Ask anything about your code</div>
						<div class="emptyHints">
							<div class="emptyHint">Try: "Explain this function"</div>
							<div class="emptyHint">Try: "Find bugs in my code"</div>
						</div>
					</div>
				</div>
				${historyPane}
				</div>
			<div class="composer">
			<select id="provider" class="stateControl" aria-hidden="true"></select>
			<select id="model" class="stateControl" aria-hidden="true"></select>
			<select id="mode" class="stateControl" aria-hidden="true">
				<option value="agent">Agent</option>
				<option value="ask">Ask</option>
				<option value="manual">Manual</option>
				<option value="free">Full Access</option>
			</select>
			<select id="intensity" class="stateControl" aria-hidden="true">
				<option value="fast">Fast</option>
				<option value="balanced">Balanced</option>
				<option value="deep">Deep</option>
			</select>
			<select id="webSearch" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="Auto">Auto</option>
			</select>
			<select id="imageGeneration" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="auto">Auto</option>
			</select>
			<select id="voiceMode" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="tts">TTS</option>
				<option value="stt">STT</option>
				<option value="conversation">Conversation</option>
			</select>
			<input id="mcpFigma" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpNotion" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpGoogle" class="stateControl" type="checkbox" aria-hidden="true">
			<span id="toolCount" class="stateControl" aria-hidden="true">Tools loading</span>
				<div id="popover" class="popover" role="dialog" aria-modal="false" aria-hidden="true">
				<div class="popoverHeader">
					<div id="popoverTitle" class="popoverTitle"></div>
					<button id="popoverClose" class="iconButton" type="button" title="Close" aria-label="Close"><span class="codicon codicon-close"></span></button>
				</div>
				<div id="popoverBody" class="popoverBody"></div>
			</div>
			<div id="changeStack" class="changeStack" aria-live="polite" aria-label="Pending file changes"></div>
			<form id="form">
					<div class="composerCard">
							<textarea id="prompt" placeholder="Message Backboard..."></textarea>
						<div class="composerRule"></div>
						<div class="composerBar">
							<div class="barLeft">
								<button id="modeBtn" class="modeButton" type="button" title="Mode and reasoning" aria-label="Mode and reasoning"><span class="modeGlyph"></span><span id="modeLabel" class="modeLabel">Agent</span><span class="codicon codicon-chevron-down"></span></button>
								<button id="modelBtn" class="modelButton" type="button" title="Backboard model" aria-label="Backboard model"><span id="modelIcon" class="modelIcon"><span class="codicon codicon-server"></span></span><span class="modelPrefix">Model</span><span id="modelLabel" class="modelValue">Auto</span><span class="codicon codicon-chevron-down"></span></button>
							</div>
							<div class="barRight">
								<button id="webBtn" class="iconButton featureButton" type="button" title="Web search" aria-label="Web search"><span class="codicon codicon-globe"></span></button>
								<button id="imageBtn" class="iconButton featureButton" type="button" title="Image output" aria-label="Image output"><span class="codicon codicon-device-camera-video"></span></button>
								<button id="usageBtn" class="iconButton featureButton usageFeatureButton" type="button" title="Usage details" aria-label="Usage details"><span class="codicon codicon-pulse"></span></button>
								<button id="voiceBtn" class="iconButton" type="button" title="Start speech-to-text" aria-label="Start speech-to-text"><span class="codicon codicon-mic"></span></button>
								<button id="stopBtn" class="iconButton stopButton" type="button" title="Stop generation" aria-label="Stop generation"><span class="codicon codicon-debug-stop"></span></button>
								<button id="sendBtn" class="iconButton sendButton" type="submit" title="Send" aria-label="Send" disabled><span class="codicon codicon-send"></span></button>
							</div>
						</div>
					</div>
				</form>
			</div>
				<div id="authOverlay" class="authOverlay" role="dialog" aria-live="polite" aria-label="Backboard sign in required">
					<div class="authCard">
						<div class="authLogo" aria-hidden="true"></div>
						<div class="authTitle">Sign in required</div>
						<div class="authText">Sign in with Backboard SSO to use the auxiliary bar.</div>
						<button id="authSignInBtn" class="authButton" type="button"><span class="codicon codicon-account"></span><span>Sign in with SSO</span></button>
					</div>
				</div>
		</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const root = document.querySelector('.root');
		const log = document.getElementById('log');
		const status = document.getElementById('status');
		const runClock = document.getElementById('runClock');
		const changeStack = document.getElementById('changeStack');
		let emptyState = document.getElementById('emptyState');
		const historyPane = document.getElementById('historyPane');
		const historyList = document.getElementById('historyList');
		const historyEmpty = document.getElementById('historyEmpty');
		const historyCount = document.getElementById('historyCount');
		const recentTabs = document.getElementById('recentTabs');
		const inlineHistoryCount = document.getElementById('inlineHistoryCount');
		const inlineNewChatButton = document.getElementById('inlineNewChatBtn');
		const inlineHistoryButton = document.getElementById('inlineHistoryBtn');
		const checkpointStrip = document.getElementById('checkpointStrip');
		const checkpointList = document.getElementById('checkpointList');
			const prompt = document.getElementById('prompt');
			const authSignInButton = document.getElementById('authSignInBtn');
			const toolCount = document.getElementById('toolCount');
		const popover = document.getElementById('popover');
		const popoverTitle = document.getElementById('popoverTitle');
		const popoverBody = document.getElementById('popoverBody');
		const modelIcon = document.getElementById('modelIcon');
		const modelLabel = document.getElementById('modelLabel');
		const modeLabelNode = document.getElementById('modeLabel');
		const headerBadge = document.getElementById('headerBadge');
		const newChatButton = document.getElementById('newChatBtn');
		const buttons = {
			mode: document.getElementById('modeBtn'),
			model: document.getElementById('modelBtn'),
			web: document.getElementById('webBtn'),
			image: document.getElementById('imageBtn'),
			usage: document.getElementById('usageBtn'),
			voice: document.getElementById('voiceBtn'),
			stop: document.getElementById('stopBtn'),
			send: document.getElementById('sendBtn')
		};
		const tabButtons = {
			chat: document.getElementById('chatTab'),
			history: document.getElementById('historyTab')
		};
		const controls = {
			provider: document.getElementById('provider'),
			model: document.getElementById('model'),
			mode: document.getElementById('mode'),
			intensity: document.getElementById('intensity'),
			webSearch: document.getElementById('webSearch'),
			imageGeneration: document.getElementById('imageGeneration'),
			voiceMode: document.getElementById('voiceMode'),
			mcpFigma: document.getElementById('mcpFigma'),
			mcpNotion: document.getElementById('mcpNotion'),
			mcpGoogle: document.getElementById('mcpGoogle')
		};
		const hostInitialState = ${initialStateJson};
		const hostHasPanelState = !!hostInitialState && typeof hostInitialState === 'object' && (!!hostInitialState.activeHistoryId || !!hostInitialState.promptQueue?.length || !!hostInitialState.historyEntries?.length);
		const persistedState = hostHasPanelState ? hostInitialState : {};
		let models = [];
		let tools = [];
			let settings = {};
			let authenticated = false;
		let activeView = persistedState.activeView === 'history' ? 'history' : 'chat';
		let historyEntries = Array.isArray(persistedState.historyEntries) ? persistedState.historyEntries : [];
		let activeHistoryId = typeof persistedState.activeHistoryId === 'string' ? persistedState.activeHistoryId : undefined;
		let promptQueue = Array.isArray(persistedState.promptQueue) ? persistedState.promptQueue : [];
		let panelStateSavedAt = typeof persistedState.savedAt === 'number' ? persistedState.savedAt : 0;
		let runInProgress = false;
		let stopRequested = false;
		let activePopover = undefined;
		let activeAnchor = undefined;
		let modelFilter = '';
		let disabledModelProviders = new Set();
		let modelProviderFiltersOpen = false;
		let currentAssistantCard = undefined;
		let activeToolRows = [];
		let activeToolGroup = undefined;
		let fileChanges = [];
		let latestUsage = undefined;
		let accountUsage = undefined;
		let runStartedAt = undefined;
		let runTimer = undefined;
		let currentPromptClock = undefined;
		let currentWorkspace = typeof persistedState.currentWorkspace === 'string' ? persistedState.currentWorkspace : '';
		let restoringHistory = false;
		let voiceRecorder = undefined;
		let voiceStream = undefined;
		let voiceChunks = [];
		let voiceRecording = false;
		const iconBase = ${JSON.stringify(iconBase.toString())};
		const providerIconFiles = {
			'anthropic': 'ai_anthropic.svg',
			'aws-bedrock': 'ai_bedrock.svg',
			'bedrock': 'ai_bedrock.svg',
			'deepseek': 'ai_deep_seek.svg',
			'gemini': 'ai_gemini.svg',
			'google': 'ai_google.svg',
			'google-ai': 'ai_google.svg',
			'lm-studio': 'ai_lm_studio.svg',
			'mistral': 'ai_mistral.svg',
			'ollama': 'ai_ollama.svg',
			'openai': 'ai_open_ai.svg',
			'openai-compatible': 'ai_open_ai_compat.svg',
			'openrouter': 'ai_open_router.svg',
			'vercel': 'ai_vercel.svg',
			'xai': 'ai_x_ai.svg'
		};
		const providerDisplayNames = {
			'anthropic': 'Anthropic',
			'aws-bedrock': 'AWS Bedrock',
			'bedrock': 'AWS Bedrock',
			'deepseek': 'DeepSeek',
			'gemini': 'Google',
			'google': 'Google',
			'google-ai': 'Google',
			'lm-studio': 'LM Studio',
			'mistral': 'Mistral',
			'ollama': 'Ollama',
			'openai': 'OpenAI',
			'openai-compatible': 'OpenAI Compatible',
			'openrouter': 'OpenRouter',
			'vercel': 'Vercel',
			'xai': 'xAI'
		};
		const supplementalModels = [
			{ provider: 'openrouter', name: 'openai/gpt-5-chat', displayName: 'GPT-5 Chat', supplemental: true }
		];
		function options() {
			return {
				provider: controls.provider.value,
				model: controls.model.value,
				mode: controls.mode.value,
				intensity: controls.intensity.value,
				webSearch: controls.webSearch.value,
				imageGeneration: controls.imageGeneration.value,
				voiceMode: controls.voiceMode.value,
				mcpFigma: controls.mcpFigma.checked,
				mcpNotion: controls.mcpNotion.checked,
				mcpGoogle: controls.mcpGoogle.checked
			};
		}
		function saveOptions() {
			vscode.postMessage({ type: 'saveSettings', options: options() });
		}
		function toolName(tool) {
			return tool && tool.function && tool.function.name || tool && (tool.name || tool.tool_name || tool.toolName || tool.function_name || tool.functionName) || 'tool';
		}
		function toolKey(tool) {
			return tool && (tool.id || tool.call_id || tool.callId || tool.tool_call_id || tool.toolCallId) || toolName(tool);
		}
		function toolArgs(tool) {
			const raw = tool && tool.function && tool.function.arguments || tool && (tool.arguments || tool.args || tool.input);
			if (!raw) {
				return {};
			}
			if (typeof raw === 'string') {
				try {
					return JSON.parse(raw);
				} catch {
					return { input: raw };
				}
			}
			return typeof raw === 'object' ? raw : {};
		}
		function renderToolCount() {
			toolCount.textContent = tools.length ? tools.length + ' tools enabled' : 'Tools loading';
		}
		function workspaceLabel() {
			if (!currentWorkspace) {
				return '';
			}
			const parts = currentWorkspace.split(/[\\/]+/).filter(Boolean);
			return parts[parts.length - 1] || currentWorkspace;
		}
		function formatElapsed(ms) {
			const totalSeconds = Math.max(0, Math.floor(ms / 1000));
			const hours = Math.floor(totalSeconds / 3600);
			const minutes = Math.floor((totalSeconds % 3600) / 60);
			const seconds = totalSeconds % 60;
			const two = value => String(value).padStart(2, '0');
			return hours ? hours + ':' + two(minutes) + ':' + two(seconds) : two(minutes) + ':' + two(seconds);
		}
		function updateRunClock() {
			if (!runInProgress || runStartedAt === undefined) {
				if (runClock) {
					runClock.hidden = true;
					runClock.textContent = '00:00';
				}
				return;
			}
			const elapsed = formatElapsed(Date.now() - runStartedAt);
			if (runClock) {
				runClock.hidden = false;
				runClock.textContent = elapsed;
				runClock.title = 'Running for ' + elapsed;
			}
			if (currentPromptClock) {
				currentPromptClock.textContent = elapsed;
				currentPromptClock.title = 'Prompt running for ' + elapsed;
			}
			for (const item of activeToolRows) {
				if (item.duration && item.startedAt !== undefined) {
					item.duration.textContent = formatElapsed(Date.now() - item.startedAt);
				}
			}
		}
		function startRunTimer(startedAt) {
			runStartedAt = typeof startedAt === 'number' ? startedAt : Date.now();
			window.clearInterval(runTimer);
			updateRunClock();
			runTimer = window.setInterval(updateRunClock, 1000);
		}
		function stopRunTimer() {
			if (currentPromptClock && runStartedAt !== undefined) {
				const elapsed = formatElapsed(Date.now() - runStartedAt);
				currentPromptClock.textContent = elapsed;
				currentPromptClock.title = 'Prompt ran for ' + elapsed;
			}
			window.clearInterval(runTimer);
			runTimer = undefined;
			runStartedAt = undefined;
			currentPromptClock = undefined;
			updateRunClock();
		}
		function updateStatus(text) {
			const value = text || 'Ready.';
			status.textContent = value === 'Ready.' && currentWorkspace ? 'Ready in ' + workspaceLabel() + '.' : value;
			status.title = currentWorkspace || value;
		}
			function refreshWorkspaceStatus() {
				const value = status.textContent || 'Ready.';
				updateStatus(value.startsWith('Ready') ? 'Ready.' : value);
			}
			function setAuthenticated(value) {
				authenticated = !!value;
				root.classList.toggle('authRequired', !authenticated);
				prompt.disabled = !authenticated;
				if (!authenticated) {
					closePopover();
					updateStatus('Sign in required.');
				} else if ((status.textContent || '').includes('Sign in required')) {
					updateStatus('Ready.');
				}
				syncComposerButtons();
			}
		function ensureEmptyState() {
			emptyState = document.getElementById('emptyState');
			if (emptyState) {
				return emptyState;
			}
			emptyState = document.createElement('div');
			emptyState.id = 'emptyState';
			emptyState.className = 'emptyState';
			const emptyIcon = document.createElement('div');
			emptyIcon.className = 'emptyIcon';
			emptyIcon.setAttribute('aria-hidden', 'true');
			emptyState.append(emptyIcon);
			const emptyTagline = document.createElement('div');
			emptyTagline.className = 'emptyTagline';
			emptyTagline.textContent = 'Ask anything about your code';
			emptyState.append(emptyTagline);
			const emptyHints = document.createElement('div');
			emptyHints.className = 'emptyHints';
			const hint1 = document.createElement('div');
			hint1.className = 'emptyHint';
			hint1.textContent = 'Try: "Explain this function"';
			const hint2 = document.createElement('div');
			hint2.className = 'emptyHint';
			hint2.textContent = 'Try: "Find bugs in my code"';
			emptyHints.append(hint1, hint2);
			emptyState.append(emptyHints);
			return emptyState;
		}
		function syncEmptyState() {
			const node = ensureEmptyState();
			if (!node.parentElement) {
				log.appendChild(node);
			}
			node.style.display = log.children.length <= 1 ? 'grid' : 'none';
		}
		function removeLegacyChangeArtifacts() {
			for (const node of Array.from(log.querySelectorAll('.fileCard, .reviewWrap, #reviewBlock'))) {
				node.remove();
			}
		}
		function spreadLegacyToolGroups() {
			for (const group of Array.from(log.querySelectorAll('.toolGroup'))) {
				updateToolGroupSummary(group);
			}
		}
		function hasConversationContent() {
			const node = ensureEmptyState();
			return [...log.children].some(child => child !== node);
		}
		function syncRootHeight() {
			if (root instanceof HTMLElement) {
				const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
				root.style.height = Math.max(0, Math.floor(viewportHeight)) + 'px';
			}
		}
		function historyTitle(promptText) {
			const words = String(promptText || '').trim().split(/\\s+/).filter(Boolean);
			return words.slice(0, 8).join(' ') || 'Untitled chat';
		}
		function historyTime(value) {
			return new Date(value || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		}
		function persistPanelState() {
			panelStateSavedAt = Date.now();
			const state = {
				activeView,
				activeHistoryId,
				promptQueue,
				currentWorkspace,
					historyEntries: historyEntries.slice(0, 40),
					savedAt: panelStateSavedAt
				};
				vscode.postMessage({ type: 'panelState', state });
			}
		function panelSnapshotTimestamp(state) {
			if (!state || typeof state !== 'object') {
				return 0;
			}
			if (typeof state.savedAt === 'number') {
				return state.savedAt;
			}
			const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
			return entries.reduce((max, entry) => Math.max(max, typeof entry?.updatedAt === 'number' ? entry.updatedAt : 0, typeof entry?.startedAt === 'number' ? entry.startedAt : 0), 0);
		}
		function hasPanelSnapshotContent(state) {
			return !!state && typeof state === 'object' && (!!state.activeHistoryId || !!state.promptQueue?.length || !!state.historyEntries?.length);
		}
			function activeHistoryEntry() {
				return historyEntries.find(item => item.id === activeHistoryId);
			}
			function historyEntryMatchesWorkspace(entry) {
				return !entry || !entry.currentWorkspace || !currentWorkspace || entry.currentWorkspace === currentWorkspace;
			}
			function detachActiveHistoryIfWorkspaceChanged() {
				const entry = activeHistoryEntry();
				if (historyEntryMatchesWorkspace(entry)) {
					return false;
				}
				activeHistoryId = undefined;
				promptQueue = [];
				fileChanges = [];
				latestUsage = undefined;
				currentAssistantCard = undefined;
				activeToolRows = [];
				activeToolGroup = undefined;
				log.textContent = '';
				log.appendChild(ensureEmptyState());
				renderQueue();
				renderChangeStack();
				renderCheckpoints();
				renderRecentTabs();
				return true;
			}
			function saveActiveHistory(status) {
				if (restoringHistory || !activeHistoryId || (!hasConversationContent() && !promptQueue.length && !fileChanges.length)) {
					return;
			}
			const entry = activeHistoryEntry();
			if (!entry) {
				return;
			}
			entry.html = log.innerHTML;
				entry.fileChanges = fileChanges.slice(0);
				entry.promptQueue = promptQueue.slice(0);
				entry.currentWorkspace = currentWorkspace;
				entry.updatedAt = Date.now();
			if (status) {
				entry.status = status;
			}
			persistPanelState();
			renderRecentTabs();
			renderCheckpoints();
		}
		function renderRecentTabs() {
			if (!recentTabs) {
				return;
			}
			if (inlineHistoryCount) {
				inlineHistoryCount.textContent = String(historyEntries.length);
			}
			recentTabs.textContent = '';
			const entries = historyEntries;
			if (!entries.length) {
				const empty = document.createElement('button');
				empty.className = 'recentTab active';
				empty.type = 'button';
				empty.title = 'New chat';
				const label = document.createElement('span');
				label.className = 'recentTabLabel';
				label.textContent = 'New chat';
				empty.append(label);
				recentTabs.appendChild(empty);
				return;
			}
			for (const entry of entries) {
				const button = document.createElement('div');
				const statusClass = String(entry.status || '').toLowerCase();
				button.className = 'recentTab' + (entry.id === activeHistoryId ? ' active' : '') + (statusClass === 'running' ? ' running' : '');
				button.dataset.historyId = entry.id;
				button.setAttribute('role', 'tab');
				button.setAttribute('aria-selected', entry.id === activeHistoryId ? 'true' : 'false');
				button.tabIndex = 0;
				button.title = entry.title || historyTitle(entry.prompt);
				const label = document.createElement('span');
				label.className = 'recentTabLabel';
				label.textContent = entry.title || historyTitle(entry.prompt);
				const close = document.createElement('button');
				close.className = 'recentTabClose';
				close.type = 'button';
				close.dataset.closeHistoryId = entry.id;
				close.title = 'Close chat';
				close.setAttribute('aria-label', 'Close chat');
				close.appendChild(icon('close'));
				button.append(label, close);
				recentTabs.appendChild(button);
			}
		}
		function renderHistory() {
			if (!historyList || !historyEmpty) {
				return;
			}
			historyList.textContent = '';
			historyEmpty.style.display = historyEntries.length ? 'none' : 'block';
			if (historyCount) {
				historyCount.textContent = String(historyEntries.length);
			}
			if (inlineHistoryCount) {
				inlineHistoryCount.textContent = String(historyEntries.length);
			}
			for (const entry of historyEntries) {
				const button = document.createElement('button');
				button.className = 'historyItem' + (entry.id === activeHistoryId ? ' active' : '');
				button.type = 'button';
				button.dataset.historyId = entry.id;
				const title = document.createElement('div');
				title.className = 'historyItemTitle';
				title.textContent = entry.title || historyTitle(entry.prompt);
				const meta = document.createElement('div');
				meta.className = 'historyItemMeta';
				const time = document.createElement('span');
				time.textContent = historyTime(entry.startedAt);
				const state = document.createElement('span');
				state.className = 'historyItemStatus ' + String(entry.status || '').toLowerCase();
				state.textContent = entry.status || 'Done';
				meta.append(time, state);
				button.append(title, meta);
				historyList.appendChild(button);
			}
			renderRecentTabs();
			renderCheckpoints();
		}
		function renderCheckpoints() {
			if (!checkpointStrip || !checkpointList) {
				return;
			}
			const entry = activeHistoryEntry();
			const checkpoints = Array.isArray(entry?.checkpoints) ? entry.checkpoints : [];
			checkpointList.textContent = '';
			checkpointStrip.classList.toggle('visible', checkpoints.length > 0);
			for (const checkpoint of checkpoints.slice(-8).reverse()) {
				const button = document.createElement('button');
				button.className = 'checkpointButton';
				button.type = 'button';
				button.dataset.checkpointId = checkpoint.id;
				button.title = 'Restore ' + (checkpoint.title || 'Checkpoint');
				button.appendChild(icon('debug-restart'));
				const label = document.createElement('span');
				label.className = 'checkpointLabel';
				label.textContent = checkpoint.title || 'Checkpoint';
				button.appendChild(label);
				checkpointList.appendChild(button);
			}
		}
		function setActiveView(view) {
			activeView = view === 'history' && historyPane ? 'history' : 'chat';
			log.classList.toggle('active', activeView === 'chat');
			historyPane?.classList.toggle('active', activeView === 'history');
			tabButtons.chat?.classList.toggle('active', activeView === 'chat');
			tabButtons.history?.classList.toggle('active', activeView === 'history');
			inlineHistoryButton?.classList.toggle('active', activeView === 'history');
			tabButtons.chat?.setAttribute('aria-selected', activeView === 'chat' ? 'true' : 'false');
			tabButtons.history?.setAttribute('aria-selected', activeView === 'history' ? 'true' : 'false');
			if (activeView === 'history') {
				renderHistory();
			}
			persistPanelState();
		}
		function beginHistoryRun(promptText) {
				const now = Date.now();
				let entry = activeHistoryEntry();
				if (!historyEntryMatchesWorkspace(entry)) {
					activeHistoryId = undefined;
					entry = undefined;
				}
				if (!entry) {
					entry = {
						id: 'chat-' + now + '-' + Math.random().toString(36).slice(2, 8),
						title: historyTitle(promptText),
						prompt: promptText || '',
						currentWorkspace,
						startedAt: now,
					updatedAt: now,
					status: 'Running',
					html: '',
					fileChanges: [],
					checkpoints: [],
					promptQueue: []
				};
			}
			if (!entry.prompt) {
				entry.prompt = promptText || '';
				entry.title = entry.title || historyTitle(promptText);
			}
				entry.updatedAt = now;
				entry.currentWorkspace = currentWorkspace;
				entry.status = 'Running';
			addCheckpoint(entry, promptText);
			historyEntries = [entry, ...historyEntries.filter(item => item.id !== entry.id)].slice(0, 40);
			activeHistoryId = entry.id;
			renderHistory();
			renderRecentTabs();
			persistPanelState();
			return entry.id;
		}
		function addCheckpoint(entry, promptText) {
			const checkpoints = Array.isArray(entry.checkpoints) ? entry.checkpoints : [];
			const title = hasConversationContent() ? 'Before ' + historyTitle(promptText) : 'Start';
			const previous = checkpoints[checkpoints.length - 1];
			const html = log.innerHTML;
			if (previous && previous.html === html && JSON.stringify(previous.promptQueue || []) === JSON.stringify(promptQueue)) {
				return;
			}
			checkpoints.push({
				id: 'cp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
				title,
				createdAt: Date.now(),
				html,
				fileChanges: fileChanges.slice(0),
				promptQueue: promptQueue.slice(0)
			});
			entry.checkpoints = checkpoints.slice(-20);
		}
		function restoreCheckpoint(id) {
			if (runInProgress) {
				updateStatus('Cancel the current run before restoring a checkpoint.');
				return;
			}
			const entry = activeHistoryEntry();
			const checkpoint = (Array.isArray(entry?.checkpoints) ? entry.checkpoints : []).find(item => item.id === id);
			if (!entry || !checkpoint) {
				return;
			}
			saveActiveHistory();
			restoringHistory = true;
			log.innerHTML = checkpoint.html || '';
			removeLegacyChangeArtifacts();
			spreadLegacyToolGroups();
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = Array.isArray(checkpoint.fileChanges) ? checkpoint.fileChanges.slice(0) : [];
			promptQueue = Array.isArray(checkpoint.promptQueue) ? checkpoint.promptQueue.slice(0) : [];
			entry.html = log.innerHTML;
			entry.fileChanges = fileChanges.slice(0);
			entry.promptQueue = promptQueue.slice(0);
			entry.status = 'Restored';
			entry.updatedAt = Date.now();
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			setActiveView('chat');
			scrollConversation(true);
			persistPanelState();
			updateStatus('Checkpoint restored.');
		}
		function restoreHistoryEntry(id) {
			if (runInProgress && id !== activeHistoryId) {
				updateStatus('Cancel or finish the current run before switching chats.');
				return;
			}
			const entry = historyEntries.find(item => item.id === id);
			if (!entry) {
				return;
			}
			saveActiveHistory();
			restoringHistory = true;
			log.innerHTML = entry.html || '';
			removeLegacyChangeArtifacts();
			spreadLegacyToolGroups();
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = Array.isArray(entry.fileChanges) ? entry.fileChanges.slice(0) : [];
			promptQueue = Array.isArray(entry.promptQueue) ? entry.promptQueue.slice(0) : [];
			activeHistoryId = entry.id;
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			setActiveView('chat');
			scrollConversation(true);
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			persistPanelState();
		}
		function closeHistoryEntry(id) {
			if (!id) {
				return;
			}
			if (runInProgress && id === activeHistoryId) {
				updateStatus('Cancel or finish the current run before closing this chat.');
				return;
			}
			const index = historyEntries.findIndex(item => item.id === id);
			if (index < 0) {
				return;
			}
			const wasActive = id === activeHistoryId;
			if (wasActive) {
				saveActiveHistory();
			}
			historyEntries = historyEntries.filter(item => item.id !== id);
			if (wasActive) {
				const next = historyEntries[Math.min(index, historyEntries.length - 1)];
				activeHistoryId = undefined;
				if (next) {
					restoreHistoryEntry(next.id);
				} else {
					clearConversation();
					setActiveView('chat');
				}
			} else {
				renderHistory();
				renderRecentTabs();
				renderCheckpoints();
				persistPanelState();
			}
		}
		function applyPanelStateSnapshot(state, force) {
			if (!hasPanelSnapshotContent(state) || runInProgress) {
				return;
			}
			const snapshotSavedAt = panelSnapshotTimestamp(state);
			if (!force && snapshotSavedAt && panelStateSavedAt && snapshotSavedAt <= panelStateSavedAt) {
				return;
			}
			const nextHistoryEntries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
			const nextActiveHistoryId = typeof state.activeHistoryId === 'string' ? state.activeHistoryId : undefined;
			const nextPromptQueue = Array.isArray(state.promptQueue) ? state.promptQueue : [];
			const nextActiveView = state.activeView === 'history' ? 'history' : 'chat';
			historyEntries = nextHistoryEntries;
			activeHistoryId = nextActiveHistoryId;
			promptQueue = nextPromptQueue;
			currentWorkspace = typeof state.currentWorkspace === 'string' ? state.currentWorkspace : currentWorkspace;
			panelStateSavedAt = snapshotSavedAt || Date.now();
			const entry = activeHistoryEntry();
			restoringHistory = true;
			if (entry) {
				log.innerHTML = entry.html || '';
				removeLegacyChangeArtifacts();
				spreadLegacyToolGroups();
				fileChanges = Array.isArray(entry.fileChanges) ? entry.fileChanges.slice(0) : [];
				promptQueue = Array.isArray(entry.promptQueue) ? entry.promptQueue.slice(0) : promptQueue;
			} else {
				log.innerHTML = '';
				fileChanges = [];
			}
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			setActiveView(nextActiveView);
			scrollConversation(true);
			}
		function startNewChat() {
			if (runInProgress) {
				updateStatus('Cancel or finish the current run before starting a new chat.');
				return;
			}
			closePopover();
			clearConversation();
			setActiveView('chat');
			prompt.focus();
		}
		function setActive(button, active) {
			button.classList.toggle('active', !!active);
		}
			function syncComposerButtons() {
			const hasMode = controls.mode.value !== 'free';
			const hasWeb = controls.webSearch.value === 'Auto';
			const hasImage = controls.imageGeneration.value === 'auto';
			setActive(buttons.mode, activePopover === 'reasoning' || hasMode);
			setActive(buttons.model, activePopover === 'model');
			setActive(buttons.web, activePopover === 'web' || hasWeb);
			setActive(buttons.image, activePopover === 'image' || hasImage);
			setActive(buttons.usage, activePopover === 'usage');
			buttons.usage.classList.toggle('hasUsage', !!latestUsage);
			buttons.usage.title = latestUsage ? 'Usage: ' + latestUsage.summary : 'Usage details';
			buttons.usage.setAttribute('aria-label', buttons.usage.title);
			setActive(buttons.voice, voiceRecording);
			buttons.stop.classList.toggle('visible', runInProgress);
			buttons.stop.disabled = !runInProgress || stopRequested;
			buttons.stop.title = stopRequested ? 'Stopping...' : 'Stop generation';
			buttons.stop.setAttribute('aria-label', buttons.stop.title);
				const hasPrompt = prompt.value.trim().length > 0;
				buttons.send.disabled = !authenticated || !hasPrompt;
				buttons.send.classList.toggle('ready', authenticated && hasPrompt);
				buttons.send.title = !authenticated ? 'Sign in required' : runInProgress ? 'Queue Prompt' : 'Send';
				buttons.send.setAttribute('aria-label', buttons.send.title);
			}
		function setVoiceRecording(recording) {
			voiceRecording = recording;
			buttons.voice.classList.toggle('recording', recording);
			buttons.voice.title = recording ? 'Stop voice recording' : 'Start voice recording';
			buttons.voice.setAttribute('aria-label', buttons.voice.title);
			document.querySelector('.composerCard')?.classList.toggle('recording', recording);
			syncComposerButtons();
		}
		function voiceMimeType() {
			if (typeof MediaRecorder === 'undefined') {
				return '';
			}
			return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'].find(type => MediaRecorder.isTypeSupported(type)) || '';
		}
		function stopVoiceStream() {
			if (voiceStream) {
				for (const track of voiceStream.getTracks()) {
					track.stop();
				}
			}
			voiceStream = undefined;
		}
		async function submitVoiceBlob(blob) {
			if (!blob.size) {
				updateStatus('Voice recording stopped. No audio captured.');
				return;
			}
			const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
			const mimeType = blob.type || 'audio/webm';
			const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'webm';
			const nextOptions = { ...options(), voiceMode: controls.voiceMode.value === 'stt' ? 'stt' : 'conversation' };
			updateStatus('Sending voice to Backboard.');
				vscode.postMessage({
					type: 'sendVoice',
					prompt: prompt.value.trim(),
					options: nextOptions,
					chatId: activeHistoryId,
					workspace: currentWorkspace,
					audio: {
					data: bytes,
					fileName: 'backboard-voice.' + extension,
					mimeType
				}
			});
			prompt.value = '';
			syncComposerButtons();
		}
		function stopVoiceCapture() {
			if (voiceRecorder && voiceRecorder.state !== 'inactive') {
				voiceRecorder.stop();
				return;
			}
			setVoiceRecording(false);
			stopVoiceStream();
		}
		async function toggleVoiceCapture() {
			if (voiceRecording) {
				stopVoiceCapture();
				return;
			}
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
				updateStatus('Microphone recording is not available in this webview.');
				return;
			}
			closePopover();
			voiceChunks = [];
			try {
				voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				const mimeType = voiceMimeType();
				voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
				voiceRecorder.ondataavailable = event => {
					if (event.data?.size) {
						voiceChunks.push(event.data);
					}
				};
				voiceRecorder.onerror = () => {
					updateStatus('Voice recording failed.');
					setVoiceRecording(false);
					stopVoiceStream();
				};
				voiceRecorder.onstop = () => {
					const blob = new Blob(voiceChunks, { type: voiceRecorder?.mimeType || mimeType || 'audio/webm' });
					voiceRecorder = undefined;
					voiceChunks = [];
					setVoiceRecording(false);
					stopVoiceStream();
					void submitVoiceBlob(blob);
				};
				voiceRecorder.start();
				setVoiceRecording(true);
				updateStatus('Recording voice. Click mic again to send.');
			} catch (error) {
				voiceRecorder = undefined;
				voiceChunks = [];
				setVoiceRecording(false);
				stopVoiceStream();
				updateStatus(error instanceof Error && /permission|denied|notallowed/i.test(error.message) ? 'Microphone access denied.' : 'Voice recording could not start.');
			}
		}
		function insertAtCursor(text) {
			const start = prompt.selectionStart || 0;
			const end = prompt.selectionEnd || 0;
			prompt.value = prompt.value.slice(0, start) + text + prompt.value.slice(end);
			prompt.selectionStart = prompt.selectionEnd = start + text.length;
			prompt.focus();
			syncComposerButtons();
		}
		function setSelect(select, value) {
			if ([...select.options].some(option => option.value === value)) {
				select.value = value;
			}
		}
		function escapeHtml(value) {
			return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
		}
		function attr(value) {
			return escapeHtml(value);
		}
		function providerKey(provider) {
			const value = String(provider || '').trim().toLowerCase().replace(/_/g, '-');
			if (value.includes('openrouter') || value.includes('open-router')) {
				return 'openrouter';
			}
			if (value.includes('bedrock') || value.includes('amazon') || value === 'aws') {
				return 'aws-bedrock';
			}
			if (value === 'google-ai' || value === 'googleai') {
				return 'google-ai';
			}
			if (value === 'open-ai' || value === 'open-ai-compatible') {
				return value === 'open-ai-compatible' ? 'openai-compatible' : 'openai';
			}
			if (value === 'openai-compatible' || value === 'openai-compat') {
				return 'openai-compatible';
			}
			if (value === 'x-ai' || value === 'x.ai') {
				return 'xai';
			}
			if (value === 'lmstudio') {
				return 'lm-studio';
			}
			return value;
		}
		function providerDisplayName(provider) {
			const key = providerKey(provider);
			return providerDisplayNames[key] || String(provider || 'Other');
		}
		function providerIconFile(provider) {
			const key = providerKey(provider);
			return providerIconFiles[key] || undefined;
		}
		function providerIconHtml(provider, className) {
			const file = providerIconFile(provider);
			if (!file) {
				return '<span class="' + attr(className) + '"><span class="codicon codicon-symbol-misc"></span></span>';
			}
			return '<span class="' + attr(className) + '"><img data-provider-icon="true" src="' + attr(iconBase + '/' + file) + '" alt="" loading="lazy"></span>';
		}
		function unwrapModelIconHtml(value) {
			const prefix = '<span class="modelIcon">';
			const suffix = '</span>';
			return value.startsWith(prefix) && value.endsWith(suffix) ? value.slice(prefix.length, -suffix.length) : value;
		}
		function supplementalModelSource(items) {
			const next = items.slice(0);
			for (const model of supplementalModels) {
				if (!next.some(item => providerKey(item.provider) === providerKey(model.provider))) {
					next.push(model);
				}
			}
			return next;
		}
		function currentModelLabel() {
			const provider = controls.provider.value;
			const selected = modelSource().find(model => model.provider === provider && model.name === controls.model.value);
			return [providerDisplayName(provider), selected?.displayName || selected?.name || controls.model.value].filter(Boolean).join(' / ');
		}
		function currentModel() {
			const provider = controls.provider.value;
			return modelSource().find(model => model.provider === provider && model.name === controls.model.value);
		}
		function isVisibleModel(model) {
			const modelType = String(model?.modelType || model?.model_type || '').trim().toLowerCase();
			return !['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics'].includes(providerKey(model.provider)) && (!modelType || modelType === 'llm');
		}
		function section(title, content) {
			return '<div class="popoverSection"><div class="popoverSectionTitle">' + escapeHtml(title) + '</div>' + content + '</div>';
		}
		function numericModelValue(model, keys) {
			for (const key of keys) {
				const value = model?.[key];
				if (typeof value === 'number' && Number.isFinite(value)) {
					return value;
				}
				if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
					return Number(value);
				}
			}
			return undefined;
		}
		function formatModelPrice(value) {
			return '$' + value.toFixed(2) + '/M';
		}
		function modelPricePair(model) {
			const explicitInput = numericModelValue(model, ['inputPricePerMillion', 'inputCostPer1mTokens', 'input_cost_per_1m_tokens', 'inputPrice', 'promptPrice', 'promptPricePerMillion']);
			const explicitOutput = numericModelValue(model, ['outputPricePerMillion', 'outputCostPer1mTokens', 'output_cost_per_1m_tokens', 'outputPrice', 'completionPrice', 'completionPricePerMillion']);
			if (explicitInput !== undefined && explicitOutput !== undefined) {
				return [explicitInput, explicitOutput];
			}
			const id = [model?.provider, model?.name, model?.displayName].filter(Boolean).join(' ').toLowerCase().replace(/[._]/g, '-');
			if (id.includes('claude-haiku-4-5') || id.includes('claude-haiku-4.5')) {
				return [1, 5];
			}
			if (id.includes('claude-sonnet-4')) {
				return [3, 15];
			}
			if (id.includes('claude-opus-4-5') || id.includes('claude-opus-4.5') || id.includes('claude-opus-4-6') || id.includes('claude-opus-4-7') || id.includes('claude-opus-4-8')) {
				return [5, 25];
			}
			if (id.includes('claude-opus-4')) {
				return [15, 75];
			}
			return undefined;
		}
		function modelPriceLabel(model) {
			if (typeof model?.pricing === 'string' && model.pricing.trim() !== '') {
				return model.pricing;
			}
			const pair = modelPricePair(model);
			return pair ? formatModelPrice(pair[0]) + ' in, ' + formatModelPrice(pair[1]) + ' out' : 'Pricing unavailable';
		}
		function choice(action, value, label, meta, selected, disabled, extraAttrs, icon) {
			const iconHtml = icon ? '<span class="choiceIcon"><span class="codicon codicon-' + attr(icon) + '"></span></span>' : '';
			return '<button class="choiceRow' + (selected ? ' selected' : '') + (disabled ? ' disabled' : '') + '" type="button" data-action="' + attr(action) + '" data-value="' + attr(value) + '" ' + (disabled ? 'disabled' : '') + ' ' + (extraAttrs || '') + '>' + iconHtml + '<span class="choiceMain"><span class="choiceLabel">' + escapeHtml(label) + '</span>' + (meta ? '<span class="choiceMeta">' + escapeHtml(meta) + '</span>' : '') + '</span>' + (selected ? '<span class="codicon codicon-check"></span>' : '') + '</button>';
		}
		function modelChoice(model, provider, selected) {
			const price = modelPriceLabel(model);
			return '<button class="choiceRow modelChoice' + (selected ? ' selected' : '') + '" type="button" data-action="chooseModel" data-value="' + attr(model.name) + '" data-provider="' + attr(provider) + '" data-model="' + attr(model.name) + '">' + providerIconHtml(provider, 'choiceIcon') + '<span class="choiceMain"><span class="choiceLabel">' + escapeHtml(model.displayName || model.name) + '</span><span class="choiceMeta">' + escapeHtml(model.name) + '</span></span><span class="modelChoiceMeta">' + escapeHtml(price) + '</span>' + (selected ? '<span class="codicon codicon-check"></span>' : '<span class="modelChoiceCheckSpacer"></span>') + '</button>';
		}
		function actionButton(action, label, icon) {
			return '<button class="drawerButton" type="button" data-action="' + attr(action) + '">' + (icon ? '<span class="codicon codicon-' + attr(icon) + '"></span> ' : '') + escapeHtml(label) + '</button>';
		}
		function providerSwitch(provider, active) {
			const icon = providerIconFile(provider) ? '<img data-provider-icon="true" src="' + attr(iconBase + '/' + providerIconFile(provider)) + '" alt="" loading="lazy">' : '<span class="codicon codicon-symbol-misc"></span>';
			return '<button class="providerSwitch' + (active ? ' active' : '') + '" type="button" data-action="toggleProviderFilter" data-provider="' + attr(provider) + '" aria-pressed="' + (active ? 'true' : 'false') + '"><span class="providerSwitchIcon">' + icon + '</span><span class="providerSwitchName">' + escapeHtml(providerDisplayName(provider)) + '</span><span class="providerSwitchToggle" aria-hidden="true">' + (active ? '<span class="codicon codicon-check"></span>' : '') + '</span></button>';
		}
		function modelSource() {
			const fallback = [{ provider: controls.provider.value || 'aws-bedrock', name: controls.model.value || 'anthropic.claude-sonnet-4-6', displayName: controls.model.value || 'anthropic.claude-sonnet-4-6' }];
			return supplementalModelSource(models.length ? models.filter(isVisibleModel) : fallback.filter(isVisibleModel));
		}
		function modeLabel(value) {
			return ({ agent: 'Agent', ask: 'Ask', manual: 'Manual', free: 'Full Access' })[value] || value;
		}
		function intensityLabel(value) {
			return ({ fast: 'Fast', balanced: 'Balanced', deep: 'Deep' })[value] || value;
		}
		function syncModeLabels() {
			const label = modeLabel(controls.mode.value);
			modeLabelNode.textContent = label;
			headerBadge.textContent = label;
			buttons.mode.title = label + ' / ' + intensityLabel(controls.intensity.value);
			buttons.mode.setAttribute('aria-label', buttons.mode.title);
		}
		function voiceLabel(value) {
			return ({ off: 'Off', tts: 'TTS', stt: 'STT', conversation: 'Conversation' })[value] || value;
		}
		function renderModelPopover() {
			const source = modelSource();
			const query = modelFilter.trim().toLowerCase();
			const allProviders = [...new Set(source.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			const providerFiltered = source.filter(model => !disabledModelProviders.has(model.provider));
			const filtered = query
				? providerFiltered.filter(model => [model.provider, model.displayName, model.name].filter(Boolean).join(' ').toLowerCase().includes(query))
				: providerFiltered;
			const providers = [...new Set(filtered.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			const search = '<div class="modelFilterBar"><input id="modelFilter" class="popoverSearch" type="search" placeholder="Select a model..." value="' + attr(modelFilter) + '" autocomplete="off"><button class="modelFilterButton' + (modelProviderFiltersOpen ? ' active' : '') + '" type="button" data-action="toggleModelProviderFilters" title="Filter by provider" aria-label="Filter by provider" aria-expanded="' + (modelProviderFiltersOpen ? 'true' : 'false') + '">Filter</button></div>';
			const filterWrap = '<div class="modelFilterWrap">' + search + '</div>';
			if (modelProviderFiltersOpen) {
				const allActive = disabledModelProviders.size === 0;
				const allProvidersRow = '<button class="providerSwitch' + (allActive ? ' active' : '') + '" type="button" data-action="setAllProviderFilters" aria-pressed="' + (allActive ? 'true' : 'false') + '"><span class="providerSwitchName">All providers</span><span class="providerSwitchToggle" aria-hidden="true">' + (allActive ? '<span class="codicon codicon-check"></span>' : '') + '</span></button>';
				const providerRows = allProviders.map(provider => providerSwitch(provider, !disabledModelProviders.has(provider))).join('');
				return filterWrap + '<div class="providerFilterPane"><div class="filterHeader"><span class="filterTitle">Filter by provider</span><span class="filterMeta">Choose one or more providers, then press Done.</span></div><div class="providerSwitchList">' + allProvidersRow + providerRows + '</div><button class="providerFilterDone" type="button" data-action="doneModelProviderFilters">Done</button></div>';
			}
			const noModelsMeta = query ? 'Try a different text filter.' : disabledModelProviders.size ? 'Enable a provider filter.' : 'Refresh models or sign in with SSO.';
			const sections = providers.length ? providers.map(provider => {
				const rows = filtered
					.filter(model => model.provider === provider)
					.map(model => modelChoice(model, provider, controls.provider.value === provider && controls.model.value === model.name))
					.join('');
				return section(providerDisplayName(provider), rows);
			}).join('') : section('Models', choice('disabled', '', 'No matching models', noModelsMeta, false, true));
			return filterWrap + sections + '<div class="popoverActions">' + actionButton('refreshModels', 'Refresh Models', 'refresh') + actionButton('signIn', 'SSO', 'account') + '</div>';
		}
		function renderReasoningPopover() {
			const modes = [
				['agent', 'Agent', ''],
				['ask', 'Ask', ''],
				['manual', 'Manual', ''],
				['free', 'Full Access', '']
			].map(([value, label, meta]) => choice('chooseMode', value, label, meta, controls.mode.value === value, false)).join('');
			const intensities = [
				['fast', 'Fast', ''],
				['balanced', 'Balanced', ''],
				['deep', 'Deep', '']
			].map(([value, label, meta]) => choice('chooseIntensity', value, label, meta, controls.intensity.value === value, false)).join('');
			return section('Mode', modes) + section('Reasoning', intensities);
		}
		function renderWebPopover() {
			return section('Web Search', [
				choice('chooseWeb', 'off', 'Off', '', controls.webSearch.value === 'off', false),
				choice('chooseWeb', 'Auto', 'Auto', '', controls.webSearch.value === 'Auto', false)
			].join(''));
		}
		function renderImagePopover() {
			return section('Image', [
				choice('chooseImage', 'off', 'Off', '', controls.imageGeneration.value === 'off', false),
				choice('chooseImage', 'auto', 'Auto', '', controls.imageGeneration.value === 'auto', false)
			].join(''));
		}
		function renderVoicePopover() {
			return section('Voice', [
				choice('chooseVoice', 'off', 'Off', '', controls.voiceMode.value === 'off', false),
				choice('chooseVoice', 'tts', 'TTS', '', controls.voiceMode.value === 'tts', false),
				choice('chooseVoice', 'stt', 'STT', '', controls.voiceMode.value === 'stt', true),
				choice('chooseVoice', 'conversation', 'Conversation', '', controls.voiceMode.value === 'conversation', true)
			].join(''));
		}
		function renderUsagePopover() {
			const refresh = '<div class="popoverActions">' + actionButton('refreshUsage', 'Refresh Usage', 'refresh') + '</div>';
			if (!latestUsage && !accountUsage) {
				return section('Usage', choice('disabled', '', 'No usage yet', 'Refresh billing usage or run a Backboard turn.', false, true, '', 'pulse')) + refresh;
			}
			const account = accountUsage
				? section('Account', choice('disabled', '', 'Billing usage', accountUsage.summary, false, true, '', 'pulse') + accountUsage.metrics.map(([label, value]) => choice('disabled', '', label, value, false, true, '', 'dashboard')).join(''))
				: '';
			if (!latestUsage) {
				return account + refresh;
			}
			const summary = section('Latest Run', choice('disabled', '', 'Latest run', latestUsage.summary, false, true, '', 'pulse'));
			const metrics = latestUsage.metrics.length
				? latestUsage.metrics.map(([label, value]) => choice('disabled', '', label, value, false, true, '', 'dashboard')).join('')
				: choice('disabled', '', 'Usage details', 'No metric fields were reported.', false, true, '', 'dashboard');
			return account + summary + section('Metrics', metrics) + refresh;
		}
		function renderPopover(name) {
			const renderers = {
				model: ['Model', renderModelPopover],
				reasoning: ['Mode and Reasoning', renderReasoningPopover],
				web: ['Web', renderWebPopover],
				image: ['Image', renderImagePopover],
				voice: ['Voice', renderVoicePopover],
				usage: ['Usage', renderUsagePopover]
			};
			const renderer = renderers[name] || renderers.model;
			popover.dataset.kind = name;
			popoverTitle.textContent = renderer[0];
			popoverBody.innerHTML = renderer[1]();
		}
		function positionPopover(anchorButton) {
			const width = Math.min(620, window.innerWidth - 8);
			popover.style.width = width + 'px';
			const rect = anchorButton.getBoundingClientRect();
			const popoverRect = popover.getBoundingClientRect();
			const left = Math.max(4, Math.min(window.innerWidth - popoverRect.width - 4, rect.left + rect.width / 2 - popoverRect.width / 2));
			const top = Math.max(4, rect.top - popoverRect.height - 4);
			popover.style.left = left + 'px';
			popover.style.top = top + 'px';
		}
		function openPopover(name, anchorButton) {
			if (activePopover === name && popover.classList.contains('open')) {
				closePopover();
				return;
			}
			if (name === 'model') {
				modelFilter = '';
				disabledModelProviders.clear();
				modelProviderFiltersOpen = false;
			}
			activePopover = name;
			activeAnchor = anchorButton;
			renderPopover(name);
			popover.classList.add('open');
			popover.setAttribute('aria-hidden', 'false');
			positionPopover(anchorButton);
			syncComposerButtons();
		}
		function closePopover() {
			activePopover = undefined;
			activeAnchor = undefined;
			popover.classList.remove('open');
			popover.setAttribute('aria-hidden', 'true');
			popoverBody.textContent = '';
			modelFilter = '';
			disabledModelProviders.clear();
			modelProviderFiltersOpen = false;
			prompt.focus();
			syncComposerButtons();
		}
		function requestUsageSnapshot() {
			updateStatus('Loading Backboard usage.');
			vscode.postMessage({ type: 'refreshUsage' });
		}
		function chooseSelect(select, value, close) {
			setSelect(select, value);
			select.dispatchEvent(new Event('change'));
			if (close) {
				closePopover();
			} else if (activePopover) {
				renderPopover(activePopover);
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			}
		}
		function renderModels() {
			const source = modelSource();
			const providers = [...new Set(source.map(model => model.provider))].sort((left, right) => providerDisplayName(left).localeCompare(providerDisplayName(right)));
			controls.provider.textContent = '';
			const fallbackProvider = source[0]?.provider || settings.provider || 'aws-bedrock';
			for (const provider of providers.length ? providers : [fallbackProvider]) {
				const option = document.createElement('option');
				option.value = provider;
				option.textContent = providerDisplayName(provider);
				controls.provider.appendChild(option);
			}
			setSelect(controls.provider, settings.provider || '');
			let provider = controls.provider.value || fallbackProvider;
			if (!providers.includes(provider) && source[0]) {
				provider = source[0].provider;
				controls.provider.value = provider;
			}
			const providerModels = source.filter(model => model.provider === provider);
			controls.model.textContent = '';
			const selectableModels = providerModels.length ? providerModels : [{ provider, name: settings.model || 'anthropic.claude-sonnet-4-6', displayName: settings.model || 'anthropic.claude-sonnet-4-6' }];
			for (const model of selectableModels) {
				const option = document.createElement('option');
				option.value = model.name;
				option.textContent = [providerDisplayName(provider), model.displayName || model.name].filter(Boolean).join(' / ');
				option.title = [providerDisplayName(provider), model.name, model.contextLimit ? model.contextLimit + ' tokens' : '', model.supportsThinking ? 'thinking' : '', modelPriceLabel(model)].filter(Boolean).join(' / ');
				controls.model.appendChild(option);
			}
			setSelect(controls.model, settings.model || '');
			if (!selectableModels.some(model => model.name === controls.model.value) && selectableModels[0]) {
				controls.model.value = selectableModels[0].name;
			}
			settings.provider = controls.provider.value || provider;
			settings.model = controls.model.value || selectableModels[0]?.name || settings.model;
			const selected = source.find(model => model.provider === provider && model.name === controls.model.value);
			modelLabel.textContent = selected?.displayName || selected?.name || controls.model.value || 'Auto';
			modelIcon.innerHTML = unwrapModelIconHtml(providerIconHtml(provider, 'modelIcon'));
			buttons.model.title = currentModelLabel();
		}
			function applySettings(next) {
				settings = { ...settings, ...(next || {}) };
				setAuthenticated(settings.authenticated === true);
				renderModels();
			setSelect(controls.mode, settings.mode || 'free');
			setSelect(controls.intensity, settings.intensity || 'fast');
			setSelect(controls.webSearch, settings.webSearch || 'off');
			setSelect(controls.imageGeneration, settings.imageGeneration || 'off');
			setSelect(controls.voiceMode, settings.voiceMode || 'off');
			controls.mcpFigma.checked = !!settings.mcpFigma;
			controls.mcpNotion.checked = !!settings.mcpNotion;
			controls.mcpGoogle.checked = !!settings.mcpGoogle;
			syncModeLabels();
			const selected = modelSource().find(model => model.provider === controls.provider.value && model.name === controls.model.value);
			modelLabel.textContent = selected?.displayName || selected?.name || controls.model.value || 'Auto';
			syncComposerButtons();
		}
		for (const control of Object.values(controls)) {
			control.addEventListener('change', () => {
				if (control === controls.provider) {
					settings.provider = controls.provider.value;
					const first = modelSource().find(model => model.provider === settings.provider);
					if (first) {
						settings.model = first.name;
					}
					renderModels();
				}
				if (control === controls.mode || control === controls.intensity) {
					syncModeLabels();
				}
				if (control === controls.mode) {
					vscode.postMessage({ type: 'refreshModels' });
				}
				saveOptions();
				syncComposerButtons();
			});
		}
			prompt.addEventListener('input', syncComposerButtons);
			authSignInButton?.addEventListener('click', () => {
				vscode.postMessage({ type: 'signIn' });
			});
		prompt.addEventListener('keydown', event => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				document.getElementById('form').requestSubmit();
			}
		});
		buttons.mode.addEventListener('click', event => openPopover('reasoning', event.currentTarget));
		buttons.model.addEventListener('click', event => openPopover('model', event.currentTarget));
		buttons.web.addEventListener('click', event => openPopover('web', event.currentTarget));
		buttons.image.addEventListener('click', event => openPopover('image', event.currentTarget));
		buttons.usage.addEventListener('click', event => {
			requestUsageSnapshot();
			openPopover('usage', event.currentTarget);
		});
		buttons.usage.addEventListener('mouseenter', event => openPopover('usage', event.currentTarget));
		buttons.usage.addEventListener('focus', event => openPopover('usage', event.currentTarget));
		buttons.voice.addEventListener('click', toggleVoiceCapture);
		buttons.stop.addEventListener('click', () => {
			if (!runInProgress) {
				return;
			}
			stopRequested = true;
			closePopover();
			updateStatus('Stopping Backboard.');
			vscode.postMessage({ type: 'cancel' });
			syncComposerButtons();
		});
		newChatButton?.addEventListener('click', startNewChat);
		inlineNewChatButton?.addEventListener('click', startNewChat);
		inlineHistoryButton?.addEventListener('click', () => setActiveView(activeView === 'history' ? 'chat' : 'history'));
		tabButtons.chat?.addEventListener('click', () => setActiveView('chat'));
		tabButtons.history?.addEventListener('click', () => setActiveView('history'));
		historyList?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-history-id]') : undefined;
			if (target) {
				restoreHistoryEntry(target.dataset.historyId || '');
			}
		});
		recentTabs?.addEventListener('click', event => {
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			const closeTarget = target?.closest('[data-close-history-id]');
			if (closeTarget) {
				event.stopPropagation();
				closeHistoryEntry(closeTarget.dataset.closeHistoryId || '');
				return;
			}
			const tabTarget = target?.closest('[data-history-id]');
			if (tabTarget) {
				restoreHistoryEntry(tabTarget.dataset.historyId || '');
			}
		});
		recentTabs?.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			if (target?.closest('[data-close-history-id]')) {
				return;
			}
			const tabTarget = target?.closest('[data-history-id]');
			if (tabTarget) {
				event.preventDefault();
				restoreHistoryEntry(tabTarget.dataset.historyId || '');
			}
		});
		checkpointList?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-checkpoint-id]') : undefined;
			if (target) {
				restoreCheckpoint(target.dataset.checkpointId || '');
			}
		});
		changeStack?.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('[data-log-action]') : undefined;
			const action = target?.getAttribute('data-log-action');
			if (action === 'reviewChanges') {
				vscode.postMessage({ type: 'reviewChanges' });
			}
		});
		log.addEventListener('click', event => {
			const groupToggle = event.target instanceof Element ? event.target.closest('[data-tool-group-toggle]') : undefined;
			if (groupToggle) {
				const group = groupToggle.closest('.toolGroup');
				if (group instanceof HTMLElement) {
					const open = group.classList.toggle('open');
					groupToggle.title = open ? 'Hide command list' : 'Show command list';
					groupToggle.setAttribute('aria-label', groupToggle.title);
					updateToolGroupSummary(group);
				}
				return;
			}
			const toolToggle = event.target instanceof Element ? event.target.closest('[data-tool-toggle]') : undefined;
			if (toolToggle) {
				const row = toolToggle.closest('.toolCard');
				if (row instanceof HTMLElement) {
					const open = row.classList.toggle('open');
					toolToggle.title = open ? 'Hide tool details' : 'Show tool details';
					toolToggle.setAttribute('aria-label', toolToggle.title);
					toolToggle.textContent = '';
					toolToggle.appendChild(icon(open ? 'chevron-up' : 'chevron-down'));
				}
				return;
			}
			const target = event.target instanceof Element ? event.target.closest('[data-log-action]') : undefined;
			const action = target?.getAttribute('data-log-action');
			if (action === 'reviewChanges') {
				vscode.postMessage({ type: 'reviewChanges' });
				return;
			}
			if (action === 'editPrompt' || action === 'queuePrompt') {
				const card = target?.closest('.messageCard.user');
				const text = card?.querySelector('.messageText')?.textContent || '';
				if (action === 'editPrompt') {
					prompt.value = text;
					prompt.focus();
					prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
					syncComposerButtons();
					updateStatus('Prompt loaded for editing.');
				} else {
					queuePrompt(text, options());
				}
				return;
			}
			const queueTarget = event.target instanceof Element ? event.target.closest('[data-queue-action]') : undefined;
			if (queueTarget) {
				const card = queueTarget.closest('[data-queue-id]');
				const queueId = card?.getAttribute('data-queue-id') || '';
				const action = queueTarget.getAttribute('data-queue-action');
				const index = promptQueue.findIndex(item => item.id === queueId);
				if (index < 0) {
					return;
				}
				if (action === 'remove') {
					promptQueue.splice(index, 1);
				} else if (action === 'run') {
					const item = promptQueue.splice(index, 1)[0];
					promptQueue.unshift(item);
					if (!runInProgress) {
						drainPromptQueue();
						return;
					}
				}
				renderQueue();
				saveActiveHistory();
			}
		});
		document.getElementById('popoverClose').addEventListener('click', closePopover);
		popoverBody.addEventListener('input', event => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement) || target.id !== 'modelFilter') {
				return;
			}
			modelFilter = target.value;
			renderPopover('model');
			if (activeAnchor) {
				positionPopover(activeAnchor);
			}
			const filter = document.getElementById('modelFilter');
			if (filter instanceof HTMLInputElement) {
				filter.focus();
				filter.setSelectionRange(filter.value.length, filter.value.length);
			}
		});
		popoverBody.addEventListener('click', event => {
			const eventTarget = event.target;
			const target = (eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined
				)?.closest('[data-action]');
			if (!target || target.classList.contains('disabled')) {
				return;
			}
			event.stopPropagation();
			const action = target.dataset.action;
			const value = target.dataset.value || '';
			if (action === 'insertContextType') {
				insertAtCursor('@' + value + ' ');
				closePopover();
			} else if (action === 'insertActiveFile') {
				vscode.postMessage({ type: 'insertActiveFile' });
				closePopover();
			} else if (action === 'insertSelection') {
				vscode.postMessage({ type: 'insertSelection' });
				closePopover();
			} else if (action === 'insertBranchDiff') {
				vscode.postMessage({ type: 'insertBranchDiff' });
				closePopover();
			} else if (action === 'chooseMode') {
				chooseSelect(controls.mode, value, false);
			} else if (action === 'chooseIntensity') {
				chooseSelect(controls.intensity, value, false);
			} else if (action === 'chooseWeb') {
				chooseSelect(controls.webSearch, value, true);
			} else if (action === 'chooseImage') {
				chooseSelect(controls.imageGeneration, value, true);
			} else if (action === 'chooseVoice') {
				chooseSelect(controls.voiceMode, value, true);
			} else if (action === 'toggleProviderFilter') {
				const provider = target.dataset.provider || value;
				if (disabledModelProviders.has(provider)) {
					disabledModelProviders.delete(provider);
				} else {
					disabledModelProviders.add(provider);
				}
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'setAllProviderFilters') {
				disabledModelProviders.clear();
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'toggleModelProviderFilters') {
				modelProviderFiltersOpen = !modelProviderFiltersOpen;
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'doneModelProviderFilters') {
				modelProviderFiltersOpen = false;
				renderPopover('model');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			} else if (action === 'chooseModel') {
				const provider = target.dataset.provider || controls.provider.value;
				const model = target.dataset.model || value;
				setSelect(controls.provider, provider);
				renderModels();
				setSelect(controls.model, model);
				settings.provider = provider;
				settings.model = model;
				const selected = modelSource().find(item => item.provider === provider && item.name === model);
				modelLabel.textContent = selected?.displayName || selected?.name || model;
				saveOptions();
				closePopover();
			} else if (action === 'refreshModels') {
				vscode.postMessage({ type: 'refreshModels' });
				closePopover();
			} else if (action === 'refreshUsage') {
				requestUsageSnapshot();
			} else if (action === 'setApiKey' || action === 'signIn') {
				vscode.postMessage({ type: 'signIn' });
				closePopover();
			} else if (action === 'openModel') {
				openPopover('model', buttons.model);
			} else if (action === 'openReasoning') {
				openPopover('reasoning', buttons.mode);
			} else if (action === 'openWeb') {
				openPopover('web', buttons.web);
			} else if (action === 'openImage') {
				openPopover('image', buttons.image);
			} else if (action === 'cancelRun') {
				vscode.postMessage({ type: 'cancel' });
				closePopover();
			}
		});
		document.addEventListener('pointerdown', event => {
			if (!activePopover) {
				return;
			}
			const eventTarget = event.target;
			const target = eventTarget instanceof Element
				? eventTarget
				: eventTarget instanceof Node ? eventTarget.parentElement : undefined;
			if (!target) {
				return;
			}
			if (popover.contains(target) || activeAnchor?.contains(target)) {
				return;
			}
			closePopover();
		}, true);
		document.addEventListener('error', event => {
			const target = event.target;
			if (!(target instanceof HTMLImageElement) || target.dataset.providerIcon !== 'true') {
				return;
			}
			const fallback = document.createElement('span');
			fallback.className = 'codicon codicon-symbol-misc';
			target.replaceWith(fallback);
		}, true);
		document.addEventListener('keydown', event => {
			if (event.key === 'Escape' && activePopover) {
				event.preventDefault();
				closePopover();
			}
		});
		window.addEventListener('resize', () => {
			syncRootHeight();
			if (activePopover && activeAnchor) {
				positionPopover(activeAnchor);
			}
		});
		window.visualViewport?.addEventListener('resize', syncRootHeight);
			document.getElementById('form').addEventListener('submit', event => {
				event.preventDefault();
				if (!authenticated) {
					updateStatus('Sign in required.');
					authSignInButton?.focus();
					return;
				}
				const text = prompt.value.trim();
			if (!text) {
				syncComposerButtons();
				return;
			}
			if (text === '/retry') {
				retryLastPrompt();
				prompt.value = '';
				syncComposerButtons();
				return;
			}
			if (runInProgress) {
				queuePrompt(text, options());
			} else {
				sendPromptToHost(text, options());
			}
			prompt.value = '';
			syncComposerButtons();
		});
		function isNearConversationBottom() {
			return log.scrollHeight - log.scrollTop - log.clientHeight < 96;
		}
		function scrollConversation(force) {
			const shouldStick = force || runInProgress || isNearConversationBottom();
			syncEmptyState();
			saveActiveHistory();
			if (shouldStick) {
				const scrollToLatest = () => {
					log.scrollTop = log.scrollHeight;
					const last = log.lastElementChild;
					if (last && last !== emptyState) {
						last.scrollIntoView({ block: 'end' });
					}
				};
				scrollToLatest();
				requestAnimationFrame(() => {
					scrollToLatest();
					requestAnimationFrame(() => {
						scrollToLatest();
					});
				});
			}
		}
		function clearConversation() {
			saveActiveHistory();
			log.textContent = '';
			log.appendChild(ensureEmptyState());
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = [];
			promptQueue = [];
			latestUsage = undefined;
			activeHistoryId = undefined;
			runInProgress = false;
			stopRequested = false;
			stopRunTimer();
			syncComposerButtons();
			renderChangeStack();
			renderRecentTabs();
			renderCheckpoints();
			scrollConversation(true);
		}
		function queuePrompt(text, queuedOptions) {
			const value = String(text || '').trim();
			if (!value) {
				return;
			}
			promptQueue.push({
				id: 'queued-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
				text: value,
				options: queuedOptions || options(),
				createdAt: Date.now()
			});
			renderQueue();
			saveActiveHistory();
			updateStatus(promptQueue.length + ' prompt' + (promptQueue.length === 1 ? '' : 's') + ' queued.');
		}
		function latestUserPrompt() {
			const messages = Array.from(log.querySelectorAll('.messageCard.user .messageText'));
			for (let index = messages.length - 1; index >= 0; index--) {
				const value = messages[index].textContent?.trim();
				if (value && value !== '/retry') {
					return value;
				}
			}
			const entry = activeHistoryEntry();
			return entry?.prompt?.trim() || '';
		}
		function retryLastPrompt() {
			const text = latestUserPrompt();
			if (!text) {
				updateStatus('No previous prompt to retry.');
				return;
			}
			if (runInProgress) {
				queuePrompt(text, options());
			} else {
				sendPromptToHost(text, options());
			}
		}
		function renderQueue() {
			document.getElementById('queueBlock')?.remove();
			if (!promptQueue.length) {
				persistPanelState();
				return;
			}
			const block = document.createElement('div');
			block.id = 'queueBlock';
			block.className = 'queueBlock';
			const header = document.createElement('div');
			header.className = 'queueHeader';
			header.append(icon('list-ordered'));
			const label = document.createElement('span');
			label.textContent = promptQueue.length + ' Queued';
			header.appendChild(label);
			block.appendChild(header);
			for (const item of promptQueue) {
				const card = document.createElement('div');
				card.className = 'queueCard';
				card.dataset.queueId = item.id;
				const editor = document.createElement('textarea');
				editor.className = 'queueTextarea';
				editor.value = item.text || '';
				editor.setAttribute('aria-label', 'Queued prompt');
				editor.addEventListener('input', () => {
					item.text = editor.value;
					saveActiveHistory();
				});
				const actions = document.createElement('div');
				actions.className = 'queueActions';
				const run = document.createElement('button');
				run.className = 'queueButton';
				run.type = 'button';
				run.dataset.queueAction = 'run';
				run.textContent = 'Run Next';
				const remove = document.createElement('button');
				remove.className = 'queueButton';
				remove.type = 'button';
				remove.dataset.queueAction = 'remove';
				remove.textContent = 'Remove';
				actions.append(run, remove);
				card.append(editor, actions);
				block.appendChild(card);
			}
			log.appendChild(block);
			scrollConversation(true);
		}
			function sendPromptToHost(text, queuedOptions) {
				detachActiveHistoryIfWorkspaceChanged();
				const chatId = beginHistoryRun(text);
				runInProgress = true;
			startRunTimer(Date.now());
			renderQueue();
				vscode.postMessage({ type: 'send', chatId, prompt: text, workspace: currentWorkspace, options: queuedOptions || options() });
			}
		function drainPromptQueue() {
			if (runInProgress || !promptQueue.length) {
				renderQueue();
				return;
			}
			const next = promptQueue.shift();
			renderQueue();
			saveActiveHistory();
			if (next?.text?.trim()) {
				sendPromptToHost(next.text.trim(), next.options || options());
			}
		}
		function icon(name) {
			const span = document.createElement('span');
			span.className = 'codicon codicon-' + name;
			return span;
		}
		function latestTranscriptNode() {
			const children = Array.from(log.children);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index];
				if (child !== emptyState) {
					return child;
				}
			}
			return undefined;
		}
		function breakAssistantStream() {
			currentAssistantCard = undefined;
		}
			function appendMessage(role, text) {
				const card = document.createElement('div');
				card.className = 'messageCard ' + role;
				const body = document.createElement('div');
				body.className = 'messageText';
				body.textContent = text || '';
				card.appendChild(body);
				if (role === 'user') {
					if (runInProgress && runStartedAt !== undefined) {
						const meta = document.createElement('div');
						meta.className = 'messageMeta';
						meta.textContent = formatElapsed(Date.now() - runStartedAt);
						meta.title = 'Prompt running';
						card.appendChild(meta);
						currentPromptClock = meta;
					}
					const actions = document.createElement('div');
					actions.className = 'messageActions';
					const edit = document.createElement('button');
					edit.className = 'messageAction';
					edit.type = 'button';
					edit.title = 'Edit prompt';
					edit.dataset.logAction = 'editPrompt';
					edit.appendChild(icon('edit'));
					const rerun = document.createElement('button');
					rerun.className = 'messageAction';
					rerun.type = 'button';
					rerun.title = 'Queue again';
					rerun.dataset.logAction = 'queuePrompt';
					rerun.appendChild(icon('debug-rerun'));
					actions.append(edit, rerun);
					card.appendChild(actions);
				}
				log.appendChild(card);
				if (role === 'assistant') {
					currentAssistantCard = card;
				}
			scrollConversation();
			return body;
		}
		function appendStatus(text, kind) {
			breakAssistantStream();
			const row = document.createElement('div');
			row.className = 'statusRow ' + (kind || '');
			const marker = document.createElement('span');
			marker.className = 'statusIcon';
			marker.appendChild(icon(kind === 'error' ? 'error' : kind === 'muted' ? 'info' : 'check'));
			const label = document.createElement('span');
			label.textContent = text || '';
			row.append(marker, label);
			log.appendChild(row);
			scrollConversation();
			return row;
		}
		function toolStatusLabel(status) {
			return ({ started: 'Running', finished: 'Finished', failed: 'Failed', denied: 'Denied' })[status] || 'Updated';
		}
		function toolStatusIconName(status) {
			return status === 'failed' || status === 'denied' ? 'error' : status === 'started' ? 'sync' : 'check';
		}
		function toolPrimaryDetail(item) {
			const args = item?.args || {};
			if (typeof args.command === 'string' || typeof args.cmd === 'string') {
				return args.command || args.cmd;
			}
			if (typeof args.path === 'string' || typeof args.file_path === 'string' || typeof args.filePath === 'string') {
				return args.path || args.file_path || args.filePath;
			}
			if (typeof args.pattern === 'string') {
				return args.pattern;
			}
			if (typeof item?.error === 'string') {
				return item.error;
			}
			const output = item?.output;
			return typeof output === 'string' ? output : '';
		}
		function toolDetailsText(item) {
			const parts = [];
			if (item?.args && Object.keys(item.args).length) {
				parts.push('Input\\n' + JSON.stringify(item.args, null, 2));
			}
			if (item?.output !== undefined) {
				parts.push('Output\\n' + (typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2)));
			}
			if (item?.error) {
				parts.push('Error\\n' + String(item.error));
			}
			return parts.join('\\n\\n');
		}
		function clippedToolText(value) {
			const text = String(value || '');
			const max = 12000;
			return text.length > max ? text.slice(0, max) + '\\n\\n[truncated]' : text;
		}
		function toolGroupParts(group) {
			return {
				status: group?.querySelector('.toolGroupStatus'),
				title: group?.querySelector('.toolGroupTitle'),
				meta: group?.querySelector('.toolGroupMeta'),
				toggle: group?.querySelector('.toolGroupToggle')
			};
		}
		function setIcon(element, name) {
			if (!element) {
				return;
			}
			element.textContent = '';
			element.appendChild(icon(name));
		}
		function updateToolGroupSummary(group) {
			if (!(group instanceof HTMLElement)) {
				return;
			}
			const cards = Array.from(group.querySelectorAll('.toolCard'));
			const running = cards.filter(card => card.classList.contains('started')).length;
			const failed = cards.filter(card => card.classList.contains('failed') || card.classList.contains('denied')).length;
			const total = cards.length;
			const parts = toolGroupParts(group);
			group.classList.toggle('running', running > 0);
			group.classList.toggle('failed', failed > 0);
			if (parts.title) {
				parts.title.textContent = running > 0 ? 'Running commands' : failed > 0 ? 'Finished with errors' : 'Finished commands';
			}
			if (parts.meta) {
				const chunks = [total + ' command' + (total === 1 ? '' : 's')];
				if (running > 0) {
					chunks.push(running + ' running');
				}
				if (failed > 0) {
					chunks.push(failed + ' failed');
				}
				parts.meta.textContent = chunks.join(', ');
			}
			setIcon(parts.status, failed > 0 ? 'error' : running > 0 ? 'sync' : 'check');
			setIcon(parts.toggle, group.classList.contains('open') ? 'chevron-up' : 'chevron-down');
		}
		function ensureToolGroup() {
			if (activeToolGroup?.row?.isConnected) {
				return activeToolGroup;
			}
			const row = document.createElement('div');
			row.className = 'toolGroup running';
			const head = document.createElement('button');
			head.className = 'toolGroupHead';
			head.type = 'button';
			head.dataset.toolGroupToggle = 'true';
			head.title = 'Show command list';
			head.setAttribute('aria-label', 'Show command list');
			const status = document.createElement('span');
			status.className = 'toolGroupStatus';
			const main = document.createElement('span');
			main.className = 'toolGroupMain';
			const title = document.createElement('span');
			title.className = 'toolGroupTitle';
			const meta = document.createElement('span');
			meta.className = 'toolGroupMeta';
			const toggle = document.createElement('span');
			toggle.className = 'toolGroupToggle';
			main.append(title, meta);
			head.append(status, main, toggle);
			const body = document.createElement('div');
			body.className = 'toolGroupBody';
			row.append(head, body);
			log.appendChild(row);
			activeToolGroup = { row, body };
			updateToolGroupSummary(row);
			return activeToolGroup;
		}
		function closeActiveToolGroup(finalStatus) {
			for (const item of activeToolRows) {
				if (item?.row instanceof HTMLElement && item.row.classList.contains('started')) {
					item.row.classList.remove('started');
					item.row.classList.add(finalStatus === 'failed' ? 'failed' : 'finished');
					const statusIcon = item.row.querySelector('.toolStatusIcon');
					setIcon(statusIcon, finalStatus === 'failed' ? 'error' : 'check');
					if (item.label) {
						item.label.textContent = (finalStatus === 'failed' ? 'Failed ' : 'Finished ') + item.name;
					}
				}
			}
			if (activeToolGroup?.row) {
				updateToolGroupSummary(activeToolGroup.row);
			}
			activeToolRows = [];
			activeToolGroup = undefined;
		}
		function appendToolOutput(payload) {
			const key = payload?.key;
			const text = typeof payload?.text === 'string' ? payload.text : '';
			if (!key || !text) {
				return;
			}
			const row = log.querySelector('.toolCard[data-tool-key="' + CSS.escape(String(key)) + '"]');
			const details = row?.querySelector('.toolDetails');
			if (!(details instanceof HTMLElement)) {
				return;
			}
			const current = details.textContent === 'No details reported.' ? '' : details.textContent || '';
			details.textContent = clippedToolText(current + text);
			row.classList.add('hasTerminal');
			const meta = row.querySelector('.toolMeta');
			if (meta && text.trim()) {
				meta.textContent = text.trim().split(/\\r?\\n/).pop()?.slice(0, 220) || meta.textContent;
			}
			updateToolGroupSummary(row.closest('.toolGroup'));
			scrollConversation();
		}
		function appendTool(item) {
			breakAssistantStream();
			const status = item?.status || 'updated';
			const name = item?.name || 'tool';
			const key = item?.key || toolKey(item);
			if (status === 'failed' || status === 'denied') {
				console.error('[Backboard tool failure]', {
					status,
					name,
					key,
					args: item?.args,
					error: item?.error,
					output: item?.output
				});
			}
			let existingIndex = -1;
			for (let index = activeToolRows.length - 1; index >= 0; index--) {
				if (activeToolRows[index].key === key) {
					existingIndex = index;
					break;
				}
			}
			if (existingIndex < 0 && status !== 'started') {
				for (let index = activeToolRows.length - 1; index >= 0; index--) {
					if (activeToolRows[index].name === name) {
						existingIndex = index;
						break;
					}
				}
			}
			const existing = existingIndex >= 0 ? activeToolRows[existingIndex] : undefined;
			const row = existing ? existing.row : document.createElement('div');
			const startedAt = existing?.startedAt ?? Date.now();
			const detail = toolPrimaryDetail(item);
			const details = toolDetailsText(item);
			row.className = 'toolCard ' + status;
			row.dataset.toolKey = String(key);
			row.textContent = '';
			const head = document.createElement('div');
			head.className = 'toolHead';
			const statusIcon = document.createElement('span');
			statusIcon.className = 'toolStatusIcon';
			statusIcon.appendChild(icon(toolStatusIconName(status)));
			const main = document.createElement('span');
			main.className = 'toolMain';
			const label = document.createElement('span');
			label.className = 'toolLabel';
			label.textContent = toolStatusLabel(status) + ' ' + name;
			const meta = document.createElement('span');
			meta.className = 'toolMeta';
			meta.textContent = detail || (details ? 'View details' : 'Local Backboard tool');
			main.append(label, meta);
			const duration = document.createElement('span');
			duration.className = 'toolDuration';
			duration.textContent = status === 'started' ? formatElapsed(Date.now() - startedAt) : existing?.duration?.textContent || formatElapsed(Date.now() - startedAt);
			const toggle = document.createElement('button');
			toggle.className = 'toolToggle';
			toggle.type = 'button';
			toggle.dataset.toolToggle = 'true';
			toggle.title = 'Show tool details';
			toggle.setAttribute('aria-label', 'Show tool details');
			toggle.appendChild(icon('chevron-down'));
			head.append(statusIcon, main, duration, toggle);
			const body = document.createElement('pre');
			body.className = 'toolDetails';
			const previousDetails = existing?.row?.querySelector('.toolDetails')?.textContent;
			body.textContent = clippedToolText(details || previousDetails || 'No details reported.');
			row.append(head, body);
			if (existingIndex >= 0) {
				activeToolRows.splice(existingIndex, 1);
			} else {
				ensureToolGroup().body.appendChild(row);
			}
			if (status === 'started') {
				activeToolRows.push({ key, name, row, label, duration, startedAt });
			}
			updateToolGroupSummary(row.closest('.toolGroup'));
			scrollConversation();
		}
		function numberValue(value) {
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
			if (typeof value === 'string' && value.trim() !== '') {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : undefined;
			}
			return undefined;
		}
		function firstNumber(source, names) {
			for (const name of names) {
				const value = numberValue(source?.[name]);
				if (value !== undefined) {
					return value;
				}
			}
			return undefined;
		}
		function firstString(source, names) {
			for (const name of names) {
				const value = source?.[name];
				if (typeof value === 'string' && value.trim()) {
					return value.trim();
				}
			}
			return undefined;
		}
		function formatNumber(value) {
			return value === undefined ? undefined : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
		}
		function formatPercent(value) {
			return value === undefined ? undefined : new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 1 ? 2 : 1 }).format(value) + '%';
		}
		function formatDuration(value, key) {
			if (value === undefined) {
				return undefined;
			}
			const lowerKey = String(key || '').toLowerCase();
			const ms = lowerKey.includes('ms') || lowerKey.includes('millis') ? value : value >= 1000 ? value : value * 1000;
			if (ms < 1000) {
				return Math.round(ms) + ' ms';
			}
			const seconds = ms / 1000;
			if (seconds < 60) {
				return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(seconds) + ' s';
			}
			const minutes = Math.floor(seconds / 60);
			const remainder = Math.round(seconds % 60);
			return minutes + 'm ' + remainder + 's';
		}
		function formatMoney(value) {
			if (value === undefined) {
				return undefined;
			}
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
		}
		function estimateTokenCost(input, output, model) {
			const pair = modelPricePair(model);
			if (!pair) {
				return undefined;
			}
			return ((input ?? 0) * pair[0] + (output ?? 0) * pair[1]) / 1000000;
		}
		function formatTokenSpeed(total, durationValue, durationKey) {
			if (total === undefined || durationValue === undefined) {
				return undefined;
			}
			const lowerKey = String(durationKey || '').toLowerCase();
			const ms = lowerKey.includes('ms') || lowerKey.includes('millis') ? durationValue : durationValue >= 1000 ? durationValue : durationValue * 1000;
			if (!Number.isFinite(ms) || ms <= 0) {
				return undefined;
			}
			const tokensPerSecond = total / (ms / 1000);
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: tokensPerSecond < 10 ? 1 : 0 }).format(tokensPerSecond) + ' tok/s';
		}
		function labelFromKey(key) {
			return String(key || '')
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.replace(/[_-]+/g, ' ')
				.replace(/\b\w/g, character => character.toUpperCase());
		}
		function normalizeUsagePayload(payload) {
			let source = payload;
			if (typeof source === 'string') {
				try {
					source = JSON.parse(source);
				} catch {
					source = { raw: source };
				}
			}
			if (!source || typeof source !== 'object') {
				source = { raw: source };
			}
			const context = source.contextUsage && typeof source.contextUsage === 'object' ? source.contextUsage : {};
			const input = firstNumber(source, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
			const output = firstNumber(source, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
			const total = firstNumber(source, ['totalTokens', 'total_tokens', 'tokens']) ?? ((input ?? 0) + (output ?? 0) || undefined);
			const contextUsed = firstNumber(context, ['used_tokens', 'usedTokens', 'used']);
			const contextLimit = firstNumber(context, ['context_limit', 'contextLimit', 'limit']);
			const summaryTokens = firstNumber(context, ['summary_tokens', 'summaryTokens']);
			const contextPercent = firstNumber(context, ['percent', 'percentage']);
			const computedPercent = contextPercent !== undefined ? contextPercent : contextUsed !== undefined && contextLimit ? contextUsed / contextLimit * 100 : undefined;
			const model = firstString(source, ['model', 'modelName', 'model_name']);
			const timeKey = ['durationMs', 'durationInMillis', 'elapsedMs', 'timeMs', 'totalTimeMs', 'duration', 'elapsed', 'time'].find(key => numberValue(source[key]) !== undefined);
			const spendKey = ['spendage', 'spend', 'cost', 'totalCost', 'total_cost', 'usd', 'amountUsd', 'amount_usd'].find(key => numberValue(source[key]) !== undefined);
			const durationValue = timeKey ? numberValue(source[timeKey]) : undefined;
			const reportedSpend = spendKey ? numberValue(source[spendKey]) : undefined;
			const estimatedSpend = reportedSpend ?? estimateTokenCost(input, output, currentModel());
			const tokenSpeed = formatTokenSpeed(total, durationValue, timeKey);
			const known = new Set(['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'totalTokens', 'total_tokens', 'tokens', 'contextUsage', 'model', 'modelName', 'model_name', timeKey, spendKey].filter(Boolean));
			const metrics = [];
			if (input !== undefined) {
				metrics.push(['Input', formatNumber(input)]);
			}
			if (output !== undefined) {
				metrics.push(['Output', formatNumber(output)]);
			}
			if (total !== undefined) {
				metrics.push(['Total', formatNumber(total)]);
			}
			if (contextUsed !== undefined || contextLimit !== undefined || computedPercent !== undefined) {
				const parts = [];
				if (contextUsed !== undefined && contextLimit !== undefined) {
					parts.push(formatNumber(contextUsed) + ' / ' + formatNumber(contextLimit));
				} else if (contextUsed !== undefined) {
					parts.push(formatNumber(contextUsed));
				}
				if (computedPercent !== undefined) {
					parts.push(formatPercent(computedPercent));
				}
				metrics.push(['Context', parts.join(' · ')]);
			}
			if (summaryTokens !== undefined) {
				metrics.push(['Summary', formatNumber(summaryTokens)]);
			}
			if (model) {
				metrics.push(['Model', model]);
			}
			if (timeKey) {
				metrics.push(['Time', formatDuration(durationValue, timeKey)]);
			}
			if (tokenSpeed) {
				metrics.push(['Speed', tokenSpeed]);
			}
			if (estimatedSpend !== undefined) {
				metrics.push([reportedSpend !== undefined ? 'Cost' : 'Est. Cost', formatMoney(estimatedSpend)]);
			}
			for (const [key, value] of Object.entries(source)) {
				if (known.has(key) || value === undefined || value === null || typeof value === 'object') {
					continue;
				}
				const numeric = numberValue(value);
				metrics.push([labelFromKey(key), numeric !== undefined ? formatNumber(numeric) : String(value)]);
			}
			return {
				percent: Math.max(0, Math.min(100, computedPercent ?? 0)),
				summary: [total !== undefined ? formatNumber(total) + ' tokens' : undefined, estimatedSpend !== undefined ? formatMoney(estimatedSpend) : undefined, tokenSpeed, computedPercent !== undefined ? formatPercent(computedPercent) + ' context' : undefined, model].filter(Boolean).join(' · ') || 'Usage details',
				metrics
			};
		}
		function normalizeBillingSnapshot(payload) {
			const source = payload && typeof payload === 'object' ? payload : {};
			const balance = source.balance && typeof source.balance === 'object' ? source.balance : {};
			const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
			const recent = source.recent && typeof source.recent === 'object' ? source.recent : {};
			const metrics = [];
			const balanceUsd = firstNumber(balance, ['balance_usd', 'balanceUsd', 'balance']);
			const totalSpending = firstNumber(summary, ['total_spending_usd', 'totalSpendingUsd', 'spending']);
			const tokenSpend = firstNumber(summary, ['token_usage_usd', 'tokenUsageUsd']);
			const inputTokens = firstNumber(summary, ['token_input_tokens', 'tokenInputTokens', 'input_tokens']);
			const outputTokens = firstNumber(summary, ['token_output_tokens', 'tokenOutputTokens', 'output_tokens']);
			const reads = firstNumber(summary, ['reads_count', 'readsCount', 'vector_reads']);
			const writes = firstNumber(summary, ['writes_count', 'writesCount']);
			const recentData = Array.isArray(recent.data) ? recent.data : Array.isArray(recent.usage) ? recent.usage : [];
			if (balanceUsd !== undefined) {
				metrics.push(['Balance', formatMoney(balanceUsd)]);
			}
			if (totalSpending !== undefined) {
				metrics.push(['Period Spend', formatMoney(totalSpending)]);
			}
			if (tokenSpend !== undefined) {
				metrics.push(['Token Spend', formatMoney(tokenSpend)]);
			}
			if (inputTokens !== undefined || outputTokens !== undefined) {
				metrics.push(['Tokens', [inputTokens !== undefined ? formatNumber(inputTokens) + ' in' : undefined, outputTokens !== undefined ? formatNumber(outputTokens) + ' out' : undefined].filter(Boolean).join(' / ')]);
			}
			if (reads !== undefined) {
				metrics.push(['Reads', formatNumber(reads)]);
			}
			if (writes !== undefined) {
				metrics.push(['Writes', formatNumber(writes)]);
			}
			if (recentData.length) {
				metrics.push(['Recent Events', formatNumber(recentData.length)]);
			}
			return {
				percent: 0,
				summary: [balanceUsd !== undefined ? 'Balance ' + formatMoney(balanceUsd) : undefined, totalSpending !== undefined ? 'Period ' + formatMoney(totalSpending) : undefined].filter(Boolean).join(' · ') || 'Billing usage',
				metrics
			};
		}
		function appendUsage(payload) {
			const usage = normalizeUsagePayload(payload);
			latestUsage = usage;
			syncComposerButtons();
			if (activePopover === 'usage') {
				renderPopover('usage');
				if (activeAnchor) {
					positionPopover(activeAnchor);
				}
			}
			return undefined;
		}
		function appendFileChange(change) {
			if (!change || !change.path) {
				return;
			}
			breakAssistantStream();
			fileChanges = fileChanges.filter(item => item.path !== change.path).concat(change);
			renderChangeStack();
			saveActiveHistory();
		}
		function createFileChangeCard(change) {
			const card = document.createElement('div');
			card.className = 'fileCard';
			const header = document.createElement('div');
			header.className = 'fileHeader';
			const dot = document.createElement('span');
			dot.className = 'typeDot';
			dot.appendChild(icon('info'));
			const name = document.createElement('div');
			name.className = 'fileName';
			name.textContent = change.path;
			const added = document.createElement('span');
			added.className = 'fileCount add';
			added.textContent = '+' + (change.added || 0);
			const removed = document.createElement('span');
			removed.className = 'fileCount remove';
			removed.textContent = '-' + (change.removed || 0);
			header.append(dot, name, added, removed);
			card.appendChild(header);
			for (const line of change.previewLines || []) {
				const row = document.createElement('div');
				row.className = 'diffLine ' + (line.type || 'context');
				row.textContent = (line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ') + (line.text || '');
				card.appendChild(row);
			}
			return card;
		}
		function fileChangeTotals() {
			return fileChanges.reduce((totals, change) => ({
				added: totals.added + (Number(change.added) || 0),
				removed: totals.removed + (Number(change.removed) || 0)
			}), { added: 0, removed: 0 });
		}
		function renderChangeStack() {
			if (!changeStack) {
				return;
			}
			changeStack.textContent = '';
			changeStack.classList.toggle('visible', fileChanges.length > 0);
			if (!fileChanges.length) {
				return;
			}
			const totals = fileChangeTotals();
			const wrap = document.createElement('div');
			wrap.id = 'reviewBlock';
			wrap.className = 'reviewWrap';
			const card = document.createElement('div');
			card.className = 'reviewCard';
			const header = document.createElement('div');
			header.className = 'reviewHeader';
			const dot = document.createElement('span');
			dot.className = 'typeDot';
			dot.appendChild(icon('git-compare'));
			const title = document.createElement('span');
			title.className = 'reviewTitle';
			title.textContent = 'Changed ' + fileChanges.length + ' ' + (fileChanges.length === 1 ? 'file' : 'files') + ', +' + totals.added + ' -' + totals.removed;
			const review = document.createElement('button');
			review.className = 'reviewButton';
			review.type = 'button';
			review.textContent = 'Review';
			review.dataset.logAction = 'reviewChanges';
			header.append(dot, title, review);
			card.appendChild(header);
			wrap.appendChild(card);
			changeStack.appendChild(wrap);
			for (const change of fileChanges) {
				changeStack.appendChild(createFileChangeCard(change));
			}
			changeStack.scrollTop = changeStack.scrollHeight;
		}
		function appendRow(role, text) {
			if (role === 'assistant' || role === 'user') {
				return appendMessage(role, text);
			}
			if (role === 'error') {
				return appendStatus(text, 'error');
			}
			return appendStatus(text, role === 'tool' ? undefined : 'muted');
		}
		function appendDelta(role, text) {
			if (role !== 'assistant') {
				appendRow(role, text);
				return;
			}
			const activeAssistant = currentAssistantCard && latestTranscriptNode() === currentAssistantCard ? currentAssistantCard : undefined;
			const target = activeAssistant?.querySelector('.messageText') || appendMessage('assistant', '');
			const incoming = text || '';
			const current = target.textContent || '';
			const spacer = current && incoming && /[.:!?)]$/.test(current) && /^[A-Z0-9"'(]/.test(incoming) ? ' ' : '';
			target.textContent += spacer + incoming;
			scrollConversation();
		}
		function renderQuestion(payload) {
			if (!payload || !payload.id) {
				return;
			}
			breakAssistantStream();
			document.getElementById('question-' + payload.id)?.remove();
			const card = document.createElement('div');
			card.id = 'question-' + payload.id;
			card.className = 'questionCard';
			const header = document.createElement('div');
			header.className = 'questionHeader';
			const title = document.createElement('div');
			title.className = 'questionTitle';
			title.textContent = payload.question || 'Backboard needs input.';
			const nav = document.createElement('div');
			nav.className = 'questionNav';
			nav.append(icon('chevron-left'));
			const count = document.createElement('span');
			count.textContent = '1 of 1';
			nav.append(count, icon('chevron-right'));
			const close = document.createElement('button');
			close.className = 'iconButton';
			close.type = 'button';
			close.title = 'Dismiss';
			close.appendChild(icon('close'));
			close.addEventListener('click', () => {
				card.remove();
				vscode.postMessage({ type: 'dismissQuestion', id: payload.id });
			});
			nav.appendChild(close);
			header.append(title, nav);
			card.appendChild(header);
			const options = Array.isArray(payload.options) ? payload.options : [];
			options.forEach((option, index) => {
				const button = document.createElement('button');
				button.className = 'questionOption';
				button.type = 'button';
				const number = document.createElement('span');
				number.className = 'questionNumber';
				number.textContent = String(index + 1);
				const label = document.createElement('span');
				label.textContent = option;
				button.append(number, label);
				button.addEventListener('click', () => {
					card.remove();
					vscode.postMessage({ type: 'questionResponse', id: payload.id, value: option });
				});
				card.appendChild(button);
				card.appendChild(Object.assign(document.createElement('div'), { className: 'questionDivider' }));
			});
			const inputRow = document.createElement('div');
			inputRow.className = 'questionInputRow';
			const number = document.createElement('span');
			number.className = 'questionNumber';
			number.appendChild(icon('edit'));
			const input = document.createElement('input');
			input.className = 'questionInput';
			input.placeholder = 'Enter text here';
			const skip = document.createElement('button');
			skip.className = 'questionSkip';
			skip.type = 'button';
			skip.textContent = 'Skip';
			const sendQuestion = value => {
				card.remove();
				vscode.postMessage({ type: 'questionResponse', id: payload.id, value });
			};
			input.addEventListener('keydown', event => {
				if (event.key === 'Enter') {
					event.preventDefault();
					sendQuestion(input.value || 'No response.');
				}
			});
			skip.addEventListener('click', () => sendQuestion('No response.'));
			inputRow.append(number, input, skip);
			card.appendChild(inputRow);
			log.appendChild(card);
			scrollConversation();
			input.focus();
		}
		function urlsFrom(value) {
			const urls = [];
			const visit = item => {
				if (!item) return;
				if (typeof item === 'string') {
					if (/^(https?:|data:|blob:)/.test(item)) urls.push(item);
				} else if (Array.isArray(item)) {
					item.forEach(visit);
				} else if (typeof item === 'object') {
					Object.values(item).forEach(visit);
				}
			};
			visit(value);
			return urls;
		}
		function renderMedia(role, payload) {
			breakAssistantStream();
			const row = document.createElement('div');
			row.className = 'mediaBlock';
			row.textContent = role === 'voice' ? 'Voice output' : 'Generated media';
			for (const url of urlsFrom(payload)) {
				if (/\\.(png|jpe?g|gif|webp|svg)(\\?|$)/i.test(url) || url.startsWith('data:image/')) {
					const img = document.createElement('img');
					img.src = url;
					row.appendChild(img);
				} else if (/\\.(mp3|wav|ogg|m4a|webm)(\\?|$)/i.test(url) || url.startsWith('data:audio/')) {
					const audio = document.createElement('audio');
					audio.controls = true;
					audio.src = url;
					row.appendChild(audio);
				}
			}
			if (row.childElementCount === 0) {
				row.textContent += '\\n' + JSON.stringify(payload, null, 2).slice(0, 2000);
			}
			log.appendChild(row);
			scrollConversation();
		}
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'clear') {
				clearConversation();
			} else if (message.type === 'runStarted') {
				if (message.chatId && message.chatId !== activeHistoryId) {
					activeHistoryId = message.chatId;
				}
				if (!activeHistoryEntry()) {
					beginHistoryRun(message.prompt || '');
				}
				runInProgress = true;
				stopRequested = false;
				activeToolRows = [];
				activeToolGroup = undefined;
				startRunTimer(Date.now());
				setActiveView('chat');
				appendMessage('user', message.prompt || '');
				syncComposerButtons();
				scrollConversation(true);
			} else if (message.type === 'runFinished') {
				runInProgress = false;
				stopRequested = false;
				stopRunTimer();
				currentAssistantCard = undefined;
				closeActiveToolGroup('finished');
				syncComposerButtons();
				saveActiveHistory('Done');
				renderHistory();
				drainPromptQueue();
			} else if (message.type === 'status') {
				updateStatus(message.text || '');
				if (/cancelled/i.test(message.text || '')) {
					runInProgress = false;
					stopRequested = false;
					stopRunTimer();
					closeActiveToolGroup('finished');
					syncComposerButtons();
					saveActiveHistory('Cancelled');
					renderHistory();
				} else if (/failed/i.test(message.text || '')) {
					runInProgress = false;
					stopRequested = false;
					stopRunTimer();
					closeActiveToolGroup('failed');
					syncComposerButtons();
					saveActiveHistory('Failed');
					renderHistory();
				}
			} else if (message.type === 'settings') {
				const nextWorkspace = typeof message.workspace === 'string' ? message.workspace : currentWorkspace;
				const workspaceChanged = nextWorkspace !== currentWorkspace;
				currentWorkspace = nextWorkspace;
				applySettings(message.settings);
				if (workspaceChanged) {
					detachActiveHistoryIfWorkspaceChanged();
				}
				refreshWorkspaceStatus();
				persistPanelState();
			} else if (message.type === 'panelStateSnapshot') {
				applyPanelStateSnapshot(message.state, false);
			} else if (message.type === 'command') {
				if (typeof message.workspace === 'string' && message.workspace && message.workspace !== currentWorkspace) {
					currentWorkspace = message.workspace;
					detachActiveHistoryIfWorkspaceChanged();
					refreshWorkspaceStatus();
					persistPanelState();
				}
				if (message.command === 'newChat') {
					startNewChat();
				} else if (message.command === 'showHistory') {
					setActiveView('history');
				} else if (message.command === 'showChat') {
					setActiveView('chat');
				} else if (message.command === 'openHistoryEntry' && typeof message.chatId === 'string') {
					restoreHistoryEntry(message.chatId);
					setActiveView('chat');
				}
			} else if (message.type === 'models') {
				models = (message.models || []).filter(isVisibleModel);
				renderModels();
				if (activePopover) {
					renderPopover(activePopover);
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'tools') {
				tools = message.tools || [];
				renderToolCount();
				if (activePopover) {
					renderPopover(activePopover);
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'append') {
				appendRow(message.role, message.text);
			} else if (message.type === 'insertText') {
				insertAtCursor(message.text || '');
			} else if (message.type === 'delta') {
				appendDelta(message.role || 'assistant', message.text);
			} else if (message.type === 'question') {
				renderQuestion(message.payload);
			} else if (message.type === 'fileChange') {
				appendFileChange(message.payload);
			} else if (message.type === 'media' || message.type === 'voice') {
				renderMedia(message.type, message.payload);
			} else if (message.type === 'usage') {
				appendUsage(message.payload);
			} else if (message.type === 'usageSnapshot') {
				accountUsage = normalizeBillingSnapshot(message.payload);
				updateStatus('Usage loaded.');
				syncComposerButtons();
				if (activePopover === 'usage') {
					renderPopover('usage');
					if (activeAnchor) {
						positionPopover(activeAnchor);
					}
				}
			} else if (message.type === 'sessionBinding') {
				updateStatus('Connected to Backboard.');
			} else if (message.type === 'toolRequested') {
				const calls = message.payload || [];
				for (const call of calls) {
					appendTool({ status: 'started', key: toolKey(call), name: toolName(call), args: toolArgs(call) });
				}
			} else if (message.type === 'toolOutput') {
				appendToolOutput(message.payload || {});
			} else if (message.type === 'toolFinished') {
				appendTool(message.payload || {});
			}
		});
		applySettings({});
		renderToolCount();
		renderHistory();
		renderChangeStack();
		renderQueue();
			setActiveView(activeView);
			applyPanelStateSnapshot(persistedState, true);
			if (hasPanelSnapshotContent(persistedState)) {
				persistPanelState();
			}
			syncEmptyState();
			syncRootHeight();
		requestAnimationFrame(() => {
			syncRootHeight();
			requestAnimationFrame(syncRootHeight);
		});
		vscode.postMessage({ type: 'ready' });
		window.setInterval(() => vscode.postMessage({ type: 'syncPanelState' }), 2000);
	</script>
</body>
</html>`;
}

class BackboardBridge implements vscode.Disposable {
	private static readonly modelCacheTtl = 24 * 60 * 60 * 1000;
	private static readonly modelCacheVersion = 2;
	private static readonly toolCacheTtl = 24 * 60 * 60 * 1000;
	private static readonly toolCacheVersion = 1;
	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly output = vscode.window.createOutputChannel('Backboard Bridge');
	private pendingModelRefresh: Promise<BridgeModel[]> | undefined;
	private readonly pendingToolRefreshes = new Map<string, Promise<unknown[]>>();

	constructor(private readonly context: vscode.ExtensionContext) {
	}

	dispose(): void {
		this.child?.kill();
		this.output.dispose();
	}

	restart(): void {
		this.pendingModelRefresh = undefined;
		if (!this.child || this.child.killed) {
			this.pending.clear();
			return;
		}
		this.output.appendLine(`[${new Date().toISOString()}] Restarting Backboard bridge after credential change`);
		this.child.kill();
	}

	refreshModels(): void {
		void this.listModels(new vscode.CancellationTokenSource().token, true);
	}

	async cachedModels(): Promise<BridgeModel[] | undefined> {
		const entry = await this.readModelCache();
		return entry?.models;
	}

	async cachedTools(mode: string): Promise<unknown[] | undefined> {
		const entry = await this.readToolCache(mode);
		return entry?.tools;
	}

	async hasFreshPanelMetadata(mode: string): Promise<boolean> {
		const [modelCache, toolCache] = await Promise.all([this.readModelCache(), this.readToolCache(mode)]);
		const now = Date.now();
		return Boolean(
			modelCache && now - modelCache.fetchedAt < BackboardBridge.modelCacheTtl
			&& toolCache && now - toolCache.fetchedAt < BackboardBridge.toolCacheTtl
		);
	}

	async listModels(token: vscode.CancellationToken, forceRefresh = false): Promise<BridgeModel[]> {
		const cached = await this.readModelCache();
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.modelCacheTtl) {
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
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.modelCacheVersion || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
				return undefined;
			}
			return { env, version: parsed.version, fetchedAt: parsed.fetchedAt, models: parsed.models.filter(isBridgeModel).filter(isVisibleBridgeModel) };
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
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.toolCacheVersion || parsed.mode !== mode || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tools)) {
				return undefined;
			}
			return { env, version: parsed.version, mode, fetchedAt: parsed.fetchedAt, tools: parsed.tools };
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
		const events = await this.send(command, undefined, { ...params, config: readSettings().config }, undefined, token);
		return events.find(event => event.type === 'apiResponse')?.data;
	}

	async send(command: string, sessionId: string | undefined, params: unknown, onEvent: ((event: BridgeEvent) => void | Promise<void>) | undefined, token: vscode.CancellationToken): Promise<BridgeEvent[]> {
		const requestId = newId();
		const child = this.ensureProcess();
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
			this.write({ requestId: newId(), command: 'cancel', sessionId, params: { requestId } });
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
			child.stdin.write(`${JSON.stringify({ requestId, command, sessionId, params })}\n`);
		}
		return promise;
	}

	private ensureProcess(): cp.ChildProcessWithoutNullStreams {
		if (this.child && !this.child.killed) {
			return this.child;
		}
		const bridgePath = this.resolveBridgePath();
		if (!fs.existsSync(bridgePath)) {
			throw new Error(`Backboard bridge binary not found at ${bridgePath}. Build it with: npm --prefix extensions/backboard run build-bridge`);
		}
		const cwd = workspacePath() ?? os.homedir();
		this.output.appendLine(`[${new Date().toISOString()}] Starting Backboard bridge`);
		this.output.appendLine(`  bridgePath: ${bridgePath}`);
		this.output.appendLine(`  bridgeDirectory: ${path.dirname(bridgePath)}`);
		this.output.appendLine(`  cwd: ${cwd}`);
		this.output.appendLine(`  workspaceRoot: ${workspacePath() ?? '<none>'}`);
		this.output.appendLine(`  configuredWorkspaceRoot: ${configuredWorkspaceRoot() ?? '<none>'}`);
		this.child = cp.spawn(bridgePath, [], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		readline.createInterface({ input: this.child.stdout }).on('line', line => this.handleLine(line));
		this.child.stderr.on('data', chunk => this.output.append(chunk.toString()));
		this.child.on('error', error => {
			this.output.appendLine(`Bridge process error: ${error.message}`);
			for (const pending of this.pending.values()) {
				pending.reject(error);
			}
			this.pending.clear();
			this.child = undefined;
		});
		this.child.on('exit', (code, signal) => {
			this.output.appendLine(`Bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
			for (const pending of this.pending.values()) {
				pending.reject(new Error('Backboard bridge exited.'));
			}
			this.pending.clear();
			this.child = undefined;
		});
		return this.child;
	}

	private resolveBridgePath(): string {
		const configured = vscode.workspace.getConfiguration('backboard').get<string>('bridgePath')?.trim();
		if (configured) {
			return configured;
		}
		const development = this.resolveDevelopmentBridgePath();
		if (development) {
			return development;
		}
		const packaged = path.join(this.context.extensionPath, 'bin', process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge');
		if (fs.existsSync(packaged)) {
			return packaged;
		}
		return path.join(this.context.extensionPath, 'rust', 'target', 'debug', process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge');
	}

	private resolveDevelopmentBridgePath(): string | undefined {
		const binaryName = process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge';
		for (const profile of ['debug', 'release']) {
			const candidate = path.join(this.context.extensionPath, 'rust', 'target', profile, binaryName);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
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
		this.output.appendLine(JSON.stringify(payload, undefined, '\t'));
	}

	private handleLine(line: string): void {
		let event: BridgeEvent;
		try {
			event = JSON.parse(line) as BridgeEvent;
		} catch {
			this.output.appendLine(line);
			return;
		}
		const pending = this.pending.get(event.requestId);
		if (!pending) {
			return;
		}
		pending.resetTimeout();
		pending.events.push(event);
		void pending.onEvent?.(event);
		if (event.type === 'done') {
			this.pending.delete(event.requestId);
			pending.resolve(pending.events);
		}
	}
}

function bridgeInactivityTimeoutMs(command: string): number {
	switch (command) {
		case 'submitToolResult':
			return 120_000;
		case 'sendPrompt':
			return 120_000;
		case 'listModels':
			return 30_000;
		default:
			return 20_000;
	}
}

async function executeToolCalls(bridge: BackboardBridge, toolCalls: unknown[], mode: string, response: ResponseSink, token: vscode.CancellationToken): Promise<unknown[]> {
	const outputs: unknown[] = [];
	for (const rawCall of toolCalls) {
		if (token.isCancellationRequested) {
			break;
		}
		const call = parseToolCall(rawCall);
		const allowed = await approveTool(call.name, call.args, mode);
		if (!allowed) {
			logToolDiagnostic('denied', call);
			response.event?.('toolFinished', { status: 'denied', key: call.id, name: call.name, args: call.args });
			outputs.push(toolOutput(call.id, { success: false, content: 'User denied this tool call.' }));
			continue;
		}
		try {
			logToolDiagnostic('started', call);
			response.event?.('toolFinished', { status: 'started', key: call.id, name: call.name, args: call.args });
			const result = await executeTool(bridge, call.name, call.args, response, token, call.id);
			logToolDiagnostic('finished', call, result);
			response.event?.('toolFinished', { status: 'finished', key: call.id, name: call.name, args: call.args, output: result });
			outputs.push(toolOutput(call.id, { success: true, content: result }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logToolDiagnostic('failed', call, undefined, error);
			response.event?.('toolFinished', { status: 'failed', key: call.id, name: call.name, args: call.args, error: message });
			outputs.push(toolOutput(call.id, { success: false, content: message }));
		}
	}
	return outputs;
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
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
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
			return writeFileTool(args, response);
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

async function writeFileTool(args: Record<string, unknown>, response: ResponseSink): Promise<string> {
	const uri = resolveWorkspaceUri(filePathArg(args));
	const content = stringArg(args, 'content', 'contents', 'new_text', 'newText');
	await vscode.workspace.fs.createDirectory(parentUri(uri));
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
	return ok ? `Wrote ${vscode.workspace.asRelativePath(uri)}` : `Failed to write ${vscode.workspace.asRelativePath(uri)}`;
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

function isReadOnlyTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search', 'web_search', 'web_fetch'].includes(name);
}

function readSettings(): {
	readonly defaultProvider: string;
	readonly defaultModel: string;
	readonly mode: string;
	readonly intensity: string;
	readonly webSearch: string;
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
		webSearch: config.get<string>('webSearch') || 'off',
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
		webSearch: options.webSearch || settings.webSearch,
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
		webSearch: stringValue(raw.webSearch),
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
		['webSearch', options.webSearch],
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
	await webview.postMessage({ type: 'settings', settings: publicSettings(settings), workspace: workspacePath() });
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
					await webview.postMessage({ type: 'status', text: 'Sign in with Backboard SSO to load models.' });
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
	const tokenSource = new vscode.CancellationTokenSource();
	try {
		const [balance, summary, recent] = await Promise.all([
			bridge.callApi('getBillingBalance', {}, tokenSource.token),
			bridge.callApi('getUsageSummary', { query: { range: 'period' } }, tokenSource.token),
			bridge.callApi('getRecentUsage', { query: { page: 1, pageSize: 20 } }, tokenSource.token)
		]);
		await webview.postMessage({ type: 'usageSnapshot', payload: { balance, summary, recent } });
	} catch (error) {
		await webview.postMessage({ type: 'status', text: error instanceof Error ? error.message : String(error) });
	} finally {
		tokenSource.dispose();
	}
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
		webSearch: settings.webSearch,
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
		return undefined;
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
