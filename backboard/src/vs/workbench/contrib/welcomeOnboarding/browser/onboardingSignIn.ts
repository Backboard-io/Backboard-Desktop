/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';

export interface ISignInPanel {
	readonly element: HTMLElement;
	readonly signUpButton: HTMLButtonElement;
	readonly logInButton: HTMLButtonElement;
	readonly apiKeyButton: HTMLButtonElement;
	readonly skipButton: HTMLButtonElement;
}

function createMark(parent: HTMLElement, className: string): void {
	const mark = append(parent, $<HTMLImageElement>(`img.${className}`));
	mark.alt = '';
	mark.decoding = 'async';
	mark.src = FileAccess.asBrowserUri('vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg').toString(true);
}

function createButton(parent: HTMLElement, className: string, label: string): HTMLButtonElement {
	const button = append(parent, $<HTMLButtonElement>(`button.onboarding-signin-btn.${className}`));
	button.type = 'button';
	append(button, $('span.onboarding-signin-btn-label')).textContent = label;
	return button;
}

function createLink(parent: HTMLElement, label: string): HTMLButtonElement {
	const link = append(parent, $<HTMLButtonElement>('button.onboarding-signin-link'));
	link.type = 'button';
	link.textContent = label;
	return link;
}

/** The "made by Backboard" line pinned to the bottom of every launch screen. */
export function createMadeByFooter(parent: HTMLElement): HTMLElement {
	const footer = append(parent, $('.onboarding-made-by'));
	footer.setAttribute('aria-hidden', 'true');
	append(footer, $('span')).textContent = localize('onboarding.signIn.madeBy', "made by");
	const brand = append(footer, $('span.onboarding-made-by-brand'));
	createMark(brand, 'onboarding-made-by-mark');
	append(brand, $('span')).textContent = localize('onboarding.signIn.brand', "Backboard");
	return footer;
}

/**
 * The sign-in or sign-up screen: logo, two buttons and a way out.
 * Only builds the markup; the caller decides what each button does.
 */
export function createSignInPanel(parent: HTMLElement): ISignInPanel {
	const element = append(parent, $('.onboarding-signin'));

	createMark(element, 'onboarding-signin-logo');
	append(element, $('h1.onboarding-signin-title')).textContent = localize('onboarding.signIn.title', "Welcome to Backboard");
	append(element, $('p.onboarding-signin-subtitle')).textContent = localize('onboarding.signIn.subtitle', "Sign in or create an account");

	const actions = append(element, $('.onboarding-signin-actions'));
	const signUpButton = createButton(actions, 'onboarding-signin-btn-primary', localize('onboarding.signIn.signUp', "Sign up"));
	const enterHint = append(signUpButton, $('span.onboarding-signin-enter'));
	enterHint.textContent = '↵';
	enterHint.setAttribute('aria-hidden', 'true');
	const logInButton = createButton(actions, 'onboarding-signin-btn-secondary', localize('onboarding.signIn.logIn', "Log in"));

	const help = append(element, $('p.onboarding-signin-help'));
	append(help, $('span')).textContent = localize('onboarding.signIn.trouble', "Having trouble?");
	const apiKeyButton = createLink(help, localize('onboarding.signIn.apiKey', "Use an API key"));
	append(help, $('span')).textContent = localize('onboarding.signIn.or', "or");
	const skipButton = createLink(help, localize('onboarding.signIn.skip', "skip for now"));

	return { element, signUpButton, logInButton, apiKeyButton, skipButton };
}
