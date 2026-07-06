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

interface UpdateManifest {
	readonly version: string;
	readonly url: string;
	readonly sha256?: string;
	readonly size_bytes?: number;
}

const defaultUpdateManifestBaseUrl = 'https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases';
const stableUpdateChannel = 'stable';
const sandboxUpdateChannel = 'sandbox';
const supportedUpdateChannels = new Set([stableUpdateChannel, sandboxUpdateChannel]);
const promptedUpdateVersions = new Set<string>();
let backboardUpdateOutput: vscode.OutputChannel | undefined;

export function initializeBackboardUpdates(context: vscode.ExtensionContext, output: vscode.OutputChannel | undefined): void {
	backboardUpdateOutput = output;
	backboardUpdateStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
	context.subscriptions.push(backboardUpdateStatusItem);
	backboardUpdateCheckStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	backboardUpdateCheckStatusItem.command = 'backboard.checkForUpdates';
	context.subscriptions.push(backboardUpdateCheckStatusItem);
	updateBackboardUpdateCheckStatusItem(false);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(true)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.installAvailableUpdate', () => installAvailableBackboardUpdate()));
	startBackboardUpdateChecks(context);
}

let backboardUpdateInstallInProgress = false;
let backboardUpdateCheckInProgress = false;
let availableBackboardUpdate: UpdateManifest | undefined;
let backboardUpdateStatusItem: vscode.StatusBarItem | undefined;
let backboardUpdateCheckStatusItem: vscode.StatusBarItem | undefined;
function startBackboardUpdateChecks(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('backboard').get<boolean>('updates.enabled', true)) {
		return;
	}

	const initialTimer = setTimeout(() => {
		void checkBackboardUpdates(false);
	}, 10_000);
	context.subscriptions.push({ dispose: () => clearTimeout(initialTimer) });

	const configuredMinutes = vscode.workspace.getConfiguration('backboard').get<number>('updates.checkIntervalMinutes', 360);
	const intervalMinutes = Number.isFinite(configuredMinutes) ? Math.max(15, configuredMinutes) : 360;
	const timer = setInterval(() => {
		void checkBackboardUpdates(false);
	}, intervalMinutes * 60 * 1000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function checkBackboardUpdates(manual: boolean): Promise<void> {
	if (backboardUpdateCheckInProgress) {
		if (manual) {
			await vscode.window.showInformationMessage('Backboard Studio update check is already running.');
		}
		return;
	}

	backboardUpdateCheckInProgress = true;
	updateBackboardUpdateCheckStatusItem(manual);
	try {
		const manifestUrl = getBackboardUpdateManifestUrl();
		if (!manifestUrl) {
			if (manual) {
				await vscode.window.showWarningMessage('Backboard Studio updates are not supported on this platform.');
			}
			return;
		}

		backboardUpdateOutput?.appendLine(`[updates] checking ${manifestUrl}`);
		const manifest = await fetchBackboardUpdateManifest(manifestUrl);
		const currentVersion = readCurrentAppVersion();
		backboardUpdateOutput?.appendLine(`[updates] current=${currentVersion} remote=${manifest.version}`);
		if (!isNewerVersion(manifest.version, currentVersion)) {
			await setAvailableBackboardUpdate(undefined);
			if (manual) {
				await vscode.window.showInformationMessage(`Backboard Studio is up to date. Current version: ${currentVersion}.`);
			}
			return;
		}

		await setAvailableBackboardUpdate(manifest);
		if (!manual && promptedUpdateVersions.has(manifest.version)) {
			return;
		}
		if (!manual) {
			promptedUpdateVersions.add(manifest.version);
		}

		const canInstall = canInstallBackboardUpdate();
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
			await vscode.window.showWarningMessage(`Could not check for Backboard Studio updates: ${message}`);
		}
	} finally {
		backboardUpdateCheckInProgress = false;
		updateBackboardUpdateCheckStatusItem(false);
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
	backboardUpdateCheckStatusItem.show();
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
	backboardUpdateStatusItem.show();
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
	try {
		const updateDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backboard-studio-update-'));
		const dmgPath = path.join(updateDirectory, `Backboard-Studio-${manifest.version}.dmg`);
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Downloading Backboard Studio ${manifest.version}`,
			cancellable: false
		}, async progress => {
			await downloadBackboardUpdate(manifest.url, dmgPath, progress);
		});
		await verifyBackboardUpdate(dmgPath, manifest);
		await stageMacBackboardInstaller(dmgPath, appPath, manifest.version);
		await vscode.window.showInformationMessage(`Backboard Studio ${manifest.version} is verified. Restarting to install.`);
		await vscode.commands.executeCommand('workbench.action.quit');
	} catch (error) {
		backboardUpdateInstallInProgress = false;
		const message = error instanceof Error ? error.message : String(error);
		backboardUpdateOutput?.appendLine(`[updates] install failed: ${message}`);
		await vscode.window.showWarningMessage(`Could not install Backboard Studio update: ${message}`);
	}
}

function currentMacAppPath(): string | undefined {
	const match = /^(.+?\.app)(?:\/|$)/.exec(process.execPath);
	return match?.[1];
}

function isSupportedMacBackboardAppName(appName: string): boolean {
	return appName === 'Backboard Studio.app' || appName === 'Backboard Studio Sandbox.app';
}

function downloadBackboardUpdate(rawUrl: string, destination: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = downloadWithRedirects(rawUrl, destination, progress, 5, resolve, reject);
		request.on('error', reject);
	});
}

function downloadWithRedirects(
	rawUrl: string,
	destination: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	redirectLimit: number,
	resolve: () => void,
	reject: (error: Error) => void
): http.ClientRequest {
	const url = new URL(rawUrl);
	const client = url.protocol === 'http:' ? http : https;
	const request = client.get(url, { headers: { 'User-Agent': `Backboard-Studio/${readCurrentAppVersion()}` } }, response => {
		const statusCode = response.statusCode ?? 0;
		const location = response.headers.location;
		if (statusCode >= 300 && statusCode < 400 && location && redirectLimit > 0) {
			response.resume();
			const nextRequest = downloadWithRedirects(new URL(location, url).toString(), destination, progress, redirectLimit - 1, resolve, reject);
			nextRequest.on('error', reject);
			return;
		}
		if (statusCode < 200 || statusCode >= 300) {
			response.resume();
			reject(new Error(`Update download failed with HTTP ${statusCode}.`));
			return;
		}

		const expectedBytes = Number(response.headers['content-length']) || undefined;
		let downloadedBytes = 0;
		let lastPercent = 0;
		const file = fs.createWriteStream(destination, { mode: 0o600 });
		response.on('data', chunk => {
			const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
			downloadedBytes += size;
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
		response.pipe(file);
		file.on('finish', () => file.close(error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		}));
		file.on('error', error => {
			response.destroy();
			reject(error);
		});
	});
	request.setTimeout(120_000, () => {
		request.destroy(new Error('Update download timed out.'));
	});
	return request;
}

async function verifyBackboardUpdate(dmgPath: string, manifest: UpdateManifest): Promise<void> {
	const stat = await fs.promises.stat(dmgPath);
	if (manifest.size_bytes !== undefined && stat.size !== manifest.size_bytes) {
		throw new Error(`Downloaded update size mismatch. Expected ${manifest.size_bytes} bytes, got ${stat.size}.`);
	}
	if (manifest.sha256) {
		const actualSha256 = await sha256File(dmgPath);
		if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
			throw new Error(`Downloaded update SHA-256 mismatch. Expected ${manifest.sha256}, got ${actualSha256}.`);
		}
	}
}

function sha256File(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

async function stageMacBackboardInstaller(dmgPath: string, appPath: string, version: string): Promise<void> {
	const installerPath = path.join(path.dirname(dmgPath), 'install-backboard-update.sh');
	const logPath = path.join(os.tmpdir(), 'backboard-studio-update.log');
	const appName = path.basename(appPath);
	const bundleIdentifier = appName === 'Backboard Studio Sandbox.app' ? 'io.backboard.studio.sandbox' : 'io.backboard.studio';
	await fs.promises.writeFile(installerPath, macUpdateInstallerScript(), { mode: 0o700 });
	const child = cp.spawn('/bin/zsh', [installerPath, dmgPath, appPath, String(process.pid), version, logPath, appName, bundleIdentifier], {
		detached: true,
		stdio: 'ignore'
	});
	child.unref();
}

function macUpdateInstallerScript(): string {
	return `#!/bin/zsh
set -euo pipefail

DMG_PATH="$1"
APP_PATH="$2"
CURRENT_PID="$3"
VERSION="$4"
LOG_PATH="$5"
APP_NAME="\${6:-Backboard Studio.app}"
BUNDLE_IDENTIFIER="\${7:-io.backboard.studio}"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/backboard-studio-update-mount.XXXXXX)"

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installing Backboard Studio $VERSION"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

/usr/bin/hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
SOURCE_APP="$MOUNT_POINT/$APP_NAME"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Mounted DMG did not contain $APP_NAME"
  exit 1
fi

/usr/bin/osascript -e "tell application id \\"$BUNDLE_IDENTIFIER\\" to quit" >/dev/null 2>&1 || true
for _ in {1..120}; do
  if ! /bin/ps -p "$CURRENT_PID" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done
/usr/bin/pkill -f "$APP_PATH/Contents/" >/dev/null 2>&1 || true

replace_app() {
  /bin/rm -rf "$APP_PATH"
  /usr/bin/ditto "$SOURCE_APP" "$APP_PATH"
  /bin/chmod -R u+rwX "$APP_PATH" >/dev/null 2>&1 || true
  /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true
}

if [[ -w "$(dirname "$APP_PATH")" || -w "$APP_PATH" ]]; then
  replace_app
else
  HELPER="$(/usr/bin/mktemp /tmp/backboard-studio-update-elevated.XXXXXX.sh)"
  shell_quote() {
    /usr/bin/python3 -c 'import shlex, sys; print(shlex.quote(sys.argv[1]))' "$1"
  }
  {
    echo '#!/bin/zsh'
    echo 'set -euo pipefail'
    printf 'SOURCE_APP=%s\\n' "$(shell_quote "$SOURCE_APP")"
    printf 'APP_PATH=%s\\n' "$(shell_quote "$APP_PATH")"
    echo '/bin/rm -rf "$APP_PATH"'
    echo '/usr/bin/ditto "$SOURCE_APP" "$APP_PATH"'
    echo '/bin/chmod -R a+rX "$APP_PATH" >/dev/null 2>&1 || true'
    echo '/usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true'
  } > "$HELPER"
  /bin/chmod 700 "$HELPER"
  /usr/bin/osascript -e "do shell script \\"/bin/zsh $HELPER\\" with administrator privileges"
  /bin/rm -f "$HELPER"
fi

cleanup
/usr/bin/open "$APP_PATH"
echo "[$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')] Installed Backboard Studio $VERSION"
`;
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

	const configuredBaseUrl = config.get<string>('updates.manifestBaseUrl', defaultUpdateManifestBaseUrl).trim();
	const manifestBaseUrl = (process.env.BBIDE_UPDATE_MANIFEST_BASE_URL || process.env.BACKBOARD_UPDATE_MANIFEST_BASE_URL || configuredBaseUrl || defaultUpdateManifestBaseUrl)
		.trim()
		.replace(/\/+$/, '');
	const channel = getBackboardUpdateChannel(config);
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

function readCurrentAppVersion(): string {
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
