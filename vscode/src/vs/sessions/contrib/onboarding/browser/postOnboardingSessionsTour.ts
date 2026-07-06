/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow, getDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ISpotlightTourIntro, ISpotlightTourStep, SpotlightTour, TourPlacement } from '../../../../workbench/contrib/welcomeOnboarding/browser/spotlightTour.js';
import { IBackboardOnboardingState, OnboardingExperience, ONBOARDING_STORAGE_KEY } from '../../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';

interface ISessionsTourStep {
	/** CSS selector for the element (panel or button) this step spotlights. */
	readonly targetSelector: string;
	/** Preferred side of the target to place the card on. */
	readonly placement: TourPlacement;
	readonly title: string;
	readonly body: string;
}

const SESSIONS_TOUR_STORAGE_KEY = 'sessions.postOnboardingTour.complete';

const TOUR_STEPS: readonly ISessionsTourStep[] = [
	{
		targetSelector: '.interactive-input-part',
		placement: TourPlacement.Top,
		title: localize('sessions.tour.prompt.title', "Start with a prompt"),
		body: localize('sessions.tour.prompt.body', "Describe what you want to build or change. The agent works from here."),
	},
	{
		targetSelector: '.part.sidebar',
		placement: TourPlacement.Right,
		title: localize('sessions.tour.sessions.title', "Find your sessions"),
		body: localize('sessions.tour.sessions.body', "Every chat you start is saved here — pick one to jump back in."),
	},
	{
		targetSelector: '.sessions-panel-header-right',
		placement: TourPlacement.Bottom,
		title: localize('sessions.tour.panels.title', "Open panels beside the agent"),
		body: localize('sessions.tour.panels.body', "Switch on Files, a Browser, or a Terminal right next to the chat."),
	},
];

/**
 * A spotlight tour shown once in the Agents (sessions) window after the user
 * completes onboarding with the Clean/Simple experience. It first asks for
 * consent, then walks through the prompt box, the sessions list, and the panel
 * switcher.
 *
 * Onboarding runs in the separate main-workbench window, so there is no
 * same-process event to subscribe to here. Instead this reads the
 * already-persisted onboarding state once at startup: onboarding writes it
 * to APPLICATION-scope storage synchronously before this window is created.
 */
export class PostOnboardingSessionsTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingSessionsTour';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		if (this._shouldShowTour()) {
			getActiveWindow().requestAnimationFrame(() => this._start());
		}
	}

	private _shouldShowTour(): boolean {
		if (this.storageService.getBoolean(SESSIONS_TOUR_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return false;
		}

		const raw = this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return false;
		}

		try {
			const state: IBackboardOnboardingState = JSON.parse(raw);
			return state.completed && state.experience === OnboardingExperience.Simple;
		} catch {
			return false;
		}
	}

	private _start(): void {
		this.storageService.store(SESSIONS_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);

		const targetWindow = getActiveWindow();
		const steps = TOUR_STEPS
			.map((step): ISpotlightTourStep | undefined => {
				const anchor = targetWindow.document.querySelector<HTMLElement>(step.targetSelector);
				if (!anchor || !this._isVisible(anchor)) {
					return undefined;
				}
				return { anchor, title: step.title, body: step.body, preferredPlacement: step.placement };
			})
			.filter((step): step is ISpotlightTourStep => !!step);

		if (!steps.length) {
			return;
		}

		const intro: ISpotlightTourIntro = {
			title: localize('sessions.tour.intro.title', "Take a quick tour?"),
			body: localize('sessions.tour.intro.body', "Get to know your workspace — where to prompt, find sessions, and open panels."),
			caption: localize('sessions.tour.intro.caption', "{0} quick stops", steps.length),
			confirmLabel: localize('sessions.tour.intro.confirm', "Take the tour"),
			dismissLabel: localize('sessions.tour.intro.dismiss', "Maybe later"),
		};

		const tour = this._register(new SpotlightTour({
			container: this.layoutService.activeContainer,
			window: targetWindow,
			onLayoutChange: this.layoutService.onDidLayoutActiveContainer,
			intro,
			steps,
		}));
		tour.start();
	}

	private _isVisible(element: HTMLElement): boolean {
		const position = getDomNodePagePosition(element);
		return position.width > 0 && position.height > 0;
	}
}
