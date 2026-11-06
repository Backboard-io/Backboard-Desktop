/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { BackboardAuthContextKeys } from '../../../chat/common/backboardAuth.js';
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

	function stepHarness(alreadyConnected: boolean) {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			selectedExperience: OnboardingExperience;
			steps: typeof ONBOARDING_STEPS;
			currentStepIndex: number;
			_renderStepFrame(): void;
			_logAction(): void;
			_dismiss(reason: string): void;
			_isAlreadyConnected(): boolean;
			_advanceOrComplete(): void;
			_prevStep(): void;
			_visibleSteps(): readonly OnboardingStepId[];
		};
		harness.selectedExperience = OnboardingExperience.Simple;
		harness.steps = ONBOARDING_STEPS;
		harness.currentStepIndex = 0;
		harness._renderStepFrame = () => undefined;
		harness._logAction = () => undefined;
		harness._isAlreadyConnected = () => alreadyConnected;
		const outcomes: string[] = [];
		harness._dismiss = reason => outcomes.push(reason);
		const visited: OnboardingStepId[] = [];
		const walk = () => {
			while (!outcomes.length) {
				visited.push(harness.steps[harness.currentStepIndex]);
				harness._advanceOrComplete();
			}
		};
		return { harness, outcomes, visited, walk };
	}

	test('Simple onboarding customizes, signs in, then offers plans before completion', () => {
		const { harness, outcomes, visited, walk } = stepHarness(false);
		walk();
		assert.deepStrictEqual({ visible: harness._visibleSteps(), visited, outcomes }, {
			visible: [OnboardingStepId.Theme, OnboardingStepId.Welcome, OnboardingStepId.Billing],
			visited: [OnboardingStepId.Theme, OnboardingStepId.Welcome, OnboardingStepId.Billing],
			outcomes: ['complete'],
		});
	});

	test('someone already signed in is not asked to sign in again', () => {
		const { harness, outcomes, visited, walk } = stepHarness(true);
		walk();
		harness._prevStep();
		assert.deepStrictEqual({ visible: harness._visibleSteps(), visited, outcomes, backTo: harness.steps[harness.currentStepIndex] }, {
			visible: [OnboardingStepId.Theme, OnboardingStepId.Billing],
			visited: [OnboardingStepId.Theme, OnboardingStepId.Billing],
			outcomes: ['complete'],
			backTo: OnboardingStepId.Theme,
		});
	});

	test('only a Backboard sign-in or a provider key skips the sign-in screen', () => {
		const harness = Object.create(OnboardingVariationA.prototype) as { contextKeyService: IContextKeyService; _isAlreadyConnected(): boolean };
		const context = disposables.add(new ContextKeyService(new TestConfigurationService()));
		harness.contextKeyService = context;
		const nothing = harness._isAlreadyConnected();
		// A guest key or a ChatGPT/Claude connection: the sign-in screen still has something to offer.
		BackboardAuthContextKeys.alternativeConfigured.bindTo(context).set(true);
		const guestOrSubscription = harness._isAlreadyConnected();
		const providerKey = BackboardAuthContextKeys.providerKeyConfigured.bindTo(context);
		providerKey.set(true);
		const withProviderKey = harness._isAlreadyConnected();
		providerKey.set(false);
		BackboardAuthContextKeys.signedIn.bindTo(context).set(true);
		assert.deepStrictEqual({ nothing, guestOrSubscription, withProviderKey, signedIn: harness._isAlreadyConnected() }, {
			nothing: false, guestOrSubscription: false, withProviderKey: true, signedIn: true,
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
