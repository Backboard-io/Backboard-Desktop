/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';

export const IAgentHostSubscriptionAuthService = createDecorator<IAgentHostSubscriptionAuthService>('agentHostSubscriptionAuthService');

/** Agent providers that support subscription billing in v1. */
export type SubscriptionAuthProvider = 'claude' | 'codex';

/**
 * Detects whether the user is logged in to a provider's own CLI credential
 * store — the prerequisite for subscription-billed sessions — and offers a
 * terminal-based login flow when they are not.
 *
 * Detection is presence-only: this service never reads token values out of
 * the credential files and never forwards them anywhere. The agent CLI/SDK
 * resolves its own credentials at spawn time.
 *
 * v1 scope: local agent host only. The checks read the local user home, so
 * callers must not consult this service for remote agent-host sessions.
 */
export interface IAgentHostSubscriptionAuthService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether the user has a provider login on this machine.
	 * `'unknown'` when detection failed (e.g. unreadable home directory) —
	 * callers should not block the user on an `'unknown'` result.
	 */
	getLoginStatus(provider: SubscriptionAuthProvider): Promise<boolean | 'unknown'>;

	/** Drop cached results so the next {@link getLoginStatus} re-checks disk. */
	refresh(): void;

	/** Open a visible terminal pre-running the provider's login command. */
	openLoginTerminal(provider: SubscriptionAuthProvider): Promise<void>;

	/** The shell command {@link openLoginTerminal} runs, for display in UI. */
	getLoginCommand(provider: SubscriptionAuthProvider): string;
}

const LOGIN_STATUS_TTL_MS = 15_000;

export class AgentHostSubscriptionAuthService implements IAgentHostSubscriptionAuthService {

	declare readonly _serviceBrand: undefined;

	private readonly _cache = new Map<SubscriptionAuthProvider, { readonly value: boolean | 'unknown'; readonly at: number }>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async getLoginStatus(provider: SubscriptionAuthProvider): Promise<boolean | 'unknown'> {
		const cached = this._cache.get(provider);
		if (cached && Date.now() - cached.at < LOGIN_STATUS_TTL_MS) {
			return cached.value;
		}
		let value: boolean | 'unknown';
		try {
			value = provider === 'claude' ? await this._checkClaudeLogin() : await this._checkCodexLogin();
		} catch (err) {
			this._logService.warn(`[AgentHostSubscriptionAuth] login detection failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`);
			value = 'unknown';
		}
		this._cache.set(provider, { value, at: Date.now() });
		return value;
	}

	refresh(): void {
		this._cache.clear();
	}

	getLoginCommand(provider: SubscriptionAuthProvider): string {
		// Claude: `claude setup-token` mints a long-lived OAuth token for the
		// user's Pro/Max subscription and stores it in the CLI credential
		// store, which the Claude Agent SDK picks up. Codex: `codex login`
		// runs the ChatGPT OAuth flow and writes `~/.codex/auth.json`.
		return provider === 'claude' ? 'claude setup-token' : 'codex login';
	}

	async openLoginTerminal(provider: SubscriptionAuthProvider): Promise<void> {
		const terminal = await this._terminalService.createTerminal({
			config: {
				name: provider === 'claude'
					? localize('subscriptionAuth.claudeTerminalName', "Claude Login")
					: localize('subscriptionAuth.codexTerminalName', "Codex Login"),
				isTransient: true,
			},
		});
		await terminal.processReady;
		this._terminalService.setActiveInstance(terminal);
		await this._terminalService.focusInstance(terminal);
		// Login flows are interactive (browser hand-off, paste-back), so just
		// kick the command off and leave the terminal to the user. A fresh
		// login is picked up by the next getLoginStatus() after the TTL, or
		// immediately after refresh().
		await terminal.runCommand(this.getLoginCommand(provider), true);
	}

	private async _userHomePath(relativeSegments: readonly string[]): Promise<URI> {
		const home = await this._pathService.userHome({ preferLocal: true });
		return URI.joinPath(home, ...relativeSegments);
	}

	/**
	 * Claude Code stores subscription credentials in
	 * `~/.claude/.credentials.json` (Linux/Windows) or the macOS Keychain.
	 * In the Keychain case there is no credentials file, but a completed
	 * login always records an `oauthAccount` in `~/.claude.json`.
	 */
	private async _checkClaudeLogin(): Promise<boolean | 'unknown'> {
		if (await this._fileService.exists(await this._userHomePath(['.claude', '.credentials.json']))) {
			return true;
		}
		const claudeJson = await this._userHomePath(['.claude.json']);
		if (!(await this._fileService.exists(claudeJson))) {
			return false;
		}
		try {
			const content = await this._fileService.readFile(claudeJson);
			const parsed: { oauthAccount?: unknown } = JSON.parse(content.value.toString());
			return !!parsed.oauthAccount;
		} catch {
			return 'unknown';
		}
	}

	/** `codex login` writes `~/.codex/auth.json` (ChatGPT tokens or an API key). */
	private async _checkCodexLogin(): Promise<boolean | 'unknown'> {
		const authJson = await this._userHomePath(['.codex', 'auth.json']);
		if (!(await this._fileService.exists(authJson))) {
			return false;
		}
		let content: VSBuffer;
		try {
			content = (await this._fileService.readFile(authJson)).value;
		} catch {
			return 'unknown';
		}
		try {
			const parsed: { tokens?: unknown; OPENAI_API_KEY?: unknown } = JSON.parse(content.toString());
			return !!parsed.tokens || !!parsed.OPENAI_API_KEY;
		} catch {
			return 'unknown';
		}
	}
}

registerSingleton(IAgentHostSubscriptionAuthService, AgentHostSubscriptionAuthService, InstantiationType.Delayed);
