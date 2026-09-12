/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { OnboardingExperience } from '../../common/onboardingTypes.js';

type ExperienceHarness = {
	selectedExperience: OnboardingExperience;
	environmentService: { isSessionsWindow: boolean; isOptimusWindow: boolean };
	commandService: { executeCommand(id: string): Promise<void> };
	_openSelectedExperienceAfterOnboarding(): Promise<void>;
};

suite('Backboard onboarding experience', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

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
