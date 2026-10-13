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
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
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
import { OPEN_API_KEYS_COMMAND_ID } from '../byokKeys/byokKeys.js';

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
/** Opens the API Keys page; offered from the picker's vendor sections. */
export const BYOK_KEYS_SETUP_ID = 'backboard.apiKeys';

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
/** Printed by the hidden shell with the command's status, so the shell itself always exits 0. */
const EXIT_MARKER = '__BACKBOARD_EXIT__';
const EXIT_MARKER_RE = new RegExp(`${EXIT_MARKER}(\\d+)__`);
/** The user dismissed the sign-in code box. */
const SIGN_IN_CANCELLED_EXIT_CODE = 130;
const REGISTRATION_TIMEOUT_MS = 10_000;

/** Official Claude Code login with a fallback for its native user install. */
export function claudeSubscriptionLoginShellCommand(windows = isWindows, executable?: string): string {
	if (executable && !windows) {
		return `'${executable.replace(/'/g, `'\\''`)}' auth login --claudeai`;
	}
	if (windows) {
		return '$claude = Get-Command claude -ErrorAction SilentlyContinue; if ($claude) { & $claude.Source auth login --claudeai } elseif (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe") { & "$env:USERPROFILE\\.local\\bin\\claude.exe" auth login --claudeai } elseif (Test-Path "$env:USERPROFILE\\.local\\bin\\claude.cmd") { & "$env:USERPROFILE\\.local\\bin\\claude.cmd" auth login --claudeai } else { Write-Error "Claude Code is not installed or was not found on PATH"; exit 127 }';
	}
	return 'if command -v claude >/dev/null 2>&1; then claude auth login --claudeai; elif [ -x "$HOME/.local/bin/claude" ]; then "$HOME/.local/bin/claude" auth login --claudeai; else echo "Claude Code is not installed or was not found on PATH" >&2; exit 127; fi';
}

/** Installed Claude Code next to the stable release; see the agent host's `claudeSubscription.version`. */
export interface IClaudeCodeVersion {
	readonly installed: string;
	readonly latest: string;
	readonly updateAvailable: boolean;
}

export const CHECK_CLAUDE_CODE_VERSION_COMMAND_ID = 'backboard.claudeCode.checkVersion';
export const UPDATE_CLAUDE_CODE_COMMAND_ID = 'backboard.claudeCode.update';

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
	/**
	 * Runs a setup flow. `confirmed` skips the confirm dialog when the caller's
	 * own UI already said what connecting does (the inline Connect rows).
	 */
	beginSetup(id: string, options?: { readonly confirmed?: boolean }): Promise<void>;
	/** Undefined when Claude Code is missing or the release list is unreachable. */
	checkClaudeCodeVersion(): Promise<IClaudeCodeVersion | undefined>;
	/** Runs `claude update` and re-reads the models; resolves false when it failed (already reported). */
	updateClaudeCode(): Promise<boolean>;
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
		@ICommandService private readonly _commandService: ICommandService,
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

	async beginSetup(id: string, options?: { readonly confirmed?: boolean }): Promise<void> {
		if (id === BYOK_KEYS_SETUP_ID) {
			await this._commandService.executeCommand(OPEN_API_KEYS_COMMAND_ID);
			return;
		}
		if (isWindows) {
			throw new Error(localize('agentSetup.byosDisabled', "BYOS subscriptions are not supported on Windows. Sign in with Backboard or use a provider API key."));
		}
		if (id === CHATGPT_SUBSCRIPTION_SETUP.id) {
			if (this._inFlight.has(id)) {
				return;
			}
			this._inFlight.add(id);
			try {
				await this._runChatGptSubscriptionSetup(options?.confirmed === true);
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
				await this._runClaudeSubscriptionSetup(options?.confirmed === true);
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

	async checkClaudeCodeVersion(): Promise<IClaudeCodeVersion | undefined> {
		if (isWindows) {
			return undefined;
		}
		try {
			const result = await this._agentHostService.executeAgentCommand({ provider: 'backboard', command: 'claudeSubscription.version' });
			return isClaudeCodeVersion(result.data) ? result.data : undefined;
		} catch (err) {
			this._logService.warn('[AgentCliSetup] Claude Code version check failed', err);
			return undefined;
		}
	}

	async updateClaudeCode(): Promise<boolean> {
		try {
			const result = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('agentSetup.claudeCode.updating', "Updating Claude Code…"),
			}, () => this._agentHostService.executeAgentCommand({ provider: 'backboard', command: 'claudeSubscription.update' }));
			this._notificationService.info(result.message);
			return true;
		} catch (err) {
			this._logService.error('[AgentCliSetup] Claude Code update failed', err);
			this._notificationService.error(localize('agentSetup.claudeCode.updateFailed', "Claude Code could not be updated: {0}. Run `claude update` in a terminal, then reopen the model picker.", err instanceof Error ? err.message : String(err)));
			return false;
		}
	}

	private async _runChatGptSubscriptionSetup(preconfirmed: boolean): Promise<void> {
		const { confirmed } = preconfirmed ? { confirmed: true } : await this._dialogService.confirm({
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

	private async _runClaudeSubscriptionSetup(preconfirmed: boolean): Promise<void> {
		const { confirmed } = preconfirmed ? { confirmed: true } : await this._dialogService.confirm({
			message: localize('agentSetup.claudeSubscription.confirmTitle', "Connect Claude subscription?"),
			detail: localize('agentSetup.claudeSubscription.confirmDetail', "Backboard will use your existing Claude Code subscription login, or open Anthropic's sign-in flow if needed."),
			primaryButton: localize('agentSetup.claudeSubscription.connectButton', "Connect"),
		});
		if (!confirmed) {
			return;
		}

		let command = claudeSubscriptionLoginShellCommand();
		const outcome = await this._progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('agentSetup.claudeSubscription.connecting', "Connecting Claude subscription…"),
			sticky: true,
		}, async progress => {
			// Install Claude Code when it is missing and update it when it is
			// outdated: releases without `claude auth` fail the sign-in below
			// with "unknown option '--claudeai'" (exit code 1).
			progress.report({ message: localize('agentSetup.claudeSubscription.preparing', "Checking Claude Code…") });
			const prepared = await this._agentHostService.executeAgentCommand({
				provider: 'backboard',
				command: 'claudeSubscription.prepare',
			});
			const ready = prepared.data as { executable?: unknown; installed?: unknown; updated?: unknown } | undefined;
			if (typeof ready?.executable === 'string') {
				command = claudeSubscriptionLoginShellCommand(isWindows, ready.executable);
			}
			if (ready?.installed === true) {
				progress.report({ message: localize('agentSetup.claudeSubscription.installed', "Claude Code installed. Signing in…") });
			} else if (ready?.updated === true) {
				progress.report({ message: localize('agentSetup.claudeSubscription.updated', "Claude Code updated. Signing in…") });
			}
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
		if (outcome.exitCode === SIGN_IN_CANCELLED_EXIT_CODE) {
			return;
		}
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
			let markedExit: number | undefined;
			let output = '';
			const marked = new Promise<number>(resolve => {
				store.add(instance.onData(chunk => {
					if (markedExit !== undefined) {
						return;
					}
					output = (output + chunk).slice(-4096);
					const match = EXIT_MARKER_RE.exec(output);
					if (match) {
						markedExit = Number(match[1]);
						resolve(markedExit);
					}
				}));
			});
			let cancel: (code: number) => void = () => { };
			const cancelled = new Promise<number>(resolve => { cancel = resolve; });
			if (definition.pasteBackSignIn) {
				this._wireSignInPasteBack(definition, instance, store, () => cancel(SIGN_IN_CANCELLED_EXIT_CODE));
			}
			const exitPromise = Event.toPromise(instance.onExit);
			// The command's status travels in the output and the shell then
			// exits 0: a non-zero shell exit raises the terminal's own
			// "terminal process terminated with exit code" popup even though
			// this terminal is hidden.
			instance.sendText(`${command}; echo "${EXIT_MARKER}$?__"; exit 0`, true);

			return await Promise.race([
				marked,
				cancelled,
				exitPromise.then(code => markedExit ?? (typeof code === 'number' ? code : code === undefined ? 0 : 1)),
				new Promise<number>(resolve => {
					const timer = setTimeout(() => resolve(124), INSTALL_TIMEOUT_MS);
					store.add({ dispose: () => clearTimeout(timer) });
				}),
			]);
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
	private _wireSignInPasteBack(definition: Pick<IAgentCliSetupDefinition, 'label'>, instance: ITerminalInstance, store: DisposableStore, onCancel: () => void): void {
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
			// Disposed with the run, so the box closes by itself when the CLI
			// finishes through its browser callback without a pasted code.
			const input = store.add(this._quickInputService.createInputBox());
			input.title = localize('agentSetup.pasteTitle', "Sign in to {0}", definition.label);
			input.prompt = localize('agentSetup.pastePrompt', "Complete the sign-in in your browser, then paste the code here.");
			input.placeholder = localize('agentSetup.pastePlaceholder', "Paste sign-in code");
			input.ignoreFocusOut = true;
			let accepted = false;
			store.add(input.onDidAccept(() => {
				const code = input.value.trim();
				if (!code) {
					return;
				}
				accepted = true;
				instance.sendText(code, true);
				input.hide();
			}));
			store.add(input.onDidHide(() => {
				if (!accepted && !store.isDisposed) {
					// Cancelled — interrupt the hidden sign-in so the flow ends
					// now instead of hanging until the timeout.
					onCancel();
					instance.sendText('\x03', false);
				}
			}));
			input.show();
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

function isClaudeCodeVersion(value: unknown): value is IClaudeCodeVersion {
	const candidate = value as Partial<IClaudeCodeVersion> | undefined;
	return typeof candidate?.installed === 'string' && typeof candidate.latest === 'string' && typeof candidate.updateAvailable === 'boolean';
}
