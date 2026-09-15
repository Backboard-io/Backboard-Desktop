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

	/** Open account setup without changing the completed onboarding experience. */
	showSignIn(): Promise<boolean>;

	/**
	 * Reset onboarding state in the current session and show the modal.
	 */
	reset(): void;
}
