/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load styles for the remaining onboarding variant.
import './media/variationA.css';

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { ONBOARDING_ADVANCED_TOUR_STORAGE_KEY, ONBOARDING_EDITOR_TOUR_PENDING_KEY, ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_STORAGE_KEY } from '../common/onboardingTypes.js';
import { OnboardingVariationA } from './onboardingVariationA.js';
import { PostOnboardingEditorTour, showEditorOnboardingTour } from './postOnboardingEditorTour.js';

registerSingleton(IOnboardingService, OnboardingVariationA, InstantiationType.Delayed);

registerWorkbenchContribution2(PostOnboardingEditorTour.ID, PostOnboardingEditorTour, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.welcomeOnboarding2026',
			title: localize2('welcomeOnboarding2026', "Backboard Onboarding"),
			category: Categories.Help,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const onboardingService = accessor.get(IOnboardingService);
		onboardingService.show();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.resetBackboardOnboarding',
			title: localize2('resetBackboardOnboarding', "Reset Backboard Onboarding"),
			category: Categories.Developer,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const storageService = accessor.get(IStorageService);
		storageService.remove(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION);
		storageService.remove(ONBOARDING_TOUR_STORAGE_KEY, StorageScope.APPLICATION);
		storageService.remove(ONBOARDING_ADVANCED_TOUR_STORAGE_KEY, StorageScope.APPLICATION);
		storageService.remove(ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, StorageScope.APPLICATION);
		storageService.remove(ONBOARDING_EDITOR_TOUR_PENDING_KEY, StorageScope.APPLICATION);

		const onboardingService = accessor.get(IOnboardingService);
		onboardingService.reset();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.showEditorWindowTour',
			title: localize2('showEditorWindowTour', "Show Editor Mode Tour"),
			category: Categories.Help,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		showEditorOnboardingTour(accessor.get(IWorkbenchLayoutService));
	}
});
