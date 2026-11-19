/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

type Outcome = { status: 'signedIn' } | { status: 'cancelled' } | { status: 'failed'; error: string };

suite('Backboard onboarding sign-in screen', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * The sign-in screen against a fake Backboard extension. `runSignIn` stays
	 * open until `finish` is called, and Cancel finishes it the way the
	 * extension does.
	 */
	function signInScreen(options: { link?: { url: string; userCode: string }; runFails?: Error } = {}) {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			stepDisposables: DisposableStore;
			stepFocusableElements: HTMLElement[];
			postOnboardingSignInPromptShown: boolean;
			commandService: { executeCommand(id: string): Promise<unknown> };
			clipboardService: { writeText(text: string): Promise<void> };
			notificationService: { notify(): void };
			_logAction(action: string): void;
			_advanceOrComplete(): void;
			_renderConnectAIStep(container: HTMLElement): void;
		};
		const container = document.body.appendChild(document.createElement('div'));
		disposables.add(toDisposable(() => container.remove()));
		const record = { calls: [] as string[], actions: [] as string[], clipboard: [] as string[], notifications: 0, advanced: false };
		let finish: (outcome: Outcome) => void = () => { };
		harness.stepDisposables = disposables.add(new DisposableStore());
		harness.stepFocusableElements = [];
		harness.postOnboardingSignInPromptShown = false;
		harness._logAction = action => record.actions.push(action);
		harness._advanceOrComplete = () => { record.advanced = true; };
		harness.notificationService = { notify: () => { record.notifications++; } };
		harness.clipboardService = { writeText: async text => { record.clipboard.push(text); } };
		harness.commandService = {
			executeCommand: async id => {
				record.calls.push(id);
				switch (id) {
					case 'backboard.extension.runSignIn':
						if (options.runFails) {
							throw options.runFails;
						}
						return new Promise<Outcome>(resolve => finish = resolve);
					case 'backboard.extension.cancelSignIn':
						finish({ status: 'cancelled' });
						return true;
					case 'backboard.extension.signInLink':
						return options.link;
				}
				return undefined;
			}
		};
		harness._renderConnectAIStep(container);
		const button = (label: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent === label)!;
		const logIn = button('Log in');
		const settle = () => new Promise(resolve => setTimeout(resolve, 0));
		const screen = () => ({
			logIn: logIn.textContent,
			buttonsEnabled: !logIn.disabled && !button('Sign up↵').disabled,
			waiting: container.querySelector<HTMLElement>('.onboarding-signin-waiting')!.style.display !== 'none',
			message: container.querySelector('.onboarding-signin-message')!.textContent,
			error: container.querySelector('.onboarding-signin-message')!.classList.contains('error'),
		});
		return { harness, record, logIn, button, settle, screen, finish: (outcome: Outcome) => finish(outcome) };
	}

	test('waits for the browser with a way to cancel, then advances once signed in', async () => {
		const { harness, record, logIn, settle, screen, finish } = signInScreen();
		logIn.click();
		await settle();
		const whileWaiting = screen();
		finish({ status: 'signedIn' });
		await settle();
		assert.deepStrictEqual({ whileWaiting, advanced: record.advanced, suppressSignIn: harness.postOnboardingSignInPromptShown, calls: record.calls }, {
			whileWaiting: { logIn: 'Connecting to Backboard…', buttonsEnabled: false, waiting: true, message: '', error: false },
			advanced: true,
			suppressSignIn: true,
			calls: ['backboard.extension.runSignIn'],
		});
	});

	test('a failed sign-in says why on this screen and can be tried again', async () => {
		const { record, logIn, settle, screen, finish } = signInScreen();
		logIn.click();
		await settle();
		finish({ status: 'failed', error: 'Backboard device login was denied.' });
		await settle();
		assert.deepStrictEqual({ screen: screen(), advanced: record.advanced, notifications: record.notifications, focused: logIn === document.activeElement }, {
			screen: { logIn: 'Log in', buttonsEnabled: true, waiting: false, message: 'Sign-in didn\'t finish: Backboard device login was denied.', error: true },
			advanced: false,
			notifications: 0,
			focused: true,
		});
	});

	test('reports the sign-in command itself failing the same way', async () => {
		const { record, logIn, settle, screen } = signInScreen({ runFails: new Error('command \'backboard.extension.runSignIn\' not found') });
		logIn.click();
		await settle();
		assert.deepStrictEqual({ screen: screen(), notifications: record.notifications }, {
			screen: { logIn: 'Log in', buttonsEnabled: true, waiting: false, message: 'Sign-in didn\'t finish: command \'backboard.extension.runSignIn\' not found', error: true },
			notifications: 0,
		});
	});

	test('Cancel stops waiting without an error', async () => {
		const { record, logIn, button, settle, screen } = signInScreen();
		logIn.click();
		await settle();
		button('Cancel').click();
		await settle();
		assert.deepStrictEqual({ screen: screen(), advanced: record.advanced, calls: record.calls, actions: record.actions }, {
			screen: { logIn: 'Log in', buttonsEnabled: true, waiting: false, message: '', error: false },
			advanced: false,
			calls: ['backboard.extension.runSignIn', 'backboard.extension.cancelSignIn'],
			actions: ['openBackboardSso', 'cancelSignIn'],
		});
	});

	test('Copy link copies the sign-in link and shows the code to look for', async () => {
		const link = { url: 'https://app.backboard.io/device?user_code=WXYZ-1234', userCode: 'WXYZ-1234' };
		const { record, logIn, button, settle, screen } = signInScreen({ link });
		logIn.click();
		await settle();
		button('Copy link').click();
		await settle();
		const copied = screen();
		button('Cancel').click();
		await settle();
		assert.deepStrictEqual({ copied, afterCancel: screen().message, clipboard: record.clipboard }, {
			copied: { logIn: 'Connecting to Backboard…', buttonsEnabled: false, waiting: true, message: 'Link copied. Open it in any browser and check that it shows the code WXYZ-1234.', error: false },
			// The link died with the sign-in it came from.
			afterCancel: '',
			clipboard: [link.url],
		});
	});

	test('Copy link before the link exists says to try again', async () => {
		const { record, logIn, button, settle, screen, finish } = signInScreen();
		logIn.click();
		await settle();
		button('Copy link').click();
		await settle();
		const message = screen().message;
		finish({ status: 'cancelled' });
		await settle();
		assert.deepStrictEqual({ message, clipboard: record.clipboard }, {
			message: 'The sign-in link isn\'t ready yet. Try again in a moment.',
			clipboard: [],
		});
	});
});
