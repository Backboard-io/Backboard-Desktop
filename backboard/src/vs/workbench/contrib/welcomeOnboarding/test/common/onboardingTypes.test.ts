/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getOnboardingStepSubtitle,
	getOnboardingStepTitle,
	OnboardingExperience,
	ONBOARDING_EXPERIENCE_OPTIONS,
	OnboardingStepId,
	ONBOARDING_STEPS,
	shouldOfferOnboardingTour,
} from '../../common/onboardingTypes.js';

suite('Backboard onboarding types', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('upgrades do not offer tours merely because their tour flag is missing', () => {
		assert.deepStrictEqual([
			shouldOfferOnboardingTour({ completed: true }),
			shouldOfferOnboardingTour({ completed: true, allowAutomaticTours: false }),
			shouldOfferOnboardingTour({ completed: false, allowAutomaticTours: true }),
			shouldOfferOnboardingTour({ completed: true, allowAutomaticTours: true }),
		], [false, false, false, true]);
	});

	test('steps are ordered to match the Backboard onboarding flow', () => {
		assert.deepStrictEqual([...ONBOARDING_STEPS], [
			OnboardingStepId.Theme,
			OnboardingStepId.Welcome,
			OnboardingStepId.Billing,
		]);
	});

	test('experience options default to Simple and include Editor and Advanced', () => {
		assert.deepStrictEqual(ONBOARDING_EXPERIENCE_OPTIONS.map(option => option.id), [
			OnboardingExperience.Simple,
			OnboardingExperience.Developer,
			OnboardingExperience.Advanced,
		]);

		for (const option of ONBOARDING_EXPERIENCE_OPTIONS) {
			assert.ok(option.label);
			assert.ok(option.eyebrow);
			assert.ok(option.description);
		}
	});

	test('each step has localized copy', () => {
		for (const step of ONBOARDING_STEPS) {
			assert.ok(getOnboardingStepTitle(step));
			assert.ok(getOnboardingStepSubtitle(step));
		}
	});
});
