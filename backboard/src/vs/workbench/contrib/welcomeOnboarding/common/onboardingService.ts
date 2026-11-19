/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { OnboardingDismissReason } from './onboardingTypes.js';

export const IOnboardingService = createDecorator<IOnboardingService>('onboardingService');

export interface IOnboardingService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the onboarding modal is dismissed.
	 */
	readonly onDidDismiss: Event<void>;

	/**
	 * Fires once the work that follows dismissal (opening the selected
	 * experience, prompting sign-in) has settled.
	 */
	readonly onDidFinishOnboardingFlow: Event<OnboardingDismissReason>;

	/**
	 * Show the onboarding modal.
	 */
	show(): void;

	/**
	 * Show the onboarding modal for a new user once this window is on screen.
	 * Every mode window starts at launch, so each would otherwise put up its
	 * own copy. Does nothing if onboarding was finished or skipped elsewhere
	 * by then.
	 */
	showWhenVisible(): void;

	/**
	 * Reset onboarding state in the current session and show the modal.
	 */
	reset(): void;
}
