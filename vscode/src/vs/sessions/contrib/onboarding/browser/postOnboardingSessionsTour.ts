/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ISpotlightTourIntro, ISpotlightTourStep, SpotlightTour, TourPlacement } from '../../../../workbench/contrib/welcomeOnboarding/browser/spotlightTour.js';
import { IBackboardOnboardingState, OnboardingExperience, ONBOARDING_EDITOR_TOUR_PENDING_KEY, ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, ONBOARDING_STORAGE_KEY } from '../../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { RightWorkbenchCommandId } from '../../rightWorkbench/browser/rightWorkbench.js';

/**
 * A spotlight tour shown once in the Agents (sessions) window after the user
 * completes onboarding. It first asks for consent, then walks through the
 * prompt, the sessions list, the Simple/Editor mode switch, and each panel that
 * can sit beside the agent — actually opening Files, Browser, and Terminal in
 * turn — before restoring the layout. The final stop offers to finish in the
 * editor page: completing the tour switches the window to Editor mode, while
 * skipping keeps the simple view.
 *
 * Onboarding runs in the separate main-workbench window, so there is no
 * same-process event to subscribe to here. Onboarding writes its state to
 * APPLICATION-scope storage, which this window reads at startup. Because the
 * Agents window may already be open when onboarding finishes (the state then
 * arrives after this contribution was created), we also watch for the state to
 * change and start the tour when it does.
 */
export class PostOnboardingSessionsTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingSessionsTour';

	private started = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._maybeStart();
		if (!this.started) {
			// The Agents window can outlive the onboarding it hands off from, so
			// pick up the completed state whenever it lands (including cross-window).
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ONBOARDING_STORAGE_KEY, this._store)(() => this._maybeStart()));
		}
	}

	private _maybeStart(): void {
		if (this.started || !this._shouldShowTour()) {
			return;
		}

		this.started = true;
		getActiveWindow().requestAnimationFrame(() => this._start());
	}

	private _shouldShowTour(): boolean {
		if (this.storageService.getBoolean(ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, StorageScope.APPLICATION, false)) {
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
		this.storageService.store(ONBOARDING_SESSIONS_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		this._register(showSessionsOnboardingTour(this.layoutService, this.commandService, this.storageService));
	}
}

/**
 * Builds and starts the Agents-window tour immediately, without any of the
 * once-only gating. Used by the contribution above after onboarding, and by the
 * developer command that force-shows the tour for testing. Returns a disposable
 * that tears the tour down; it also disposes itself once the tour ends.
 */
export function showSessionsOnboardingTour(layoutService: IWorkbenchLayoutService, commandService: ICommandService, storageService: IStorageService): IDisposable {
	const store = new DisposableStore();
	const targetWindow = getActiveWindow();

	const query = (selector: string) => () => targetWindow.document.querySelector<HTMLElement>(selector) ?? undefined;
	// The right-workbench launcher lists every panel as a row keyed by its icon.
	const panelRow = (codicon: string) => () => targetWindow.document.querySelector<HTMLElement>(`.sessions-right-workbench-launcher-row:has(.codicon-${codicon})`) ?? undefined;
	const openPanelMenu = () => commandService.executeCommand(RightWorkbenchCommandId.OpenLauncherMode).then(() => undefined);

	const steps: ISpotlightTourStep[] = [
		{
			title: localize('sessions.tour.prompt.title', "Start with a prompt"),
			body: localize('sessions.tour.prompt.body', "Describe what you want to build or change. The agent works from here."),
			preferredPlacement: TourPlacement.Top,
			anchor: query('.interactive-input-part'),
		},
		{
			title: localize('sessions.tour.sessions.title', "Find your sessions"),
			body: localize('sessions.tour.sessions.body', "Every chat you start is saved here — pick one to jump back in."),
			preferredPlacement: TourPlacement.Right,
			anchor: query('.part.sidebar'),
		},
		{
			title: localize('sessions.tour.mode.title', "Simple and editor, one IDE"),
			body: localize('sessions.tour.mode.body', "Stay in this simple view, or open the full editor to read and edit code — same project, one click away."),
			preferredPlacement: TourPlacement.Bottom,
			anchor: query('.open-in-vscode-titlebar-widget'),
		},
		{
			// The first panel step opens the panels menu beside the agent; the
			// next three walk the spotlight down its rows.
			title: localize('sessions.tour.review.title', "Review changes"),
			body: localize('sessions.tour.review.body', "See what the agent changed, side by side, right beside the chat."),
			preferredPlacement: TourPlacement.Left,
			setup: openPanelMenu,
			anchor: panelRow('diff-multiple'),
		},
		{
			title: localize('sessions.tour.browser.title', "Preview in a browser"),
			body: localize('sessions.tour.browser.body', "Open a live browser to see your app as the agent builds it."),
			preferredPlacement: TourPlacement.Left,
			anchor: panelRow('globe'),
		},
		{
			title: localize('sessions.tour.files.title', "Browse your files"),
			body: localize('sessions.tour.files.body', "Open your project files without leaving the agent."),
			preferredPlacement: TourPlacement.Left,
			anchor: panelRow('files'),
		},
		{
			title: localize('sessions.tour.terminal.title', "Run a terminal"),
			body: localize('sessions.tour.terminal.body', "Run commands in a terminal right next to the chat."),
			preferredPlacement: TourPlacement.Left,
			anchor: panelRow('terminal'),
		},
		{
			title: localize('sessions.tour.editor.title', "Finish in the editor"),
			body: localize('sessions.tour.editor.body', "Want to see the code behind your project? End the tour in the full editor — or skip to stay in this simple view."),
			preferredPlacement: TourPlacement.Bottom,
			anchor: query('.open-in-vscode-titlebar-widget'),
			nextLabel: localize('sessions.tour.editor.cta', "Open the Editor"),
		},
	];

	const intro: ISpotlightTourIntro = {
		title: localize('sessions.tour.intro.title', "Take a quick tour?"),
		body: localize('sessions.tour.intro.body', "Get to know your workspace — where to prompt, find sessions, and open panels beside the agent."),
		caption: localize('sessions.tour.intro.caption', "{0} quick stops", steps.length),
		confirmLabel: localize('sessions.tour.intro.confirm', "Take the tour"),
		dismissLabel: localize('sessions.tour.intro.dismiss', "Maybe later"),
	};

	// Snapshot the panels the tour opens so we can put the layout back afterwards.
	const restore = captureLayout(layoutService, targetWindow);

	const tour = store.add(new SpotlightTour({
		container: layoutService.activeContainer,
		window: targetWindow,
		onLayoutChange: layoutService.onDidLayoutActiveContainer,
		intro,
		steps,
		// Runs however the tour ends (Done, Skip, Escape, or "Maybe later").
		// Puts back whatever the panel steps opened; a no-op when nothing was.
		// Completing the last step (its button reads "Open the Editor") also
		// switches this window to the editor page; skipping stays in Simple.
		onFinish: completed => {
			restoreLayout(layoutService, targetWindow, restore);
			store.dispose();
			if (completed) {
				void openEditorPage(commandService, storageService);
			}
		},
	}));
	tour.start();

	return store;
}

/**
 * Switches the window to the editor page, the same way the titlebar mode
 * switcher's "Editor" item does. The command ids are owned by the desktop
 * (`vs/sessions/electron-browser`) and web (`vs/sessions/browser`) action
 * registrations, which this browser-layer contribution cannot import, so they
 * are tried by id — whichever is registered in this window flavor wins.
 *
 * The pending flag is written first so it is persisted before the switch
 * reloads this window into the main workbench, where the editor-window tour
 * reads it and continues the walkthrough.
 */
async function openEditorPage(commandService: ICommandService, storageService: IStorageService): Promise<void> {
	storageService.store(ONBOARDING_EDITOR_TOUR_PENDING_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
	for (const commandId of ['agents.openSessionInVSCode', 'sessions.openInVSCode']) {
		try {
			await commandService.executeCommand(commandId);
			return;
		} catch {
			// Not registered in this window flavor — try the next one.
		}
	}
}

interface ILayoutSnapshot {
	readonly auxiliaryBar: boolean;
	readonly panel: boolean;
	readonly editor: boolean;
}

function captureLayout(layoutService: IWorkbenchLayoutService, targetWindow: Window): ILayoutSnapshot {
	return {
		auxiliaryBar: layoutService.isVisible(Parts.AUXILIARYBAR_PART),
		panel: layoutService.isVisible(Parts.PANEL_PART),
		editor: layoutService.isVisible(Parts.EDITOR_PART, targetWindow),
	};
}

function restoreLayout(layoutService: IWorkbenchLayoutService, targetWindow: Window, snapshot: ILayoutSnapshot): void {
	if (layoutService.isVisible(Parts.AUXILIARYBAR_PART) !== snapshot.auxiliaryBar) {
		layoutService.setPartHidden(!snapshot.auxiliaryBar, Parts.AUXILIARYBAR_PART);
	}
	if (layoutService.isVisible(Parts.PANEL_PART) !== snapshot.panel) {
		layoutService.setPartHidden(!snapshot.panel, Parts.PANEL_PART);
	}
	if (layoutService.isVisible(Parts.EDITOR_PART, targetWindow) !== snapshot.editor) {
		layoutService.setPartHidden(!snapshot.editor, Parts.EDITOR_PART);
	}
}
