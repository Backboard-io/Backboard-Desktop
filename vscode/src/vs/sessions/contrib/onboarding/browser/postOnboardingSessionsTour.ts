/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/postOnboardingSessionsTour.css';

import { $, addDisposableListener, append, EventType, getActiveWindow, getDomNodePagePosition, getTotalHeight, getTotalWidth } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IBackboardOnboardingState, OnboardingExperience, ONBOARDING_STORAGE_KEY } from '../../../../workbench/contrib/welcomeOnboarding/common/onboardingTypes.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';

interface ISessionsTourStep {
	/** CSS selector for the element this step spotlights. */
	readonly targetSelector: string;
	/** Where the card sits relative to the target: 'above' points its arrow down, 'below' points its arrow up. */
	readonly placement: 'above' | 'below';
	readonly title: string;
	readonly body: string;
}

interface IResolvedSessionsTourStep {
	readonly step: ISessionsTourStep;
	readonly anchor: HTMLElement;
}

const CARD_WIDTH = 320;
const CARD_TARGET_GAP = 16;
const VIEWPORT_MARGIN = 16;
const SESSIONS_TOUR_STORAGE_KEY = 'sessions.postOnboardingTour.complete';

const TOUR_STEPS: readonly ISessionsTourStep[] = [
	{
		targetSelector: '.interactive-input-part',
		placement: 'above',
		title: localize('sessions.tour.prompt.title', "Start with a Prompt"),
		body: localize('sessions.tour.prompt.body', "Describe the next task. Backboard keeps workspace context attached."),
	},
	{
		targetSelector: '.part.sessionspart.basepanel.right .sessions-panel-header-right',
		placement: 'below',
		title: localize('sessions.tour.panels.title', "Switch Panels"),
		body: localize('sessions.tour.panels.body', "Use this menu to open Files, Browser, or Terminal beside the agent."),
	},
	{
		targetSelector: '.part.sessionspart.basepanel.right .sessions-panel-header-right',
		placement: 'below',
		title: localize('sessions.tour.preview.title', "Preview the Result"),
		body: localize('sessions.tour.preview.body', "Open the browser beside chat so beginners can see changes immediately."),
	},
];

/**
 * A lightweight, non-modal spotlight tour shown once in the Agents (sessions)
 * window after the user completes onboarding with the Clean/Simple
 * experience, pointing them at the prompt box and the panel switcher.
 *
 * Onboarding runs in the separate main-workbench window, so there is no
 * same-process event to subscribe to here. Instead this reads the
 * already-persisted onboarding state once at startup: onboarding writes it
 * to APPLICATION-scope storage synchronously before this window is created.
 */
export class PostOnboardingSessionsTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingSessionsTour';

	private readonly stepDisposables = this._register(new DisposableStore());
	private steps: readonly IResolvedSessionsTourStep[] = [];
	private stepIndex = 0;
	private card: HTMLElement | undefined;
	private previouslyFocusedElement: HTMLElement | undefined;

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
		this.steps = TOUR_STEPS
			.map(step => ({ step, anchor: targetWindow.document.querySelector<HTMLElement>(step.targetSelector) }))
			.filter((entry): entry is IResolvedSessionsTourStep => !!entry.anchor && this._isVisible(entry.anchor));

		if (!this.steps.length) {
			return;
		}

		this.stepIndex = 0;
		this.previouslyFocusedElement = targetWindow.document.activeElement as HTMLElement | undefined;
		this._renderStep();
	}

	private _isVisible(element: HTMLElement): boolean {
		const position = getDomNodePagePosition(element);
		return position.width > 0 && position.height > 0;
	}

	private _renderStep(): void {
		this.stepDisposables.clear();
		this.card?.remove();

		const { step, anchor } = this.steps[this.stepIndex];
		const isLastStep = this.stepIndex === this.steps.length - 1;
		const targetWindow = getActiveWindow();

		this.card = append(this.layoutService.activeContainer, $('.sessions-tour-card'));
		this.card.classList.add(step.placement === 'above' ? 'sessions-tour-arrow-down' : 'sessions-tour-arrow-up');
		this.card.setAttribute('role', 'dialog');
		this.card.setAttribute('aria-label', step.title);
		this.card.tabIndex = -1;

		append(this.card, $('.sessions-tour-arrow'));

		const body = append(this.card, $('.sessions-tour-body'));
		append(body, $('h3.sessions-tour-title')).textContent = step.title;
		append(body, $('p.sessions-tour-text')).textContent = step.body;

		const footer = append(this.card, $('.sessions-tour-footer'));
		const skipButton = append(footer, $<HTMLButtonElement>('button.sessions-tour-skip'));
		skipButton.type = 'button';
		skipButton.textContent = localize('sessions.tour.skip', "Skip");

		const footerRight = append(footer, $('.sessions-tour-footer-right'));

		const backButton = append(footerRight, $<HTMLButtonElement>('button.sessions-tour-btn.sessions-tour-btn-secondary'));
		backButton.type = 'button';
		backButton.textContent = localize('sessions.tour.back', "Back");
		backButton.style.visibility = this.stepIndex === 0 ? 'hidden' : '';

		const nextButton = append(footerRight, $<HTMLButtonElement>('button.sessions-tour-btn.sessions-tour-btn-primary'));
		nextButton.type = 'button';
		nextButton.textContent = localize('sessions.tour.continue', "Continue");

		this.stepDisposables.add(addDisposableListener(skipButton, EventType.CLICK, () => this._finish()));
		this.stepDisposables.add(addDisposableListener(backButton, EventType.CLICK, () => {
			if (this.stepIndex > 0) {
				this.stepIndex--;
				this._renderStep();
			}
		}));
		this.stepDisposables.add(addDisposableListener(nextButton, EventType.CLICK, () => {
			if (isLastStep) {
				this._finish();
			} else {
				this.stepIndex++;
				this._renderStep();
			}
		}));
		this.stepDisposables.add(addDisposableListener(this.card, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this._finish();
			}
		}));

		const reposition = () => this._positionCard(anchor, step);
		this.stepDisposables.add(addDisposableListener(targetWindow, EventType.RESIZE, reposition));

		reposition();
		targetWindow.requestAnimationFrame(() => {
			this.card?.classList.add('sessions-tour-visible');
			this.card?.focus();
		});
	}

	private _positionCard(anchor: HTMLElement, step: ISessionsTourStep): void {
		if (!this.card) {
			return;
		}

		const anchorRect = getDomNodePagePosition(anchor);
		const targetWindow = getActiveWindow();
		const cardHeight = getTotalHeight(this.card);
		const cardWidth = getTotalWidth(this.card) || CARD_WIDTH;

		const top = step.placement === 'above'
			? anchorRect.top - cardHeight - CARD_TARGET_GAP
			: anchorRect.top + anchorRect.height + CARD_TARGET_GAP;
		const maxTop = Math.max(VIEWPORT_MARGIN, targetWindow.innerHeight - cardHeight - VIEWPORT_MARGIN);

		const idealLeft = anchorRect.left + (anchorRect.width / 2) - (cardWidth / 2);
		const maxLeft = Math.max(VIEWPORT_MARGIN, targetWindow.innerWidth - cardWidth - VIEWPORT_MARGIN);

		this.card.style.top = `${Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop)}px`;
		this.card.style.left = `${Math.min(Math.max(idealLeft, VIEWPORT_MARGIN), maxLeft)}px`;
	}

	private _finish(): void {
		this.stepDisposables.clear();
		this.card?.remove();
		this.card = undefined;
		this.previouslyFocusedElement?.focus();
	}
}
