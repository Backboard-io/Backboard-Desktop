/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/postOnboardingTour.css';

import { $, addDisposableListener, append, EventType, getActiveWindow, getDomNodePagePosition, getTotalHeight } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { ONBOARDING_TOUR_STORAGE_KEY } from '../common/onboardingTypes.js';

interface IPostOnboardingTourStep {
	/** Workbench part this step spotlights. */
	readonly part: Parts;
	/** Direction the card's arrow points, i.e. which side the target part is on. */
	readonly arrowDirection: 'left' | 'right';
	/** Fraction (0-1) down the target part's height to align the card's vertical center with. */
	readonly verticalAnchor: number;
	readonly title: string;
	readonly body: string;
}

interface IResolvedTourStep {
	readonly step: IPostOnboardingTourStep;
	readonly anchor: HTMLElement;
}

const CARD_WIDTH = 320;
const CARD_TARGET_GAP = 20;
const VIEWPORT_MARGIN = 16;

const TOUR_STEPS: readonly IPostOnboardingTourStep[] = [
	{
		part: Parts.SIDEBAR_PART,
		arrowDirection: 'left',
		verticalAnchor: 0.3,
		title: localize('onboarding.tour.editIde.title', "Edit in the IDE"),
		body: localize('onboarding.tour.editIde.body', "Open files, read code, and preview changes without switching apps."),
	},
	{
		part: Parts.AUXILIARYBAR_PART,
		arrowDirection: 'right',
		verticalAnchor: 0.75,
		title: localize('onboarding.tour.chat.title', "Chat with Backboard"),
		body: localize('onboarding.tour.chat.body', "Describe the change you want, then review the result beside your project."),
	},
];

/**
 * A lightweight, non-modal spotlight tour shown once after onboarding
 * finishes, pointing new users at the editor and the chat panel.
 */
export class PostOnboardingTour extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.postOnboardingTour';

	private readonly stepDisposables = this._register(new DisposableStore());
	private steps: readonly IResolvedTourStep[] = [];
	private stepIndex = 0;
	private card: HTMLElement | undefined;
	private previouslyFocusedElement: HTMLElement | undefined;

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

		// Let the layout the user just opened (editor, panels) settle before measuring it.
		getActiveWindow().requestAnimationFrame(() => this._start());
	}

	private _start(): void {
		this.storageService.store(ONBOARDING_TOUR_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);

		const targetWindow = getActiveWindow();
		this.steps = TOUR_STEPS
			.map(step => ({ step, anchor: this.layoutService.getContainer(targetWindow, step.part) }))
			.filter((entry): entry is IResolvedTourStep => !!entry.anchor && this._isVisible(entry.anchor));

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

		this.card = append(this.layoutService.activeContainer, $('.backboard-tour-card'));
		this.card.classList.add(step.arrowDirection === 'left' ? 'backboard-tour-arrow-left' : 'backboard-tour-arrow-right');
		this.card.setAttribute('role', 'dialog');
		this.card.setAttribute('aria-label', step.title);
		this.card.tabIndex = -1;

		append(this.card, $('.backboard-tour-arrow'));

		const body = append(this.card, $('.backboard-tour-body'));
		append(body, $('h3.backboard-tour-title')).textContent = step.title;
		append(body, $('p.backboard-tour-text')).textContent = step.body;

		const footer = append(this.card, $('.backboard-tour-footer'));
		const skipButton = append(footer, $<HTMLButtonElement>('button.backboard-tour-skip'));
		skipButton.type = 'button';
		skipButton.textContent = localize('onboarding.tour.skip', "Skip");

		const footerRight = append(footer, $('.backboard-tour-footer-right'));

		const backButton = append(footerRight, $<HTMLButtonElement>('button.backboard-tour-btn.backboard-tour-btn-secondary'));
		backButton.type = 'button';
		backButton.textContent = localize('onboarding.tour.back', "Back");
		backButton.style.visibility = this.stepIndex === 0 ? 'hidden' : '';

		const nextButton = append(footerRight, $<HTMLButtonElement>('button.backboard-tour-btn.backboard-tour-btn-primary'));
		nextButton.type = 'button';
		nextButton.textContent = localize('onboarding.tour.continue', "Continue");

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
		this.stepDisposables.add(this.layoutService.onDidLayoutActiveContainer(reposition));
		this.stepDisposables.add(addDisposableListener(getActiveWindow(), EventType.RESIZE, reposition));

		reposition();
		getActiveWindow().requestAnimationFrame(() => {
			this.card?.classList.add('backboard-tour-visible');
			this.card?.focus();
		});
	}

	private _positionCard(anchor: HTMLElement, step: IPostOnboardingTourStep): void {
		if (!this.card) {
			return;
		}

		const anchorRect = getDomNodePagePosition(anchor);
		const targetWindow = getActiveWindow();
		const cardHeight = getTotalHeight(this.card);

		const left = step.arrowDirection === 'left'
			? anchorRect.left + anchorRect.width + CARD_TARGET_GAP
			: anchorRect.left - CARD_WIDTH - CARD_TARGET_GAP;
		const maxLeft = targetWindow.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN;

		const idealTop = anchorRect.top + (anchorRect.height * step.verticalAnchor) - (cardHeight / 2);
		const maxTop = Math.max(VIEWPORT_MARGIN, targetWindow.innerHeight - cardHeight - VIEWPORT_MARGIN);

		this.card.style.left = `${Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, maxLeft))}px`;
		this.card.style.top = `${Math.min(Math.max(idealTop, VIEWPORT_MARGIN), maxTop)}px`;
	}

	private _finish(): void {
		this.stepDisposables.clear();
		this.card?.remove();
		this.card = undefined;
		this.previouslyFocusedElement?.focus();
	}
}
