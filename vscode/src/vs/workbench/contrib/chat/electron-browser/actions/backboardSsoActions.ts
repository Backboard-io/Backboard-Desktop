/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';

const backboardOAuthAuthorizeUrl = 'https://app.backboard.io/api/oauth/authorize';
const backboardOAuthTokenUrl = 'https://app.backboard.io/api/oauth/token';
const backboardOAuthClientId = 'Backboard_oauth_BGmuDtqCPmPgmIqWZ2ORvdqpl8fdKFQY';
const defaultBackboardOAuthRedirectUri = 'http://127.0.0.1:49321/auth/callback';
const backboardOAuthScope = 'openid email profile';
const backboardCategory = localize2('backboard.category', "Backboard");

interface BackboardOAuthPending {
	readonly state: string;
	readonly resolve: (code: string) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

interface BackboardOAuthTokens {
	readonly api_key?: string | null;
	readonly apiKey?: string | null;
	readonly backboard_api_key?: string | null;
	readonly personal_api_key?: string | null;
	readonly access_token?: string | null;
	readonly refresh_token?: string | null;
	readonly token_type?: string | null;
	readonly expires_in?: number | null;
	readonly scope?: string | null;
	readonly id_token?: string | null;
	readonly assistant_id?: string | null;
	readonly selected_client_name?: string | null;
}

interface BackboardOAuthSaveResult {
	readonly apiKeySaved: boolean;
	readonly assistantId?: string;
}

interface BackboardConfigJson {
	readonly [key: string]: unknown;
	readonly env?: string;
	readonly api_key?: string;
	readonly env_keys?: Record<string, string>;
}

let pendingBackboardOAuth: BackboardOAuthPending | undefined;

export function registerBackboardSsoActions(): void {
	registerAction2(class BackboardSignInAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.signIn',
				title: localize2('backboard.signIn', "Backboard: Sign In"),
				category: backboardCategory,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IInstantiationService).createInstance(BackboardSsoFlow).signIn();
		}
	});

	registerAction2(class BackboardCopyOAuthRedirectUriAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.copyOAuthRedirectUri',
				title: localize2('backboard.copyOAuthRedirectUri', "Backboard: Copy OAuth Redirect URI"),
				category: backboardCategory,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IInstantiationService).createInstance(BackboardSsoFlow).copyRedirectUri();
		}
	});

	registerAction2(class BackboardCompleteOAuthCallbackAction extends Action2 {
		constructor() {
			super({
				id: 'backboard.completeOAuthCallback',
				title: localize2('backboard.completeOAuthCallback', "Backboard: Complete OAuth Callback from Clipboard"),
				category: backboardCategory,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IInstantiationService).createInstance(BackboardSsoFlow).completeCallbackFromClipboard();
		}
	});
}

class BackboardSsoFlow {
	constructor(
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) { }

	async signIn(): Promise<boolean> {
		const state = crypto.randomBytes(24).toString('base64url');
		const nonce = crypto.randomBytes(24).toString('base64url');
		const codeVerifier = crypto.randomBytes(32).toString('base64url');
		const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
		let callbackServer: { dispose(): void } | undefined;

		try {
			const redirectUri = this.backboardOAuthCallbackUri();
			this.logService.info(`[Backboard OAuth] Redirect URI: ${redirectUri}`);
			callbackServer = await startBackboardOAuthCallbackServer(redirectUri, this.logService);
			const codePromise = waitForBackboardOAuthCode(state);
			const params = new URLSearchParams({
				client_id: backboardOAuthClientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: backboardOAuthScope,
				state,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
				nonce,
			});
			const authorizeUrl = `${backboardOAuthAuthorizeUrl}?${params}`;
			this.logService.info(`[Backboard OAuth] Opening authorize URL`);
			await this.openAuthorizeUrl(authorizeUrl);

			const code = await codePromise;
			callbackServer?.dispose();
			callbackServer = undefined;
			const tokens = await exchangeBackboardOAuthCode(code, redirectUri, codeVerifier);
			const saveResult = await saveBackboardOAuthTokens(tokens, this.configurationService);
			this.notificationService.info(saveResult.apiKeySaved
				? localize('backboard.ssoCompleteWithApiKey', "Backboard sign in complete. API key saved for the Rust bridge.")
				: localize('backboard.ssoCompleteAccessTokenOnly', "Backboard sign in complete. Access token saved; the token response did not include an API key."));
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[Backboard OAuth] sign in failed: ${message}`);
			this.notificationService.error(localize('backboard.ssoFailed', "Backboard sign in failed: {0}", message));
			return false;
		} finally {
			callbackServer?.dispose();
		}
	}

	async copyRedirectUri(): Promise<void> {
		const redirectUri = this.backboardOAuthCallbackUri();
		await this.clipboardService.writeText(redirectUri);
		this.notificationService.info(localize('backboard.redirectCopied', "Backboard OAuth redirect URI copied to clipboard."));
	}

	async completeCallbackFromClipboard(): Promise<void> {
		const text = (await this.clipboardService.readText()).trim();
		if (!text) {
			this.notificationService.error(localize('backboard.emptyCallbackClipboard', "Clipboard does not contain a Backboard OAuth callback URL or query string."));
			return;
		}
		const handled = completeBackboardOAuthCallback(callbackQueryString(text), this.logService);
		if (!handled) {
			this.notificationService.error(localize('backboard.callbackNotHandled', "No pending Backboard sign in could use the clipboard callback."));
		}
	}

	private backboardOAuthCallbackUri(): string {
		const configured = this.configurationService.getValue<string>('backboard.oauthRedirectUri');
		return stringValueFromRecord(configured) ?? defaultBackboardOAuthRedirectUri;
	}

	private openAuthorizeUrl(authorizeUrl: string): Promise<void> {
		if (process.platform === 'darwin') {
			return new Promise((resolve, reject) => {
				cp.execFile('/usr/bin/open', [authorizeUrl], error => error ? reject(error) : resolve());
			});
		}
		return this.openerService.open(URI.parse(authorizeUrl), { openExternal: true }).then(() => undefined);
	}
}

function waitForBackboardOAuthCode(state: string): Promise<string> {
	if (pendingBackboardOAuth) {
		clearTimeout(pendingBackboardOAuth.timeout);
		pendingBackboardOAuth.reject(new Error('A new Backboard sign in was started.'));
	}
	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (pendingBackboardOAuth?.state === state) {
				pendingBackboardOAuth = undefined;
				reject(new Error('Backboard sign in timed out waiting for the OAuth callback.'));
			}
		}, 5 * 60 * 1000);
		pendingBackboardOAuth = { state, resolve, reject, timeout };
	});
}

function startBackboardOAuthCallbackServer(redirectUri: string, logService: ILogService): Promise<{ dispose(): void } | undefined> {
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

			const handled = completeBackboardOAuthCallback(requestUrl.searchParams.toString(), logService);
			response.writeHead(handled ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(callbackHtml(handled));
		});
		server.once('error', error => reject(new Error(`Could not start Backboard OAuth callback server on ${redirectUri}: ${error.message}`)));
		server.listen(port, parsed.hostname, () => {
			logService.info(`[Backboard OAuth] Listening for callback on ${redirectUri}`);
			resolve({ dispose: () => server.close() });
		});
	});
}

function completeBackboardOAuthCallback(queryString: string, logService: ILogService): boolean {
	const pending = pendingBackboardOAuth;
	if (!pending) {
		logService.info('[Backboard OAuth] Ignoring callback because no sign in is pending.');
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
		code_verifier: codeVerifier,
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
				'Content-Length': Buffer.byteLength(requestBody),
			},
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

async function saveBackboardOAuthTokens(tokens: BackboardOAuthTokens, configurationService: IConfigurationService): Promise<BackboardOAuthSaveResult> {
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
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv(configurationService));
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
			obtained_at: new Date().toISOString(),
		},
	});
	return { apiKeySaved: Boolean(usableApiKey), assistantId };
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

async function writeBackboardConfigJson(config: BackboardConfigJson): Promise<void> {
	const configPath = backboardConfigPath();
	const configDir = path.dirname(configPath);
	await fs.promises.mkdir(configDir, { recursive: true });
	const tempPath = path.join(configDir, `config.${process.pid}.${Date.now()}.tmp`);
	await fs.promises.writeFile(tempPath, `${JSON.stringify(config, undefined, '\t')}\n`, { mode: 0o600 });
	await fs.promises.rename(tempPath, configPath);
	if (process.platform !== 'win32') {
		await fs.promises.chmod(configPath, 0o600);
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

function currentBackboardEnv(configurationService: IConfigurationService): string {
	return normalizeBackboardEnv(configurationService.getValue<string>('backboard.env'));
}

function normalizeBackboardEnv(env: string | undefined): string {
	switch ((env || 'prod').trim().toLowerCase()) {
		case '':
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (env || 'prod').trim().toLowerCase();
	}
}

function backboardConfigPath(): string {
	return path.join(os.homedir(), '.backboard_ide', 'config.json');
}

function callbackQueryString(value: string): string {
	try {
		const parsed = new URL(value);
		return parsed.searchParams.toString();
	} catch {
		return value.startsWith('?') ? value.slice(1) : value;
	}
}

function callbackHtml(handled: boolean): string {
	const title = handled ? 'Backboard sign in complete' : 'Backboard sign in could not be completed';
	const message = handled ? 'You can return to the editor. This tab may close automatically.' : 'Return to the editor and start Backboard sign in again.';
	const color = handled ? '#1677ff' : '#dc2626';
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #101828; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(520px, calc(100% - 48px)); padding: 32px; border: 1px solid #d8dee8; border-radius: 8px; background: white; box-shadow: 0 16px 48px rgba(15, 23, 42, 0.12); }
h1 { margin: 0 0 12px; color: ${color}; font-size: 26px; line-height: 1.2; letter-spacing: 0; }
p { margin: 0; color: #5f6b7a; font-size: 16px; line-height: 1.5; }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main>${handled ? '<script>window.setTimeout(() => window.close(), 1200);</script>' : ''}</body>
</html>`;
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
	return isObjectRecord(error) && error.code === 'ENOENT';
}
