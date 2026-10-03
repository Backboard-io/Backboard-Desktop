/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import product from '../../../../platform/product/common/product.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';

export interface BackboardConfigJson {
	readonly [key: string]: unknown;
	readonly env?: string;
	readonly api_key?: string;
	readonly env_keys?: Record<string, string>;
}

/**
 * Backboard SSO endpoints and client registration shared by the sign-in flow
 * and the user-info lookup. See https://docs.backboard.io/concepts/sso.
 *
 * Sign-in uses the OAuth device authorization grant (RFC 8628) via the
 * built-in Backboard extension. The client id is the first-party PUBLIC
 * device-code client (no secret); token refreshes must use the same client id
 * the tokens were issued to.
 */
export const BackboardOAuth = {
	tokenUrl: 'https://app.backboard.io/api/oauth/token',
	userInfoUrl: 'https://app.backboard.io/api/oauth/userinfo',
	clientId: 'Backboard_oauth_q_cli',
} as const;

/** Opens the "sign in to use this model" popup. Argument: the model's display name (optional). */
export const SHOW_SIGN_IN_PROMPT_COMMAND_ID = 'backboard.showSignInPrompt';

export namespace BackboardAuthContextKeys {
	export const alternativeConfigured = new RawContextKey<boolean>('backboard.alternativeConfigured', false);
	export const enabled = new RawContextKey<boolean>('backboard.authGateEnabled', false, {
		type: 'boolean',
		description: localize('backboard.authGateEnabled', "True when Backboard authentication gates are enabled."),
	});

	export const signedIn = new RawContextKey<boolean>('backboard.signedIn', false, {
		type: 'boolean',
		description: localize('backboard.signedIn', "True when Backboard credentials are available on this machine."),
	});
}

export const BackboardAuthGateContextKeys = new Set([
	BackboardAuthContextKeys.enabled.key,
	BackboardAuthContextKeys.alternativeConfigured.key,
	BackboardAuthContextKeys.signedIn.key,
]);

export function isBackboardProduct(): boolean {
	return product.defaultChatAgent?.provider?.default?.id === 'backboard';
}

export async function backboardConfigResource(pathService: IPathService): Promise<URI> {
	return URI.joinPath(await pathService.userHome({ preferLocal: true }), '.backboard_ide', 'config.json');
}

export async function hasBackboardCredentials(fileService: IFileService, configResource: URI): Promise<boolean> {
	const config = await readBackboardConfigJson(fileService, configResource);
	return Boolean(backboardConfigApiKey(config) || backboardConfigAccessToken(config));
}

export async function readBackboardConfigJson(fileService: IFileService, configResource: URI): Promise<BackboardConfigJson> {
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

export function backboardConfigApiKey(config: BackboardConfigJson): string | undefined {
	const apiKey = stringValueFromRecord(config.api_key);
	if (apiKey) {
		return apiKey;
	}
	const env = normalizeBackboardEnv(config.env);
	return stringValueFromRecord(backboardConfigEnvKeys(config)[env]);
}

/**
 * The device's guest key, minted by the agent host while nobody is signed in.
 * It runs Backboard's free models only, so it never counts as signed in.
 */
export function backboardConfigGuestApiKey(config: BackboardConfigJson): string | undefined {
	const guest = isObjectRecord(config.guest) ? config.guest : undefined;
	return stringValueFromRecord(guest?.api_key);
}

export function backboardConfigAccessToken(config: BackboardConfigJson): string | undefined {
	const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
	return stringValueFromRecord(oauth?.access_token);
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

export function normalizeBackboardEnv(env: string | undefined): string {
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

/**
 * The Backboard REST API base for the configured environment, e.g.
 * `https://app.backboard.io/api`. An explicit URL (setting or config file)
 * wins over the environment default.
 */
export function backboardApiBaseUrl(config: BackboardConfigJson, configuredUrl?: string, configuredEnv?: string): string {
	const explicit = configuredUrl ?? stringValueFromRecord(config.api_url) ?? stringValueFromRecord(config.apiUrl);
	const env = normalizeBackboardEnv(stringValueFromRecord(config.env) ?? configuredEnv);
	const base = explicit ?? (env === 'local' ? 'http://localhost:8000' : env === 'prod' ? 'https://app.backboard.io/api' : 'https://dev.app.backboard.io/api');
	return base.replace(/\/+$/, '');
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Ask the credential-owning runtime without exposing secrets to the workbench. */
export async function hasAlternativeBackboardCredentials(commands: ICommandService): Promise<boolean> {
	try { return await commands.executeCommand<boolean>('backboard.hasAlternativeCredentials') === true; }
	catch { return false; }
}

export const IBackboardAuthService = createDecorator<IBackboardAuthService>('backboardAuthService');

/** The window's single owner of credential context keys. Views only read them. */
export interface IBackboardAuthService {
	readonly _serviceBrand: undefined;
	refresh(): Promise<void>;
}
