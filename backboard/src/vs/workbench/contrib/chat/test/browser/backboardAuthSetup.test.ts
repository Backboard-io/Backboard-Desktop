/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderBackboardAuthSetup } from '../../browser/backboardAuthSetup.js';

suite('Backboard auth setup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	for (const [index, command] of ['backboard.signIn', 'backboard.setupProviderKey', ...(!isWindows ? ['backboard.setupSubscription'] : [])].entries()) {
		test(`routes ${command} and refreshes credentials`, async () => {
			const calls: string[] = [];
			const commands = new class extends mock<ICommandService>() {
				override async executeCommand<T>(id: string): Promise<T> { calls.push(id); return false as T; }
			};
			const parent = document.createElement('div');
			disposables.add(renderBackboardAuthSetup(parent, commands, async () => { calls.push('refresh'); }));
			const buttons = parent.querySelectorAll('button');
			buttons[index].click();
			assert.ok(Array.from(buttons).every(button => button.disabled));
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual(calls, [command, 'refresh']);
			assert.ok(Array.from(buttons).every(button => !button.disabled));
		});
	}
	test('failed setup permits retry without displaying secrets', async () => {
		const commands = new class extends mock<ICommandService>() {
			override async executeCommand<T>(): Promise<T> { throw new Error('secret'); }
		};
		const parent = document.createElement('div');
		disposables.add(renderBackboardAuthSetup(parent, commands, async () => assert.fail('must not refresh')));
		parent.querySelector('button')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(parent.querySelector('[role=status]')!.textContent, 'Setup failed. Please try again.');
		assert.ok(Array.from(parent.querySelectorAll('button')).every(button => !button.disabled));
	});
});
