/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	deprecatedBridgeVersion,
	deprecatedBridgeDetail,
	deprecatedBridgeDownloadAction,
	deprecatedBridgeTitle,
	deprecatedSandboxBridgeAppName,
	deprecatedStableBridgeAppName,
	replacementDownloadUrl,
	replacementManifestBaseUrl,
	shouldShowDeprecatedBridgeNotice,
	shouldUseReplacementManifest
} from '../migrationNotice';

describe('deprecated bridge notice', () => {
	test('uses concise Alpha-to-Beta migration copy', () => {
		assert.deepStrictEqual({
			title: deprecatedBridgeTitle,
			detail: deprecatedBridgeDetail,
			action: deprecatedBridgeDownloadAction
		}, {
			title: 'Backboard Studio Alpha is deprecated.',
			detail: 'Download Backboard Studio Beta to continue. Your settings and projects will remain available.',
			action: 'Download Beta'
		});
	});

	test('only appears in the macOS 2.5.9 sandbox and stable bridges', () => {
		const results = [
			shouldShowDeprecatedBridgeNotice(deprecatedBridgeVersion, 'sandbox', deprecatedSandboxBridgeAppName, 'darwin'),
			shouldShowDeprecatedBridgeNotice(deprecatedBridgeVersion, 'stable', deprecatedStableBridgeAppName, 'darwin'),
			shouldShowDeprecatedBridgeNotice('2.5.10', 'sandbox', deprecatedSandboxBridgeAppName, 'darwin'),
			shouldShowDeprecatedBridgeNotice(deprecatedBridgeVersion, 'stable', deprecatedSandboxBridgeAppName, 'darwin'),
			shouldShowDeprecatedBridgeNotice(deprecatedBridgeVersion, 'sandbox', deprecatedSandboxBridgeAppName, 'win32')
		];

		assert.deepStrictEqual(results, [true, true, false, false, false]);
	});

	test('links directly to the replacement 2.5.10 stable M-series DMG', () => {
		const url = new URL(replacementDownloadUrl);
		assert.deepStrictEqual({
			protocol: url.protocol,
			host: url.host,
			path: url.pathname
		}, {
			protocol: 'https:',
			host: 'backboard-ide-robert-cert.s3.ca-central-1.amazonaws.com',
			path: '/ide-releases/stable/2.5.10/bbide/macos-aarch64/Backboard-Studio-aarch64.dmg'
		});
	});

	test('routes replacement sandbox and stable releases to the dedicated update manifest', () => {
		assert.equal(shouldUseReplacementManifest('2.5.9', 'sandbox', deprecatedSandboxBridgeAppName, 'darwin'), false);
		assert.equal(shouldUseReplacementManifest('2.5.10', 'sandbox', deprecatedSandboxBridgeAppName, 'darwin'), true);
		assert.equal(shouldUseReplacementManifest('2.5.10', 'stable', deprecatedStableBridgeAppName, 'darwin'), true);
		assert.equal(shouldUseReplacementManifest('2.6.0', 'stable', deprecatedSandboxBridgeAppName, 'darwin'), false);
		assert.equal(shouldUseReplacementManifest('2.6.0', 'sandbox', deprecatedStableBridgeAppName, 'darwin'), false);
		assert.equal(shouldUseReplacementManifest('2.6.0', 'sandbox', deprecatedSandboxBridgeAppName, 'win32'), false);
		assert.equal(replacementManifestBaseUrl, 'https://backboard-ide-robert-cert.s3.ca-central-1.amazonaws.com/ide-releases');
	});
});
