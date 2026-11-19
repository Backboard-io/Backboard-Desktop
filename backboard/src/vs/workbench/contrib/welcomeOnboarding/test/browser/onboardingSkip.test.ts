/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { BackboardAuthContextKeys } from '../../../chat/common/backboardAuth.js';
import { OnboardingDismissReason } from '../../common/onboardingTypes.js';

suite('Backboard onboarding skip', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** The onboarding modal with its steps stubbed out, recording how it was left. */
	function openOnboarding() {
		const harness = Object.create(OnboardingVariationA.prototype) as {
			overlay: HTMLElement | undefined;
			card: HTMLElement | undefined;
			pendingShow: MutableDisposable<IDisposable>;
			disposables: DisposableStore;
			footerFocusableElements: HTMLElement[];
			layoutService: { activeContainer: HTMLElement };
			show(): void;
			_renderProgress(): void;
			_renderStep(): void;
			_logStepView(): void;
			_updateButtonStates(): void;
			_focusCurrentStepElement(): void;
			_dismiss(reason: string): void;
			_prevStep(): void;
		};
		const container = document.body.appendChild(document.createElement('div'));
		disposables.add(toDisposable(() => container.remove()));
		const record = { left: [] as string[] };
		harness.overlay = undefined;
		harness.pendingShow = disposables.add(new MutableDisposable());
		harness.disposables = disposables.add(new DisposableStore());
		harness.footerFocusableElements = [];
		harness.layoutService = { activeContainer: container };
		harness._renderProgress = harness._renderStep = harness._logStepView = harness._updateButtonStates = harness._focusCurrentStepElement = () => { };
		harness._dismiss = reason => record.left.push(`dismiss ${reason}`);
		harness._prevStep = () => record.left.push('back');
		harness.show();
		const escape = () => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', keyCode: 27 });
		return { harness, record, overlay: harness.overlay!, card: harness.card!, escape };
	}

	test('clicking outside the card leaves onboarding open', () => {
		const { record, overlay } = openOnboarding();
		overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.deepStrictEqual(record.left, []);
	});

	test('Escape goes back a step instead of skipping', () => {
		const { record, overlay, escape } = openOnboarding();
		overlay.dispatchEvent(escape());
		assert.deepStrictEqual(record.left, ['back']);
	});

	test('Escape that closed a dialog inside the card goes no further', () => {
		const { record, card, escape } = openOnboarding();
		const dialog = card.appendChild(document.createElement('div'));
		dialog.addEventListener('keydown', event => event.preventDefault());
		dialog.dispatchEvent(escape());
		assert.deepStrictEqual(record.left, []);
	});

	for (const [credentials, offered] of [['none', true], ['subscription or provider key', false]] as const) {
		test(`Skip with ${credentials} ${offered ? 'still offers' : 'does not offer'} sign-in`, async () => {
			const harness = Object.create(OnboardingVariationA.prototype) as {
				overlay: HTMLElement | undefined;
				postOnboardingSignInPromptShown: boolean;
				contextKeyService: { getContextKeyValue(key: string): unknown };
				_onDidDismiss: { fire(): void };
				_onDidFinishOnboardingFlow: { fire(reason: OnboardingDismissReason): void };
				_logAction(): void;
				_storeOnboardingState(): void;
				_removeFromDOM(): void;
				_isBackboardProduct(): boolean;
				_hasBackboardCredentials(): Promise<boolean>;
				_showBackboardSsoPromptDialog(): void;
				_dismiss(reason: 'complete' | 'skip'): void;
			};
			let prompts = 0;
			harness.overlay = document.createElement('div');
			harness.postOnboardingSignInPromptShown = false;
			harness.contextKeyService = { getContextKeyValue: key => key === BackboardAuthContextKeys.byoConfigured.key && credentials !== 'none' };
			harness._onDidDismiss = { fire: () => { } };
			const finished = new Promise<OnboardingDismissReason>(resolve => harness._onDidFinishOnboardingFlow = { fire: resolve });
			harness._logAction = harness._storeOnboardingState = () => { };
			harness._removeFromDOM = () => { harness.overlay = undefined; };
			harness._isBackboardProduct = () => true;
			harness._hasBackboardCredentials = async () => false;
			harness._showBackboardSsoPromptDialog = () => { prompts++; };
			const overlay = harness.overlay;
			harness._dismiss('skip');
			overlay.dispatchEvent(new Event('transitionend'));
			assert.deepStrictEqual({ reason: await finished, prompts }, { reason: 'skip', prompts: offered ? 1 : 0 });
		});
	}
});
