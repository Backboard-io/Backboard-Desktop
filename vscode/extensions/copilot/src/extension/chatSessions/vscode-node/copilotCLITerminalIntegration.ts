/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Terminal, TerminalLocation, TerminalOptions, ThemeIcon, Uri, ViewColumn, window } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { deriveCopilotCliOTelEnv } from '../../../platform/otel/common/agentOTelEnv';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../util/common/services';
import { disposableTimeout } from '../../../util/vs/base/common/async';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import * as path from '../../../util/vs/base/common/path';
import { windowsToGitBashPath } from '../../../util/vs/workbench/contrib/terminalContrib/suggest/browser/terminalGitBashHelpers';
import { CopilotCLITerminalLinkProvider, SessionDirResolver } from './copilotCLITerminalLinkProvider';

//@ts-ignore
import powershellScript from './copilotCLIShim.ps1';

const COPILOT_CLI_SHIM_JS = 'copilotCLIShim.js';
const COPILOT_CLI_COMMAND = 'backboard';
export type TerminalOpenLocation = 'panel' | 'editor' | 'editorBeside';

export interface ICopilotCLITerminalIntegration extends Disposable {
	readonly _serviceBrand: undefined;
	openTerminal(name: string, cliArgs?: string[], cwd?: string, location?: TerminalOpenLocation): Promise<Terminal | undefined>;
	/**
	 * Sets the session-state directory used to resolve relative CLI paths.
	 */
	setTerminalSessionDir(terminal: Terminal, sessionDir: Uri): void;
	/**
	 * Sets a resolver used when no session directory is set on a terminal.
	 */
	setSessionDirResolver(resolver: SessionDirResolver): void;
}

export const ICopilotCLITerminalIntegration = createServiceIdentifier<ICopilotCLITerminalIntegration>('ICopilotCLITerminalIntegration');

export class CopilotCLITerminalIntegration extends Disposable implements ICopilotCLITerminalIntegration {
	declare _serviceBrand: undefined;
	private readonly initialization: Promise<void>;
	private shellScriptPath: string | undefined;
	/**
	 * On Windows only: a POSIX shell script (no extension) that Git Bash / MSYS bash
	 * can execute. Used when the user's default shell is `bash.exe`, since bash cannot
	 * run the `copilot.bat` shim.
	 */
	private posixShellScriptPath: string | undefined;
	private powershellScriptPath: string | undefined;
	private readonly _linkProvider: CopilotCLITerminalLinkProvider | undefined;
	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceService workspaceService: IWorkspaceService,
		@IOTelService private readonly _otelService: IOTelService,
	) {
		super();
		if (configurationService.getConfig(ConfigKey.Advanced.CLITerminalLinks)) {
			this._linkProvider = new CopilotCLITerminalLinkProvider(logService, workspaceService);
			this._register(window.registerTerminalLinkProvider(this._linkProvider));
		}
		this.initialization = this.initialize();
	}

	private async initialize(): Promise<void> {
		const globalStorageUri = this.context.globalStorageUri;
		if (!globalStorageUri) {
			// globalStorageUri is not available in extension tests
			return;
		}

		const storageLocation = path.join(globalStorageUri.fsPath, 'copilotCli');
		this.terminalService.contributePath('copilot-cli', storageLocation, { command: COPILOT_CLI_COMMAND }, true);

		await fs.mkdir(storageLocation, { recursive: true });

		if (process.platform === 'win32') {
			this.powershellScriptPath = path.join(storageLocation, `${COPILOT_CLI_COMMAND}.ps1`);
			await fs.writeFile(this.powershellScriptPath, powershellScript);
			const copilotPowershellScript = `@echo off
powershell -ExecutionPolicy Bypass -File "${this.powershellScriptPath}" %*
`;
			this.shellScriptPath = path.join(storageLocation, `${COPILOT_CLI_COMMAND}.bat`);
			await fs.writeFile(this.shellScriptPath, copilotPowershellScript);

			// Also create a POSIX shell script for Git Bash on Windows. Bash cannot
			// execute the .bat shim directly inside a `bash -c` string, and we cannot run
			// the JS shim via Electron-as-node here because Electron on Windows does not
			// support console stdin (see copilotCLIShim.ts header). Instead, delegate to
			// the existing .bat shim, which routes through cmd.exe -> PowerShell where
			// console stdin works correctly.
			const posixBatPath = windowsToGitBashPath(this.shellScriptPath);
			const copilotBashScript = `#!/bin/sh\nexec "${posixBatPath}" "$@"\n`;
			this.posixShellScriptPath = path.join(storageLocation, COPILOT_CLI_COMMAND);
			await fs.writeFile(this.posixShellScriptPath, copilotBashScript);
		} else {
			const copilotShellScript = `#!/bin/sh
unset NODE_OPTIONS
ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${path.join(storageLocation, COPILOT_CLI_SHIM_JS)}" "$@"`;
			await fs.copyFile(path.join(__dirname, COPILOT_CLI_SHIM_JS), path.join(storageLocation, COPILOT_CLI_SHIM_JS));
			this.shellScriptPath = path.join(storageLocation, COPILOT_CLI_COMMAND);
			this.powershellScriptPath = path.join(storageLocation, `copilotCLIShim.ps1`);
			await fs.writeFile(this.shellScriptPath, copilotShellScript);
			await fs.writeFile(this.powershellScriptPath, powershellScript);
			await fs.chmod(this.shellScriptPath, 0o750);
		}

	}

	public setTerminalSessionDir(terminal: Terminal, sessionDir: Uri): void {
		this._linkProvider?.setSessionDir(terminal, sessionDir);
	}

	public setSessionDirResolver(resolver: SessionDirResolver): void {
		this._linkProvider?.setSessionDirResolver(resolver);
	}

	public async openTerminal(name: string, cliArgs: string[] = [], cwd?: string, location: TerminalOpenLocation = 'editor'): Promise<Terminal | undefined> {
		// Capture session type before mutating cliArgs.
		// If cliArgs are provided (e.g. --resume), we are resuming a session; otherwise it's a new session.
		const sessionType = cliArgs.length > 0 ? 'resume' : 'new';

		await this.initialization;

		const options = await getCommonTerminalOptions(name, this._authenticationService, this._otelService, location);
		options.cwd = cwd;

		const terminal = this._register(this.terminalService.createTerminal(options));
		this._linkProvider?.registerTerminal(terminal);
		await this.sendCommandToTerminal(terminal, quoteArgsForShell(COPILOT_CLI_COMMAND, cliArgs));
		this.sendTerminalOpenTelemetry(sessionType, 'default', 'regularTerminal', location);
		return terminal;
	}

	private sendTerminalOpenTelemetry(sessionType: string, shell: string, terminalCreationMethod: string, location: TerminalOpenLocation): void {
		/* __GDPR__
			"copilotcli.terminal.open" : {
				"owner": "DonJayamanne",
				"comment": "Event sent when a Copilot CLI terminal is opened.",
				"sessionType" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the terminal is for a new session or resuming an existing one." },
				"shell" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The shell type used for the terminal." },
				"terminalCreationMethod" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "How the terminal was created." },
				"location" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Where the terminal was opened - panel, editor area (active), or editor area (beside)." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('copilotcli.terminal.open', {
			sessionType,
			shell,
			terminalCreationMethod,
			location
		});
	}

	private async sendCommandToTerminal(terminal: Terminal, command: string): Promise<void> {
		// Wait for shell integration to be available
		const shellIntegrationTimeout = 3000;
		let shellIntegrationAvailable = terminal.shellIntegration ? true : false;
		const disposables = new DisposableStore();
		const integrationPromise = shellIntegrationAvailable ? Promise.resolve() : new Promise<void>((resolve) => {
			const disposable = disposables.add(this.terminalService.onDidChangeTerminalShellIntegration(e => {
				if (e.terminal === terminal && e.shellIntegration) {
					shellIntegrationAvailable = true;
					disposable.dispose();
					resolve();
				}
			}));

			disposables.add(disposableTimeout(() => {
				disposable.dispose();
				resolve();
			}, shellIntegrationTimeout));
		});

		try {
			await integrationPromise;

			if (terminal.shellIntegration) {
				terminal.shellIntegration.executeCommand(command);
			} else {
				terminal.sendText(command);
			}

			terminal.show();
		} finally {
			disposables.dispose();
		}
	}

}

function quoteArgsForShell(shellScript: string, args: string[]): string {
	const escapeArg = (arg: string): string => {
		// If argument contains spaces, quotes, or special characters, wrap in quotes and escape internal quotes
		if (/[\s"'$`\\|&;()<>]/.test(arg)) {
			return `"${arg.replace(/["\\]/g, '\\$&')}"`;
		}
		return arg;
	};

	const escapedArgs = args.map(escapeArg);
	return args.length ? `${escapeArg(shellScript)} ${escapedArgs.join(' ')}` : escapeArg(shellScript);
}

async function getCommonTerminalOptions(name: string, authenticationService: IAuthenticationService, otelService: IOTelService, location: TerminalOpenLocation = 'editor'): Promise<TerminalOptions> {
	const options: TerminalOptions = {
		name,
		titleTemplate: '${sequence}',
		iconPath: new ThemeIcon('terminal'),
		hideFromUser: false
	};
	if (location === 'panel') {
		options.location = TerminalLocation.Panel;
	} else {
		options.location = { viewColumn: location === 'editorBeside' ? ViewColumn.Beside : ViewColumn.Active };
	}
	const session = await authenticationService.getGitHubSession('any', { silent: true });
	if (session) {
		options.env = {
			// Old Token name for GitHub integrations (deprecate once the new variable has been adopted widely)
			GH_TOKEN: session.accessToken,
			// New Token name for Copilot
			COPILOT_GITHUB_TOKEN: session.accessToken,
			// Forward OTel config so the CLI binary exports traces/metrics to the same endpoint.
			// Pass an empty env so all vars are explicitly included in TerminalOptions.env,
			// regardless of process.env state (which may have stale values from the
			// in-process background agent). TerminalOptions.env overlays the inherited
			// process.env, so explicit entries here take precedence.
			// `deriveCopilotCliOTelEnv` returns `{}` when not `enabledExplicitly`.
			...deriveCopilotCliOTelEnv(otelService.config, {}),
		};
	}
	return options;
}
