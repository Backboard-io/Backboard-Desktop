/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../nls.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { SpotlightTour, ISpotlightTourStep, TourPlacement } from '../../../workbench/contrib/welcomeOnboarding/browser/spotlightTour.js';
import { isWorkbenchVisible, onceWorkbenchVisible } from '../../../workbench/contrib/welcomeOnboarding/browser/workbenchVisibility.js';
import { IOnboardingService } from '../../../workbench/contrib/welcomeOnboarding/common/onboardingService.js';
import { ONBOARDING_ADVANCED_TOUR_STORAGE_KEY, ONBOARDING_STORAGE_KEY, shouldOfferOnboardingTour } from '../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';

class AdvancedOnboardingTour extends Disposable {
	static readonly ID = 'optimus.contrib.onboardingTour';
	private started = false;
	private readonly whenVisible = this._register(new MutableDisposable());

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IOnboardingService onboardingService: IOnboardingService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this._register(onboardingService.onDidFinishOnboardingFlow(() => this.maybeStart()));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ONBOARDING_STORAGE_KEY, this._store)(() => this.maybeStart()));
		if (!this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION)
			&& !environmentService.extensionDevelopmentLocationURI && !environmentService.extensionTestsLocationURI) {
			onboardingService.showWhenVisible();
		}
		this.maybeStart();
	}

	private maybeStart(): void {
		if (this.started || getActiveWindow().document.querySelector('.onboarding-a-overlay')
			|| this.storageService.getBoolean(ONBOARDING_ADVANCED_TOUR_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		try {
			const state = JSON.parse(this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
			if (!shouldOfferOnboardingTour(state)) {
				return;
			}
		} catch {
			return;
		}
		if (!isWorkbenchVisible()) {
			// Onboarding finished in another mode: offer the tour once the user comes here.
			this.whenVisible.value ??= onceWorkbenchVisible(() => {
				this.whenVisible.clear();
				this.maybeStart();
			});
			return;
		}
		this.started = true;
		this.storageService.store(ONBOARDING_ADVANCED_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		this._register(showAdvancedTour(this.layoutService));
	}
}

function showAdvancedTour(layoutService: IWorkbenchLayoutService): IDisposable {
	const store = new DisposableStore();
	const targetWindow = getActiveWindow();
	const query = (selector: string) => () => targetWindow.document.querySelector<HTMLElement>(selector) ?? undefined;
	const steps: ISpotlightTourStep[] = [
		{
			title: localize('advanced.tour.dashboard', "Your Agent Dashboard"),
			body: localize('advanced.tour.dashboard.body', "Advanced brings multiple agent tasks into one workspace. Start a task or drag a chat from the sessions list into the dashboard."),
			anchor: query('.optimus-grid-content'),
		},
		{
			title: localize('advanced.tour.views', "See What Needs Attention"),
			body: localize('advanced.tour.views.body', "Switch dashboard views to track your tasks. The board groups them into Running, Blocked, and Ready so you can spot work that needs your input."),
			anchor: query('.optimus-view-switcher'),
			preferredPlacement: TourPlacement.Bottom,
		},
		{
			title: localize('advanced.tour.sessions', "Focus on a Task"),
			body: localize('advanced.tour.sessions.body', "Find previous conversations in Sessions. Open a task to continue the conversation, then return to the dashboard to see the rest of your work."),
			anchor: query('.part.sidebar'),
			preferredPlacement: TourPlacement.Right,
		},
		{
			title: localize('advanced.tour.review', "Review Before You Ship"),
			body: localize('advanced.tour.review.body', "Use the tools beside your agent to inspect files, review diffs, preview your app, and run tests. Check agent changes and requested commands before committing your work."),
			anchor: query('.part.auxiliarybar'),
			preferredPlacement: TourPlacement.Left,
		},
		{
			title: localize('advanced.tour.modes', "Use the Mode That Fits"),
			body: localize('advanced.tour.modes.body', "Switch to Simple for a focused conversation or Editor to work directly with code. Replay this tour by searching for ‘Show Advanced Mode Tour’ in the Command Palette."),
			anchor: query('.optimus-window-chrome .backboard-mode-segments'),
			preferredPlacement: TourPlacement.Bottom,
		},
	];
	const tour = store.add(new SpotlightTour({
		container: layoutService.activeContainer,
		window: targetWindow,
		onLayoutChange: layoutService.onDidLayoutActiveContainer,
		intro: {
			title: localize('advanced.tour.intro', "Explore Advanced Mode?"),
			body: localize('advanced.tour.intro.body', "Learn how to organize multiple tasks and review agent work without leaving your dashboard."),
			caption: localize('advanced.tour.count', "{0} quick stops", steps.length),
			confirmLabel: localize('advanced.tour.start', "Take the Tour"),
			dismissLabel: localize('advanced.tour.later', "Maybe Later"),
		},
		steps,
		onFinish: () => store.dispose(),
	}));
	tour.start();
	return store;
}

registerWorkbenchContribution2(AdvancedOnboardingTour.ID, AdvancedOnboardingTour, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'workbench.action.showAdvancedModeTour', title: localize2('advanced.tour.command', "Show Advanced Mode Tour"), category: Categories.Help, f1: true });
	}
	run(accessor: ServicesAccessor): void {
		showAdvancedTour(accessor.get(IWorkbenchLayoutService));
	}
});
