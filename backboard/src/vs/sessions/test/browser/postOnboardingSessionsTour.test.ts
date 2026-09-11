/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, OnboardingExperience } from '../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { PostOnboardingSessionsTour } from '../../contrib/onboarding/browser/postOnboardingSessionsTour.js';

suite('Post-onboarding Simple tour eligibility', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	for (const [name, state, shown, expected] of [
		['missing state', undefined, false, false],
		['legacy boolean', 'true', false, false],
		['invalid state', '{', false, false],
		['null state', 'null', false, false],
		['upgraded installation', JSON.stringify({ completed: true, experience: OnboardingExperience.Simple }), false, false],
		['fresh installation', JSON.stringify({ tourEligible: true, completed: true, experience: OnboardingExperience.Simple }), false, true],
		['skipped setup', JSON.stringify({ tourEligible: true, dismissedReason: 'skip', experience: OnboardingExperience.Simple }), false, true],
		['already shown', JSON.stringify({ tourEligible: true, completed: true, experience: OnboardingExperience.Simple }), true, false],
	] as const) {
		test(name, () => {
			const storageService = disposables.add(new InMemoryStorageService());
			if (state !== undefined) {
				storageService.store(ONBOARDING_STORAGE_KEY, state, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			storageService.store(ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, shown, StorageScope.APPLICATION, StorageTarget.MACHINE);
			const harness = Object.create(PostOnboardingSessionsTour.prototype) as {
				storageService: InMemoryStorageService;
				_shouldShowTour(): boolean;
			};
			harness.storageService = storageService;
			assert.strictEqual(harness._shouldShowTour(), expected);
		});
	}
});
