/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatEntitlementContextKeys, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

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

		override async run(accessor: ServicesAccessor): Promise<boolean> {
			return accessor.get(IInstantiationService).createInstance(BackboardSsoFlow).signIn();
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

export class BackboardCredentialsContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardCredentials';

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		if (isBackboardProduct()) {
			this.checkBackboardCredentials().catch(error => this.logService.error(`[Backboard] Failed to check credentials: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	private async checkBackboardCredentials(): Promise<void> {
		const configResource = await backboardConfigResource(this.pathService);
		if (await hasBackboardCredentials(this.fileService, configResource)) {
			markBackboardChatReady(this.chatEntitlementService, this.contextKeyService);
			this.logService.info(`[Backboard] Existing credentials found in ${configResource.fsPath}; chat setup marked ready.`);
		}
	}
}

class BackboardSsoFlow {
	constructor(
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) { }

	async signIn(): Promise<boolean> {
		let callbackServer: { dispose(): void } | undefined;

		try {
			const configResource = await backboardConfigResource(this.pathService);
			if (await hasBackboardCredentials(this.fileService, configResource)) {
				markBackboardChatReady(this.chatEntitlementService, this.contextKeyService);
				this.logService.info(`[Backboard OAuth] Existing credentials found in ${configResource.fsPath}; asking whether to sign in again.`);
				const shouldSignInAgain = await this.confirmSignInAgain(configResource.fsPath);
				if (!shouldSignInAgain) {
					return true;
				}
			}

			const state = randomBase64Url(24);
			const nonce = randomBase64Url(24);
			const codeVerifier = randomBase64Url(32);
			const codeChallenge = await sha256Base64Url(codeVerifier);
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
			const saveResult = await saveBackboardOAuthTokens(tokens, this.configurationService, this.fileService, configResource);
			markBackboardChatReady(this.chatEntitlementService, this.contextKeyService);
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

	private async openAuthorizeUrl(authorizeUrl: string): Promise<void> {
		await this.openerService.open(URI.parse(authorizeUrl), { openExternal: true });
	}

	private async confirmSignInAgain(configPath: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const handle = this.notificationService.prompt(
				Severity.Info,
				localize('backboard.ssoExistingCredentials', "Backboard is already signed in. Credentials are stored at {0}.", configPath),
				[
					{
						label: localize('backboard.ssoSignInAgain', "Sign In Again"),
						run: () => {
							handle.close();
							resolve(true);
						}
					},
					{
						label: localize('backboard.ssoUseExisting', "Use Existing"),
						run: () => {
							handle.close();
							resolve(false);
						}
					}
				],
				{
					sticky: true,
					onCancel: () => resolve(false),
				}
			);
		});
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

async function startBackboardOAuthCallbackServer(redirectUri: string, logService: ILogService): Promise<{ dispose(): void } | undefined> {
	const parsed = new URL(redirectUri);
	if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
		return undefined;
	}
	logService.info(`[Backboard OAuth] Renderer cannot host a localhost callback server for ${redirectUri}; use the clipboard callback action if the browser does not return automatically.`);
	return undefined;
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

async function postForm(urlString: string, body: URLSearchParams, label: string): Promise<string> {
	const response = await fetch(urlString, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`${label} returned HTTP ${response.status}: ${responseText}`);
	}
	return responseText;
}

async function saveBackboardOAuthTokens(tokens: BackboardOAuthTokens, configurationService: IConfigurationService, fileService: IFileService, configResource: URI): Promise<BackboardOAuthSaveResult> {
	const accessToken = stringValueFromRecord(tokens.access_token);
	if (!accessToken) {
		throw new Error('Backboard token response did not include an access token.');
	}
	const directApiKey = stringValueFromRecord(tokens.api_key) ?? stringValueFromRecord(tokens.apiKey);
	const backboardApiKey = stringValueFromRecord(tokens.backboard_api_key);
	const personalApiKey = stringValueFromRecord(tokens.personal_api_key);
	const usableApiKey = directApiKey ?? backboardApiKey ?? personalApiKey;
	const assistantId = stringValueFromRecord(tokens.assistant_id);

	const config = await readBackboardConfigJson(fileService, configResource);
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) || currentBackboardEnv(configurationService));
	const envKeys = backboardConfigEnvKeys(config);
	if (usableApiKey) {
		envKeys[env] = usableApiKey;
	}

	await writeBackboardConfigJson(fileService, configResource, {
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

async function readBackboardConfigJson(fileService: IFileService, configResource: URI): Promise<BackboardConfigJson> {
	try {
		const parsed: unknown = JSON.parse((await fileService.readFile(configResource)).value.toString());
		return isObjectRecord(parsed) ? parsed : {};
	} catch (error) {
		if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

async function writeBackboardConfigJson(fileService: IFileService, configResource: URI, config: BackboardConfigJson): Promise<void> {
	await fileService.createFolder(dirname(configResource));
	await fileService.writeFile(configResource, VSBuffer.fromString(`${JSON.stringify(config, undefined, '\t')}\n`));
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

async function hasBackboardCredentials(fileService: IFileService, configResource: URI): Promise<boolean> {
	const config = await readBackboardConfigJson(fileService, configResource);
	return Boolean(backboardConfigApiKey(config) || backboardConfigAccessToken(config));
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

function markBackboardChatReady(chatEntitlementService: IChatEntitlementService, contextKeyService: IContextKeyService): void {
	chatEntitlementService.markSetupCompleted();
	ChatEntitlementContextKeys.Setup.completed.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Setup.installed.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Setup.hidden.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.disabled.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.disabledInWorkspace.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.untrusted.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.later.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Setup.registered.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.canSignUp.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planFree.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planEdu.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planPro.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planProPlus.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planMax.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planEnterprise.bindTo(contextKeyService).set(false);
	ChatEntitlementContextKeys.Entitlement.planBusiness.bindTo(contextKeyService).set(true);
	ChatEntitlementContextKeys.Entitlement.organisations.bindTo(contextKeyService).set(['backboard']);
	ChatEntitlementContextKeys.Entitlement.sku.bindTo(contextKeyService).set('backboard');
}

function isBackboardProduct(): boolean {
	return product.defaultChatAgent?.provider?.default?.id === 'backboard';
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

async function backboardConfigResource(pathService: IPathService): Promise<URI> {
	return URI.joinPath(await pathService.userHome({ preferLocal: true }), '.backboard_ide', 'config.json');
}

function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	globalThis.crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return bytesToBase64Url(new Uint8Array(hash));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function callbackQueryString(value: string): string {
	try {
		const parsed = new URL(value);
		return parsed.searchParams.toString();
	} catch {
		return value.startsWith('?') ? value.slice(1) : value;
	}
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
