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
import { deprecatedBridgeDetail, deprecatedBridgeDownloadAction, deprecatedBridgeTitle, getReplacementDownloadUrl, replacementManifestBaseUrl, shouldShowDeprecatedBridgeNotice, shouldUseReplacementManifest } from './migrationNotice';
import { macUpdateInstallerScript } from './updatesInstaller';

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
const promptedUpdateVersionStateKey = 'backboard.updates.lastPromptedVersion';
const updateLockOwnerFileName = 'owner.json';
const updateLockMissingOwnerGraceMs = 60_000;
let backboardUpdateOutput: vscode.OutputChannel | undefined;
let backboardUpdateContext: vscode.ExtensionContext | undefined;

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

export function initializeBackboardUpdates(context: vscode.ExtensionContext, output: vscode.OutputChannel | undefined): void {
	backboardUpdateOutput = output;
	backboardUpdateContext = context;
	// The deprecated Bagel bridge is intentionally a manual certificate migration.
	// It must show only the direct-DMG notice: offering Install and Restart here
	// sends the user through the cross-certificate in-place updater that this
	// bridge exists to avoid.
	if (showDeprecatedBridgeNotice(context)) {
		backboardUpdateOutput?.appendLine('[updates] automatic updater disabled for deprecated Alpha bridge');
		return;
	}
	backboardUpdateStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
	context.subscriptions.push(backboardUpdateStatusItem);
	backboardUpdateCheckStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	backboardUpdateCheckStatusItem.command = 'backboard.checkForUpdates';
	context.subscriptions.push(backboardUpdateCheckStatusItem);
	updateBackboardUpdateCheckStatusItem(false);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(true)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.installAvailableUpdate', () => installAvailableBackboardUpdate()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.cancelUpdate', () => backboardUpdateCancellation?.abort()));
	context.subscriptions.push({ dispose: () => backboardUpdateCancellation?.abort() });
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
let backboardUpdateCancellation: AbortController | undefined;
let backboardUpdateCheckInProgress = false;
let availableBackboardUpdate: UpdateManifest | undefined;
let backboardUpdateStatusItem: vscode.StatusBarItem | undefined;
let backboardUpdateCheckStatusItem: vscode.StatusBarItem | undefined;
async function checkBackboardUpdates(manual: boolean): Promise<void> {
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
		if (!isNewerVersion(manifest.version, currentVersion)) {
			await setAvailableBackboardUpdate(undefined);
			if (manual) {
				vscode.window.setStatusBarMessage(`Backboard Studio is up to date (${currentVersion}).`, 4000);
			}
			return;
		}

		await setAvailableBackboardUpdate(manifest);
		const canInstall = canInstallBackboardUpdate();
		if (!manual && backboardUpdateContext?.globalState.get<string>(promptedUpdateVersionStateKey) === manifest.version) {
			return;
		}
		if (!manual) {
			try {
				await backboardUpdateContext?.globalState.update(promptedUpdateVersionStateKey, manifest.version);
			} catch (error) {
				backboardUpdateOutput?.appendLine(`[updates] could not persist prompted update version: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const message = `Backboard Studio ${manifest.version} is available. Current version: ${currentVersion}.`;
		const actions = canInstall ? ['Install and Restart', 'Download DMG', 'Copy Link', 'Later'] : ['Download DMG', 'Copy Link', 'Later'];
		const choice = await vscode.window.showInformationMessage(message, ...actions);
		if (choice === 'Install and Restart') {
			await installBackboardUpdate(manifest);
		} else if (choice === 'Download DMG') {
			await vscode.env.openExternal(vscode.Uri.parse(manifest.url));
		} else if (choice === 'Copy Link') {
			await vscode.env.clipboard.writeText(manifest.url);
			await vscode.window.showInformationMessage('Backboard Studio update link copied.');
		}
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

async function setAvailableBackboardUpdate(manifest: UpdateManifest | undefined): Promise<void> {
	availableBackboardUpdate = manifest;
	await vscode.commands.executeCommand('setContext', 'backboard.updateAvailable', Boolean(manifest));
	if (!backboardUpdateStatusItem) {
		return;
	}
	if (!manifest) {
		backboardUpdateStatusItem.hide();
		return;
	}
	backboardUpdateStatusItem.text = `$(cloud-download) Update ${manifest.version}`;
	backboardUpdateStatusItem.tooltip = `Install Backboard Studio ${manifest.version}`;
	backboardUpdateStatusItem.hide();
}

async function installAvailableBackboardUpdate(): Promise<void> {
	if (!availableBackboardUpdate) {
		await checkBackboardUpdates(true);
		return;
	}
	if (canInstallBackboardUpdate()) {
		await installBackboardUpdate(availableBackboardUpdate);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(availableBackboardUpdate.url));
}

function canInstallBackboardUpdate(): boolean {
	if (process.platform !== 'darwin') {
		return false;
	}
	const appPath = currentMacAppPath();
	return Boolean(appPath && isSupportedMacBackboardAppName(path.basename(appPath)));
}

async function installBackboardUpdate(manifest: UpdateManifest): Promise<void> {
	if (backboardUpdateInstallInProgress) {
		await vscode.window.showInformationMessage('Backboard Studio update installation is already running.');
		return;
	}
	const appPath = currentMacAppPath();
	if (!appPath || !isSupportedMacBackboardAppName(path.basename(appPath))) {
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
		const dmgPath = path.join(updateDirectory, `Backboard-Studio-${manifest.version}.dmg`);
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
				if (fs.existsSync(dmgPath)) {
					try {
						progress.report({ message: vscode.l10n.t('Verifying downloaded update…') });
						await verifyBackboardUpdate(dmgPath, manifest, signal);
						cachedDownloadValid = true;
					} catch (error) {
						signal.throwIfAborted();
						await fs.promises.rm(dmgPath, { force: true });
					}
				}
				if (!cachedDownloadValid) {
					const partialDmgPath = path.join(updateDirectory, `.Backboard-Studio-${manifest.version}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.partial`);
					try {
						progress.report({ message: vscode.l10n.t('Downloading update…') });
						await downloadBackboardUpdate(manifest.url, partialDmgPath, progress, signal);
						progress.report({ message: vscode.l10n.t('Verifying downloaded update…') });
						await verifyBackboardUpdate(partialDmgPath, manifest, signal);
						signal.throwIfAborted();
						await fs.promises.rename(partialDmgPath, dmgPath);
					} finally {
						await fs.promises.rm(partialDmgPath, { force: true });
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
		}, async () => stageMacBackboardInstaller(dmgPath, appPath, manifest.version, acquiredInstallLock));
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
	const appKey = path.basename(appPath, '.app').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
	const versionKey = manifest.version.replace(/[^a-zA-Z0-9._-]/g, '_');
	const digestKey = manifest.sha256?.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16) || 'unverified';
	const directory = path.join(os.tmpdir(), 'backboard-studio-update-cache', appKey, `${versionKey}-${digestKey}`);
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	return directory;
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
	await pipeline(response, fs.createWriteStream(destination, { mode: 0o600 }), { signal });
}

async function verifyBackboardUpdate(dmgPath: string, manifest: UpdateManifest, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const stat = await fs.promises.stat(dmgPath);
	if (manifest.size_bytes !== undefined && stat.size !== manifest.size_bytes) {
		throw new Error(`Downloaded update size mismatch. Expected ${manifest.size_bytes} bytes, got ${stat.size}.`);
	}
	if (manifest.sha256) {
		const actualSha256 = await sha256File(dmgPath, signal);
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
	const logPath = path.join(os.tmpdir(), 'backboard-studio-update.log');
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
	await waitForMacInstallerReady(child, statusPath, logPath);
	child.unref();
}

function waitForMacInstallerReady(child: cp.ChildProcess, statusPath: string, logPath: string): Promise<void> {
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
				const logLines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
				detail = logLines.at(-1) ?? '';
			} catch {
				// The installer may fail before opening its log.
			}
			return new Error(detail ? `Update preparation failed: ${detail}` : 'Update preparation failed.');
		};
		const checkStatus = (): void => {
			try {
				const status = fs.readFileSync(statusPath, 'utf8').trim();
				if (status === 'ready') {
					finish();
				} else if (status === 'failed') {
					finish(installerFailure());
				}
			} catch {
				// The detached installer creates the status file after its preflight checks.
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
			child.kill('SIGTERM');
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
