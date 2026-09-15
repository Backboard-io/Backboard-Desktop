/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { BackboardAuthContextKeys, IBackboardAuthService } from '../../common/backboardAuth.js';
import { renderBackboardAuthSetup, renderBackboardAuthGate } from '../../browser/backboardAuthSetup.js';

suite('Backboard auth setup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	test('dashboard gate tracks sign-in without an extra mode switch', async () => {
		const context = disposables.add(new ContextKeyService(new TestConfigurationService()));
		BackboardAuthContextKeys.enabled.bindTo(context).set(true);
		const signedIn = BackboardAuthContextKeys.signedIn.bindTo(context);
		const alternative = BackboardAuthContextKeys.alternativeConfigured.bindTo(context);
		const calls: string[] = [];
		const commands = new class extends mock<ICommandService>() {
			override async executeCommand<T>(id: string): Promise<T> { calls.push(id); return undefined as T; }
		};
		const auth = new class extends mock<IBackboardAuthService>() { override async refresh(): Promise<void> {} };
		const parent = document.createElement('div');
		disposables.add(renderBackboardAuthGate(parent, commands, context, auth));
		const overlay = parent.querySelector<HTMLElement>('.backboard-auth-gate-overlay')!;
		assert.strictEqual(overlay.hidden, false);
		assert.strictEqual(parent.querySelector('.backboard-auth-switch-mode'), null);
		signedIn.set(true);
		assert.strictEqual(overlay.hidden, true);
		signedIn.set(false);
		assert.strictEqual(overlay.hidden, false);
		alternative.set(true);
		assert.strictEqual(overlay.hidden, true);
		assert.strictEqual(parent.classList.contains('backboard-auth-gate-active'), false);
	});

	for (const [index, command] of ['backboard.signIn', 'backboard.setupProviderKey'].entries()) {
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
	for (const windows of [true, false]) {
		test(`account actions for Windows=${windows}`, () => {
			const parent = document.createElement('div');
			const commands = new class extends mock<ICommandService>() { };
			disposables.add(renderBackboardAuthSetup(parent, commands, async () => undefined, windows));
			assert.deepStrictEqual(Array.from(parent.querySelectorAll('button')).map(button => button.textContent),
				windows ? ['Sign In', 'Use API Key'] : ['Sign In with SSO', 'Use API Key']);
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
