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
import { CHATGPT_SUBSCRIPTION_SETUP_ID, CLAUDE_SUBSCRIPTION_SETUP_ID } from '../../browser/agentSessions/agentCliSetup.js';
import { ADD_PROVIDER_KEY_COMMAND_ID } from '../../browser/byokKeys/byokKeys.js';

suite('Backboard auth setup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>) {
		const calls: unknown[][] = [];
		const commands = new class extends mock<ICommandService>() {
			override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
				calls.push([id, ...args]);
				return await executeCommand(id, ...args) as T;
			}
		};
		const parent = document.createElement('div');
		disposables.add(renderBackboardAuthSetup(parent, commands, async () => { calls.push(['refresh']); }));
		const row = (target: string) => parent.querySelector<HTMLButtonElement>(`.backboard-connect-row[data-target="${target}"]`)!;
		return { calls, parent, row };
	}

	const settle = () => new Promise(resolve => setTimeout(resolve, 0));

	test('lists every way to connect inline', () => {
		const { parent } = setup(async () => undefined);
		assert.deepStrictEqual(
			[...parent.querySelectorAll<HTMLElement>('.backboard-connect-row')].map(row => row.dataset.target),
			isWindows ? ['backboard', 'key'] : ['backboard', 'chatgpt', 'claude', 'key'],
		);
	});

	test('sign-in and subscriptions run their flow directly, then refresh', async () => {
		const { calls, row } = setup(async () => undefined);
		row('backboard').click();
		await settle();
		if (!isWindows) {
			row('chatgpt').click();
			await settle();
			row('claude').click();
			await settle();
		}
		assert.deepStrictEqual(calls, [
			['backboard.signIn'], ['refresh'],
			...(!isWindows ? [
				['backboard.setupSubscription', CHATGPT_SUBSCRIPTION_SETUP_ID], ['refresh'],
				['backboard.setupSubscription', CLAUDE_SUBSCRIPTION_SETUP_ID], ['refresh'],
			] : []),
		]);
	});

	test('an API key is entered inline and saved without a pop-up', async () => {
		const { calls, parent, row } = setup(async () => undefined);
		row('key').click();
		const input = parent.querySelector<HTMLInputElement>('.backboard-connect-key-input')!;
		input.value = 'sk-abcdefghijklmnopqrstuvwxyz0123';
		input.dispatchEvent(new Event('input'));
		parent.querySelector<HTMLButtonElement>('.backboard-connect-key-save')!.click();
		await settle();
		assert.deepStrictEqual(calls, [[ADD_PROVIDER_KEY_COMMAND_ID, 'openai', 'sk-abcdefghijklmnopqrstuvwxyz0123'], ['refresh']]);
		assert.strictEqual(parent.querySelector('.backboard-connect-key-form'), null);
	});

	test('a rejected key keeps the form open with the reason and never refreshes', async () => {
		const { calls, parent, row } = setup(async () => { throw new Error('OpenAI rejected the key.'); });
		row('key').click();
		const input = parent.querySelector<HTMLInputElement>('.backboard-connect-key-input')!;
		input.value = 'sk-abcdefghijklmnopqrstuvwxyz0123';
		input.dispatchEvent(new Event('input'));
		parent.querySelector<HTMLButtonElement>('.backboard-connect-key-save')!.click();
		await settle();
		assert.deepStrictEqual({
			calls: calls.map(call => call[0]),
			note: parent.querySelector('.backboard-connect-key-note.error')?.textContent,
			keptDraft: parent.querySelector<HTMLInputElement>('.backboard-connect-key-input')?.value,
		}, {
			calls: [ADD_PROVIDER_KEY_COMMAND_ID],
			note: 'OpenAI rejected the key.',
			keptDraft: 'sk-abcdefghijklmnopqrstuvwxyz0123',
		});
	});
});
