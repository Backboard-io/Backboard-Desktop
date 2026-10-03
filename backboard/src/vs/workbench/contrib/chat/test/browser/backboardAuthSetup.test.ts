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
import { CHATGPT_SUBSCRIPTION_SETUP_ID, CHECK_CLAUDE_CODE_VERSION_COMMAND_ID, CLAUDE_SUBSCRIPTION_SETUP_ID, UPDATE_CLAUDE_CODE_COMMAND_ID } from '../../browser/agentSessions/agentCliSetup.js';
import { EMPTY_BACKBOARD_CONNECT_STATE, renderBackboardConnect } from '../../browser/backboardConnect.js';
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

	(isWindows ? test.skip : test)('an outdated Claude Code turns the Claude row into Update, which updates and refreshes', async () => {
		let updated = false;
		const calls: unknown[][] = [];
		const commands = new class extends mock<ICommandService>() {
			override async executeCommand<T>(id: string): Promise<T> {
				calls.push([id]);
				if (id === UPDATE_CLAUDE_CODE_COMMAND_ID) {
					updated = true;
				}
				return (id === CHECK_CLAUDE_CODE_VERSION_COMMAND_ID
					? { installed: updated ? '2.1.285' : '2.1.172', latest: '2.1.285', updateAvailable: !updated }
					: undefined) as T;
			}
		};
		const parent = document.createElement('div');
		const view = renderBackboardConnect(parent, commands, { ...EMPTY_BACKBOARD_CONNECT_STATE, claude: true }, { targets: ['claude'], onDidConnect: () => { calls.push(['refresh']); } });
		disposables.add(view.store);
		const row = () => parent.querySelector<HTMLButtonElement>('.backboard-connect-row[data-target="claude"]')!;
		const action = () => row().querySelector('.backboard-connect-action')!.textContent;
		const before = action();
		await settle();
		const outdated = { action: action(), description: row().querySelector('.backboard-connect-description')!.textContent };
		row().click();
		await settle();
		assert.deepStrictEqual({ before, outdated, after: action(), calls }, {
			before: 'Reconnect',
			outdated: { action: 'Update', description: 'Claude Code 2.1.172 is out of date. Update to see every model' },
			after: 'Reconnect',
			calls: [[CHECK_CLAUDE_CODE_VERSION_COMMAND_ID], [UPDATE_CLAUDE_CODE_COMMAND_ID], [CHECK_CLAUDE_CODE_VERSION_COMMAND_ID], ['refresh']],
		});
	});
});
