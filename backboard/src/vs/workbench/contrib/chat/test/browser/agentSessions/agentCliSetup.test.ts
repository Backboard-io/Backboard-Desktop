/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentCliSetupService, CHATGPT_SUBSCRIPTION_SETUP_ID, CLAUDE_SUBSCRIPTION_SETUP_ID, claudeSubscriptionLoginShellCommand } from '../../../browser/agentSessions/agentCliSetup.js';

suite('Agent CLI setup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('offers distinct ChatGPT and Claude subscription connection routes', () => {
		const service = new AgentCliSetupService(
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);

		const candidates = service.getSetupCandidates(new Set(['backboard']));

		assert.deepStrictEqual(candidates
			.map(candidate => candidate.id)
			.filter(id => id === CHATGPT_SUBSCRIPTION_SETUP_ID || id === CLAUDE_SUBSCRIPTION_SETUP_ID), [
			CHATGPT_SUBSCRIPTION_SETUP_ID,
			CLAUDE_SUBSCRIPTION_SETUP_ID,
		]);
	});

	test('builds Claude login commands with PATH and native-install fallbacks', () => {
		const posix = claudeSubscriptionLoginShellCommand(false);
		const windows = claudeSubscriptionLoginShellCommand(true);

		assert.ok(posix.includes('command -v claude'));
		assert.ok(posix.includes('$HOME/.local/bin/claude'));
		assert.ok(posix.includes('auth login --claudeai'));
		assert.ok(windows.includes('Get-Command claude'));
		assert.ok(windows.includes('$env:USERPROFILE\\.local\\bin\\claude.exe'));
		assert.ok(windows.includes('auth login --claudeai'));
	});

	test('uses an existing Claude subscription without opening OAuth', async () => {
		const commands: string[] = [];
		const notifications: string[] = [];
		const service = new AgentCliSetupService(
			{ createTerminal: async () => { throw new Error('OAuth should not open'); } } as never,
			{ executeAgentCommand: async ({ command }: { command: string }) => {
				commands.push(command);
				return { message: 'connected', requiresSignIn: false };
			} } as never,
			{ confirm: async () => ({ confirmed: true }) } as never,
			{ withProgress: async (_options: unknown, task: () => Promise<unknown>) => task() } as never,
			{} as never, {} as never,
			{ info: (message: string) => notifications.push(message), error: (message: string) => notifications.push(message) } as never,
			{} as never, {} as never, { error: () => {} } as never,
		);
		await service.beginSetup(CLAUDE_SUBSCRIPTION_SETUP_ID);
		assert.deepStrictEqual({ commands, notifications }, { commands: ['claudeSubscription.check', 'claudeSubscription.enable'], notifications: ['connected'] });
	});

	test('runs Claude OAuth in a hidden terminal, pastes the code, then enables Backboard', async () => {
		const commands: { provider: string; command: string }[] = [];
		const sent: string[] = [];
		const opened: string[] = [];
		const dataEmitter = disposables.add(new Emitter<string>());
		const exitEmitter = disposables.add(new Emitter<number | undefined>());
		const terminal = {
			onData: dataEmitter.event,
			onExit: exitEmitter.event,
			sendText: (text: string) => {
				sent.push(text);
				if (sent.length === 1) {
					queueMicrotask(() => dataEmitter.fire('Open https://claude.ai/oauth/authorize?state=test to continue\nPaste code here if prompted >'));
				} else {
					exitEmitter.fire(0);
				}
			},
			dispose: () => undefined,
		};
		const service = new AgentCliSetupService(
			{ createTerminal: async () => terminal } as never,
			{
				executeAgentCommand: async (command: { provider: string; command: string }) => {
					commands.push(command);
					return { message: 'connected', requiresSignIn: command.command === 'claudeSubscription.check' };
				},
			} as never,
			{ confirm: async () => ({ confirmed: true }) } as never,
			{ withProgress: async (_options: unknown, task: () => Promise<unknown>) => task() } as never,
			{ input: async () => ' pasted-code ' } as never,
			{ open: async (uri: URI) => { opened.push(uri.toString(true)); return true; } } as never,
			{ info: () => undefined } as never,
			{} as never,
			{ userHome: async () => URI.file('/tmp') } as never,
			{ error: () => undefined } as never,
		);

		await service.beginSetup(CLAUDE_SUBSCRIPTION_SETUP_ID);

		assert.deepStrictEqual(commands, [{ provider: 'backboard', command: 'claudeSubscription.check' }, { provider: 'backboard', command: 'claudeSubscription.enable' }]);
		assert.deepStrictEqual(opened, ['https://claude.ai/oauth/authorize?state=test']);
		assert.ok(sent[0].includes('auth login --claudeai'));
		assert.ok(sent[0].includes('$HOME/.local/bin/claude'));
		assert.strictEqual(sent[1], 'pasted-code');
	});
});
