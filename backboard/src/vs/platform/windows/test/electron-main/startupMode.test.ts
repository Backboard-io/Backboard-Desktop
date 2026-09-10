/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WindowMode } from '../../../window/electron-main/window.js';
import { shouldOpenSimpleOnStartup } from '../../electron-main/startupMode.js';
import { IOpenConfiguration, OpenContext } from '../../electron-main/windows.js';
import { IWindowState } from '../../electron-main/windowsStateHandler.js';

suite('Backboard startup mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const config: IOpenConfiguration = { context: OpenContext.DESKTOP, initialStartup: true, cli: { _: [] } };
	const savedWindow: IWindowState = { uiState: { mode: WindowMode.Normal, x: 0, y: 0, width: 1000, height: 800 } };

	test('fresh launch selects Simple before creating the window', () => {
		assert.strictEqual(shouldOpenSimpleOnStartup(config, { openedWindows: [] }), true);
	});

	test('saved windows are restored without overriding their mode', () => {
		assert.deepStrictEqual([
			shouldOpenSimpleOnStartup(config, { openedWindows: [], lastActiveWindow: savedWindow }),
			shouldOpenSimpleOnStartup(config, { openedWindows: [savedWindow] }),
		], [false, false]);
	});

	test('explicit window, file, profile, and development requests take precedence', () => {
		const requests: IOpenConfiguration[] = [
			{ ...config, initialStartup: false },
			{ ...config, optimusWindow: true },
			{ ...config, forceEmpty: true },
			{ ...config, forceNewWindow: true },
			{ ...config, forceProfile: 'Test' },
			{ ...config, forceTempProfile: true },
			{ ...config, remoteAuthority: 'ssh-remote+test' },
			{ ...config, cli: { _: ['/project'] } },
			{ ...config, cli: { _: [], 'file-uri': ['file:///file.ts'] } },
			{ ...config, cli: { _: [], 'folder-uri': ['file:///project'] } },
			{ ...config, cli: { _: [], extensionDevelopmentPath: ['/extension'] } },
			{ ...config, cli: { _: [], extensionTestsPath: '/tests' } },
			{ ...config, urisToOpen: [{ workspaceUri: URI.file('/agents.code-workspace') }] },
		];
		assert.deepStrictEqual(requests.map(request => shouldOpenSimpleOnStartup(request, { openedWindows: [] })), requests.map(() => false));
	});
});
