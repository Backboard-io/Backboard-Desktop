/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { OnboardingExperience, ONBOARDING_STEPS, OnboardingStepId } from '../../common/onboardingTypes.js';

type ExperienceHarness = {
	selectedExperience: OnboardingExperience;
	environmentService: { isSessionsWindow: boolean; isOptimusWindow: boolean };
	commandService: { executeCommand(id: string): Promise<void> };
	_openSelectedExperienceAfterOnboarding(): Promise<void>;
};

suite('Backboard onboarding experience', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('Simple onboarding visits welcome, AI connection and theme before completion', () => {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			selectedExperience: OnboardingExperience;
			steps: typeof ONBOARDING_STEPS;
			currentStepIndex: number;
			_renderStepFrame(): void;
			_logAction(): void;
			_dismiss(reason: string): void;
			_advanceOrComplete(): void;
			_visibleSteps(): readonly OnboardingStepId[];
		};
		harness.selectedExperience = OnboardingExperience.Simple;
		harness.steps = ONBOARDING_STEPS;
		harness.currentStepIndex = 0;
		harness._renderStepFrame = () => undefined;
		harness._logAction = () => undefined;
		const outcomes: string[] = [];
		harness._dismiss = reason => outcomes.push(reason);
		const visited: OnboardingStepId[] = [];
		for (let index = 0; index < ONBOARDING_STEPS.length; index++) {
			visited.push(harness.steps[harness.currentStepIndex]);
			harness._advanceOrComplete();
		}
		assert.deepStrictEqual({ visible: harness._visibleSteps(), visited, outcomes }, {
			visible: [OnboardingStepId.Welcome, OnboardingStepId.Theme],
			visited: [OnboardingStepId.Welcome, OnboardingStepId.Theme],
			outcomes: ['complete'],
		});
	});

	test('selecting Advanced updates the radio selection without finishing onboarding', () => {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			selectedExperience: OnboardingExperience;
			stepDisposables: DisposableStore;
			stepFocusableElements: HTMLElement[];
			accessibilityService: { alert(message: string): void };
			_logAction(): void;
			_dismiss(): void;
			_renderExperienceStep(container: HTMLElement): void;
		};
		let dismissed = false;
		harness.selectedExperience = OnboardingExperience.Simple;
		harness.stepDisposables = disposables.add(new DisposableStore());
		harness.stepFocusableElements = [];
		harness.accessibilityService = { alert: () => undefined };
		harness._logAction = () => undefined;
		harness._dismiss = () => { dismissed = true; };
		const container = document.createElement('div');
		harness._renderExperienceStep(container);
		const cards = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
		cards[2].click();
		assert.deepStrictEqual({
			selected: harness.selectedExperience,
			dismissed,
			cards: cards.map(card => [card.getAttribute('aria-checked'), card.tabIndex]),
		}, { selected: OnboardingExperience.Advanced, dismissed: false, cards: [['false', -1], ['false', -1], ['true', 0]] });
	});

	for (const reason of ['complete', 'skip'] as const) {
		test(`standalone sign-in ${reason} resolves without changing onboarding or workspace mode`, async () => {
			let shows = 0;
			const harness = Object.create(OnboardingVariationA.prototype) as {
				overlay: HTMLElement | undefined;
				signInOnly: boolean;
				show(): void;
				showSignIn(): Promise<boolean>;
				_focusCurrentStepElement(): void;
				_removeFromDOM(): void;
				_dismiss(reason: 'complete' | 'skip'): void;
			};
			harness.show = () => { shows++; harness.overlay = document.createElement('div'); };
			harness._focusCurrentStepElement = () => undefined;
			harness._removeFromDOM = () => { harness.overlay = undefined; };
			const result = harness.showSignIn();
			assert.strictEqual(harness.showSignIn(), result, 'repeated sign-in clicks reuse the open panel');
			harness._dismiss(reason);
			assert.deepStrictEqual({ signedIn: await result, shows, open: !!harness.overlay }, { signedIn: reason === 'complete', shows: 1, open: false });
		});
	}

	for (const scenario of ['valid', 'invalid', 'save failure', 'dismissed'] as const) {
		test(`reviewer sign-in: ${scenario}`, async () => {
			let saves = 0;
			let advances = 0;
			const harness = Object.create(OnboardingVariationA.prototype) as {
				stepDisposables: DisposableStore;
				stepFocusableElements: HTMLElement[];
				hasImportedApiKey: boolean;
				hasConfirmedBackboardSignIn: boolean;
				postOnboardingSignInPromptShown: boolean;
				_saveBackboardApiKey(key: string): Promise<void>;
				_advanceOrComplete(): void;
				_renderReviewerSignIn(container: HTMLElement): void;
			};
			harness.stepDisposables = disposables.add(new DisposableStore());
			harness.stepFocusableElements = [];
			harness._saveBackboardApiKey = async key => {
				assert.match(key, /^espr_[A-Za-z0-9_-]{43}$/);
				saves++;
				if (scenario === 'dismissed') { harness.stepDisposables.clear(); }
				if (scenario === 'save failure') {
					throw new Error('Test write failure');
				}
			};
			harness._advanceOrComplete = () => { advances++; };
			const container = document.createElement('div');
			harness._renderReviewerSignIn(container);
			container.querySelector<HTMLInputElement>('input[type="email"]')!.value = 'bburgers784@gmail.com';
			const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
			password.value = scenario === 'invalid' ? 'wrong-password' : 'password123!';
			container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
			container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
			await Promise.resolve();
			await Promise.resolve();
			assert.deepStrictEqual({ saves, advances, cleared: password.value === '', error: !!container.querySelector('.onboarding-backboard-reviewer-error')!.textContent }, {
				saves: scenario === 'invalid' ? 0 : 1,
				advances: scenario === 'valid' ? 1 : 0,
				cleared: true,
				error: scenario === 'invalid' || scenario === 'save failure',
			});
			if (scenario === 'valid') {
				assert.ok(harness.hasImportedApiKey && harness.hasConfirmedBackboardSignIn && harness.postOnboardingSignInPromptShown);
			}
		});
	}

	for (const windows of [true, false]) {
		for (const connected of [true, false]) {
			test(`account setup for Windows=${windows} with SSO result=${connected}`, async () => {
				const calls: string[] = [];
				let advances = 0;
				let finish!: (result: boolean) => void;
				const result = new Promise<boolean>(resolve => { finish = resolve; });
				const harness = Object.create(OnboardingVariationA.prototype) as {
					stepDisposables: DisposableStore;
					stepFocusableElements: HTMLElement[];
					commandService: { executeCommand(id: string): Promise<boolean> };
					_createBrandLockup(): void;
					_logAction(): void;
					_advanceOrComplete(): void;
					_renderConnectAIStep(container: HTMLElement, windows: boolean): void;
				};
				harness.stepDisposables = disposables.add(new DisposableStore());
				harness.stepFocusableElements = [];
				harness._createBrandLockup = () => undefined;
				harness._logAction = () => undefined;
				harness._advanceOrComplete = () => { advances++; };
				harness.commandService = { executeCommand: id => { calls.push(id); return result; } };
				const container = document.body.appendChild(document.createElement('div'));
				disposables.add(toDisposable(() => container.remove()));
				harness._renderConnectAIStep(container, windows);
				assert.ok(container.querySelector('form input[type=email]'));
				assert.ok(container.querySelector('form input[type=password]'));
				assert.strictEqual(container.querySelector('.onboarding-backboard-skip-link'), null);
				const buttons = Array.from(container.querySelectorAll('button'));
				assert.strictEqual(buttons.some(button => button.textContent === 'Bring Your Own Subscription'), false);
				const sso = buttons.find(button => button.textContent === 'Continue with Backboard')!;
				sso.click();
				sso.click();
				assert.deepStrictEqual(calls, [windows ? 'backboard.extension.signIn' : 'backboard.signIn']);
				assert.strictEqual(advances, 0);
				finish(connected);
				await result;
				assert.strictEqual(advances, connected ? 1 : 0);
				if (!connected) { assert.strictEqual(sso.disabled, false); }
			});
		}
	}

	for (const signInOnly of [true, false]) {
		test(`onboarding skip controls are absent; standalone sign-in=${signInOnly}`, () => {
			const harness = Object.create(OnboardingVariationA.prototype) as {
				stepDisposables: DisposableStore;
				disposables: DisposableStore;
				stepFocusableElements: HTMLElement[];
				footerFocusableElements: HTMLElement[];
				steps: typeof ONBOARDING_STEPS;
				layoutService: { activeContainer: HTMLElement };
				signInOnly: boolean;
				overlay: HTMLElement;
				_createBrandLockup(): void;
				_logStepView(): void;
				_logAction(): void;
				_dismiss(reason: string): void;
				show(): void;
			};
			harness.stepDisposables = disposables.add(new DisposableStore());
			harness.disposables = disposables.add(new DisposableStore());
			harness.stepFocusableElements = [];
			harness.footerFocusableElements = [];
			harness.steps = ONBOARDING_STEPS;
			harness.signInOnly = signInOnly;
			harness._createBrandLockup = () => undefined;
			harness._logStepView = () => undefined;
			harness._logAction = () => undefined;
			const dismissals: string[] = [];
			harness._dismiss = reason => dismissals.push(reason);
			const container = document.body.appendChild(document.createElement('div'));
			disposables.add(toDisposable(() => container.remove()));
			harness.layoutService = { activeContainer: container };
			harness.show();
			assert.ok(container.querySelector('form input[type=email]'));
			assert.ok(container.querySelector('form input[type=password]'));
			assert.strictEqual(container.querySelector('.onboarding-backboard-skip-link'), null);
			assert.strictEqual(!!container.querySelector('.onboarding-a-close-btn'), signInOnly);
			assert.ok(!Array.from(container.querySelectorAll('button')).some(button => ['Skip', 'Set Up Later'].includes(button.textContent ?? '')));
			harness.overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
			harness.overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			assert.deepStrictEqual(dismissals, signInOnly ? ['skip', 'skip'] : []);
		});
	}

	for (const [experience, sessions, optimus, expected] of [
		[OnboardingExperience.Simple, true, false, []],
		[OnboardingExperience.Developer, true, false, ['agents.openSessionInVSCode']],
		[OnboardingExperience.Advanced, true, false, ['agents.openOptimusWindow']],
		[OnboardingExperience.Advanced, false, false, ['workbench.action.openOptimusWindow']],
		[OnboardingExperience.Simple, false, true, ['agents.openAgentsWindow']],
		[OnboardingExperience.Developer, false, false, []],
		[OnboardingExperience.Advanced, false, true, []],
	] as const) {
		test(`${experience} from sessions=${sessions}, advanced=${optimus}`, async () => {
			const harness = Object.create(OnboardingVariationA.prototype) as ExperienceHarness;
			const commands: string[] = [];
			harness.selectedExperience = experience;
			harness.environmentService = { isSessionsWindow: sessions, isOptimusWindow: optimus };
			harness.commandService = { executeCommand: async id => { commands.push(id); } };
			await harness._openSelectedExperienceAfterOnboarding();
			assert.deepStrictEqual(commands, expected);
		});
	}
});
