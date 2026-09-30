import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../../config/backboardConfig.ts";
import { backboardOAuthCompleteUrl } from "../../core/auth/BackboardOAuthComplete.ts";
import { openDefaultBrowser } from "../../core/oauth/LoopbackOAuth.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { ensureDir, renameOverPreservingDestination } from "../../utils/fs.ts";

const AUTH_ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
// Public OAuth client id used by the open-source Codex ChatGPT login flow.
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_SCOPE =
	"openid profile email offline_access api.connectors.read api.connectors.invoke";
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const CALLBACK_PORTS = [1455, 1457] as const;

type JsonObject = Record<string, unknown>;

export interface CodexSubscriptionCredentials {
	accessToken: string;
	accountId: string;
	expiresAt?: number;
}

interface SubscriptionTokenSet {
	accessToken: string;
	accountId: string;
	idToken?: string;
	refreshToken?: string;
}

export interface SubscriptionAuthManagerOptions {
	authFile?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface SubscriptionLoginOptions {
	authFile?: string;
	homeDir?: string;
	fetchImpl?: typeof fetch;
	openBrowser?: (url: string) => Promise<void>;
	onAuthUrl?: (url: string) => void;
}

export function defaultSubscriptionAuthFile(homeDir = homedir()): string {
	return join(homeDir, ".backboard", "chatgpt-auth.json");
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
	object: JsonObject,
	key: string,
	context: string,
): string {
	const value = object[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`${context} is missing ${key}.`);
	}
	return value;
}

function parseJwtPayload(token: string): JsonObject | null {
	const encoded = token.split(".")[1];
	if (!encoded) return null;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function jwtExpiration(token: string): number | undefined {
	const exp = parseJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp)
		? exp * 1_000
		: undefined;
}

function accountIdFromToken(token: string): string | undefined {
	const claims = parseJwtPayload(token);
	if (!claims) return undefined;
	for (const key of ["chatgpt_account_id", "account_id"]) {
		const value = claims[key];
		if (typeof value === "string" && value) return value;
	}
	for (const value of Object.values(claims)) {
		if (!isObject(value)) continue;
		for (const key of ["chatgpt_account_id", "account_id"]) {
			const accountId = value[key];
			if (typeof accountId === "string" && accountId) return accountId;
		}
	}
	return undefined;
}

async function readAuthFile(authFile: string): Promise<JsonObject> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(authFile, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read ChatGPT subscription login at ${authFile}. Run "backboard subscription login" first.`,
			{ cause: error },
		);
	}
	if (!isObject(parsed) || !isObject(parsed.tokens)) {
		throw new Error(
			`ChatGPT subscription login at ${authFile} does not contain subscription tokens.`,
		);
	}
	return parsed;
}

function tokensFromAuth(auth: JsonObject): SubscriptionTokenSet {
	const tokens = auth.tokens as JsonObject;
	const accessToken = requiredString(tokens, "access_token", "ChatGPT login");
	const accountId =
		(typeof tokens.account_id === "string" && tokens.account_id) ||
		accountIdFromToken(accessToken) ||
		(typeof tokens.id_token === "string"
			? accountIdFromToken(tokens.id_token)
			: undefined);
	if (!accountId) {
		throw new Error("ChatGPT login is missing account_id.");
	}
	return {
		accessToken,
		accountId,
		...(typeof tokens.id_token === "string"
			? { idToken: tokens.id_token }
			: {}),
		...(typeof tokens.refresh_token === "string" && tokens.refresh_token
			? { refreshToken: tokens.refresh_token }
			: {}),
	};
}

export async function loadCodexSubscriptionCredentials(
	authFile = join(
		process.env.CODEX_HOME ?? join(homedir(), ".codex"),
		"auth.json",
	),
): Promise<CodexSubscriptionCredentials> {
	const tokens = tokensFromAuth(await readAuthFile(authFile));
	return {
		accessToken: tokens.accessToken,
		accountId: tokens.accountId,
		...(jwtExpiration(tokens.accessToken) !== undefined
			? { expiresAt: jwtExpiration(tokens.accessToken) }
			: {}),
	};
}

export function buildSubscriptionHeaders(
	credentials: CodexSubscriptionCredentials,
	sessionId: string,
): Headers {
	return new Headers({
		Authorization: `Bearer ${credentials.accessToken}`,
		"ChatGPT-Account-ID": credentials.accountId,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		originator: "backboard_cli_ts",
		version: "3.0.2",
		"session-id": sessionId,
		"thread-id": sessionId,
		"x-client-request-id": sessionId,
	});
}

export class SubscriptionAuthManager {
	private readonly authFile: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private refreshPromise?: Promise<CodexSubscriptionCredentials>;

	constructor(options: SubscriptionAuthManagerOptions = {}) {
		this.authFile =
			options.authFile ??
			join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
	}

	async credentials(
		forceRefresh = false,
	): Promise<CodexSubscriptionCredentials> {
		const credentials = await loadCodexSubscriptionCredentials(this.authFile);
		const shouldRefresh =
			forceRefresh ||
			(credentials.expiresAt !== undefined &&
				credentials.expiresAt <= this.now() + REFRESH_WINDOW_MS);
		if (!shouldRefresh) return credentials;
		this.refreshPromise ??= this.refresh(credentials).finally(() => {
			this.refreshPromise = undefined;
		});
		return await this.refreshPromise;
	}

	private async refresh(
		observed: CodexSubscriptionCredentials,
	): Promise<CodexSubscriptionCredentials> {
		const lease = await acquireFileLease(`${this.authFile}.lock`, {
			label: "ChatGPT subscription credentials",
			timeoutMs: TOKEN_REQUEST_TIMEOUT_MS + 5_000,
			retryMs: 50,
			invalidOwnerStaleMs: 5_000,
		});
		try {
			const auth = await readAuthFile(this.authFile);
			const current = tokensFromAuth(auth);
			// Another process may have rotated this login while we waited for its
			// lease. Reuse that result, including when retrying a rejected token.
			if (current.accessToken !== observed.accessToken) {
				return await loadCodexSubscriptionCredentials(this.authFile);
			}
			if (!current.refreshToken) {
				throw new Error(
					'ChatGPT access token expired and no refresh token is available. Run "backboard subscription login" again.',
				);
			}
			const response = await this.fetchImpl(TOKEN_URL, {
				method: "POST",
				signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: CHATGPT_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: current.refreshToken,
				}),
			});
			if (!response.ok) {
				throw new Error(
					`ChatGPT token refresh failed with HTTP ${response.status}. Run "backboard subscription login" again.`,
				);
			}
			const refreshed: unknown = await response.json();
			if (!isObject(refreshed)) {
				throw new Error("ChatGPT token refresh returned an invalid response.");
			}
			const accessToken = requiredString(
				refreshed,
				"access_token",
				"ChatGPT token refresh",
			);
			const idToken =
				typeof refreshed.id_token === "string"
					? refreshed.id_token
					: current.idToken;
			const refreshToken =
				typeof refreshed.refresh_token === "string" && refreshed.refresh_token
					? refreshed.refresh_token
					: current.refreshToken;
			const tokens = auth.tokens as JsonObject;
			tokens.access_token = accessToken;
			tokens.refresh_token = refreshToken;
			tokens.account_id =
				accountIdFromToken(accessToken) ||
				(idToken ? accountIdFromToken(idToken) : undefined) ||
				current.accountId;
			if (idToken) tokens.id_token = idToken;
			auth.last_refresh = new Date(this.now()).toISOString();
			await writeAuthFile(this.authFile, auth);
			return await loadCodexSubscriptionCredentials(this.authFile);
		} finally {
			await lease.release();
		}
	}
}

export async function loginWithChatGptSubscription(
	options: SubscriptionLoginOptions = {},
): Promise<string> {
	const homeDir = options.homeDir ?? homedir();
	const authFile = options.authFile ?? defaultSubscriptionAuthFile(homeDir);
	const fetchImpl = options.fetchImpl ?? fetch;
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(64).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const callback = await startCallbackServer(state);
	const redirectUri = `http://localhost:${callback.port}/auth/callback`;
	const authUrl = new URL(`${AUTH_ISSUER}/oauth/authorize`);
	for (const [key, value] of Object.entries({
		response_type: "code",
		client_id: CHATGPT_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: AUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: "backboard_cli_ts",
	})) {
		authUrl.searchParams.set(key, value);
	}
	try {
		options.onAuthUrl?.(authUrl.toString());
		await (options.openBrowser ?? openDefaultBrowser)(authUrl.toString()).catch(
			() => undefined,
		);
		const code = await callback.code;
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CHATGPT_CLIENT_ID,
			code_verifier: verifier,
		});
		const response = await fetchImpl(TOKEN_URL, {
			method: "POST",
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!response.ok) {
			throw new Error(
				`ChatGPT token exchange failed with HTTP ${response.status}.`,
			);
		}
		const result: unknown = await response.json();
		if (!isObject(result)) {
			throw new Error("ChatGPT token exchange returned an invalid response.");
		}
		const accessToken = requiredString(
			result,
			"access_token",
			"ChatGPT token exchange",
		);
		const idToken = requiredString(
			result,
			"id_token",
			"ChatGPT token exchange",
		);
		const refreshToken = requiredString(
			result,
			"refresh_token",
			"ChatGPT token exchange",
		);
		const accountId =
			accountIdFromToken(accessToken) || accountIdFromToken(idToken);
		if (!accountId) {
			throw new Error("ChatGPT login did not return an account id.");
		}
		await writeAuthFile(authFile, {
			version: 1,
			auth_mode: "chatgpt",
			managed_by: "backboard",
			tokens: {
				id_token: idToken,
				access_token: accessToken,
				refresh_token: refreshToken,
				account_id: accountId,
			},
			last_refresh: new Date().toISOString(),
		});
		const existingConfig = readBackboardConfig(homeDir);
		const defaultModel = existingConfig.model
			? undefined
			: await firstSubscriptionModel(fetchImpl, {
					accessToken,
					accountId,
				}).catch(() => undefined);
		await saveBackboardConfig(
			{
				...existingConfig,
				chatgptSubscriptionAuthFile: authFile,
				...(defaultModel
					? {
							model: {
								provider: "openai-subscription",
								model: defaultModel,
							},
						}
					: {}),
			},
			homeDir,
		);
		return `Connected ChatGPT subscription. Credentials saved to ${authFile}.`;
	} finally {
		callback.server.close();
	}
}

async function firstSubscriptionModel(
	fetchImpl: typeof fetch,
	credentials: CodexSubscriptionCredentials,
): Promise<string | undefined> {
	const sessionId = randomBytes(16).toString("hex");
	const url = new URL("https://chatgpt.com/backend-api/codex/models");
	url.searchParams.set("client_version", "3.0.2");
	const response = await fetchImpl(url, {
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		headers: buildSubscriptionHeaders(credentials, sessionId),
	});
	if (!response.ok) return undefined;
	const value: unknown = await response.json();
	if (!isObject(value) || !Array.isArray(value.models)) return undefined;
	return value.models
		.filter(isObject)
		.filter((model) => model.visibility !== "hide")
		.sort(
			(left, right) =>
				(typeof left.priority === "number"
					? left.priority
					: Number.MAX_SAFE_INTEGER) -
				(typeof right.priority === "number"
					? right.priority
					: Number.MAX_SAFE_INTEGER),
		)
		.map((model) => model.slug)
		.find((slug): slug is string => typeof slug === "string" && Boolean(slug));
}

export async function logoutChatGptSubscription(
	homeDir = homedir(),
): Promise<string> {
	const config = readBackboardConfig(homeDir);
	const authFile =
		config.chatgptSubscriptionAuthFile ?? defaultSubscriptionAuthFile(homeDir);
	let removed = false;
	try {
		const parsed: unknown = JSON.parse(await readFile(authFile, "utf8"));
		if (isObject(parsed) && parsed.managed_by === "backboard") {
			await rm(authFile, { force: true });
			removed = true;
		}
	} catch (error) {
		if (
			!(error instanceof SyntaxError) &&
			(error as { code?: string }).code !== "ENOENT"
		)
			throw error;
	}
	const { chatgptSubscriptionAuthFile: _removed, ...remaining } = config;
	await saveBackboardConfig(remaining, homeDir);
	return removed
		? `Disconnected ChatGPT subscription and removed ${authFile}.`
		: "Disconnected ChatGPT subscription. The imported credential file was left untouched.";
}

async function writeAuthFile(
	authFile: string,
	value: JsonObject,
): Promise<void> {
	await ensureDir(dirname(authFile), 0o700);
	await chmod(dirname(authFile), 0o700).catch(() => undefined);
	const temporary = `${authFile}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		await chmod(temporary, 0o600).catch(() => undefined);
		await renameOverPreservingDestination(temporary, authFile);
		await chmod(authFile, 0o600).catch(() => undefined);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function startCallbackServer(state: string): Promise<{
	server: Server;
	port: number;
	code: Promise<string>;
}> {
	let resolveCode: (code: string) => void;
	let rejectCode: (error: Error) => void;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	let settled = false;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/auth/callback") {
			response.writeHead(404).end("Not found");
			return;
		}
		const finish = (
			status: number,
			message: string,
			error?: Error,
			completesLogin = true,
		): void => {
			response.writeHead(status, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy":
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
			});
			response.end(oauthCallbackHtml(message));
			if (settled || !completesLogin) return;
			settled = true;
			if (error) rejectCode(error);
			else resolveCode(url.searchParams.get("code") as string);
		};
		if (url.searchParams.get("state") !== state) {
			finish(
				400,
				"Login state did not match.",
				new Error("OAuth state mismatch."),
				false,
			);
			return;
		}
		const remoteError = url.searchParams.get("error");
		if (remoteError) {
			finish(
				400,
				"ChatGPT login was not completed.",
				new Error(`ChatGPT login failed: ${remoteError}.`),
			);
			return;
		}
		if (!url.searchParams.get("code")) {
			finish(
				400,
				"No authorization code was returned.",
				new Error("ChatGPT login returned no authorization code."),
			);
			return;
		}
		// Land on the same page Backboard SSO finishes on. The redirect target
		// is a fixed Backboard URL, so the code never leaves this machine.
		response.writeHead(302, {
			Location: backboardOAuthCompleteUrl(),
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		});
		response.end();
		if (settled) return;
		settled = true;
		resolveCode(url.searchParams.get("code") as string);
	});

	let port: number | undefined;
	for (const candidate of CALLBACK_PORTS) {
		try {
			await listen(server, candidate);
			port = candidate;
			break;
		} catch (error) {
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		}
	}
	if (!port) throw new Error("Could not open the ChatGPT login callback port.");
	const timeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		rejectCode(new Error("Timed out waiting for ChatGPT login."));
		server.close();
	}, LOGIN_TIMEOUT_MS);
	void code.finally(() => clearTimeout(timeout)).catch(() => undefined);
	return { server, port, code };
}

/** Shown only when the login failed; success redirects to Backboard. */
function oauthCallbackHtml(message: string): string {
	const escapedMessage = message
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Backboard sign-in</title>
		<style>
			html { color-scheme: dark; font: 15px -apple-system, BlinkMacSystemFont, sans-serif; }
			body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111214; color: #f5f5f5; }
			main { max-width: 360px; padding: 28px; text-align: center; }
			p { margin: 0; color: #c8c8c8; line-height: 1.5; }
		</style>
	</head>
	<body><main><p>${escapedMessage}</p></main></body>
	</html>`;
}

async function listen(server: Server, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}
