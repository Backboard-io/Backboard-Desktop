/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ONBOARDING_STORAGE_KEY } from '../../../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { useSimulatedVisibility } from '../../../../../workbench/contrib/welcomeOnboarding/test/browser/simulatedVisibility.js';
import { PostOnboardingSessionsTour } from '../../browser/postOnboardingSessionsTour.js';

suite('Simple mode tour across mode windows', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const visibility = useSimulatedVisibility();

	function tour(experience: string) {
		const harness = Object.create(PostOnboardingSessionsTour.prototype) as {
			started: boolean;
			whenVisible: MutableDisposable<IDisposable>;
			storageService: { getBoolean(key: string): boolean; get(key: string): string | undefined };
			_maybeStart(): void;
			_start(): void;
		};
		const record = { starts: 0 };
		harness.started = false;
		harness.whenVisible = disposables.add(new MutableDisposable());
		harness.storageService = {
			getBoolean: () => false,
			get: key => key === ONBOARDING_STORAGE_KEY
				? JSON.stringify({ version: 1, completed: true, allowAutomaticTours: true, dismissedReason: 'complete', experience, themeId: 'backboard-obsidian', apiKeyImported: false })
				: undefined,
		};
		harness._start = () => record.starts++;
		return { harness, record };
	}

	function runFrames(): void {
		for (const frame of visibility.frames.splice(0)) {
			frame(0);
		}
	}

	test('offers the tour right away when Simple is on screen', () => {
		const { harness, record } = tour('beginner');
		harness._maybeStart();
		runFrames();
		assert.deepStrictEqual({ started: harness.started, starts: record.starts }, { started: true, starts: 1 });
	});

	test('waits for Simple to come on screen when onboarding finished in another mode', () => {
		visibility.set('hidden');
		const { harness, record } = tour('beginner');
		harness._maybeStart();
		harness._maybeStart();
		runFrames();
		const whileHidden = { started: harness.started, starts: record.starts };
		visibility.set('visible');
		runFrames();
		assert.deepStrictEqual({ whileHidden, started: harness.started, starts: record.starts }, {
			whileHidden: { started: false, starts: 0 },
			started: true,
			starts: 1,
		});
	});

	test('does not wait at all when the user picked another experience', () => {
		visibility.set('hidden');
		const { harness } = tour('developer');
		harness._maybeStart();
		assert.deepStrictEqual({ started: harness.started, waiting: !!harness.whenVisible.value }, { started: false, waiting: false });
	});
});
