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
	Simple = 'simple',
	Editor = 'editor',
	Advanced = 'advanced',
}

export interface IOnboardingExperienceOption {
	readonly id: OnboardingExperience;
	readonly label: string;
	readonly eyebrow: string;
	readonly description: string;
	readonly lightPreview: string;
	readonly darkPreview: string;
}

export const ONBOARDING_EXPERIENCE_OPTIONS: readonly IOnboardingExperienceOption[] = [
	{
		id: OnboardingExperience.Simple,
		label: localize('onboarding.backboard.experience.simple', "Clean"),
		eyebrow: localize('onboarding.backboard.experience.simple.eyebrow', "Prompt First"),
		description: localize('onboarding.backboard.experience.simple.description', "I don't want to see code, I just want to build things."),
		lightPreview: 'onboarding-simple.png',
		darkPreview: 'onboarding-simple-dark.png',
	},
	{
		id: OnboardingExperience.Editor,
		label: localize('onboarding.backboard.experience.editor', "Editor"),
		eyebrow: localize('onboarding.backboard.experience.editor.eyebrow', "Code First"),
		description: localize('onboarding.backboard.experience.editor.description', "I want to see and edit code, with Backboard close by."),
		lightPreview: 'onboarding-dev.png',
		darkPreview: 'onboarding-dev-dark.png',
	},
	{
		id: OnboardingExperience.Advanced,
		label: localize('onboarding.backboard.experience.advanced', "Advanced"),
		eyebrow: localize('onboarding.backboard.experience.advanced.eyebrow', "Orchestrate Everything"),
		description: localize('onboarding.backboard.experience.advanced.description', "I want one unified workspace to orchestrate all my agents."),
		lightPreview: 'onboarding-dev.png',
		darkPreview: 'onboarding-dev-dark.png',
	},
];

/**
 * Returns a localized title for each step.
 */
export function getOnboardingStepTitle(stepId: OnboardingStepId): string {
	switch (stepId) {
		case OnboardingStepId.Welcome:
			return localize('onboarding.backboard.step.welcome', "Welcome to Backboard Studio");
		case OnboardingStepId.Experience:
			return localize('onboarding.backboard.step.experience', "Choose Your Front Door");
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
			return localize('onboarding.backboard.step.welcome.subtitle', "Let's get your workspace set up.");
		case OnboardingStepId.Experience:
			return localize('onboarding.backboard.step.experience.subtitle', "Start where you feel most at home. You can switch modes any time.");
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
	OnboardingStepId.ImportSettings,
	OnboardingStepId.Theme,
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

export type OnboardingDismissReason = 'complete' | 'skip';

export interface IBackboardOnboardingState {
	readonly version: 1;
	readonly completed: boolean;
	readonly dismissedReason: OnboardingDismissReason;
	readonly experience: OnboardingExperience;
	readonly themeId: string;
	readonly apiKeyImported: boolean;
}
