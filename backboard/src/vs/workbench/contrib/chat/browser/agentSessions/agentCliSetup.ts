/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import type { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

/** An agent CLI the user can set up with one click from the session-type picker. */
export interface IAgentCliSetupCandidate {
	/** Bare agent-host provider or account-route id. */
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Short row description shown in the picker. */
	readonly description: string;
	/** Action badge shown on the row. Defaults to Install. */
	readonly actionLabel?: string;
}

/** The vendor's Node-less installer command, per shell family. */
interface IInstallCommand {
	/** Installer for POSIX shells (macOS/Linux). */
	readonly posix: string;
	/** Installer for Windows PowerShell; omitted when the vendor ships no Node-less Windows installer. */
	readonly win32?: string;
}

/** A path that differs between POSIX shells and Windows PowerShell. */
interface IShellPath {
	/** Value for POSIX shells (`$HOME`-relative). */
	readonly posix: string;
	/** Value for Windows PowerShell (`$env:USERPROFILE`-relative). */
	readonly win32: string;
}

interface IAgentCliSetupDefinition extends IAgentCliSetupCandidate {
	/**
	 * Node-less installer command per shell family. These use the vendors'
	 * native install scripts (e.g. `curl … | bash`) so no Node/npm is required
	 * on the user's machine.
	 */
	readonly install: IInstallCommand;
	/** Bare sign-in invocation run after install; omitted for account-less CLIs. */
	readonly signIn?: string;
	/**
	 * Directory the installer drops the CLI binary into. Prepended to PATH
	 * before {@link signIn} runs, because the freshly-installed binary is not
	 * yet on the hidden shell's PATH. Required whenever {@link signIn} is set.
	 */
	readonly binDir?: IShellPath;
	/** Dialog detail explaining what Install will do. */
	readonly installDetail: string;
	/** Notification shown once the agent is enabled. */
	readonly readyMessage: string;
	/**
	 * Whether the CLI's sign-in hands the user a code to paste back
	 * (Claude's out-of-band OAuth). When set, the runner watches the hidden
	 * process output for the sign-in URL, opens it in the browser, and
	 * collects the code through a quick input instead of a terminal.
	 */
	readonly pasteBackSignIn?: boolean;
}

/**
 * Subscription-native agents the picker can offer to set up when their
 * provider is not registered. The install runs in a hidden shell — the user
 * only sees the Install dialog, a progress notification, and (for vendors
 * that need it) their browser's sign-in page.
 */
const SETUP_DEFINITIONS: readonly IAgentCliSetupDefinition[] = [];

export const CHATGPT_SUBSCRIPTION_SETUP_ID = 'backboard';
export const CLAUDE_SUBSCRIPTION_SETUP_ID = 'backboard.claudeSubscription';

const CHATGPT_SUBSCRIPTION_SETUP: IAgentCliSetupCandidate = {
	id: CHATGPT_SUBSCRIPTION_SETUP_ID,
	label: localize('agentSetup.chatgptSubscription.label', "ChatGPT Subscription"),
	icon: Codicon.openai,
	description: localize('agentSetup.chatgptSubscription.description', "Connect or reconnect ChatGPT to use subscription models through the Backboard harness."),
	actionLabel: localize('agentSetup.chatgptSubscription.action', "Connect"),
};

const CLAUDE_SUBSCRIPTION_SETUP: IAgentCliSetupCandidate & { readonly pasteBackSignIn: true } = {
	id: CLAUDE_SUBSCRIPTION_SETUP_ID,
	label: localize('agentSetup.claudeSubscription.label', "Claude Subscription"),
	icon: Codicon.sparkle,
	description: localize('agentSetup.claudeSubscription.description', "Connect or reconnect Claude Code to use subscription models through the Backboard harness."),
	actionLabel: localize('agentSetup.claudeSubscription.action', "Connect"),
	pasteBackSignIn: true,
};

/** Matches the vendor OAuth URL in CLI sign-in output. */
const SIGN_IN_URL_RE = /https:\/\/[^\s\x1b]*(?:oauth|authorize)[^\s\x1b]*/i;

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const REGISTRATION_TIMEOUT_MS = 10_000;

/** Official Claude Code login with a fallback for its native user install. */
export function claudeSubscriptionLoginShellCommand(windows = isWindows): string {
	if (windows) {
		return '$claude = Get-Command claude -ErrorAction SilentlyContinue; if ($claude) { & $claude.Source auth login --claudeai } elseif (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe") { & "$env:USERPROFILE\\.local\\bin\\claude.exe" auth login --claudeai } elseif (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.cmd") { & "$env:USERPROFILE\\.local\\bin\\claude.cmd" auth login --claudeai } else { Write-Error "Claude Code is not installed or was not found on PATH"; exit 127 }';
	}
	return 'if command -v claude >/dev/null 2>&1; then claude auth login --claudeai; elif [ -x "$HOME/.local/bin/claude" ]; then "$HOME/.local/bin/claude" auth login --claudeai; else echo "Claude Code is not installed or was not found on PATH" >&2; exit 127; fi';
}

export const IAgentCliSetupService = createDecorator<IAgentCliSetupService>('agentCliSetupService');

/**
 * One-click install for subscription-native agent CLIs. The session-type
 * picker lists {@link getSetupCandidates} for providers the agent host has
 * not registered; {@link beginSetup} runs the whole flow: a confirm dialog
 * with an Install button, a hidden install + vendor sign-in, an automatic
 * agent-host restart, and — only if the agent still hasn't appeared — a
 * simple restart-IDE popup.
 */
export interface IAgentCliSetupService {
	readonly _serviceBrand: undefined;
	getSetupCandidates(registeredTypeIds: ReadonlySet<string>): IAgentCliSetupCandidate[];
	beginSetup(id: string): Promise<void>;
}

export class AgentCliSetupService implements IAgentCliSetupService {

	declare readonly _serviceBrand: undefined;

	/** Ids with a setup run currently in flight — dedupes double-clicks. */
	private readonly _inFlight = new Set<string>();

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IProgressService private readonly _progressService: IProgressService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IHostService private readonly _hostService: IHostService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) { }

	getSetupCandidates(registeredTypeIds: ReadonlySet<string>): IAgentCliSetupCandidate[] {
		if (isWindows) {
			return [];
		}
		// Subscription rows remain available as reconnect actions. Installable
		// agents disappear once registered; on Windows, vendors without a
		// Node-less PowerShell installer are excluded.
		return [
			CHATGPT_SUBSCRIPTION_SETUP,
			CLAUDE_SUBSCRIPTION_SETUP,
			...SETUP_DEFINITIONS.filter(d => !registeredTypeIds.has(d.id) && (!isWindows || d.install.win32 !== undefined)),
		];
	}

	/**
	 * Builds the full shell line for the current platform: the vendor's
	 * Node-less installer, a PATH prepend so the freshly-installed binary is
	 * found, and the sign-in command (when the CLI needs one).
	 */
	private _composeCommand(definition: IAgentCliSetupDefinition): string {
		const install = isWindows ? definition.install.win32 : definition.install.posix;
		if (!install) {
			// Guarded by getSetupCandidates, which hides Windows-unsupported agents.
			throw new Error(`No Node-less installer for ${definition.id} on this platform`);
		}
		if (!definition.signIn || !definition.binDir) {
			return install;
		}
		if (isWindows) {
			return `${install}; $env:PATH = "${definition.binDir.win32};$env:PATH"; ${definition.signIn}`;
		}
		return `${install} && export PATH="${definition.binDir.posix}:$PATH" && ${definition.signIn}`;
	}

	async beginSetup(id: string): Promise<void> {
		if (isWindows) {
			throw new Error(localize('agentSetup.byosDisabled', "BYOS subscriptions are not supported on Windows. Sign in with Backboard or use a provider API key."));
		}
		if (id === CHATGPT_SUBSCRIPTION_SETUP.id) {
			if (this._inFlight.has(id)) {
				return;
			}
			this._inFlight.add(id);
			try {
				await this._runChatGptSubscriptionSetup();
			} catch (err) {
				this._logService.error('[AgentCliSetup] ChatGPT subscription login failed', err);
				this._notificationService.error(localize('agentSetup.chatgptSubscription.failed', "ChatGPT could not be connected: {0}", err instanceof Error ? err.message : String(err)));
			} finally {
				this._inFlight.delete(id);
			}
			return;
		}
		if (id === CLAUDE_SUBSCRIPTION_SETUP.id) {
			if (this._inFlight.has(id)) {
				return;
			}
			this._inFlight.add(id);
			try {
				await this._runClaudeSubscriptionSetup();
			} catch (err) {
				this._logService.error('[AgentCliSetup] Claude subscription login failed', err);
				this._notificationService.error(localize('agentSetup.claudeSubscription.failed', "Claude could not be connected: {0}", err instanceof Error ? err.message : String(err)));
			} finally {
				this._inFlight.delete(id);
			}
			return;
		}
		const definition = SETUP_DEFINITIONS.find(d => d.id === id);
		if (!definition || this._inFlight.has(id)) {
			return;
		}
		this._inFlight.add(id);
		try {
			await this._runSetup(definition);
		} catch (err) {
			this._logService.error(`[AgentCliSetup] ${id} setup failed`, err);
			this._notificationService.error(localize('agentSetup.failed', "{0} could not be installed: {1}", definition.label, err instanceof Error ? err.message : String(err)));
		} finally {
			this._inFlight.delete(id);
		}
	}

	private async _runChatGptSubscriptionSetup(): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSetup.chatgptSubscription.confirmTitle', "Connect ChatGPT subscription?"),
			detail: localize('agentSetup.chatgptSubscription.confirmDetail', "Backboard will open ChatGPT in your browser and store its own renewable login. OpenAI model requests will continue to run through the Backboard CLI harness."),
			primaryButton: localize('agentSetup.chatgptSubscription.connectButton', "Connect"),
		});
		if (!confirmed) {
			return;
		}

		const result = await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('agentSetup.chatgptSubscription.connecting', "Connecting ChatGPT subscription…"),
			sticky: true,
		}, () => this._agentHostService.executeAgentCommand({
			provider: 'backboard',
			command: 'chatgptSubscription.login',
		}));
		this._notificationService.info(result.message);
	}

	private async _runClaudeSubscriptionSetup(): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSetup.claudeSubscription.confirmTitle', "Connect Claude subscription?"),
			detail: localize('agentSetup.claudeSubscription.confirmDetail', "Backboard will use your existing Claude Code subscription login, or open Anthropic's sign-in flow if needed."),
			primaryButton: localize('agentSetup.claudeSubscription.connectButton', "Connect"),
		});
		if (!confirmed) {
			return;
		}

		const command = claudeSubscriptionLoginShellCommand();
		const outcome = await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('agentSetup.claudeSubscription.connecting', "Connecting Claude subscription…"),
			sticky: true,
		}, async () => {
			const status = await this._agentHostService.executeAgentCommand({
				provider: 'backboard',
				command: 'claudeSubscription.check',
			});
			const exitCode = status.requiresSignIn
				? await this._runHidden(CLAUDE_SUBSCRIPTION_SETUP, command)
				: 0;
			if (exitCode !== 0) {
				return { exitCode };
			}
			const result = await this._agentHostService.executeAgentCommand({
				provider: 'backboard',
				command: 'claudeSubscription.enable',
			});
			return { exitCode, result };
		});
		if (outcome.exitCode !== 0) {
			this._notificationService.error(localize('agentSetup.claudeSubscription.exitFailed', "Claude sign-in did not complete (exit code {0}). Try Connect Claude again, or run this in a terminal: {1}", outcome.exitCode, command));
			return;
		}
		if (outcome.result) {
			this._notificationService.info(outcome.result.message);
		}
	}

	private async _runSetup(definition: IAgentCliSetupDefinition): Promise<void> {
		const command = this._composeCommand(definition);

		// 1. Clean confirm dialog — the primary button is the Install button.
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSetup.confirmTitle', "Install {0}?", definition.label),
			detail: definition.installDetail,
			primaryButton: localize('agentSetup.installButton', "Install"),
		});
		if (!confirmed) {
			return;
		}

		// 2. Hidden install + sign-in under a progress notification.
		const exitCode = await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('agentSetup.installing', "Installing {0}…", definition.label),
			sticky: true,
		}, () => this._runHidden(definition, command));

		if (exitCode !== 0) {
			this._notificationService.error(localize('agentSetup.exitFailed', "{0} setup did not complete (exit code {1}). Try again, or install it from a terminal with: {2}", definition.label, exitCode, command));
			return;
		}

		// 3. Silent agent-host restart so the new provider registers.
		try {
			await this._agentHostService.restartAgentHost();
		} catch (err) {
			this._logService.error(`[AgentCliSetup] agent host restart failed after ${definition.id} setup`, err);
		}

		// 4. Verify the provider actually appeared; if not, one simple popup.
		if (await this._waitForRegistration(definition.id)) {
			this._notificationService.info(definition.readyMessage);
			return;
		}
		const { confirmed: restart } = await this._dialogService.confirm({
			message: localize('agentSetup.restartTitle', "{0} is installed", definition.label),
			detail: localize('agentSetup.restartDetail', "Restart Backboard to finish enabling {0}.", definition.label),
			primaryButton: localize('agentSetup.restartButton', "Restart"),
		});
		if (restart) {
			await this._hostService.restart();
		}
	}

	/**
	 * Runs the definition's command in a terminal hidden from the user and
	 * resolves with its exit code. For paste-back sign-ins (Claude), watches
	 * the output for the OAuth URL, opens it in the browser, and forwards
	 * the code the user pastes into a quick input.
	 */
	private async _runHidden(definition: Pick<IAgentCliSetupDefinition, 'label' | 'pasteBackSignIn'>, command: string): Promise<number> {
		const userHome = await this._pathService.userHome();
		const instance = await this._terminalService.createTerminal({
			config: { cwd: userHome, hideFromUser: true },
		});
		const store = new DisposableStore();
		try {
			if (definition.pasteBackSignIn) {
				this._wireSignInPasteBack(definition, instance, store);
			}
			const exitPromise = Event.toPromise(instance.onExit);
			// `exit` after the command so the hidden shell terminates and
			// surfaces the command's status as the terminal exit code.
			instance.sendText(`${command}; exit`, true);

			const exit = await Promise.race([
				exitPromise,
				new Promise<number>(resolve => {
					const timer = setTimeout(() => resolve(124), INSTALL_TIMEOUT_MS);
					store.add({ dispose: () => clearTimeout(timer) });
				}),
			]);
			return typeof exit === 'number' ? exit : exit === undefined ? 0 : 1;
		} finally {
			store.dispose();
			instance.dispose();
		}
	}

	/**
	 * Claude's official `auth login --claudeai` flow prints an OAuth URL and waits for the
	 * user to paste a code back. Surface that as: open the browser to the
	 * URL, then a single quick-input box for the code — no terminal shown.
	 */
	private _wireSignInPasteBack(definition: Pick<IAgentCliSetupDefinition, 'label'>, instance: ITerminalInstance, store: DisposableStore): void {
		let output = '';
		let handled = false;
		store.add(instance.onData(chunk => {
			if (handled) {
				return;
			}
			output += chunk;
			const match = SIGN_IN_URL_RE.exec(output);
			if (!match) {
				return;
			}
			handled = true;
			void this._openerService.open(URI.parse(match[0]));
			void this._quickInputService.input({
				title: localize('agentSetup.pasteTitle', "Sign in to {0}", definition.label),
				prompt: localize('agentSetup.pastePrompt', "Complete the sign-in in your browser, then paste the code here."),
				placeHolder: localize('agentSetup.pastePlaceholder', "Paste sign-in code"),
				ignoreFocusLost: true,
			}).then(code => {
				if (code) {
					instance.sendText(code.trim(), true);
				} else {
					// Cancelled — abort the hidden sign-in so the flow fails
					// fast instead of hanging until the timeout.
					instance.sendText('', false);
				}
			});
		}));
	}

	/** Polls the agent host's root state until the provider registers. */
	private async _waitForRegistration(id: string): Promise<boolean> {
		const isRegistered = () => {
			const state = this._agentHostService.rootState.value;
			return !!state && !(state instanceof Error) && (state as RootState).agents.some(agent => agent.provider === id);
		};
		if (isRegistered()) {
			return true;
		}
		return new Promise<boolean>(resolve => {
			const store = new DisposableStore();
			const timer = setTimeout(() => { store.dispose(); resolve(false); }, REGISTRATION_TIMEOUT_MS);
			store.add({ dispose: () => clearTimeout(timer) });
			store.add(this._agentHostService.rootState.onDidChange(() => {
				if (isRegistered()) {
					store.dispose();
					resolve(true);
				}
			}));
		});
	}
}

registerSingleton(IAgentCliSetupService, AgentCliSetupService, InstantiationType.Delayed);
