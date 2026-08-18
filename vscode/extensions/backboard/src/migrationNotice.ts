/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const deprecatedBridgeVersion = '2.5.9';
export const deprecatedSandboxBridgeAppName = 'Backboard Studio Sandbox.app';
export const deprecatedStableBridgeAppName = 'Backboard Studio.app';
export const replacementVersion = '2.5.10';
export const replacementManifestBaseUrl = 'https://backboard-ide-robert-cert.s3.ca-central-1.amazonaws.com/ide-releases';
export const replacementDownloadUrl = 'https://backboard-ide-robert-cert.s3.ca-central-1.amazonaws.com/ide-releases/stable/2.5.10/bbide/macos-aarch64/Backboard-Studio-aarch64.dmg';
export const deprecatedBridgeTitle = 'Backboard Studio Alpha is deprecated.';
export const deprecatedBridgeDetail = 'Download Backboard Studio Beta to continue. Your settings and projects will remain available.';
export const deprecatedBridgeDownloadAction = 'Download Beta';

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
		&& compareNumericVersions(version, replacementVersion) >= 0;
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
