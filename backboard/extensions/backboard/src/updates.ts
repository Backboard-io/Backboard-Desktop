/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { setTimeout as delay } from 'timers/promises';
import { deprecatedBridgeDetail, deprecatedBridgeDownloadAction, deprecatedBridgeTitle, getReplacementDownloadUrl, replacementManifestBaseUrl, shouldShowDeprecatedBridgeNotice, shouldUseReplacementManifest } from './migrationNotice';
import { macUpdateInstallerScript } from './updatesInstaller';
import { updatePreparationFailure } from './updateDiagnostics';
import type { LiveRestartState, LiveUpdatesController } from './liveUpdates';
import { innoProgressPercent, windowsSignatureCheckScript, windowsSignatureRejection, WindowsSignatures, windowsSilentUpdateArguments, windowsUpdateReadyFileName, windowsUpdaterEnvironment } from './updatesWindowsInstaller';

interface UpdateManifest {
	readonly version: string;
	readonly url: string;
	readonly sha256?: string;
	readonly size_bytes?: number;
}

const defaultUpdateManifestBaseUrl = 'https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases';
const stableUpdateChannel = 'stable';
const sandboxUpdateChannel = 'sandbox';
const supportedUpdateChannels = new Set([stableUpdateChannel, sandboxUpdateChannel]);
const updateLockOwnerFileName = 'owner.json';
const updateLockMissingOwnerGraceMs = 60_000;
let backboardUpdateOutput: vscode.OutputChannel | undefined;

interface UpdateInstallLock {
	readonly directory: string;
	readonly ownerPath: string;
}

interface UpdateLockOwner {
	readonly pid: number;
	readonly version: string;
	readonly phase: 'extension' | 'installer';
	readonly createdAt: string;
}

/** Returns false when this build must not update itself (the deprecated bridge). */
export function initializeBackboardUpdates(context: vscode.ExtensionContext, output: vscode.OutputChannel | undefined): boolean {
	backboardUpdateOutput = output;
	// The deprecated Bagel bridge is intentionally a manual certificate migration.
	// It must show only the direct-DMG notice: offering Install and Restart here
	// sends the user through the cross-certificate in-place updater that this
	// bridge exists to avoid.
	if (showDeprecatedBridgeNotice(context)) {
		backboardUpdateOutput?.appendLine('[updates] automatic updater disabled for deprecated Alpha bridge');
		return false;
	}
	backboardUpdateStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
	context.subscriptions.push(backboardUpdateStatusItem);
	backboardUpdateCheckStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	backboardUpdateCheckStatusItem.command = 'backboard.checkForUpdates';
	context.subscriptions.push(backboardUpdateCheckStatusItem);
	updateBackboardUpdateCheckStatusItem(false);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(true)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.testUpdate', () => testBackboardUpdate()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.showUpdateLog', () => showBackboardUpdateLog()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.installAvailableUpdate', () => installAvailableBackboardUpdate()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.cancelUpdate', () => backboardUpdateCancellation?.abort()));
	context.subscriptions.push({ dispose: () => backboardUpdateCancellation?.abort() });
	scheduleAutomaticBackboardUpdateChecks(context);
	return true;
}

/** Live updates (liveUpdates.ts) share the Update button and the manual check. */
export function attachBackboardLiveUpdates(controller: LiveUpdatesController | undefined): void {
	backboardLiveUpdates = controller;
}

export function currentBackboardUpdateChannel(): string {
	return getBackboardUpdateChannel(vscode.workspace.getConfiguration('backboard'));
}

const automaticUpdateCheckStartupDelayMs = 8_000;
const automaticUpdateCheckIntervalMs = 20 * 60_000;
/** A focus change (switching between Simple, Editor and Agents) re-checks at most this often. */
const automaticUpdateCheckFocusThrottleMs = 60_000;
let lastAutomaticBackboardUpdateCheck = 0;

/**
 * Keeps the Update button current without the user asking: shortly after
 * launch, on a timer, and whenever this window gains focus. Each mode is its
 * own window, so switching modes is a focus change. These checks never show a
 * prompt; they only set `backboard.updateAvailable`, which lights the button.
 */
function scheduleAutomaticBackboardUpdateChecks(context: vscode.ExtensionContext): void {
	const check = (): void => {
		lastAutomaticBackboardUpdateCheck = Date.now();
		void checkBackboardUpdates(false);
	};
	const startup = setTimeout(() => {
		check();
		if (process.platform === 'win32') {
			void pruneWindowsUpdateCache();
		}
	}, automaticUpdateCheckStartupDelayMs);
	const interval = setInterval(check, automaticUpdateCheckIntervalMs);
	context.subscriptions.push({ dispose: () => { clearTimeout(startup); clearInterval(interval); } });
	context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
		if (state.focused && Date.now() - lastAutomaticBackboardUpdateCheck >= automaticUpdateCheckFocusThrottleMs) {
			check();
		}
	}));
}

function showDeprecatedBridgeNotice(context: vscode.ExtensionContext): boolean {
	const appPath = currentMacAppPath();
	const appName = appPath ? path.basename(appPath) : '';
	const channel = getBackboardUpdateChannel(vscode.workspace.getConfiguration('backboard'));
	const replacementDownloadUrl = getReplacementDownloadUrl(process.arch);
	if (!replacementDownloadUrl || !shouldShowDeprecatedBridgeNotice(readCurrentAppVersion(), channel, appName, process.platform)) {
		return false;
	}

	let presented = false;
	let focusSubscription: vscode.Disposable | undefined;
	const present = (): void => {
		if (presented) {
			return;
		}
		presented = true;
		focusSubscription?.dispose();
		backboardUpdateOutput?.appendLine('[updates] showing Alpha-to-Beta migration notification');
		void vscode.window.showWarningMessage(
			`${deprecatedBridgeTitle} ${deprecatedBridgeDetail}`,
			deprecatedBridgeDownloadAction
		).then(choice => {
			if (choice === deprecatedBridgeDownloadAction) {
				void vscode.env.openExternal(vscode.Uri.parse(replacementDownloadUrl));
			}
		});
	};

	if (vscode.window.state.focused) {
		present();
		return true;
	}

	// Wait until the window receives focus so the bottom-right notification is
	// visible once on every launch, including launches initiated by an updater.
	focusSubscription = vscode.window.onDidChangeWindowState(state => {
		if (state.focused) {
			present();
		}
	});
	context.subscriptions.push(focusSubscription);
	if (vscode.window.state.focused) {
		present();
	}
	return true;
}

let backboardUpdateInstallInProgress = false;
/** Set by the update test command: offer the latest release even when it is already installed. Ends on restart. */
let backboardUpdateTestMode = false;
let backboardUpdateCancellation: AbortController | undefined;
let backboardUpdateCheckInProgress = false;
let availableBackboardUpdate: UpdateManifest | undefined;
/** Live updates ship JavaScript between releases; see liveUpdates.ts. */
let backboardLiveUpdates: LiveUpdatesController | undefined;
/** A staged live update that takes effect with a quick restart, no installer. */
let pendingLiveRestart: LiveRestartState | undefined;
let backboardUpdateStatusItem: vscode.StatusBarItem | undefined;
let backboardUpdateCheckStatusItem: vscode.StatusBarItem | undefined;
async function checkBackboardUpdates(manual: boolean): Promise<void> {
	// A full release replaces live updates, so the live check only prompts when
	// there is no newer release to install.
	if (manual && backboardLiveUpdates) {
		await checkBackboardLiveUpdates();
	}
	// A development build's update test keeps its simulated release on offer until it is installed.
	if (!manual && availableBackboardUpdate && isSimulatedBackboardUpdate(availableBackboardUpdate)) {
		return;
	}
	if (backboardUpdateCheckInProgress) {
		if (manual) {
			await vscode.window.showInformationMessage('Backboard Studio update check is already running.');
		}
		return;
	}

	backboardUpdateCheckInProgress = true;
	updateBackboardUpdateCheckStatusItem(manual);
	let checkLock: UpdateInstallLock | undefined;
	let checkFinished = false;
	try {
		checkLock = await acquireBackboardUpdateCheckLock();
		if (!checkLock) {
			if (manual) {
				await vscode.window.showInformationMessage('Another Backboard Studio window is already checking for updates.');
			} else {
				// Each window tracks the button on its own; try again once the other window is done.
				setTimeout(() => void checkBackboardUpdates(false), 5_000);
			}
			return;
		}

		const manifestUrl = getBackboardUpdateManifestUrl();
		if (!manifestUrl) {
			if (manual) {
				await vscode.window.showWarningMessage('Backboard Studio updates are not supported on this platform.');
			}
			return;
		}

		backboardUpdateOutput?.appendLine(`[updates] checking ${manifestUrl}`);
		const manifest = await fetchBackboardUpdateManifest(manifestUrl);
		await releaseBackboardUpdateInstallLock(checkLock);
		checkLock = undefined;
		checkFinished = true;
		backboardUpdateCheckInProgress = false;
		updateBackboardUpdateCheckStatusItem(false);
		const currentVersion = readCurrentAppVersion();
		backboardUpdateOutput?.appendLine(`[updates] current=${currentVersion} remote=${manifest.version}`);
		// The update test reinstalls the latest release, but never downgrades.
		const testReinstall = backboardUpdateTestMode && !isNewerVersion(currentVersion, manifest.version);
		if (!isNewerVersion(manifest.version, currentVersion) && !testReinstall) {
			await setAvailableBackboardUpdate(undefined);
			if (manual && backboardUpdateTestMode) {
				void vscode.window.showWarningMessage(`The latest published release (${manifest.version}) is older than this build (${currentVersion}). Publish this build to its update channel first; the update test reinstalls the latest published release.`);
			} else if (manual && pendingLiveRestart) {
				await backboardLiveUpdates?.promptRestart();
			} else if (manual) {
				vscode.window.setStatusBarMessage(`Backboard Studio is up to date (${currentVersion}).`, 4000);
			}
			return;
		}

		await setAvailableBackboardUpdate(manifest);
		// An automatic check only lights the Update button; the prompt is for a check the user asked for.
		if (!manual) {
			return;
		}
		await promptBackboardUpdate(manifest, currentVersion);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		backboardUpdateOutput?.appendLine(`[updates] ${message}`);
		if (manual) {
			void vscode.window.showWarningMessage(`Could not check for Backboard Studio updates: ${message}`);
		}
	} finally {
		if (checkLock) {
			await releaseBackboardUpdateInstallLock(checkLock);
		}
		if (!checkFinished) {
			backboardUpdateCheckInProgress = false;
			updateBackboardUpdateCheckStatusItem(false);
		}
	}
}

async function promptBackboardUpdate(manifest: UpdateManifest, currentVersion: string): Promise<void> {
	const simulated = isSimulatedBackboardUpdate(manifest);
	const canInstall = simulated || canInstallBackboardUpdate();
	const message = `Backboard Studio ${manifest.version} is available. Current version: ${currentVersion}.`;
	const downloadAction = process.platform === 'win32' ? 'Download Installer' : 'Download DMG';
	const actions = canInstall ? ['Install and Restart', downloadAction, 'Copy Link', 'Later'] : [downloadAction, 'Copy Link', 'Later'];
	const choice = await vscode.window.showInformationMessage(message, ...actions);
	if (choice === 'Install and Restart') {
		await installBackboardUpdate(manifest);
	} else if (simulated && (choice === downloadAction || choice === 'Copy Link')) {
		await vscode.window.showInformationMessage(`Update test: a packaged build would ${choice === downloadAction ? 'open' : 'copy'} the installer link here.`);
	} else if (choice === downloadAction) {
		await vscode.env.openExternal(vscode.Uri.parse(manifest.url));
	} else if (choice === 'Copy Link') {
		await vscode.env.clipboard.writeText(manifest.url);
		await vscode.window.showInformationMessage('Backboard Studio update link copied.');
	}
}

/**
 * Lets a tester run the real update popup, Update button, download, install
 * and relaunch on any packaged build by reinstalling the latest release. A
 * development build cannot replace itself, so it gets a simulated release.
 */
async function testBackboardUpdate(): Promise<void> {
	if (isBackboardDevelopmentBuild()) {
		const currentVersion = readCurrentAppVersion();
		const manifest = simulatedBackboardUpdate(currentVersion);
		backboardUpdateOutput?.appendLine(`[updates] update test: development build, simulating ${currentVersion} -> ${manifest.version}`);
		await setAvailableBackboardUpdate(manifest);
		await promptBackboardUpdate(manifest, currentVersion);
		return;
	}
	backboardUpdateTestMode = true;
	const installTarget = process.platform === 'win32' ? ` target=${readBackboardProductMetadataString('target') ?? 'none'}` : '';
	backboardUpdateOutput?.appendLine(`[updates] update test: platform=${process.platform} arch=${process.arch} executable=${process.execPath}${installTarget} inPlaceInstall=${canInstallBackboardUpdate()}`);
	const unavailableReason = inPlaceInstallUnavailableReason();
	if (unavailableReason) {
		void vscode.window.showWarningMessage(unavailableReason);
	}
	await checkBackboardUpdates(true);
}

/**
 * The release a development build's update test offers. It runs the real
 * popup, Update button, Stop, progress notifications and restart dialog; only
 * the download and install are timed stand-ins, and nothing touches the
 * network. It ends before quitting, since a development build has no app to replace.
 */
const simulatedUpdateUrl = 'https://simulated-update.invalid/backboard-studio';

function simulatedBackboardUpdate(currentVersion: string): UpdateManifest {
	const [major, minor, patch] = parseVersion(currentVersion) ?? [0, 0, 0];
	return { version: `${major}.${minor}.${patch + 1}`, url: simulatedUpdateUrl };
}

function isSimulatedBackboardUpdate(manifest: UpdateManifest): boolean {
	return manifest.url === simulatedUpdateUrl;
}

function simulatedUpdateStep(signal?: AbortSignal): Promise<void> {
	return delay(150, undefined, { signal });
}

async function simulateBackboardUpdateDownload(destination: string, progress: vscode.Progress<{ message?: string; increment?: number }>, signal: AbortSignal): Promise<void> {
	for (let percent = 5; percent <= 100; percent += 5) {
		await simulatedUpdateStep(signal);
		progress.report({ increment: 5, message: `${percent}%` });
	}
	await fs.promises.writeFile(destination, 'simulated update', { mode: 0o600 });
}

async function simulateBackboardUpdateInstall(progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
	for (let percent = 10; percent <= 100; percent += 10) {
		await simulatedUpdateStep();
		progress.report({ increment: 10, message: `${percent}%` });
	}
}

function inPlaceInstallUnavailableReason(): string | undefined {
	if (canInstallBackboardUpdate()) {
		return undefined;
	}
	switch (process.platform) {
		case 'win32':
			return 'This install can only download the installer. In-place updates need an install made with Backboard-Studio-User-Setup-x64.exe; system-wide installs and the portable ZIP are not updated in place.';
		case 'darwin':
			return 'This build can only download the DMG. In-place updates need the packaged Backboard Studio.app, not a development build.';
		default:
			return 'In-place updates are only available on macOS and Windows.';
	}
}

async function showBackboardUpdateLog(): Promise<void> {
	backboardUpdateOutput?.show(true);
	const logPath = backboardUpdateLogPath();
	if (fs.existsSync(logPath)) {
		await vscode.window.showTextDocument(vscode.Uri.file(logPath), { preview: false });
	} else {
		await vscode.window.showInformationMessage(`No installer log yet. It is written to ${logPath} once Install and Restart starts.`);
	}
}

function backboardUpdateLogPath(): string {
	return path.join(os.tmpdir(), 'backboard-studio-update.log');
}

function updateBackboardUpdateCheckStatusItem(checking: boolean): void {
	if (!backboardUpdateCheckStatusItem) {
		return;
	}
	if (checking) {
		backboardUpdateCheckStatusItem.text = '$(sync~spin) Checking Updates';
		backboardUpdateCheckStatusItem.tooltip = 'Checking the Backboard Studio S3 update manifest';
	} else {
		backboardUpdateCheckStatusItem.text = '$(sync) Check Updates';
		backboardUpdateCheckStatusItem.tooltip = 'Check S3 for a Backboard Studio update';
	}
	backboardUpdateCheckStatusItem.hide();
}

async function checkBackboardLiveUpdates(): Promise<void> {
	try {
		// The Update button prompts for a full release when one exists; this
		// only fetches, so a staged live update lights the same button.
		await backboardLiveUpdates?.check();
	} catch (error) {
		backboardUpdateOutput?.appendLine(`[live] ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function setAvailableBackboardUpdate(manifest: UpdateManifest | undefined): Promise<void> {
	availableBackboardUpdate = manifest;
	await refreshBackboardUpdateButton();
}

export async function setPendingLiveRestart(state: LiveRestartState | undefined): Promise<void> {
	pendingLiveRestart = state;
	await refreshBackboardUpdateButton();
}

/** One Update button for both: a full release wins over a staged live update. */
async function refreshBackboardUpdateButton(): Promise<void> {
	const manifest = availableBackboardUpdate;
	await vscode.commands.executeCommand('setContext', 'backboard.updateAvailable', Boolean(manifest || pendingLiveRestart));
	if (!backboardUpdateStatusItem) {
		return;
	}
	if (manifest) {
		backboardUpdateStatusItem.text = `$(cloud-download) Update ${manifest.version}`;
		backboardUpdateStatusItem.tooltip = `Install Backboard Studio ${manifest.version}`;
	} else if (pendingLiveRestart) {
		backboardUpdateStatusItem.text = '$(debug-restart) Restart to Update';
		backboardUpdateStatusItem.tooltip = pendingLiveRestart.notes ?? 'Restart Backboard Studio to apply the latest update';
	}
	backboardUpdateStatusItem.hide();
}

async function installAvailableBackboardUpdate(): Promise<void> {
	if (!availableBackboardUpdate && pendingLiveRestart) {
		await vscode.commands.executeCommand('backboard.relaunchApp');
		return;
	}
	if (!availableBackboardUpdate) {
		await checkBackboardUpdates(true);
		return;
	}
	if (isSimulatedBackboardUpdate(availableBackboardUpdate) || canInstallBackboardUpdate()) {
		await installBackboardUpdate(availableBackboardUpdate);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(availableBackboardUpdate.url));
}

function canInstallBackboardUpdate(): boolean {
	return Boolean(currentInstalledAppPath());
}

/**
 * What the in-place updater replaces: the macOS app bundle, or the folder of a
 * per-user Windows install. Other layouts (system-wide Windows installs, the
 * portable ZIP, Linux, development builds) only offer the download link.
 */
function currentInstalledAppPath(): string | undefined {
	if (process.platform === 'win32') {
		return currentWindowsUserInstallDirectory();
	}
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const appPath = currentMacAppPath();
	return appPath && isSupportedMacBackboardAppName(path.basename(appPath)) ? appPath : undefined;
}

async function installBackboardUpdate(manifest: UpdateManifest): Promise<void> {
	if (backboardUpdateInstallInProgress) {
		await vscode.window.showInformationMessage('Backboard Studio update installation is already running.');
		return;
	}
	const simulated = isSimulatedBackboardUpdate(manifest);
	const appPath = simulated ? path.join(os.tmpdir(), 'Backboard Studio Update Test') : currentInstalledAppPath();
	if (!appPath) {
		await vscode.window.showWarningMessage('Automatic update install is only available from the packaged Backboard Studio app.');
		return;
	}

	backboardUpdateInstallInProgress = true;
	const cancellation = new AbortController();
	backboardUpdateCancellation = cancellation;
	const { signal } = cancellation;
	let installLock: UpdateInstallLock | undefined;
	let installerOwnsLock = false;
	try {
		await vscode.commands.executeCommand('setContext', 'backboard.updateCancellable', true);
		if (backboardUpdateStatusItem) {
			backboardUpdateStatusItem.text = vscode.l10n.t('$(debug-stop) Stop Update');
			backboardUpdateStatusItem.tooltip = vscode.l10n.t('Stop downloading or verifying the update');
			backboardUpdateStatusItem.command = 'backboard.cancelUpdate';
		}
		signal.throwIfAborted();
		const acquiredInstallLock = await acquireBackboardUpdateInstallLock(appPath, manifest.version);
		installLock = acquiredInstallLock;
		const updateDirectory = await backboardUpdateCacheDirectory(appPath, manifest);
		const packagePath = path.join(updateDirectory, process.platform === 'win32' ? `Backboard-Studio-${manifest.version}-Setup.exe` : `Backboard-Studio-${manifest.version}.dmg`);
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Preparing Backboard Studio {0}', manifest.version),
			cancellable: true
		}, async (progress, token) => {
			const subscription = token.onCancellationRequested(() => cancellation.abort());
			try {
				if (token.isCancellationRequested) {
					cancellation.abort();
				}
				signal.throwIfAborted();
				let cachedDownloadValid = false;
				if (!simulated && fs.existsSync(packagePath)) {
					try {
						progress.report({ message: vscode.l10n.t('Verifying downloaded update…') });
						await verifyBackboardUpdate(packagePath, manifest, signal);
						cachedDownloadValid = true;
					} catch (error) {
						signal.throwIfAborted();
						await fs.promises.rm(packagePath, { force: true });
					}
				}
				if (!cachedDownloadValid) {
					const partialPackagePath = path.join(updateDirectory, `.Backboard-Studio-${manifest.version}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.partial`);
					try {
						progress.report({ message: vscode.l10n.t('Downloading update…') });
						await (simulated
							? simulateBackboardUpdateDownload(partialPackagePath, progress, signal)
							: downloadBackboardUpdate(manifest.url, partialPackagePath, progress, signal));
						progress.report({ message: vscode.l10n.t('Verifying downloaded update…') });
						await verifyBackboardUpdate(partialPackagePath, manifest, signal);
						signal.throwIfAborted();
						await fs.promises.rename(partialPackagePath, packagePath);
					} finally {
						await fs.promises.rm(partialPackagePath, { force: true });
					}
				}
			} finally {
				subscription.dispose();
			}
		});
		signal.throwIfAborted();
		const installAction = vscode.l10n.t('Install and Restart');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Backboard Studio {0} is ready to install.', manifest.version),
			{ modal: true, detail: vscode.l10n.t('Installing will close Backboard Studio and restart it. You can cancel now and keep working. Once installation begins, it cannot be stopped.') },
			installAction
		);
		if (choice !== installAction) {
			cancellation.abort();
		}
		signal.throwIfAborted();
		// This is the commit point: the user has explicitly chosen to restart.
		backboardUpdateCancellation = undefined;
		await vscode.commands.executeCommand('setContext', 'backboard.updateCancellable', false);
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Installing Backboard Studio {0}', manifest.version),
			cancellable: false
		}, async progress => simulated
			? simulateBackboardUpdateInstall(progress)
			: process.platform === 'win32'
				? stageWindowsBackboardInstaller(packagePath, appPath, manifest.version, acquiredInstallLock, progress)
				: stageMacBackboardInstaller(packagePath, appPath, manifest.version, acquiredInstallLock));
		if (simulated) {
			availableBackboardUpdate = undefined;
			backboardUpdateOutput?.appendLine(`[updates] update test finished; a packaged build would now quit and install ${manifest.version}`);
			void vscode.window.showInformationMessage(`Update test complete. A packaged build would now close, install Backboard Studio ${manifest.version} and reopen.`);
			return;
		}
		installerOwnsLock = true;
		await vscode.commands.executeCommand('workbench.action.quit');
	} catch (error) {
		if (signal.aborted) {
			backboardUpdateOutput?.appendLine('[updates] update stopped by the user; installed app unchanged');
		} else {
			const message = error instanceof Error ? error.message : String(error);
			backboardUpdateOutput?.appendLine(`[updates] install failed: ${message}`);
			await vscode.window.showWarningMessage(`Could not install Backboard Studio update: ${message}`);
		}
	} finally {
		backboardUpdateCancellation = undefined;
		backboardUpdateInstallInProgress = installerOwnsLock;
		if (installLock && !installerOwnsLock) {
			await releaseBackboardUpdateInstallLock(installLock);
		}
		await vscode.commands.executeCommand('setContext', 'backboard.updateCancellable', false);
		if (backboardUpdateStatusItem) {
			backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
		}
		await setAvailableBackboardUpdate(availableBackboardUpdate);
	}
}

async function backboardUpdateCacheDirectory(appPath: string, manifest: UpdateManifest): Promise<string> {
	const versionKey = manifest.version.replace(/[^a-zA-Z0-9._-]/g, '_');
	const digestKey = manifest.sha256?.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16) || 'unverified';
	const directory = path.join(backboardUpdateCacheRoot(appPath), `${versionKey}-${digestKey}`);
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	return directory;
}

function backboardUpdateCacheRoot(appPath: string): string {
	const appKey = path.basename(appPath, '.app').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
	return path.join(os.tmpdir(), 'backboard-studio-update-cache', appKey);
}

/**
 * Each Windows installer is about 350 MB and %TEMP% is rarely cleaned, so drop
 * cached installers once this version or a newer one is running. macOS keeps
 * its cache: its installer holds the rollback copy there through a post-launch
 * health check that overlaps the updated app's startup.
 */
async function pruneWindowsUpdateCache(): Promise<void> {
	const installDirectory = currentWindowsUserInstallDirectory();
	if (!installDirectory) {
		return;
	}
	const root = backboardUpdateCacheRoot(installDirectory);
	const currentVersion = readCurrentAppVersion();
	let entries: string[];
	try {
		entries = await fs.promises.readdir(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		const separator = entry.lastIndexOf('-');
		if (separator <= 0 || isNewerVersion(entry.slice(0, separator), currentVersion)) {
			continue;
		}
		try {
			await fs.promises.rm(path.join(root, entry), { recursive: true, force: true });
		} catch (error) {
			backboardUpdateOutput?.appendLine(`[updates] could not remove cached update ${entry}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function backboardUpdateInstallLockDirectory(appPath: string): string {
	const appKey = path.basename(appPath, '.app').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
	return path.join(os.tmpdir(), `backboard-studio-${appKey}-update.lock`);
}

function backboardUpdateCheckLockDirectory(): string {
	const appPath = currentMacAppPath();
	const appName = appPath ? path.basename(appPath, '.app') : vscode.env.appName;
	const appKey = appName.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
	const channel = getBackboardUpdateChannel(vscode.workspace.getConfiguration('backboard'));
	return path.join(os.tmpdir(), `backboard-studio-${appKey}-${channel}-update-check.lock`);
}

async function acquireBackboardUpdateCheckLock(): Promise<UpdateInstallLock | undefined> {
	const directory = backboardUpdateCheckLockDirectory();
	const ownerPath = path.join(directory, updateLockOwnerFileName);
	const lock = { directory, ownerPath };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.promises.mkdir(directory, { mode: 0o700 });
			await writeBackboardUpdateLockOwner(lock, {
				pid: process.pid,
				version: readCurrentAppVersion(),
				phase: 'extension',
				createdAt: new Date().toISOString()
			});
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			if (!(await backboardUpdateInstallLockIsStale(lock))) {
				return undefined;
			}
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	}
	return undefined;
}

async function acquireBackboardUpdateInstallLock(appPath: string, version: string): Promise<UpdateInstallLock> {
	const directory = backboardUpdateInstallLockDirectory(appPath);
	const ownerPath = path.join(directory, updateLockOwnerFileName);
	const lock = { directory, ownerPath };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.promises.mkdir(directory, { mode: 0o700 });
			await writeBackboardUpdateLockOwner(lock, {
				pid: process.pid,
				version,
				phase: 'extension',
				createdAt: new Date().toISOString()
			});
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			if (!(await backboardUpdateInstallLockIsStale(lock))) {
				throw new Error('A Backboard Studio update is already downloading or waiting to install. Quit the app once and let that installer finish.');
			}
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	}
	throw new Error('Could not acquire the Backboard Studio update installation lock.');
}

async function writeBackboardUpdateLockOwner(lock: UpdateInstallLock, owner: UpdateLockOwner): Promise<void> {
	const temporaryPath = `${lock.ownerPath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
	await fs.promises.rename(temporaryPath, lock.ownerPath);
}

async function backboardUpdateInstallLockIsStale(lock: UpdateInstallLock): Promise<boolean> {
	try {
		const owner = JSON.parse(await fs.promises.readFile(lock.ownerPath, 'utf8')) as Partial<UpdateLockOwner>;
		if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
			return false;
		}
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'ESRCH';
		}
	} catch {
		try {
			const stat = await fs.promises.stat(lock.directory);
			return Date.now() - stat.mtimeMs > updateLockMissingOwnerGraceMs;
		} catch {
			return true;
		}
	}
}

async function releaseBackboardUpdateInstallLock(lock: UpdateInstallLock): Promise<void> {
	await fs.promises.rm(lock.directory, { recursive: true, force: true });
}

function currentMacAppPath(): string | undefined {
	const match = /^(.+?\.app)(?:\/|$)/.exec(process.execPath);
	return match?.[1];
}

function isSupportedMacBackboardAppName(appName: string): boolean {
	return appName === 'Backboard Studio.app' || appName === 'Backboard Studio Sandbox.app';
}

/**
 * The folder of a per-user Inno Setup install, the only Windows layout the
 * per-user installer in the update manifest can update in place. The
 * installer stamps `target` into product.json; the portable ZIP has none.
 */
function currentWindowsUserInstallDirectory(): string | undefined {
	if (process.platform !== 'win32') {
		return undefined;
	}
	const executableName = path.basename(process.execPath);
	if (executableName !== 'Backboard Studio.exe' && executableName !== 'Backboard Studio Sandbox.exe') {
		return undefined;
	}
	if (readBackboardProductMetadataString('target') !== 'user') {
		return undefined;
	}
	const installDirectory = path.dirname(process.execPath);
	return fs.existsSync(path.join(installDirectory, 'unins000.exe')) ? installDirectory : undefined;
}

async function downloadBackboardUpdate(rawUrl: string, destination: string, progress: vscode.Progress<{ message?: string; increment?: number }>, signal: AbortSignal, redirectLimit = 5): Promise<void> {
	signal.throwIfAborted();
	const url = new URL(rawUrl);
	const client = url.protocol === 'http:' ? http : https;
	const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
		const request = client.get(url, { signal, headers: { 'User-Agent': `Backboard-Studio/${readCurrentAppVersion()}` } }, resolve);
		request.setTimeout(120_000, () => request.destroy(new Error('Update download timed out.')));
		request.on('error', reject);
	});
	const statusCode = response.statusCode ?? 0;
	const location = response.headers.location;
	if (statusCode >= 300 && statusCode < 400 && location && redirectLimit > 0) {
		response.destroy();
		return downloadBackboardUpdate(new URL(location, url).toString(), destination, progress, signal, redirectLimit - 1);
	}
	if (statusCode < 200 || statusCode >= 300) {
		response.destroy();
		throw new Error(`Update download failed with HTTP ${statusCode}.`);
	}
	const expectedBytes = Number(response.headers['content-length']) || undefined;
	let downloadedBytes = 0;
	let lastPercent = 0;
	response.on('data', chunk => {
		downloadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
		if (expectedBytes) {
			const percent = Math.min(100, Math.floor((downloadedBytes / expectedBytes) * 100));
			if (percent > lastPercent) {
				progress.report({ increment: percent - lastPercent, message: `${percent}%` });
				lastPercent = percent;
			}
		} else {
			progress.report({ message: `${Math.round(downloadedBytes / 1024 / 1024)} MB` });
		}
	});
	// pipeline closes both streams before rejecting, so cancellation can safely
	// remove the partial file and release the lock before another attempt starts.
	try {
		await pipeline(response, fs.createWriteStream(destination, { mode: 0o600 }), { signal });
	} catch (error) {
		// Node can surface an aborted HTTP socket as a generic `Error: aborted`
		// on Windows. Normalize it to the AbortSignal's AbortError so callers can
		// reliably distinguish an intentional Stop action from a failed download.
		signal.throwIfAborted();
		throw error;
	}
}

async function verifyBackboardUpdate(packagePath: string, manifest: UpdateManifest, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const stat = await fs.promises.stat(packagePath);
	if (manifest.size_bytes !== undefined && stat.size !== manifest.size_bytes) {
		throw new Error(`Downloaded update size mismatch. Expected ${manifest.size_bytes} bytes, got ${stat.size}.`);
	}
	if (manifest.sha256) {
		const actualSha256 = await sha256File(packagePath, signal);
		if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
			throw new Error(`Downloaded update SHA-256 mismatch. Expected ${manifest.sha256}, got ${actualSha256}.`);
		}
	}
}

function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath, { signal });
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

async function stageMacBackboardInstaller(dmgPath: string, appPath: string, version: string, installLock: UpdateInstallLock): Promise<void> {
	const installerPath = path.join(path.dirname(dmgPath), 'install-backboard-update.sh');
	const statusPath = path.join(path.dirname(dmgPath), 'install-backboard-update.status');
	const logPath = backboardUpdateLogPath();
	const appName = path.basename(appPath);
	const bundleIdentifier = appName === 'Backboard Studio Sandbox.app' ? 'io.backboard.studio.sandbox' : 'io.backboard.studio';
	await fs.promises.writeFile(installerPath, macUpdateInstallerScript(), { mode: 0o700 });
	await fs.promises.rm(statusPath, { force: true });
	const child = cp.spawn('/bin/zsh', [installerPath, dmgPath, appPath, String(process.pid), version, logPath, appName, bundleIdentifier, statusPath, '', installLock.directory], {
		detached: true,
		stdio: 'ignore'
	});
	if (!child.pid) {
		throw new Error('Could not start the detached Backboard Studio update installer.');
	}
	await writeBackboardUpdateLockOwner(installLock, {
		pid: child.pid,
		version,
		phase: 'installer',
		createdAt: new Date().toISOString()
	});
	await waitForUpdateInstallerReady(child, logPath, () => {
		try {
			const status = fs.readFileSync(statusPath, 'utf8').trim();
			return status === 'ready' || status === 'failed' ? status : undefined;
		} catch {
			// The detached installer creates the status file after its preflight checks.
			return undefined;
		}
	});
	child.unref();
}

/**
 * Stages a per-user Windows update the way VS Code's own updater does: the
 * signed Inno Setup installer runs silently beside the running app, copies the
 * new version into `{app}\_`, and waits for the app's mutex to disappear. On
 * quit, `inno_updater.exe` swaps the staged files in and setup relaunches the
 * app, so the user never sees the setup wizard.
 */
async function stageWindowsBackboardInstaller(setupPath: string, installDirectory: string, version: string, installLock: UpdateInstallLock, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
	await verifyWindowsInstallerSignature(setupPath, process.execPath);
	const workDirectory = path.dirname(setupPath);
	const files = {
		flagPath: path.join(workDirectory, 'install-backboard-update.flag'),
		progressPath: path.join(workDirectory, 'install-backboard-update.progress'),
		logPath: backboardUpdateLogPath()
	};
	const readyPath = path.join(installDirectory, windowsUpdateReadyFileName);
	// A marker left by an interrupted earlier attempt must not pass for this one.
	await fs.promises.rm(readyPath, { force: true });
	await fs.promises.rm(files.progressPath, { force: true });
	await fs.promises.writeFile(files.flagPath, 'flag');
	const child = cp.spawn(setupPath, windowsSilentUpdateArguments(files), {
		argv0: `"${setupPath}"`,
		detached: true,
		stdio: 'ignore',
		windowsVerbatimArguments: true,
		env: windowsUpdaterEnvironment(process.env)
	});
	if (!child.pid) {
		child.once('error', () => { /* reported by the throw below */ });
		throw new Error('Could not start the Backboard Studio update installer.');
	}
	await writeBackboardUpdateLockOwner(installLock, {
		pid: child.pid,
		version,
		phase: 'installer',
		createdAt: new Date().toISOString()
	});
	let reportedPercent = 0;
	await waitForUpdateInstallerReady(child, files.logPath, () => {
		if (fs.existsSync(readyPath)) {
			return 'ready';
		}
		try {
			const percent = innoProgressPercent(fs.readFileSync(files.progressPath, 'utf8'));
			if (percent !== undefined && percent > reportedPercent) {
				progress.report({ increment: percent - reportedPercent, message: `${percent}%` });
				reportedPercent = percent;
			}
		} catch {
			// Setup creates the progress file once it starts copying files.
		}
		return undefined;
	});
	// Deleting the flag is the commit: once the app exits, setup swaps in the
	// staged version and relaunches it instead of only applying it.
	await fs.promises.rm(files.flagPath, { force: true });
	child.unref();
}

async function verifyWindowsInstallerSignature(setupPath: string, installedAppPath: string): Promise<void> {
	const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const output = await new Promise<string>((resolve, reject) => {
		cp.execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsSignatureCheckScript], {
			env: { ...process.env, BACKBOARD_UPDATE_INSTALLER: setupPath, BACKBOARD_UPDATE_INSTALLED_APP: installedAppPath },
			timeout: 5 * 60_000,
			windowsHide: true
		}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`Could not verify the update installer's signature: ${(stderr || error.message).trim()}`));
			} else {
				resolve(stdout);
			}
		});
	});
	const signatures = JSON.parse(output.trim()) as WindowsSignatures;
	const rejection = windowsSignatureRejection(signatures);
	if (rejection) {
		throw new Error(rejection);
	}
	backboardUpdateOutput?.appendLine(`[updates] installer signature ${signatures.setupStatus || 'missing'} (${signatures.setupSigner || 'no signer'})`);
}

/** Waits until a detached installer has staged the update and only needs the app to exit. */
function waitForUpdateInstallerReady(child: cp.ChildProcess, logPath: string, poll: () => 'ready' | 'failed' | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(statusTimer);
			clearTimeout(timeoutTimer);
			child.off('error', onError);
			child.off('exit', onExit);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const installerFailure = (): Error => {
			let detail = '';
			try {
				detail = fs.readFileSync(logPath, 'utf8');
			} catch {
				// The installer may fail before opening its log.
			}
			return new Error(updatePreparationFailure(detail, logPath));
		};
		const checkStatus = (): void => {
			const status = poll();
			if (status === 'ready') {
				finish();
			} else if (status === 'failed') {
				finish(installerFailure());
			}
		};
		const onError = (error: Error): void => finish(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			checkStatus();
			if (!settled) {
				if (code !== 0) {
					finish(installerFailure());
				} else {
					finish(new Error(`Update installer exited before preparation completed (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`));
				}
			}
		};
		const statusTimer = setInterval(checkStatus, 250);
		const timeoutTimer = setTimeout(() => {
			child.kill();
			finish(new Error('Update preparation timed out.'));
		}, 15 * 60 * 1000);
		child.once('error', onError);
		child.once('exit', onExit);
		checkStatus();
	});
}

function getBackboardUpdateManifestUrl(): string | undefined {
	const config = vscode.workspace.getConfiguration('backboard');
	const configuredManifestUrl = config.get<string>('updates.manifestUrl', '').trim();
	const manifestUrlOverride = process.env.BBIDE_UPDATE_MANIFEST_URL || process.env.BACKBOARD_UPDATE_MANIFEST_URL || configuredManifestUrl;
	if (manifestUrlOverride.trim()) {
		return manifestUrlOverride.trim();
	}

	const platform = getUpdatePlatform();
	const arch = getUpdateArch();
	if (!platform || !arch) {
		return undefined;
	}

	const channel = getBackboardUpdateChannel(config);
	const appPath = currentMacAppPath();
	const appName = appPath ? path.basename(appPath) : '';
	const automaticBaseUrl = shouldUseReplacementManifest(readCurrentAppVersion(), channel, appName, process.platform)
		? replacementManifestBaseUrl
		: defaultUpdateManifestBaseUrl;
	const configuredBaseUrl = config.get<string>('updates.manifestBaseUrl', defaultUpdateManifestBaseUrl).trim();
	const effectiveConfiguredBaseUrl = configuredBaseUrl && configuredBaseUrl !== defaultUpdateManifestBaseUrl
		? configuredBaseUrl
		: automaticBaseUrl;
	const manifestBaseUrl = (process.env.BBIDE_UPDATE_MANIFEST_BASE_URL || process.env.BACKBOARD_UPDATE_MANIFEST_BASE_URL || effectiveConfiguredBaseUrl)
		.trim()
		.replace(/\/+$/, '');
	return `${manifestBaseUrl}/${channel}/latest/bbide/${platform}-${arch}.json`;
}

function getBackboardUpdateChannel(config: vscode.WorkspaceConfiguration): string {
	const configuredChannel = process.env.BBIDE_UPDATE_CHANNEL
		|| process.env.BACKBOARD_UPDATE_CHANNEL
		|| config.get<string>('updates.channel', '').trim();
	const configured = normalizeBackboardUpdateChannel(configuredChannel);
	if (configured) {
		return configured;
	}

	const packagedChannel = normalizeBackboardUpdateChannel(
		readBackboardReleaseMetadataString('channel', 'backboardUpdateChannel', 'productJsonBackboardUpdateChannel')
		|| readBackboardProductMetadataString('backboardUpdateChannel')
	);
	if (packagedChannel) {
		return packagedChannel;
	}

	return isBackboardDevelopmentBuild() ? sandboxUpdateChannel : stableUpdateChannel;
}

function normalizeBackboardUpdateChannel(channel: string | undefined): string | undefined {
	const normalized = channel?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (supportedUpdateChannels.has(normalized)) {
		return normalized;
	}
	backboardUpdateOutput?.appendLine(`[updates] unsupported channel "${channel}", falling back to automatic channel selection.`);
	return undefined;
}

function isBackboardDevelopmentBuild(): boolean {
	const metadataVersion = readBackboardReleaseMetadataString('version', 'backboardStudioVersion')
		|| readBackboardProductMetadataString('backboardStudioVersion');
	if (metadataVersion) {
		return false;
	}

	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes('dev')) {
		return true;
	}

	const productName = readBackboardProductMetadataString('nameShort', 'nameLong', 'applicationName');
	if (productName?.toLowerCase().includes('dev')) {
		return true;
	}

	return readCurrentAppVersion() === 'development build';
}

function getUpdatePlatform(): string | undefined {
	switch (process.platform) {
		case 'darwin':
			return 'macos';
		case 'win32':
			return 'windows';
		default:
			return undefined;
	}
}

function getUpdateArch(): string | undefined {
	switch (process.arch) {
		case 'arm64':
			return 'aarch64';
		case 'x64':
			return 'x86_64';
		default:
			return undefined;
	}
}

async function fetchBackboardUpdateManifest(manifestUrl: string): Promise<UpdateManifest> {
	const body = await fetchText(manifestUrl, 5);
	const parsed = JSON.parse(body) as unknown;
	if (!isObjectRecord(parsed)) {
		throw new Error('Update manifest is not an object.');
	}
	const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
	const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
	if (!version || !url) {
		throw new Error('Update manifest is missing version or url.');
	}
	return {
		version,
		url,
		sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : undefined,
		size_bytes: typeof parsed.size_bytes === 'number' ? parsed.size_bytes : undefined
	};
}

function fetchText(rawUrl: string, redirectLimit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const url = new URL(rawUrl);
		const client = url.protocol === 'http:' ? http : https;
		const request = client.get(url, { headers: { 'User-Agent': `Backboard-Studio/${readCurrentAppVersion()}` } }, response => {
			const statusCode = response.statusCode ?? 0;
			const location = response.headers.location;
			if (statusCode >= 300 && statusCode < 400 && location && redirectLimit > 0) {
				response.resume();
				resolve(fetchText(new URL(location, url).toString(), redirectLimit - 1));
				return;
			}
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				reject(new Error(`Update manifest request failed with HTTP ${statusCode}.`));
				return;
			}

			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		request.setTimeout(15_000, () => {
			request.destroy(new Error('Update manifest request timed out.'));
		});
		request.on('error', reject);
	});
}

export function readCurrentAppVersion(): string {
	const envVersion = process.env.BACKBOARD_STUDIO_VERSION || process.env.BBIDE_VERSION;
	if (envVersion?.trim()) {
		return envVersion.trim();
	}

	const metadataVersion = readBackboardReleaseMetadataString('version', 'backboardStudioVersion', 'backboardVersion');
	if (metadataVersion) {
		return metadataVersion;
	}

	// `backboardVersion` is the canonical Backboard product version declared in
	// product.json (decoupled from the VS Code engine version). It is the source
	// of truth for both the About dialog and this update check.
	const productVersion = readBackboardProductMetadataString('backboardStudioVersion', 'backboardVersion');
	if (productVersion) {
		return productVersion;
	}

	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	const releaseMetadataPaths = [
		appRoot ? path.join(appRoot, 'backboard-build-info.json') : undefined,
		appRoot ? path.join(appRoot, 'product.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'backboard-build-info.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'product.json') : undefined,
		path.join(process.cwd(), 'backboard-build-info.json'),
		path.join(process.cwd(), 'product.json')
	].filter((value): value is string => Boolean(value));
	for (const releaseMetadataPath of releaseMetadataPaths) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(releaseMetadataPath, 'utf8'));
			if (isObjectRecord(parsed)) {
				const backboardBuildInfo = isObjectRecord(parsed.backboardBuildInfo) ? parsed.backboardBuildInfo : undefined;
				const isBuildInfoFile = path.basename(releaseMetadataPath) === 'backboard-build-info.json';
				const value =
					stringValueFromRecord(parsed.backboardStudioVersion) ||
					stringValueFromRecord(parsed.backboardVersion) ||
					(backboardBuildInfo ? stringValueFromRecord(backboardBuildInfo.version) : undefined) ||
					(isBuildInfoFile ? stringValueFromRecord(parsed.version) : undefined);
				if (value) {
					return value;
				}
			}
		} catch {
			// Development hosts may not have packaged Backboard release metadata.
		}
	}

	const appPath = currentMacAppPath();
	const infoPlistPaths = [
		appPath ? path.join(appPath, 'Contents', 'Info.plist') : undefined,
		path.join(path.dirname(process.execPath), '..', 'Info.plist')
	].filter((value): value is string => Boolean(value));
	for (const infoPlist of infoPlistPaths) {
		try {
			const plist = fs.readFileSync(infoPlist, 'utf8');
			const value = readPlistString(plist, 'CFBundleShortVersionString') || readPlistString(plist, 'CFBundleVersion');
			if (value && value !== vscode.version) {
				return value;
			}
		} catch {
			// Development hosts may not run from a packaged macOS app bundle.
		}
	}

	return 'development build';
}

function readBackboardReleaseMetadataString(...keys: string[]): string | undefined {
	for (const metadataPath of backboardReleaseMetadataPaths()) {
		const value = readBackboardMetadataString(metadataPath, keys, true);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function readBackboardProductMetadataString(...keys: string[]): string | undefined {
	for (const metadataPath of backboardProductMetadataPaths()) {
		const value = readBackboardMetadataString(metadataPath, keys, false);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function readBackboardMetadataString(metadataPath: string, keys: readonly string[], includeBuildInfo: boolean): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
		if (!isObjectRecord(parsed)) {
			return undefined;
		}
		const buildInfo = includeBuildInfo && isObjectRecord(parsed.backboardBuildInfo) ? parsed.backboardBuildInfo : undefined;
		for (const key of keys) {
			const rootValue = stringValueFromRecord(parsed[key]);
			if (rootValue) {
				return rootValue;
			}
			const buildInfoValue = buildInfo ? stringValueFromRecord(buildInfo[key]) : undefined;
			if (buildInfoValue) {
				return buildInfoValue;
			}
		}
	} catch {
		// Development hosts may not have packaged Backboard release metadata.
	}
	return undefined;
}

function backboardReleaseMetadataPaths(): string[] {
	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	return [
		appRoot ? path.join(appRoot, 'backboard-build-info.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'backboard-build-info.json') : undefined,
		path.join(process.cwd(), 'backboard-build-info.json')
	].filter((value): value is string => Boolean(value));
}

function backboardProductMetadataPaths(): string[] {
	const appRoot = vscode.env.appRoot;
	const extensionPath = vscode.extensions.getExtension('backboard.backboard')?.extensionPath;
	return [
		appRoot ? path.join(appRoot, 'product.json') : undefined,
		extensionPath ? path.resolve(extensionPath, '..', '..', 'product.json') : undefined,
		path.join(process.cwd(), 'product.json')
	].filter((value): value is string => Boolean(value));
}

function readPlistString(plist: string, key: string): string | undefined {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`).exec(plist);
	return match?.[1]?.trim();
}

function isNewerVersion(candidate: string, current: string): boolean {
	const candidateParts = parseVersion(candidate);
	const currentParts = parseVersion(current);
	if (!candidateParts || !currentParts) {
		return candidate !== current;
	}

	for (let index = 0; index < Math.max(candidateParts.length, currentParts.length); index++) {
		const candidatePart = candidateParts[index] ?? 0;
		const currentPart = currentParts[index] ?? 0;
		if (candidatePart > currentPart) {
			return true;
		}
		if (candidatePart < currentPart) {
			return false;
		}
	}
	return false;
}

function parseVersion(version: string): number[] | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
	if (!match) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}


function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValueFromRecord(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
