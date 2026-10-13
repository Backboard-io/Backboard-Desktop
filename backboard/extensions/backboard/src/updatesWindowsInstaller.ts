/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inno Setup writes this file into the install folder once a background update
 * (`/update=`) has staged the new version in `{app}\_` and is only waiting for
 * the running app to exit (see `CurStepChanged` in build/win32/code.iss).
 */
export const windowsUpdateReadyFileName = 'updating_version';

/** Files the extension shares with a background Inno Setup run. */
export interface WindowsUpdateInstallerFiles {
	/** While present, setup applies the update on exit without relaunching; deleting it requests a relaunch. */
	readonly flagPath: string;
	readonly progressPath: string;
	readonly logPath: string;
}

/**
 * Arguments for the per-user Inno Setup installer, matching VS Code's own
 * Windows updater: stage silently beside the running app, keep the user's
 * previous task choices, and relaunch once the swap is done.
 * The caller spawns with `windowsVerbatimArguments`, so paths are quoted here.
 */
export function windowsSilentUpdateArguments(files: WindowsUpdateInstallerFiles): string[] {
	return [
		'/verysilent',
		'/suppressmsgboxes',
		'/norestart',
		`/log="${files.logPath}"`,
		`/update="${files.flagPath}"`,
		`/progress="${files.progressPath}"`,
		'/nocloseapplications',
		'/mergetasks=runcode,!desktopicon,!quicklaunchicon'
	];
}

/**
 * The environment for the installer, which also launches the updated app.
 * Process-local VS Code and Electron state from the extension host must not
 * reach the relaunched app: `ELECTRON_RUN_AS_NODE` would start it as plain
 * Node, and a stale IPC hook can make it exit as a secondary instance.
 */
export function windowsUpdaterEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		const name = key.toUpperCase();
		if (name !== 'ELECTRON_RUN_AS_NODE' && !name.startsWith('VSCODE_')) {
			result[key] = value;
		}
	}
	// Never let Windows' installer-detection heuristics elevate the per-user setup.
	result.__COMPAT_LAYER = 'RunAsInvoker';
	return result;
}

/** Inno Setup's `/progress` file holds `current,max`; returns a whole percentage. */
export function innoProgressPercent(content: string): number | undefined {
	const match = /^\s*(?<current>\d+)\s*,\s*(?<max>\d+)\s*$/.exec(content);
	const current = Number(match?.groups?.current);
	const max = Number(match?.groups?.max);
	if (!match || !(max > 0)) {
		return undefined;
	}
	return Math.min(100, Math.floor((current * 100) / max));
}

/**
 * Reports the Authenticode status and signer of the downloaded installer and
 * the installed app as one JSON line. Paths arrive through the environment so
 * no file name is ever parsed as PowerShell.
 */
export const windowsSignatureCheckScript = [
	`$ErrorActionPreference = 'Stop'`,
	'$setup = Get-AuthenticodeSignature -LiteralPath $env:BACKBOARD_UPDATE_INSTALLER',
	'$installed = Get-AuthenticodeSignature -LiteralPath $env:BACKBOARD_UPDATE_INSTALLED_APP',
	'[pscustomobject]@{ setupStatus = [string]$setup.Status; setupSigner = [string]$setup.SignerCertificate.Subject; installedStatus = [string]$installed.Status; installedSigner = [string]$installed.SignerCertificate.Subject } | ConvertTo-Json -Compress'
].join('; ');

export interface WindowsSignatures {
	readonly setupStatus: string;
	readonly setupSigner: string;
	readonly installedStatus: string;
	readonly installedSigner: string;
}

/**
 * Returns why the installer must not run, or undefined when it may. Like the
 * macOS team check, a signed install only accepts an installer from the same
 * publisher; an unsigned (development) install relies on the manifest SHA-256.
 */
export function windowsSignatureRejection(signatures: WindowsSignatures): string | undefined {
	if (signatures.installedStatus !== 'Valid' || !signatures.installedSigner) {
		return undefined;
	}
	if (signatures.setupStatus !== 'Valid') {
		return `The downloaded installer's signature is not valid (${signatures.setupStatus || 'missing'}).`;
	}
	if (signatures.setupSigner !== signatures.installedSigner) {
		return `Refusing an installer signed by "${signatures.setupSigner}"; the installed app is signed by "${signatures.installedSigner}".`;
	}
	return undefined;
}
