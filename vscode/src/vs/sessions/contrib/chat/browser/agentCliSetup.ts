/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';

/** An agent CLI the user can set up with one click from the session-type picker. */
export interface IAgentCliSetupCandidate {
	/** Bare agent-host provider id ('claude' | 'codex' | 'opencode'). */
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Short row description shown in the picker. */
	readonly description: string;
}

interface IAgentCliSetupDefinition extends IAgentCliSetupCandidate {
	/** Single shell line run in the integrated terminal to install + log in. */
	readonly command: string;
	/** Notification shown once the agent is enabled. */
	readonly readyMessage: string;
	/** Binary name to poll for as the install-completion fallback. */
	readonly binaryName: string;
}

/**
 * Subscription-native agents the picker can offer to set up when their
 * provider is not registered. Install goes through npm so the one-liner is
 * identical across platforms; the terminal keeps the whole run visible
 * (including each vendor's own browser-based login).
 */
const SETUP_DEFINITIONS: readonly IAgentCliSetupDefinition[] = [
	{
		id: 'claude',
		label: 'Claude',
		icon: Codicon.claude,
		description: localize('agentSetup.claude.description', "Uses your Claude Pro/Max subscription"),
		command: `npm install -g @anthropic-ai/claude-code && claude setup-token`,
		readyMessage: localize('agentSetup.claude.ready', "Claude is ready — new sessions bill to your Claude subscription."),
		binaryName: 'claude',
	},
	{
		id: 'codex',
		label: 'Codex',
		icon: Codicon.openai,
		description: localize('agentSetup.codex.description', "Uses your ChatGPT subscription"),
		command: `npm install -g @openai/codex && codex login`,
		readyMessage: localize('agentSetup.codex.ready', "Codex is ready — new sessions bill to your ChatGPT plan."),
		binaryName: 'codex',
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		icon: Codicon.circuitBoard,
		description: localize('agentSetup.opencode.description', "Free models included, no account needed"),
		command: `npm install -g opencode-ai`,
		readyMessage: localize('agentSetup.opencode.ready', "OpenCode is ready — free models work now; run 'opencode auth login' in a terminal to add more providers."),
		binaryName: 'opencode',
	},
];

export const IAgentCliSetupService = createDecorator<IAgentCliSetupService>('agentCliSetupService');

/**
 * One-click install for subscription-native agent CLIs. The session-type
 * picker lists {@link getSetupCandidates} for providers the agent host has
 * not registered; {@link beginSetup} opens the integrated terminal with the
 * install command and, once the command finishes (or the user confirms via
 * the fallback notification), restarts the agent host so the new provider
 * registers without an app restart.
 */
export interface IAgentCliSetupService {
	readonly _serviceBrand: undefined;
	getSetupCandidates(registeredTypeIds: ReadonlySet<string>): IAgentCliSetupCandidate[];
	beginSetup(id: string): Promise<void>;
}

const SETUP_POLL_INTERVAL_MS = 3_000;
const SETUP_POLL_TIMEOUT_MS = 15 * 60_000;

export class AgentCliSetupService implements IAgentCliSetupService {

	declare readonly _serviceBrand: undefined;

	/** Ids with a setup run currently in flight — dedupes double-clicks. */
	private readonly _inFlight = new Set<string>();

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IPathService private readonly _pathService: IPathService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) { }

	private async _binaryPresent(dirs: readonly URI[], name: string): Promise<boolean> {
		for (const dir of dirs) {
			try {
				const stat = await this._fileService.stat(dir.with({ path: `${dir.path}/${name}` }));
				if (stat.isFile || stat.isSymbolicLink) {
					return true;
				}
			} catch {
				// keep scanning
			}
		}
		return false;
	}

	getSetupCandidates(registeredTypeIds: ReadonlySet<string>): IAgentCliSetupCandidate[] {
		return SETUP_DEFINITIONS.filter(d => !registeredTypeIds.has(d.id));
	}

	async beginSetup(id: string): Promise<void> {
		const definition = SETUP_DEFINITIONS.find(d => d.id === id);
		if (!definition || this._inFlight.has(id)) {
			return;
		}
		this._inFlight.add(id);
		try {
			await this._runSetup(definition);
		} finally {
			this._inFlight.delete(id);
		}
	}

	private async _runSetup(definition: IAgentCliSetupDefinition): Promise<void> {
		const userHome = await this._pathService.userHome();
		const instance = await this._terminalService.createTerminal({
			config: { cwd: userHome },
		});
		this._terminalService.setActiveInstance(instance);
		await this._terminalService.focusActiveInstance();
		instance.sendText(definition.command, true);

		const store = new DisposableStore();
		let settled = false;
		const finish = async (enable: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			store.dispose();
			handle.close();
			if (!enable) {
				return;
			}
			try {
				await this._agentHostService.restartAgentHost();
				this._notificationService.info(localize('agentSetup.readyWithHint', "{0} If it doesn't appear in the agent picker, restart the IDE.", definition.readyMessage));
			} catch (err) {
				this._logService.error(`[AgentCliSetup] agent host restart failed after ${definition.id} setup`, err);
				this._notificationService.error(localize('agentSetup.restartFailed', "{0} was installed, but agents could not be restarted automatically. Restart the app to finish enabling it.", definition.label));
			}
		};

		// Auto-enable when the install command completes successfully. Shell
		// integration reports the composite line as a single command; ignore
		// unrelated empty/prompt commands.
		const hookCommandDetection = (): boolean => {
			const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
			if (!detection) {
				return false;
			}
			store.add(detection.onCommandFinished(command => {
				const line = command.command?.trim() ?? '';
				if (!line.includes('npm install')) {
					return;
				}
				if (command.exitCode === 0) {
					void finish(true);
				} else {
					this._notificationService.warn(localize('agentSetup.installFailed', "{0} setup exited with code {1} — see the terminal for details.", definition.label, command.exitCode ?? -1));
				}
			}));
			return true;
		};
		if (!hookCommandDetection()) {
			store.add(instance.capabilities.onDidAddCapability(e => {
				if (e.id === TerminalCapability.CommandDetection) {
					hookCommandDetection();
				}
			}));
		}
		// Shell integration is not guaranteed (and its command reporting can
		// miss composite lines) — also poll the well-known install dirs for
		// the binary and enable as soon as it appears. First signal wins.
		const pollDirs = [
			userHome.with({ path: `${userHome.path}/.local/bin` }),
			userHome.with({ path: `${userHome.path}/bin` }),
			URI.file('/opt/homebrew/bin'),
			URI.file('/usr/local/bin'),
		];
		const alreadyPresent = await this._binaryPresent(pollDirs, definition.binaryName);
		const poll = new IntervalTimer();
		store.add(poll);
		const pollDeadline = Date.now() + SETUP_POLL_TIMEOUT_MS;
		poll.cancelAndSet(async () => {
			if (settled || Date.now() > pollDeadline) {
				poll.cancel();
				return;
			}
			// Only auto-enable on a NEW appearance: if the binary already
			// existed when setup began (reinstall flows), rely on command
			// detection or the manual button instead.
			if (!alreadyPresent && await this._binaryPresent(pollDirs, definition.binaryName)) {
				this._logService.info(`[AgentCliSetup] detected ${definition.binaryName} on disk — enabling`);
				void finish(true);
			}
		}, SETUP_POLL_INTERVAL_MS);

		// If the terminal goes away without a detected completion, drop the
		// listeners; the manual notification button remains the fallback.
		store.add(this._terminalService.onDidDisposeInstance(disposed => {
			if (disposed === instance) {
				store.dispose();
			}
		}));

		const handle = this._notificationService.prompt(
			Severity.Info,
			localize('agentSetup.inProgress', "Setting up {0} in the terminal. It is enabled automatically when the install finishes — or click Enable once it's done. If {0} still doesn't appear in the agent picker afterwards, restart the IDE.", definition.label),
			[{
				label: localize('agentSetup.enableNow', "Enable {0}", definition.label),
				run: () => { void finish(true); },
			}],
			{ sticky: true, onCancel: () => { void finish(false); } },
		);
	}
}

registerSingleton(IAgentCliSetupService, AgentCliSetupService, InstantiationType.Delayed);
