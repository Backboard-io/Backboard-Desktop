/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IStorageValueChangeEvent, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { PostOnboardingEditorTour } from '../../browser/postOnboardingEditorTour.js';
import { ONBOARDING_EDITOR_TOUR_PENDING_KEY, ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_STORAGE_KEY } from '../../common/onboardingTypes.js';
import { useSimulatedVisibility } from './simulatedVisibility.js';

const COMPLETED_STATE = JSON.stringify({ version: 1, completed: true, allowAutomaticTours: true, dismissedReason: 'complete', experience: 'beginner', themeId: 'backboard-obsidian', apiKeyImported: false });

function stateEvent(external: boolean): IStorageValueChangeEvent {
	return { scope: StorageScope.APPLICATION, key: ONBOARDING_STORAGE_KEY, target: StorageTarget.USER, external };
}

suite('Backboard onboarding across mode windows', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const visibility = useSimulatedVisibility();

	function onboarding(stored?: string) {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			overlay: HTMLElement | undefined;
			pendingShow: MutableDisposable<IDisposable>;
			storageService: { get(key: string): string | undefined };
			show(): void;
			showWhenVisible(): void;
			_removeFromDOM(): void;
			_dismiss(): void;
			_storeOnboardingState(): void;
			_logAction(): void;
			_onDidChangeOnboardingState(event: IStorageValueChangeEvent): void;
		};
		const record = { stored, shows: 0, removed: 0, recorded: [] as string[] };
		harness.overlay = undefined;
		harness.pendingShow = disposables.add(new MutableDisposable());
		harness.storageService = { get: key => key === ONBOARDING_STORAGE_KEY ? record.stored : undefined };
		harness.show = () => {
			record.shows++;
			harness.overlay = document.createElement('div');
		};
		harness._removeFromDOM = () => {
			record.removed++;
			harness.overlay = undefined;
		};
		harness._dismiss = () => record.recorded.push('dismiss');
		harness._storeOnboardingState = () => record.recorded.push('store');
		harness._logAction = () => record.recorded.push('log');
		return { harness, record };
	}

	test('shows right away in the mode that is on screen', () => {
		const { harness, record } = onboarding();
		harness.showWhenVisible();
		assert.deepStrictEqual({ shows: record.shows, waiting: !!harness.pendingShow.value }, { shows: 1, waiting: false });
	});

	test('waits in a background mode and shows once, when it comes on screen', () => {
		visibility.set('hidden');
		const { harness, record } = onboarding();
		harness.showWhenVisible();
		harness.showWhenVisible();
		const whileHidden = record.shows;
		visibility.set('visible');
		visibility.set('hidden');
		visibility.set('visible');
		assert.deepStrictEqual({ whileHidden, shows: record.shows, waiting: !!harness.pendingShow.value }, { whileHidden: 0, shows: 1, waiting: false });
	});

	test('stays away when onboarding finished elsewhere while this mode was hidden', () => {
		visibility.set('hidden');
		const notified = onboarding();
		notified.harness.showWhenVisible();
		notified.record.stored = COMPLETED_STATE;
		notified.harness._onDidChangeOnboardingState(stateEvent(true));
		const stopsWaiting = !notified.harness.pendingShow.value;

		// Even without the change event, it reads the state again before showing.
		const missedEvent = onboarding();
		missedEvent.harness.showWhenVisible();
		missedEvent.record.stored = COMPLETED_STATE;

		visibility.set('visible');
		assert.deepStrictEqual({ stopsWaiting, notified: notified.record.shows, missedEvent: missedEvent.record.shows }, { stopsWaiting: true, notified: 0, missedEvent: 0 });
	});

	test('stays away when onboarding was already done', () => {
		const { harness, record } = onboarding(COMPLETED_STATE);
		harness.showWhenVisible();
		assert.strictEqual(record.shows, 0);
	});

	test('closes an open copy when another window finishes onboarding, without recording anything', () => {
		const { harness, record } = onboarding();
		harness.show();
		record.stored = COMPLETED_STATE;
		harness._onDidChangeOnboardingState(stateEvent(true));
		assert.deepStrictEqual({ removed: record.removed, open: !!harness.overlay, recorded: record.recorded }, { removed: 1, open: false, recorded: [] });
	});

	test('keeps the copy open for its own write and for a reset elsewhere', () => {
		const { harness, record } = onboarding();
		harness.show();
		record.stored = COMPLETED_STATE;
		harness._onDidChangeOnboardingState(stateEvent(false));
		record.stored = undefined;
		harness._onDidChangeOnboardingState(stateEvent(true));
		assert.deepStrictEqual({ removed: record.removed, open: !!harness.overlay }, { removed: 0, open: true });
	});

	function editorTour(values: { pending?: boolean; stored?: string }) {
		const tour = Object.create(PostOnboardingEditorTour.prototype) as {
			started: boolean;
			whenVisible: MutableDisposable<IDisposable>;
			storageService: {
				getBoolean(key: string): boolean;
				get(key: string, scope: StorageScope, fallback?: string): string | undefined;
				store(key: string, value: boolean): void;
				remove(key: string): void;
			};
			_maybeStart(): void;
		};
		const writes: string[] = [];
		tour.started = false;
		tour.whenVisible = disposables.add(new MutableDisposable());
		tour.storageService = {
			getBoolean: key => key === ONBOARDING_EDITOR_TOUR_PENDING_KEY ? !!values.pending : false,
			get: (key, _scope, fallback) => key === ONBOARDING_STORAGE_KEY ? values.stored ?? fallback : fallback,
			store: key => writes.push(`store ${key}`),
			remove: key => writes.push(`remove ${key}`),
		};
		return { tour, writes };
	}

	test('does not use up the Editor tour while Editor is in the background', () => {
		visibility.set('hidden');
		const { tour, writes } = editorTour({ stored: COMPLETED_STATE });
		tour._maybeStart();
		tour._maybeStart();
		const whileHidden = { started: tour.started, writes: [...writes], frames: visibility.frames.length };
		visibility.set('visible');
		assert.deepStrictEqual({ whileHidden, started: tour.started, writes, frames: visibility.frames.length }, {
			whileHidden: { started: false, writes: [], frames: 0 },
			started: true,
			writes: [`remove ${ONBOARDING_EDITOR_TOUR_PENDING_KEY}`, `store ${ONBOARDING_TOUR_STORAGE_KEY}`],
			frames: 1,
		});
	});

	test('keeps the Simple-to-Editor tour handoff until Editor is on screen', () => {
		visibility.set('hidden');
		const { tour, writes } = editorTour({ pending: true });
		tour._maybeStart();
		const whileHidden = [...writes];
		visibility.set('visible');
		assert.deepStrictEqual({ whileHidden, started: tour.started, writes }, {
			whileHidden: [],
			started: true,
			writes: [`remove ${ONBOARDING_EDITOR_TOUR_PENDING_KEY}`, `store ${ONBOARDING_TOUR_STORAGE_KEY}`],
		});
	});
});
