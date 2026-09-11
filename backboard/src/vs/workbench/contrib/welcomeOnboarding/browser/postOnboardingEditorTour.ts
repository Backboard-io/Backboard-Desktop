/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ISpotlightTourIntro, ISpotlightTourStep, SpotlightTour, TourPlacement } from './spotlightTour.js';
import { OnboardingExperience, ONBOARDING_ADVANCED_TOUR_PENDING_KEY, ONBOARDING_EDITOR_TOUR_PENDING_KEY, ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_STORAGE_KEY } from '../common/onboardingTypes.js';
import { IOnboardingService } from '../common/onboardingService.js';

/**
 * Continues the fresh-install walkthrough in Editor mode, then hands off to Advanced.
 * Legacy onboarding states never trigger an automatic tour.
 */
export class PostOnboardingEditorTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingEditorTour';

	private started = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@IOnboardingService onboardingService: IOnboardingService,
	) {
		super();

		// welcomeOnboarding loads in every window flavor; the editor tour belongs
		// only in the plain editor workbench, never the Agents or Advanced window.
		if (this.environmentService.isSessionsWindow || this.environmentService.isOptimusWindow) {
			return;
		}

		this._maybeStart();
		if (!this.started) {
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ONBOARDING_EDITOR_TOUR_PENDING_KEY, this._store)(() => this._maybeStart()));
			this._register(onboardingService.onDidFinishOnboardingFlow(() => this._maybeStart()));
		}
	}

	private _maybeStart(): void {
		if (this.started || getActiveWindow().document.querySelector('.onboarding-a-overlay')) {
			return;
		}
		const pending = this.storageService.getBoolean(ONBOARDING_EDITOR_TOUR_PENDING_KEY, StorageScope.APPLICATION, false);
		try {
			const state = JSON.parse(this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
			if (state?.tourEligible !== true) {
				return;
			}
		} catch {
			return;
		}
		if (!pending) {
			if (this.storageService.getBoolean(ONBOARDING_TOUR_STORAGE_KEY, StorageScope.APPLICATION, false)) {
				return;
			}
			try {
				const state = JSON.parse(this.storageService.get(ONBOARDING_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
				if (state.completed !== true || state.experience !== OnboardingExperience.Developer) {
					return;
				}
			} catch {
				return;
			}
		}

		this.started = true;
		// One-shot: clear the handoff flag so the tour never repeats.
		this.storageService.remove(ONBOARDING_EDITOR_TOUR_PENDING_KEY, StorageScope.APPLICATION);
		this.storageService.store(ONBOARDING_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		getActiveWindow().requestAnimationFrame(() => this._register(showEditorOnboardingTour(this.layoutService, () => {
			this.storageService.store(ONBOARDING_ADVANCED_TOUR_PENDING_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			void this.storageService.flush().then(() => this.commandService.executeCommand('workbench.action.openOptimusWindow')).catch(onUnexpectedError);
		})));
	}
}

/**
 * Builds and starts the editor-window tour immediately, without any once-only
 * gating. Used by the contribution above after the Agents-window handoff, and
 * by the developer command that force-shows the tour for testing. Returns a
 * disposable that tears the tour down; it also disposes itself once the tour
 * ends.
 */
export function showEditorOnboardingTour(layoutService: IWorkbenchLayoutService, onComplete?: () => void): IDisposable {
	const store = new DisposableStore();
	const targetWindow = getActiveWindow();

	const query = (selector: string) => () => targetWindow.document.querySelector<HTMLElement>(selector) ?? undefined;
	// Reveal a part before its step so the spotlight has something to ring.
	const reveal = (part: Parts) => () => {
		if (!layoutService.isVisible(part, targetWindow)) {
			layoutService.setPartHidden(false, part);
		}
	};

	const steps: ISpotlightTourStep[] = [
		{
			title: localize('editor.tour.editor.title', "The full editor"),
			body: localize('editor.tour.editor.body', "Here's the complete IDE. Read and edit any file the agent works on, with everything you'd expect from an editor."),
			preferredPlacement: TourPlacement.Left,
			anchor: () => layoutService.getContainer(targetWindow, Parts.EDITOR_PART),
		},
		{
			title: localize('editor.tour.explorer.title', "Browse your project"),
			body: localize('editor.tour.explorer.body', "Every file in your workspace lives here — open, rename, and organize them from the explorer."),
			preferredPlacement: TourPlacement.Right,
			setup: reveal(Parts.SIDEBAR_PART),
			anchor: () => layoutService.getContainer(targetWindow, Parts.SIDEBAR_PART),
		},
		{
			title: localize('editor.tour.terminal.title', "Run a terminal"),
			body: localize('editor.tour.terminal.body', "Run commands, servers, and scripts in the integrated terminal — no need to leave the editor."),
			preferredPlacement: TourPlacement.Top,
			setup: reveal(Parts.PANEL_PART),
			anchor: () => layoutService.getContainer(targetWindow, Parts.PANEL_PART),
		},
		{
			title: localize('editor.tour.chat.title', "Your agent, still here"),
			body: localize('editor.tour.chat.body', "The agent stays beside your code. Keep chatting while you read and edit."),
			preferredPlacement: TourPlacement.Left,
			setup: reveal(Parts.AUXILIARYBAR_PART),
			anchor: () => layoutService.getContainer(targetWindow, Parts.AUXILIARYBAR_PART),
		},
		{
			title: localize('editor.tour.switch.title', "Explore Advanced mode"),
			body: localize('editor.tour.switch.body', "Advanced brings your agent tasks together in a dashboard. Use the mode menu anytime to return to Simple or Editor."),
			preferredPlacement: TourPlacement.Bottom,
			anchor: query('.backboard-mode-titlebar-widget'),
			nextLabel: onComplete ? localize('editor.tour.advanced.cta', "Open Advanced") : localize('editor.tour.done', "Done"),
		},
	];

	const intro: ISpotlightTourIntro = {
		title: localize('editor.tour.intro.title', "Explore Editor mode?"),
		body: localize('editor.tour.intro.body', "Take a quick look around the full editor: your files, the terminal, and your agent right beside the code."),
		caption: localize('editor.tour.intro.caption', "{0} quick stops", steps.length),
		confirmLabel: localize('editor.tour.intro.confirm', "Show me"),
		dismissLabel: localize('editor.tour.intro.dismiss', "Maybe later"),
	};

	// Snapshot the parts the tour reveals so we can put the layout back afterwards.
	const restore = captureLayout(layoutService, targetWindow);

	const tour = store.add(new SpotlightTour({
		container: layoutService.activeContainer,
		window: targetWindow,
		onLayoutChange: layoutService.onDidLayoutActiveContainer,
		intro: onComplete ? undefined : intro,
		steps,
		// Runs however the tour ends (Done, Skip, Escape, or "Maybe later").
		// Puts back whatever the steps revealed; a no-op when nothing changed.
		onFinish: completed => {
			restoreLayout(layoutService, targetWindow, restore);
			store.dispose();
			if (completed) {
				onComplete?.();
			}
		},
	}));
	tour.start();

	return store;
}

interface ILayoutSnapshot {
	readonly sidebar: boolean;
	readonly panel: boolean;
	readonly auxiliaryBar: boolean;
}

function captureLayout(layoutService: IWorkbenchLayoutService, targetWindow: Window): ILayoutSnapshot {
	return {
		sidebar: layoutService.isVisible(Parts.SIDEBAR_PART, targetWindow),
		panel: layoutService.isVisible(Parts.PANEL_PART, targetWindow),
		auxiliaryBar: layoutService.isVisible(Parts.AUXILIARYBAR_PART, targetWindow),
	};
}

function restoreLayout(layoutService: IWorkbenchLayoutService, targetWindow: Window, snapshot: ILayoutSnapshot): void {
	if (layoutService.isVisible(Parts.SIDEBAR_PART, targetWindow) !== snapshot.sidebar) {
		layoutService.setPartHidden(!snapshot.sidebar, Parts.SIDEBAR_PART);
	}
	if (layoutService.isVisible(Parts.PANEL_PART, targetWindow) !== snapshot.panel) {
		layoutService.setPartHidden(!snapshot.panel, Parts.PANEL_PART);
	}
	if (layoutService.isVisible(Parts.AUXILIARYBAR_PART, targetWindow) !== snapshot.auxiliaryBar) {
		layoutService.setPartHidden(!snapshot.auxiliaryBar, Parts.AUXILIARYBAR_PART);
	}
}
