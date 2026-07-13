/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { DynamicAuthenticationProviderTokensChangeEvent, IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IPathService } from '../../../services/path/common/pathService.js';

/**
 * Mirrors OAuth tokens acquired by the workbench for MCP servers into the
 * Backboard CLI's token store (~/.backboard/mcp-oauth/<server>.json), so a
 * server authorized once — e.g. right after installing it from the
 * marketplace — is also authorized for chat sessions, which run on
 * backboard-cli-ts with its own OAuth state.
 *
 * The written file replicates the shape and validation stamp produced by
 * cli-ts/src/core/mcp/oauth.ts (McpOAuthProvider). The helpers at the bottom
 * of this file MUST stay in sync with that implementation.
 */
export class McpBackboardChatAuthBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mcpBackboardChatAuthBridge';

	constructor(
		@IDynamicAuthenticationProviderStorageService private readonly _dynamicAuthStorage: IDynamicAuthenticationProviderStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._dynamicAuthStorage.onDidChangeTokens(e => this._syncTokens(e)));
		this._initialSweep();
	}

	/** Sync tokens that were acquired before this window session started. */
	private async _initialSweep(): Promise<void> {
		try {
			for (const provider of this._dynamicAuthStorage.getInteractedProviders()) {
				const tokens = await this._dynamicAuthStorage.getSessionsForDynamicAuthProvider(provider.providerId, provider.clientId);
				if (tokens?.length) {
					await this._syncTokens({ authProviderId: provider.providerId, clientId: provider.clientId, tokens });
				}
			}
		} catch (err) {
			this._logService.trace('[McpBackboardChatAuthBridge] initial sweep failed:', err);
		}
	}

	private async _syncTokens(e: DynamicAuthenticationProviderTokensChangeEvent): Promise<void> {
		try {
			if (!e.tokens?.length) {
				return;
			}
			const latest = [...e.tokens].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
			const provider = this._dynamicAuthStorage.getInteractedProviders().find(p => p.providerId === e.authProviderId);
			const authServer = provider?.authorizationServer ?? e.authProviderId;
			let authOrigin: string;
			try {
				authOrigin = new URL(authServer).origin;
			} catch {
				return;
			}

			const home = await this._pathService.userHome();
			const configResource = URI.joinPath(home, '.backboard', 'mcp.json');
			let servers: Record<string, { url?: string; disabled?: boolean }> = {};
			try {
				const content = await this._fileService.readFile(configResource);
				const parsed: unknown = JSON.parse(content.value.toString());
				if (parsed && typeof parsed === 'object') {
					servers = (parsed as { mcpServers?: Record<string, { url?: string; disabled?: boolean }> }).mcpServers ?? {};
				}
			} catch {
				return; // no CLI config — nothing to authorize for chat
			}

			for (const [name, config] of Object.entries(servers)) {
				if (!config?.url) {
					continue;
				}
				let serverOrigin: string;
				try {
					serverOrigin = new URL(config.url).origin;
				} catch {
					continue;
				}
				if (serverOrigin !== authOrigin) {
					continue;
				}
				await this._writeChatOAuthState(home, name, e.clientId, latest);
			}
		} catch (err) {
			this._logService.warn('[McpBackboardChatAuthBridge] failed to sync MCP tokens to the Backboard CLI store:', err);
		}
	}

	private async _writeChatOAuthState(home: URI, serverName: string, clientId: string, token: { access_token: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string }): Promise<void> {
		const stateResource = URI.joinPath(home, '.backboard', 'mcp-oauth', `${cliSafeFileName(serverName)}.json`);
		try {
			const existing: unknown = JSON.parse((await this._fileService.readFile(stateResource)).value.toString());
			if (existing && typeof existing === 'object' && (existing as { tokens?: { access_token?: string } }).tokens?.access_token) {
				return; // chat already has its own tokens; don't clobber that refresh chain
			}
		} catch {
			// no existing state — proceed
		}
		const state = {
			clientInformation: { client_id: clientId },
			clientMetadataKey: cliClientMetadataKey(serverName),
			tokens: {
				access_token: token.access_token,
				token_type: token.token_type ?? 'Bearer',
				...(token.expires_in !== undefined ? { expires_in: token.expires_in } : {}),
				...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
				...(token.scope ? { scope: token.scope } : {}),
			},
		};
		await this._fileService.writeFile(stateResource, VSBuffer.fromString(`${JSON.stringify(state, null, 2)}\n`));
		this._logService.info(`[McpBackboardChatAuthBridge] authorized '${serverName}' for Backboard chat sessions.`);
	}
}

// --- helpers replicated from cli-ts/src/core/mcp/oauth.ts — keep in sync ---

const CLI_APP_DISPLAY_NAME = 'Backboard R-CLI';
const CLI_CALLBACK_PORT_BASE = 7810;
const CLI_CALLBACK_PORT_RANGE = 50;
const CLI_CALLBACK_PATH = '/oauth/callback';

function cliHash(value: string): number {
	let result = 0;
	for (const char of value) {
		result = (result * 31 + char.charCodeAt(0)) >>> 0;
	}
	return result;
}

function cliSafeFileName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'server';
}

export function cliClientMetadataKey(serverName: string): string {
	const port = CLI_CALLBACK_PORT_BASE + (cliHash(serverName) % CLI_CALLBACK_PORT_RANGE);
	const redirect = `http://localhost:${port}${CLI_CALLBACK_PATH}`;
	return JSON.stringify({
		client_name: CLI_APP_DISPLAY_NAME,
		redirect_uris: [redirect],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
	});
}
