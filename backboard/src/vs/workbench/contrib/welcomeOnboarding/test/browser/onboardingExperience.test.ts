/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ONBOARDING_STORAGE_KEY, OnboardingExperience } from '../../common/onboardingTypes.js';

type ExperienceHarness = {
	selectedExperience: OnboardingExperience;
	environmentService: { isSessionsWindow: boolean; isOptimusWindow: boolean };
	commandService: { executeCommand(id: string): Promise<void> };
	_openSelectedExperienceAfterOnboarding(): Promise<void>;
};

suite('Backboard onboarding experience', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const freshInstall of [true, false]) {
		test(`automatic tour eligibility is restricted to fresh installs: ${freshInstall}`, () => {
			const storageService = disposables.add(new InMemoryStorageService());
			storageService.isNew = scope => scope === StorageScope.APPLICATION && freshInstall;
			const harness = Object.create(OnboardingVariationA.prototype) as {
				storageService: InMemoryStorageService;
				selectedExperience: OnboardingExperience;
				_storeOnboardingState(reason: 'complete'): void;
			};
			harness.storageService = storageService;
			harness.selectedExperience = OnboardingExperience.Simple;
			harness._storeOnboardingState('complete');
			assert.strictEqual(JSON.parse(storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION)!).tourEligible, freshInstall);
		});
	}

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

	for (const signedIn of [true, false]) {
		test(`SSO in onboarding and shared sign-in waits for browser result: ${signedIn}`, async () => {
			const commands: string[] = [];
			let advances = 0;
			let finish!: (value: boolean) => void;
			const result = new Promise<boolean>(resolve => { finish = resolve; });
			const harness = Object.create(OnboardingVariationA.prototype) as {
				stepDisposables: DisposableStore;
				stepFocusableElements: HTMLElement[];
				commandService: { executeCommand(id: string): Promise<boolean> };
				_createAnimatedBackboardMark(): void;
				_renderReviewerSignIn(): void;
				_logAction(): void;
				_advanceOrComplete(): void;
				_renderWelcomeStep(container: HTMLElement): void;
			};
			harness.stepDisposables = disposables.add(new DisposableStore());
			harness.stepFocusableElements = [];
			harness.commandService = { executeCommand: id => { commands.push(id); return result; } };
			harness._createAnimatedBackboardMark = () => undefined;
			harness._renderReviewerSignIn = () => undefined;
			harness._logAction = () => undefined;
			harness._advanceOrComplete = () => { advances++; };
			const container = document.createElement('div');
			harness._renderWelcomeStep(container);
			const button = container.querySelector<HTMLButtonElement>('.onboarding-backboard-browser-sign-in')!;
			button.click();
			button.click();
			assert.deepStrictEqual({ commands, advances, disabled: button.disabled }, { commands: ['backboard.signInWithBrowser'], advances: 0, disabled: true });
			finish(signedIn);
			await result;
			await Promise.resolve();
			assert.strictEqual(advances, signedIn ? 1 : 0);
			if (!signedIn) {
				assert.deepStrictEqual({ disabled: button.disabled, label: button.textContent }, { disabled: false, label: 'Sign in with SSO' });
			}
		});
	}

	for (const scenario of ['valid', 'invalid', 'save failure'] as const) {
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
			await Promise.resolve();
			await Promise.resolve();
			assert.deepStrictEqual({ saves, advances, cleared: password.value === '', error: !!container.querySelector('.onboarding-backboard-reviewer-error')!.textContent }, {
				saves: scenario === 'invalid' ? 0 : 1,
				advances: scenario === 'valid' ? 1 : 0,
				cleared: true,
				error: scenario !== 'valid',
			});
			if (scenario === 'valid') {
				assert.ok(harness.hasImportedApiKey && harness.hasConfirmedBackboardSignIn && harness.postOnboardingSignInPromptShown);
			}
		});
	}

	for (const reason of ['complete', 'skip'] as const) {
		test(`${reason} enters Simple mode before announcing the end of onboarding`, async () => {
			const events: string[] = [];
			let finished!: () => void;
			const done = new Promise<void>(resolve => { finished = resolve; });
			const overlay = document.createElement('div');
			const harness = Object.create(OnboardingVariationA.prototype) as {
				overlay: HTMLElement | undefined;
				selectedExperience: OnboardingExperience;
				postOnboardingSignInPromptShown: boolean;
				_onDidDismiss: { fire(): void };
				_onDidFinishOnboardingFlow: { fire(reason: string): void };
				_logAction(): void;
				_storeOnboardingState(reason: string): void;
				_removeFromDOM(): void;
				_openSelectedExperienceAfterOnboarding(): Promise<void>;
				_promptBackboardSsoAfterOnboarding(): Promise<void>;
				_dismiss(reason: 'complete' | 'skip'): void;
			};
			harness.overlay = overlay;
			harness.selectedExperience = OnboardingExperience.Developer;
			harness._logAction = () => undefined;
			harness._storeOnboardingState = value => { events.push(`store:${value}:${harness.selectedExperience}`); };
			harness._removeFromDOM = () => { harness.overlay = undefined; };
			harness._onDidDismiss = { fire: () => undefined };
			harness._openSelectedExperienceAfterOnboarding = async () => { events.push(`open:${harness.selectedExperience}`); };
			harness._promptBackboardSsoAfterOnboarding = async () => undefined;
			harness._onDidFinishOnboardingFlow = { fire: value => { events.push(`finished:${value}`); finished(); } };
			harness._dismiss(reason);
			// A late sign-in result must not replace a Skip during the exit animation.
			harness._dismiss('complete');
			overlay.dispatchEvent(new Event('transitionend'));
			await done;
			assert.deepStrictEqual(events, [`store:${reason}:beginner`, 'open:beginner', `finished:${reason}`]);
		});
	}

	for (const [experience, sessions, optimus, expected] of [
		[OnboardingExperience.Simple, true, false, []],
		[OnboardingExperience.Simple, false, false, ['workbench.action.openAgentsWindow']],
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
