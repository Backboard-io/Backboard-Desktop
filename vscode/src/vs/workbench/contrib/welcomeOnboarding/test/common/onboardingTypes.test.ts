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
} from '../../common/onboardingTypes.js';

suite('Backboard onboarding types', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('steps are ordered to match the Backboard onboarding flow', () => {
		assert.deepStrictEqual([...ONBOARDING_STEPS], [
			OnboardingStepId.Welcome,
			OnboardingStepId.Experience,
			OnboardingStepId.Theme,
			OnboardingStepId.ImportSettings,
			OnboardingStepId.SignIn,
			OnboardingStepId.ApiKey,
		]);
	});

	test('experience options include simple and developer modes with previews', () => {
		assert.deepStrictEqual(ONBOARDING_EXPERIENCE_OPTIONS.map(option => option.id), [
			OnboardingExperience.Simple,
			OnboardingExperience.Developer,
		]);

		for (const option of ONBOARDING_EXPERIENCE_OPTIONS) {
			assert.ok(option.label);
			assert.ok(option.eyebrow);
			assert.ok(option.description);
			assert.ok(option.lightPreview.endsWith('.png'));
			assert.ok(option.darkPreview.endsWith('.png'));
		}
	});

	test('each step has localized copy', () => {
		for (const step of ONBOARDING_STEPS) {
			assert.ok(getOnboardingStepTitle(step));
			assert.ok(getOnboardingStepSubtitle(step));
		}
	});
});
