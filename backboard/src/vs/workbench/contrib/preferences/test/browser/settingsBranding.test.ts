/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sanitizeSettingsText } from '../../common/settingsBranding.js';

suite('settingsBranding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sanitizeSettingsText scrubs VS Code links and text', () => {
		assert.deepStrictEqual({
			docsLink: sanitizeSettingsText('See [the docs](https://code.visualstudio.com/docs/editor/codebasics#_find) for more.', 'Backboard Studio'),
			apiDocsLink: sanitizeSettingsText('See [API](https://code.visualstudio.com/api/references/vscode-api).', 'Backboard Studio'),
			marketingLink: sanitizeSettingsText('Get it from [our website](https://code.visualstudio.com).', 'Backboard Studio'),
			akaLink: sanitizeSettingsText('Read the [privacy statement](https://aka.ms/privacy).', 'Backboard Studio'),
			bareDocsLink: sanitizeSettingsText('More at https://code.visualstudio.com/docs/terminal/basics today.', 'Backboard Studio'),
			bareOtherLink: sanitizeSettingsText('More at https://marketplace.visualstudio.com/items today.', 'Backboard Studio'),
			brandText: sanitizeSettingsText('Controls whether VS Code restarts automatically.', 'Backboard Studio'),
			brandLong: sanitizeSettingsText('Visual Studio Code will reload.', 'Backboard Studio'),
			untouched: sanitizeSettingsText('Controls the [editor](#editor.fontSize) font.', 'Backboard Studio'),
		}, {
			docsLink: 'See [the docs](https://docs.backboard.io) for more.',
			apiDocsLink: 'See [API](https://docs.backboard.io).',
			marketingLink: 'Get it from our website.',
			akaLink: 'Read the privacy statement.',
			bareDocsLink: 'More at https://docs.backboard.io today.',
			bareOtherLink: 'More at  today.',
			brandText: 'Controls whether Backboard Studio restarts automatically.',
			brandLong: 'Backboard Studio will reload.',
			untouched: 'Controls the [editor](#editor.fontSize) font.',
		});
	});
});
