/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { renderBackboardAccountActions } from '../../browser/backboardAccountActions.js';
import '../../browser/media/settingsEditor2.css';

suite('Backboard account settings', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const width of [240, 440, 768]) {
		test(`account buttons fit and run their commands at ${width}px`, async () => {
			const commands: string[] = [];
			const container = document.createElement('div');
			container.className = 'settings-editor';
			container.style.width = `${width}px`;
			document.body.appendChild(container);
			store.add({ dispose: () => container.remove() });
			renderBackboardAccountActions(container, {
				executeCommand: async (command: string) => { commands.push(command); },
			} as ICommandService, store.add(new DisposableStore()));
			const buttons = Array.from(container.querySelectorAll<HTMLElement>('.monaco-button'));
			assert.deepStrictEqual(buttons.map(button => button.textContent), ['Sign Out', 'Delete Account']);
			for (const button of buttons) {
				const bounds = button.getBoundingClientRect();
				const parent = container.getBoundingClientRect();
				assert.ok(bounds.width > 0 && bounds.left >= parent.left && bounds.right <= parent.right);
				button.click();
				await Promise.resolve();
			}
			assert.deepStrictEqual(commands, ['backboard.signOut', 'backboard.deleteAccount']);
			assert.ok(container.scrollWidth <= width, 'no horizontal overflow');
		});
	}
});
