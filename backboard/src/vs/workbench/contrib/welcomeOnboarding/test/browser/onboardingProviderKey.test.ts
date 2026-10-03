/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

suite('Backboard onboarding provider key', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const connected of [true, false]) {
		test(`logging in ${connected ? 'advances when connected' : 'stays on onboarding when cancelled'}`, async () => {
			const harness = Object.create(OnboardingVariationA.prototype) as {
				stepDisposables: DisposableStore;
				stepFocusableElements: HTMLElement[];
				postOnboardingSignInPromptShown: boolean;
				commandService: { executeCommand(id: string): Promise<boolean> };
				billingService: { refresh(): Promise<void>; status: { plan: { cancel_at_period_end: boolean } } };
				_logAction(): void;
				_advanceOrComplete(): void;
				_renderConnectAIStep(container: HTMLElement): void;
			};
			const container = document.body.appendChild(document.createElement('div'));
			disposables.add(toDisposable(() => container.remove()));
			harness.stepDisposables = disposables.add(new DisposableStore());
			harness.stepFocusableElements = [];
			harness.postOnboardingSignInPromptShown = false;
			harness._logAction = () => undefined;
			let advanced = false;
			harness._advanceOrComplete = () => { advanced = true; };
			const calls: string[] = [];
			harness.commandService = { executeCommand: async id => { calls.push(id); return connected; } };
			// Already subscribed, so the plan offer is skipped and sign-in moves straight on.
			harness.billingService = { refresh: async () => { }, status: { plan: { cancel_at_period_end: false } } };
			harness._renderConnectAIStep(container);
			const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Log in')!;
			button.click();
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual({ calls, advanced, suppressSignIn: harness.postOnboardingSignInPromptShown }, {
				calls: ['backboard.signIn'],
				advanced: connected, suppressSignIn: connected,
			});
			if (!connected) { assert.strictEqual(button.disabled, false); }
		});
	}

	for (const result of ['success', 'failure', 'dismissed'] as const) {
		test(`provider setup handles ${result}`, async () => {
			const harness = Object.create(OnboardingVariationA.prototype) as {
				stepDisposables: DisposableStore;
				stepFocusableElements: HTMLElement[];
				hasImportedApiKey: boolean;
				postOnboardingSignInPromptShown: boolean;
				commandService: { executeCommand(id: string, provider: string, key: string): Promise<boolean> };
				_logAction(): void;
				_advanceOrComplete(): void;
				_renderProviderKeySetup(container: HTMLElement): void;
			};
			const container = document.body.appendChild(document.createElement('div'));
			disposables.add(toDisposable(() => container.remove()));
			harness.stepDisposables = disposables.add(new DisposableStore());
			harness.stepFocusableElements = [];
			harness.hasImportedApiKey = false;
			harness.postOnboardingSignInPromptShown = false;
			harness._logAction = () => undefined;
			let completed = false;
			harness._advanceOrComplete = () => { completed = true; };
			const calls: string[][] = [];
			harness.commandService = { executeCommand: async (...args) => {
				calls.push(args);
				if (result === 'dismissed') {
					container.remove();
				}
				if (result === 'failure') {
					throw new Error('Key rejected');
				}
				return true;
			} };
			harness._renderProviderKeySetup(container);
			const input = container.querySelector('input')!;
			const select = container.querySelector('select')!;
			const save = container.querySelector('button')!;
			assert.strictEqual(save.disabled, true);
			select.value = 'anthropic';
			input.value = '  test-provider-key  ';
			input.dispatchEvent(new Event('input'));
			save.click();
			await Promise.resolve();
			assert.deepStrictEqual({
				calls, completed,
				imported: harness.hasImportedApiKey,
				suppressSignIn: harness.postOnboardingSignInPromptShown,
				masked: input.type,
				retryEnabled: !save.disabled,
			}, {
				calls: [['backboard.configureProviderKey', 'anthropic', 'test-provider-key']],
				completed: result === 'success',
				imported: result === 'success',
				suppressSignIn: result === 'success',
				masked: 'password',
				retryEnabled: result === 'failure',
			});
		});
	}
});
