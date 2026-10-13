/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { BackboardOAuth, backboardConfigResource, readBackboardConfigJson } from '../common/backboardAuth.js';

/**
 * Identity of the signed-in Backboard user, as far as it can be resolved from
 * the stored credentials and the OAuth `userinfo` endpoint. Every field is
 * optional — a signed-in user always has a name, but email and plan are only
 * present when the SSO profile / userinfo response provides them.
 */
export interface IBackboardUserInfo {
	readonly id?: string;
	readonly name?: string;
	readonly email?: string;
	readonly plan?: string;
}

/**
 * Resolves the identity (display name, and — when available — email and plan)
 * of the signed-in Backboard user.
 *
 * Fields are resolved from the credentials stored in `~/.backboard_ide/config.json`
 * (written by the SSO sign-in flow):
 * 1. `name` prefers a cached `oauth.user_name`, then the `id_token` `name` claim,
 *    then the OAuth `userinfo` endpoint.
 * 2. `email` / `plan` come from the `id_token` claims, then `userinfo` when
 *    neither a local name nor email is available.
 *
 * A single `userinfo` request is made (with a one-shot token refresh on 401)
 * only when the local claims cannot identify the account at all. Avoid doing
 * network work just to fill optional metadata such as the plan: this resolver
 * runs while the chat UI is opening, and stale OAuth metadata can otherwise
 * add two failed requests even though a cached name or email is already enough
 * to render the account. Requests go through
 * {@link IRequestService} (main process) because the Backboard endpoints do not
 * allow cross-origin renderer fetches. A newly resolved name is cached back into
 * the config file so later lookups work offline. Returns an empty object when
 * the user is not signed in.
 */
export async function resolveBackboardUserInfo(fileService: IFileService, pathService: IPathService, requestService: IRequestService, logService: ILogService, requireAccountId = false): Promise<IBackboardUserInfo> {
	const configResource = await backboardConfigResource(pathService);
	const config = await readBackboardConfigJson(fileService, configResource);
	const oauth = isRecord(config.oauth) ? config.oauth : undefined;
	if (!oauth) {
		return {};
	}

	const idClaims = claimsFromJwt(stringValue(oauth.id_token));
	let id = idClaims ? stringValue(idClaims.sub) : undefined;
	let name = stringValue(oauth.user_name) ?? (idClaims ? displayNameFromClaims(idClaims) : undefined);
	let email = idClaims ? emailFromClaims(idClaims) : undefined;
	let plan = idClaims ? planFromClaims(idClaims) : undefined;

	if ((requireAccountId && !id) || (!name && !email)) {
		const claims = await userInfoClaims(oauth, fileService, configResource, requestService, logService);
		if (claims) {
			id = id ?? stringValue(claims.sub);
			name = name ?? displayNameFromClaims(claims);
			email = email ?? emailFromClaims(claims);
			plan = plan ?? planFromClaims(claims);
		}
	}

	if (name && !stringValue(oauth.user_name)) {
		await patchBackboardConfigOAuth(fileService, configResource, { user_name: name });
	}
	return { ...(id ? { id } : {}), name, email, plan };
}

async function userInfoClaims(oauth: Record<string, unknown>, fileService: IFileService, configResource: URI, requestService: IRequestService, logService: ILogService): Promise<Record<string, unknown> | undefined> {
	const accessToken = stringValue(oauth.access_token);
	if (!accessToken) {
		return undefined;
	}

	const result = await requestUserInfo(accessToken, requestService);
	if (result.claims) {
		return result.claims;
	}

	// The access token has expired; refresh it once and retry.
	const refreshToken = stringValue(oauth.refresh_token);
	if (result.status !== 401 || !refreshToken) {
		logService.info(`[Backboard] userinfo lookup failed with status ${result.status}; not refreshing (refresh token available: ${Boolean(refreshToken)}).`);
		return undefined;
	}
	const refreshed = await refreshBackboardOAuthCredentials(fileService, configResource, requestService, logService, accessToken);
	if (!refreshed) {
		return undefined;
	}
	return (await requestUserInfo(refreshed, requestService)).claims;
}

const credentialRefreshes = new Map<string, Promise<string | undefined>>();
const credentialRotations = new Map<string, { previous: string; current: string }>();

/** Identify a coordinated rotation so concurrent successful responses remain usable. */
export function isBackboardOAuthRotation(resource: URI, previous: string, current: string | undefined): boolean {
	const rotation = credentialRotations.get(resource.toString());
	return rotation?.previous === previous && rotation.current === current;
}

/** Share token rotation between account metadata and concurrent billing requests. */
export async function refreshBackboardOAuthCredentials(fileService: IFileService, resource: URI, requestService: IRequestService, logService: ILogService, rejectedToken: string): Promise<string | undefined> {
	const key = resource.toString();
	const inFlight = credentialRefreshes.get(key);
	if (inFlight) { return inFlight; }
	const refresh = (async () => {
		const config = await readBackboardConfigJson(fileService, resource);
		const oauth = isRecord(config.oauth) ? config.oauth : {};
		const current = stringValue(oauth.access_token);
		if (current !== rejectedToken) { return current; }
		const refreshToken = stringValue(oauth.refresh_token);
		if (!refreshToken) { return undefined; }
		const tokens = await refreshBackboardAccessToken(refreshToken, requestService, logService);
		if (!tokens) { return undefined; }
		// A sign-in/sign-out that happened during the request wins over this refresh.
		const latest = await readBackboardConfigJson(fileService, resource);
		const latestOAuth = isRecord(latest.oauth) ? latest.oauth : {};
		if (stringValue(latestOAuth.access_token) !== rejectedToken) { return stringValue(latestOAuth.access_token); }
		await fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify({
			...latest, oauth: {
				...latestOAuth,
				access_token: tokens.accessToken, refresh_token: tokens.refreshToken ?? refreshToken,
				expires_in: tokens.expiresIn, obtained_at: new Date().toISOString(),
			}
		}, undefined, '\t')}\n`));
		credentialRotations.set(key, { previous: rejectedToken, current: tokens.accessToken });
		return tokens.accessToken;
	})();
	credentialRefreshes.set(key, refresh);
	try { return await refresh; } finally { credentialRefreshes.delete(key); }
}

async function requestUserInfo(accessToken: string, requestService: IRequestService): Promise<{ readonly status: number | undefined; readonly claims: Record<string, unknown> | undefined }> {
	const context = await requestService.request({
		type: 'GET',
		url: BackboardOAuth.userInfoUrl,
		headers: { 'Authorization': `Bearer ${accessToken}` },
		callSite: 'backboardUserInfo.userInfo',
	}, CancellationToken.None);
	const status = context.res.statusCode;
	if (!status || status < 200 || status >= 300) {
		return { status, claims: undefined };
	}
	return { status, claims: await jsonBody(context.stream) };
}

async function refreshBackboardAccessToken(refreshToken: string, requestService: IRequestService, logService: ILogService): Promise<{ readonly accessToken: string; readonly refreshToken: string | undefined; readonly expiresIn: number | undefined } | undefined> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: BackboardOAuth.clientId,
	});
	const context = await requestService.request({
		type: 'POST',
		url: BackboardOAuth.tokenUrl,
		data: body.toString(),
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		timeout: 15000,
		callSite: 'backboardUserInfo.refreshToken',
	}, CancellationToken.None);
	const status = context.res.statusCode;
	if (!status || status < 200 || status >= 300) {
		logService.info(`[Backboard] Access token refresh failed with status ${status}.`);
		return undefined;
	}
	const tokens = await jsonBody(context.stream);
	const accessToken = tokens ? stringValue(tokens.access_token) : undefined;
	if (!tokens || !accessToken) {
		logService.info('[Backboard] Access token refresh response did not include an access token.');
		return undefined;
	}
	return {
		accessToken,
		refreshToken: stringValue(tokens.refresh_token),
		expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
	};
}

async function jsonBody(stream: Parameters<typeof streamToBuffer>[0]): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse((await streamToBuffer(stream)).toString());
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function claimsFromJwt(jwt: string | undefined): Record<string, unknown> | undefined {
	const payloadSegment = jwt?.split('.')[1];
	if (!payloadSegment) {
		return undefined;
	}
	try {
		const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
		const claims: unknown = JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)));
		return isRecord(claims) ? claims : undefined;
	} catch {
		return undefined;
	}
}

function displayNameFromClaims(claims: Record<string, unknown>): string | undefined {
	const name = stringValue(claims.name);
	if (name) {
		return name;
	}
	const composed = [stringValue(claims.given_name), stringValue(claims.family_name)].filter(Boolean).join(' ');
	return composed || undefined;
}

function emailFromClaims(claims: Record<string, unknown>): string | undefined {
	return stringValue(claims.email);
}

/**
 * Best-effort plan/tier extraction. The Backboard SSO profile has no single
 * canonical field, so probe the common OIDC/entitlement claim names and use the
 * first string value found (title-cased, e.g. "pro" → "Pro").
 */
function planFromClaims(claims: Record<string, unknown>): string | undefined {
	for (const key of ['plan', 'tier', 'subscription_tier', 'subscription', 'entitlement', 'product', 'account_type']) {
		const value = stringValue(claims[key]);
		if (value) {
			return value.charAt(0).toUpperCase() + value.slice(1);
		}
	}
	return undefined;
}

async function patchBackboardConfigOAuth(fileService: IFileService, configResource: URI, patch: Record<string, unknown>): Promise<void> {
	const config = await readBackboardConfigJson(fileService, configResource);
	const oauth = isRecord(config.oauth) ? config.oauth : {};
	const updated = { ...config, oauth: { ...oauth, ...patch } };
	await fileService.writeFile(configResource, VSBuffer.fromString(`${JSON.stringify(updated, undefined, '\t')}\n`));
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value);
}
