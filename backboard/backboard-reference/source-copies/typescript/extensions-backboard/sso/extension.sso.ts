/*
 * Extracted Backboard SSO/OAuth implementation reference.
 * Source: extensions/backboard/src/extension.ts
 * This is not standalone-compilable; it preserves the relevant implementation blocks.
 */

const backboardOAuthAuthorizeUrl = 'https://app.backboard.io/api/oauth/authorize';
const backboardOAuthTokenUrl = 'https://app.backboard.io/api/oauth/token';
const backboardOAuthClientId = 'Backboard_oauth_BGmuDtqCPmPgmIqWZ2ORvdqpl8fdKFQY';
const defaultBackboardOAuthRedirectUri = 'http://127.0.0.1:49321/auth/callback';
const backboardOAuthScope = 'openid email profile';
let backboardToolOutput: vscode.OutputChannel | undefined;
let backboardUpdateInstallInProgress = false;
let pendingBackboardOAuth: BackboardOAuthPending | undefined;

export function activate(context: vscode.ExtensionContext): void {
	backboardToolOutput = vscode.window.createOutputChannel('Backboard Tools');
	const bridge = new BackboardBridge(context);
	const panelProvider = new BackboardPanelProvider(bridge, context);
	context.subscriptions.push(backboardToolOutput);
	context.subscriptions.push(bridge);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.setApiKey', async () => {
		if (await setApiKey()) {
			bridge.restart();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.signIn', () => promptBackboardSso(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.copyOAuthRedirectUri', () => copyBackboardOAuthRedirectUri()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.completeOAuthCallback', () => completeBackboardOAuthCallbackFromInput()));
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: uri => handleBackboardOAuthCallback(uri)
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.refreshModels', () => bridge.refreshModels()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(context, true)));
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
	const choice = await vscode.window.showInformationMessage(
		'Sign in to Backboard Studio.',
		{ modal: true },
		'Continue with SSO'
	);
	if (choice !== 'Continue with SSO') {
		return false;
	}
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
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
	const threadedAnyWorkspace = workspace ? readSharedPanelThreadsState(undefined) : undefined;
	return newerPanelState(scoped, store.latest, threaded, threadedAnyWorkspace);
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
	let fileNames: string[];
	try {
		fileNames = fs.readdirSync(backboardThreadsDir());
	} catch {
		return [];
	}
	const entries: unknown[] = [];
	for (const fileName of fileNames) {
		if (!fileName.endsWith('.json')) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(backboardThreadsDir(), fileName), 'utf8'));
			if (!isObjectRecord(parsed)) {
				continue;
			}
			const thread = parsed as PanelThreadFile;
			if (workspace && thread.workspace && thread.workspace !== workspace) {
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
	const currentIds = new Set<string>();
	for (const entry of entries) {
		if (!isObjectRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
			continue;
		}
		currentIds.add(entry.id);
		const threadPath = path.join(threadsDir, `${safePanelThreadFileName(entry.id)}.json`);
		await writeJsonFileAtomic(threadPath, {
			version: 1,
			source: 'panel',
			workspace: typeof state.currentWorkspace === 'string' ? state.currentWorkspace : undefined,
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
	let fileNames: string[];
	try {
		fileNames = await fs.promises.readdir(backboardThreadsDir());
	} catch {
		return;
	}
	await Promise.all(fileNames.map(async fileName => {
		if (!fileName.endsWith('.json')) {
			return;
		}
		const threadPath = path.join(backboardThreadsDir(), fileName);
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(threadPath, 'utf8'));
			if (!isObjectRecord(parsed)) {
				return;
			}
			const entry = isObjectRecord(parsed.entry) ? parsed.entry : undefined;
			const entryId = typeof entry?.id === 'string' ? entry.id : undefined;
			if (parsed.source === 'panel' && parsed.workspace === workspace && entryId && !currentIds.has(entryId)) {
				await fs.promises.unlink(threadPath);
			}
		} catch {
			// Leave unreadable files alone; they may be from a newer format.
		}
	}));
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
