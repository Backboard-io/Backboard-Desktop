/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProductOnboardingTheme } from '../../../../base/common/product.js';
import { localize } from '../../../../nls.js';

/**
 * Step identifiers for the Backboard onboarding walkthrough.
 */
export const enum OnboardingStepId {
	Welcome = 'onboarding.backboard.welcome',
	Experience = 'onboarding.backboard.experience',
	Theme = 'onboarding.backboard.theme',
	ImportSettings = 'onboarding.backboard.importSettings',
	SignIn = 'onboarding.backboard.signIn',
	ApiKey = 'onboarding.backboard.apiKey',
}

/**
 * Backboard workspace entry points ported from the Zed onboarding flow.
 */
export const enum OnboardingExperience {
	Simple = 'beginner',
	Developer = 'developer',
	Advanced = 'advanced',
}

export interface IOnboardingExperienceOption {
	readonly id: OnboardingExperience;
	readonly label: string;
	readonly eyebrow: string;
	readonly description: string;
}

export const ONBOARDING_EXPERIENCE_OPTIONS: readonly IOnboardingExperienceOption[] = [
	{
		id: OnboardingExperience.Simple,
		label: localize('onboarding.backboard.experience.clean', "Clean"),
		eyebrow: localize('onboarding.backboard.experience.clean.eyebrow', "Clean"),
		description: localize('onboarding.backboard.experience.clean.description', "I don't want to see code, I just want to build things"),
	},
	{
		id: OnboardingExperience.Developer,
		label: localize('onboarding.backboard.experience.editor', "Editor"),
		eyebrow: localize('onboarding.backboard.experience.editor.eyebrow', "Editor"),
		description: localize('onboarding.backboard.experience.editor.description', "I want to see and edit code, show me the editor layout I know and love."),
	},
];

/**
 * Returns a localized title for each step.
 */
export function getOnboardingStepTitle(stepId: OnboardingStepId): string {
	switch (stepId) {
		case OnboardingStepId.Welcome:
			return localize('onboarding.backboard.step.welcome', "Welcome to\nBackboard Studio");
		case OnboardingStepId.Experience:
			return localize('onboarding.backboard.step.experience', "Your Workspace. Your way.");
		case OnboardingStepId.Theme:
			return localize('onboarding.backboard.step.theme', "Choose Your Theme");
		case OnboardingStepId.ImportSettings:
			return localize('onboarding.backboard.step.importSettings', "Bring Your Setup");
		case OnboardingStepId.SignIn:
			return localize('onboarding.backboard.step.signIn', "Sign In to Backboard");
		case OnboardingStepId.ApiKey:
			return localize('onboarding.backboard.step.apiKey', "Set Up Your API Key");
	}
}

/**
 * Returns a localized subtitle for each step.
 */
export function getOnboardingStepSubtitle(stepId: OnboardingStepId): string {
	switch (stepId) {
		case OnboardingStepId.Welcome:
			return localize('onboarding.backboard.step.welcome.subtitle', "Set up a focused workspace for designing, coding, and shipping AI-assisted interfaces.");
		case OnboardingStepId.Experience:
			return localize('onboarding.backboard.step.experience.subtitle', "Choose a view built around how you like to work.\nYou can change this later as your project grows.");
		case OnboardingStepId.Theme:
			return localize('onboarding.backboard.step.theme.subtitle', "Start with a look you like. You can change it anytime.");
		case OnboardingStepId.ImportSettings:
			return localize('onboarding.backboard.step.importSettings.subtitle', "One click. Skip it if you want a fresh start.");
		case OnboardingStepId.SignIn:
			return localize('onboarding.backboard.step.signIn.subtitle', "Connect your Backboard account before you start building.");
		case OnboardingStepId.ApiKey:
			return localize('onboarding.backboard.step.apiKey.subtitle', "Create a key in Backboard, then import it here.");
	}
}

/**
 * Ordered step IDs for the onboarding flow.
 */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
	OnboardingStepId.Welcome,
];

/**
 * Theme option for the onboarding theme step.
 * Sourced from product.json via `onboardingThemes`.
 */
export type IOnboardingThemeOption = IProductOnboardingTheme;

/**
 * Storage key for persisting onboarding completion state.
 */
export const ONBOARDING_STORAGE_KEY = 'welcomeOnboarding.state';

/**
 * Storage key for tracking whether the post-onboarding tour has been shown.
 */
export const ONBOARDING_TOUR_STORAGE_KEY = 'welcomeOnboarding.tourComplete';

/**
 * Storage key for tracking whether the Agents-window post-onboarding tour has
 * been shown. Lives here (rather than in the sessions window that owns the tour)
 * so the onboarding reset action can clear it too — the tour runs in a separate
 * window that cannot be reached by importing from `vs/sessions`.
 */
export const ONBOARDING_SESSIONS_TOUR_STORAGE_KEY = 'sessions.postOnboardingTour.complete';

/**
 * Handoff flag set by the Agents-window tour when the user finishes it with
 * "Open the Editor". The window then switches to the editor page (a full reload
 * into the main workbench), and the editor-window tour reads this flag at
 * startup to continue the walkthrough there before clearing it. APPLICATION
 * scope so it survives the cross-window reload; the reset action clears it too.
 */
export const ONBOARDING_EDITOR_TOUR_PENDING_KEY = 'welcomeOnboarding.editorTourPending';

export type OnboardingDismissReason = 'complete' | 'skip';

export interface IBackboardOnboardingState {
	readonly version: 1;
	readonly completed: boolean;
	readonly dismissedReason: OnboardingDismissReason;
	readonly experience: OnboardingExperience;
	readonly themeId: string;
	readonly apiKeyImported: boolean;
}
