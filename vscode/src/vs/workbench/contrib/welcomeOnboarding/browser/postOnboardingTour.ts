/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow, getDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { IBackboardOnboardingState, OnboardingExperience, ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_STORAGE_KEY } from '../common/onboardingTypes.js';
import { ISpotlightTourIntro, ISpotlightTourStep, SpotlightTour, TourPlacement } from './spotlightTour.js';

interface IPostOnboardingTourStep {
	/** Workbench part this step spotlights. */
	readonly part: Parts;
	/** Preferred side of the part to place the card on. */
	readonly placement: TourPlacement;
	readonly title: string;
	readonly body: string;
}

const TOUR_STEPS: readonly IPostOnboardingTourStep[] = [
	{
		part: Parts.SIDEBAR_PART,
		placement: TourPlacement.Right,
		title: localize('onboarding.tour.editIde.title', "Edit in the IDE"),
		body: localize('onboarding.tour.editIde.body', "Open files, read code, and preview changes without switching apps."),
	},
	{
		part: Parts.AUXILIARYBAR_PART,
		placement: TourPlacement.Left,
		title: localize('onboarding.tour.chat.title', "Chat with Backboard"),
		body: localize('onboarding.tour.chat.body', "Describe a change, then review the result beside your project."),
	},
];

/**
 * A spotlight tour shown once after onboarding finishes in the main IDE window
 * (Developer or Advanced experience — the Simple experience opens the Agents
 * window, which runs its own tour). It first asks for consent, then dims the
 * workbench and highlights the editor and chat panel in turn.
 */
export class PostOnboardingTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingTour';

	constructor(
		@IOnboardingService private readonly onboardingService: IOnboardingService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(this.onboardingService.onDidFinishOnboardingFlow(() => this._tryStart()));
	}

	private _tryStart(): void {
		if (this.storageService.getBoolean(ONBOARDING_TOUR_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		// The Simple experience hands off to the Agents window, which runs its
		// own tour there; showing this one would target the backgrounded window.
		const experience = this._completedExperience();
		if (experience === undefined || experience === OnboardingExperience.Simple) {
			return;
		}

		// Let the layout the user just opened (editor, panels) settle before measuring it.
		getActiveWindow().requestAnimationFrame(() => this._start());
	}

	private _completedExperience(): OnboardingExperience | undefined {
		const raw = this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const state: IBackboardOnboardingState = JSON.parse(raw);
			return state.completed ? state.experience : undefined;
		} catch {
			return undefined;
		}
	}

	private _start(): void {
		this.storageService.store(ONBOARDING_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);

		const targetWindow = getActiveWindow();
		const steps = TOUR_STEPS
			.map((step): ISpotlightTourStep | undefined => {
				const anchor = this.layoutService.getContainer(targetWindow, step.part);
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
			title: localize('onboarding.tour.intro.title', "Take a quick tour?"),
			body: localize('onboarding.tour.intro.body', "See where to edit code and chat with Backboard."),
			caption: localize('onboarding.tour.intro.caption', "{0} quick stops", steps.length),
			confirmLabel: localize('onboarding.tour.intro.confirm', "Take the tour"),
			dismissLabel: localize('onboarding.tour.intro.dismiss', "Maybe later"),
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
