/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const deprecatedBridgeVersion = '2.5.9';
export const deprecatedSandboxBridgeAppName = 'Backboard Studio Sandbox.app';
export const deprecatedStableBridgeAppName = 'Backboard Studio.app';
export const replacementManifestMinimumVersion = '2.5.10';
export const replacementReleaseVersion = '3.0.0';
export const replacementManifestBaseUrl = 'https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases';
export const deprecatedBridgeTitle = 'Backboard Studio Alpha is deprecated.';
export const deprecatedBridgeDetail = 'Download Backboard Studio Beta to continue. Your settings and projects will remain available.';
export const deprecatedBridgeDownloadAction = 'Download Beta';

export function getReplacementDownloadUrl(architecture: string): string | undefined {
	const releaseArchitecture = architecture === 'arm64'
		? 'aarch64'
		: architecture === 'x64'
			? 'x86_64'
			: undefined;
	if (!releaseArchitecture) {
		return undefined;
	}
	return `${replacementManifestBaseUrl}/stable/${replacementReleaseVersion}/bbide/macos-${releaseArchitecture}/Backboard-Studio-${releaseArchitecture}.dmg`;
}

export function shouldShowDeprecatedBridgeNotice(
	version: string,
	channel: string,
	appName: string,
	platform: NodeJS.Platform
): boolean {
	return platform === 'darwin'
		&& version === deprecatedBridgeVersion
		&& ((channel === 'sandbox' && appName === deprecatedSandboxBridgeAppName)
			|| (channel === 'stable' && appName === deprecatedStableBridgeAppName));
}

export function shouldUseReplacementManifest(
	version: string,
	channel: string,
	appName: string,
	platform: NodeJS.Platform
): boolean {
	return platform === 'darwin'
		&& ((channel === 'sandbox' && appName === deprecatedSandboxBridgeAppName)
			|| (channel === 'stable' && appName === deprecatedStableBridgeAppName))
		&& compareNumericVersions(version, replacementManifestMinimumVersion) >= 0;
}

function compareNumericVersions(left: string, right: string): number {
	const parse = (value: string): number[] | undefined => {
		const match = /^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/.exec(value.trim());
		return match ? match.slice(1).map(component => Number.parseInt(component, 10)) : undefined;
	};
	const leftParts = parse(left);
	const rightParts = parse(right);
	if (!leftParts || !rightParts) {
		return -1;
	}
	for (let index = 0; index < 3; index++) {
		if (leftParts[index] !== rightParts[index]) {
			return leftParts[index] - rightParts[index];
		}
	}
	return 0;
}
