/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getActiveWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Severity, INotificationService } from '../../../../platform/notification/common/notification.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService, FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';
import product from '../../../../platform/product/common/product.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID } from '../../chat/common/constants.js';
import { IOnboardingService } from '../common/onboardingService.js';
import {
	getOnboardingStepSubtitle,
	getOnboardingStepTitle,
	IBackboardOnboardingState,
	IOnboardingThemeOption,
	OnboardingExperience,
	ONBOARDING_STORAGE_KEY,
	ONBOARDING_EXPERIENCE_OPTIONS,
	OnboardingStepId,
	ONBOARDING_STEPS,
} from '../common/onboardingTypes.js';

type OnboardingStepViewClassification = {
	owner: 'cwebster-99';
	comment: 'Tracks which onboarding step is viewed.';
	step: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The step identifier.' };
	stepNumber: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The 1-based visible step index.' };
};

type OnboardingStepViewEvent = {
	step: string;
	stepNumber: number;
};

type OnboardingActionClassification = {
	owner: 'cwebster-99';
	comment: 'Tracks actions taken on the Backboard onboarding wizard.';
	action: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The action performed.' };
	step: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The step the action was performed on.' };
	argument: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Optional context such as selected mode or theme id.' };
};

type OnboardingActionEvent = {
	action: string;
	step: string;
	argument: string | undefined;
};

const BACKBOARD_SIGN_IN_URL = 'https://app.backboard.io/signup';
const BACKBOARD_API_KEYS_URL = 'https://app.backboard.io/dashboard/api-keys';
const BACKBOARD_API_KEY_PATTERN = /^espr_[A-Za-z0-9_-]{43}$/;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBackboardEnv(env: string | undefined): string {
	switch ((env || 'prod').trim().toLowerCase()) {
		case '':
			return 'prod';
		case 'production':
			return 'prod';
		case 'development':
			return 'dev';
		default:
			return (env || 'prod').trim().toLowerCase();
	}
}

function getBackboardEnvKeys(config: Record<string, unknown>): Record<string, string> {
	const envKeys = config.env_keys;
	if (!isObjectRecord(envKeys)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const [env, apiKey] of Object.entries(envKeys)) {
		if (typeof apiKey === 'string') {
			result[normalizeBackboardEnv(env)] = apiKey;
		}
	}
	return result;
}

/**
 * Backboard onboarding modal.
 *
 * This ports the Zed onboarding flow into the VS Code workbench shell:
 * welcome, experience picker, theme picker, and optional settings import.
 */
export class OnboardingVariationA extends Disposable implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidDismiss = this._register(new Emitter<void>());
	readonly onDidDismiss: Event<void> = this._onDidDismiss.event;

	private overlay: HTMLElement | undefined;
	private card: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	private progressContainer: HTMLElement | undefined;
	private stepLabelEl: HTMLElement | undefined;
	private titleEl: HTMLElement | undefined;
	private subtitleEl: HTMLElement | undefined;
	private contentEl: HTMLElement | undefined;
	private backButton: HTMLButtonElement | undefined;
	private nextButton: HTMLButtonElement | undefined;
	private closeButton: HTMLButtonElement | undefined;

	private currentStepIndex = 0;
	private readonly steps = ONBOARDING_STEPS;
	private readonly disposables = this._register(new DisposableStore());
	private readonly stepDisposables = this._register(new DisposableStore());
	private readonly footerFocusableElements: HTMLElement[] = [];
	private readonly stepFocusableElements: HTMLElement[] = [];

	private previouslyFocusedElement: HTMLElement | undefined;
	private _isShowing = false;
	private selectedThemeId = 'dark-2026';
	private selectedExperience = OnboardingExperience.Developer;
	private hasConfirmedBackboardSignIn = false;
	private hasImportedApiKey = false;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();

		this._syncSelectedThemeWithCurrentTheme();
	}

	private _syncSelectedThemeWithCurrentTheme(): void {
		const currentTheme = this.themeService.getColorTheme();
		const matchingTheme = (product.onboardingThemes ?? []).find(theme => theme.themeId === currentTheme.settingsId);
		if (matchingTheme) {
			this.selectedThemeId = matchingTheme.id;
		}
	}

	get isShowing(): boolean {
		return this._isShowing;
	}

	show(): void {
		if (this.overlay) {
			return;
		}

		this._isShowing = true;
		this.currentStepIndex = 0;
		this.previouslyFocusedElement = getActiveWindow().document.activeElement as HTMLElement | undefined;

		const container = this.layoutService.activeContainer;

		this.overlay = append(container, $('.onboarding-a-overlay'));
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.overlay.setAttribute('aria-label', localize('onboarding.backboard.aria', "Welcome to Backboard Studio"));

		this.card = append(this.overlay, $('.onboarding-a-card'));

		this.closeButton = append(this.card, $<HTMLButtonElement>('button.onboarding-a-close-btn'));
		this.closeButton.type = 'button';
		this.closeButton.setAttribute('aria-label', localize('onboarding.close', "Close"));
		this.closeButton.appendChild(renderIcon(Codicon.close));

		const header = append(this.card, $('.onboarding-a-header'));
		this.progressContainer = append(header, $('.onboarding-a-progress'));
		this.stepLabelEl = append(this.progressContainer, $('span.onboarding-a-step-label'));
		this._renderProgress();

		this.bodyEl = append(this.card, $('.onboarding-a-body'));
		this.titleEl = append(this.bodyEl, $('h2.onboarding-a-step-title'));
		this.subtitleEl = append(this.bodyEl, $('p.onboarding-a-step-subtitle'));
		this.contentEl = append(this.bodyEl, $('.onboarding-a-step-content'));
		this._renderStep();
		this._logStepView();

		const footer = append(this.card, $('.onboarding-a-footer'));
		const footerRight = append(footer, $('.onboarding-a-footer-right'));

		this.backButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-secondary'));
		this.backButton.textContent = localize('onboarding.back', "Back");
		this.backButton.type = 'button';
		this.footerFocusableElements.push(this.backButton);

		this.nextButton = append(footerRight, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-primary'));
		this.nextButton.type = 'button';
		this.footerFocusableElements.push(this.nextButton);
		this._updateButtonStates();

		this.disposables.add(addDisposableListener(this.closeButton, EventType.CLICK, () => {
			this._logAction('skip');
			this._dismiss('skip');
		}));

		this.disposables.add(addDisposableListener(this.backButton, EventType.CLICK, () => {
			this._logAction('back');
			this._prevStep();
		}));

		this.disposables.add(addDisposableListener(this.nextButton, EventType.CLICK, () => {
			if (this._isLastStep()) {
				this._logAction('complete');
				this._dismiss('complete');
				return;
			}

			this._logAction('next');
			this._nextStep();
		}));

		this.disposables.add(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (event.target === this.overlay) {
				this._dismiss('skip');
			}
		}));

		this.disposables.add(addDisposableListener(this.overlay, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			event.stopPropagation();

			if (keyboardEvent.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this._dismiss('skip');
				return;
			}

			if (keyboardEvent.keyCode === KeyCode.Tab) {
				this._trapTab(event, keyboardEvent.shiftKey);
			}
		}));

		getActiveWindow().requestAnimationFrame(() => {
			this.overlay?.classList.add('visible');
		});

		this._focusCurrentStepElement();
	}

	reset(): void {
		if (this.overlay) {
			this._removeFromDOM();
		}

		this.currentStepIndex = 0;
		this.selectedExperience = OnboardingExperience.Developer;
		this.hasConfirmedBackboardSignIn = false;
		this.hasImportedApiKey = false;
		this._syncSelectedThemeWithCurrentTheme();
		this.show();
	}

	private _dismiss(reason: 'complete' | 'skip'): void {
		if (!this.overlay) {
			return;
		}

		this._logAction('dismiss', undefined, reason);
		this._storeOnboardingState(reason);
		this.overlay.classList.remove('visible');
		this.overlay.classList.add('exiting');

		let handled = false;
		const onTransitionEnd = () => {
			if (handled) {
				return;
			}

			handled = true;
			this._removeFromDOM();
			this._onDidDismiss.fire();
		};

		this.overlay.addEventListener('transitionend', onTransitionEnd, { once: true });
		setTimeout(onTransitionEnd, 400);
	}

	private _storeOnboardingState(reason: 'complete' | 'skip'): void {
		const state: IBackboardOnboardingState = {
			version: 1,
			completed: reason === 'complete',
			dismissedReason: reason,
			experience: this.selectedExperience,
			themeId: this.selectedThemeId,
			apiKeyImported: this.hasImportedApiKey,
		};

		this.storageService.store(ONBOARDING_STORAGE_KEY, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private _nextStep(): void {
		const nextStepIndex = this._nextVisibleStepIndex();
		if (nextStepIndex === undefined) {
			return;
		}

		this.currentStepIndex = nextStepIndex;
		this._renderStepFrame();
	}

	private _prevStep(): void {
		const previousStepIndex = this._previousVisibleStepIndex();
		if (previousStepIndex === undefined) {
			return;
		}

		this.currentStepIndex = previousStepIndex;
		this._renderStepFrame();
	}

	private _renderStepFrame(): void {
		this._renderStep();
		this._renderProgress();
		this._updateButtonStates();
		this._focusCurrentStepElement();
		this._logStepView();
	}

	private _isLastStep(): boolean {
		return this._nextVisibleStepIndex() === undefined;
	}

	private _nextVisibleStepIndex(): number | undefined {
		for (let index = this.currentStepIndex + 1; index < this.steps.length; index++) {
			if (!this._shouldSkipStep(this.steps[index])) {
				return index;
			}
		}

		return undefined;
	}

	private _previousVisibleStepIndex(): number | undefined {
		for (let index = this.currentStepIndex - 1; index >= 0; index--) {
			if (!this._shouldSkipStep(this.steps[index])) {
				return index;
			}
		}

		return undefined;
	}

	private _visibleSteps(): readonly OnboardingStepId[] {
		return this.steps.filter(step => !this._shouldSkipStep(step));
	}

	private _shouldSkipStep(step: OnboardingStepId): boolean {
		if (this.selectedExperience === OnboardingExperience.Simple) {
			return step === OnboardingStepId.Theme || step === OnboardingStepId.ImportSettings;
		}

		return false;
	}

	private _renderProgress(): void {
		if (!this.progressContainer || !this.stepLabelEl) {
			return;
		}

		clearNode(this.progressContainer);

		const visibleSteps = this._visibleSteps();
		const currentVisibleStepIndex = visibleSteps.indexOf(this.steps[this.currentStepIndex]);
		for (let index = 0; index < visibleSteps.length; index++) {
			const dot = append(this.progressContainer, $('span.onboarding-a-progress-dot'));
			if (index === currentVisibleStepIndex) {
				dot.classList.add('active');
			} else if (index < currentVisibleStepIndex) {
				dot.classList.add('completed');
			}
		}

		this.progressContainer.appendChild(this.stepLabelEl);
		this.stepLabelEl.textContent = localize('onboarding.stepOf', "{0} of {1}", currentVisibleStepIndex + 1, visibleSteps.length);
	}

	private _renderStep(): void {
		if (!this.bodyEl || !this.titleEl || !this.subtitleEl || !this.contentEl || !this.card) {
			return;
		}

		this.stepDisposables.clear();
		this.stepFocusableElements.length = 0;

		const stepId = this.steps[this.currentStepIndex];
		const isWelcome = stepId === OnboardingStepId.Welcome;

		this.card.classList.toggle('onboarding-a-card-welcome', isWelcome);
		this.titleEl.style.display = isWelcome ? 'none' : '';
		this.subtitleEl.style.display = isWelcome ? 'none' : '';
		this.titleEl.textContent = getOnboardingStepTitle(stepId);
		this.subtitleEl.textContent = getOnboardingStepSubtitle(stepId);

		clearNode(this.contentEl);

		switch (stepId) {
			case OnboardingStepId.Welcome:
				this._renderWelcomeStep(this.contentEl);
				break;
			case OnboardingStepId.Experience:
				this._renderExperienceStep(this.contentEl);
				break;
			case OnboardingStepId.Theme:
				this._renderThemeStep(this.contentEl);
				break;
			case OnboardingStepId.ImportSettings:
				this._renderImportSettingsStep(this.contentEl);
				break;
			case OnboardingStepId.SignIn:
				this._renderSignInStep(this.contentEl);
				break;
			case OnboardingStepId.ApiKey:
				this._renderApiKeyStep(this.contentEl);
				break;
		}

		const visibleSteps = this._visibleSteps();
		this.bodyEl.setAttribute('aria-label', localize(
			'onboarding.step.aria',
			"Step {0} of {1}: {2}",
			visibleSteps.indexOf(stepId) + 1,
			visibleSteps.length,
			getOnboardingStepTitle(stepId)
		));
	}

	private _updateButtonStates(): void {
		if (this.backButton) {
			this.backButton.style.display = this._previousVisibleStepIndex() === undefined ? 'none' : '';
		}

		if (!this.nextButton) {
			return;
		}

		const currentStep = this.steps[this.currentStepIndex];
		this.nextButton.disabled =
			(currentStep === OnboardingStepId.SignIn && !this.hasConfirmedBackboardSignIn)
			|| (currentStep === OnboardingStepId.ApiKey && !this.hasImportedApiKey);

		if (this._isLastStep()) {
			this.nextButton.textContent = localize('onboarding.backboard.startBuilding', "Start Building");
		} else if (currentStep === OnboardingStepId.Welcome) {
			this.nextButton.textContent = localize('onboarding.backboard.continue', "Continue");
		} else {
			this.nextButton.textContent = localize('onboarding.next', "Continue");
		}
	}

	private _renderWelcomeStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-welcome'));

		const splash = append(wrapper, $('.onboarding-backboard-splash'));
		this._createBackboardMark(splash, 'onboarding-backboard-splash-mark');

		const welcomeContent = append(wrapper, $('.onboarding-backboard-welcome-content'));

		const brand = append(welcomeContent, $('.onboarding-backboard-brand'));
		this._createBackboardMark(brand, 'onboarding-backboard-mark');

		const title = append(welcomeContent, $('h1.onboarding-backboard-title'));
		title.textContent = getOnboardingStepTitle(OnboardingStepId.Welcome);

		const subtitle = append(welcomeContent, $('p.onboarding-backboard-subtitle'));
		subtitle.textContent = getOnboardingStepSubtitle(OnboardingStepId.Welcome);

		const continueButton = this._registerStepFocusable(append(welcomeContent, $<HTMLButtonElement>('button.onboarding-backboard-welcome-continue')));
		continueButton.type = 'button';
		continueButton.disabled = true;
		continueButton.textContent = localize('onboarding.backboard.continue', "Continue");
		let isAdvancing = false;
		this.stepDisposables.add(addDisposableListener(continueButton, EventType.CLICK, () => {
			if (isAdvancing || continueButton.disabled) {
				return;
			}

			isAdvancing = true;
			continueButton.disabled = true;
			this._logAction('next');
			welcomeContent.classList.add('exiting');
			this._playWelcomeAdvanceTransition();
		}));

		const activeWindow = getActiveWindow();
		const splashTimer = activeWindow.setTimeout(() => {
			splash.classList.add('fade-out');
			welcomeContent.classList.add('visible');
			continueButton.disabled = false;
			this._focusCurrentStepElement();
		}, 1800);
		const removeTimer = activeWindow.setTimeout(() => {
			splash.remove();
		}, 2500);

		this.stepDisposables.add(toDisposable(() => {
			activeWindow.clearTimeout(splashTimer);
			activeWindow.clearTimeout(removeTimer);
			}));
	}

	private _playWelcomeAdvanceTransition(): void {
		if (!this.card) {
			this._nextStep();
			return;
		}

		const activeWindow = getActiveWindow();
		const transitionSplash = append(this.card, $('.onboarding-backboard-step-transition'));
		transitionSplash.setAttribute('aria-hidden', 'true');
		this._createBackboardMark(transitionSplash, 'onboarding-backboard-splash-mark');

		activeWindow.requestAnimationFrame(() => {
			transitionSplash.classList.add('visible');
		});

		const nextStepTimer = activeWindow.setTimeout(() => {
			this._nextStep();
		}, 800);

		const fadeTimer = activeWindow.setTimeout(() => {
			transitionSplash.classList.add('fade-out');
		}, 1800);

		const removeTimer = activeWindow.setTimeout(() => {
			transitionSplash.remove();
			this._focusCurrentStepElement();
		}, 2450);

		this.disposables.add(toDisposable(() => {
			activeWindow.clearTimeout(nextStepTimer);
			activeWindow.clearTimeout(fadeTimer);
			activeWindow.clearTimeout(removeTimer);
			transitionSplash.remove();
		}));
	}

	private _createBackboardMark(parent: HTMLElement, className: string): HTMLElement {
		const mark = append(parent, $(`.${className}`));
		const markImg = append(mark, $<HTMLImageElement>('img'));
		markImg.alt = '';
		markImg.decoding = 'async';
		markImg.src = FileAccess.asBrowserUri('vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg').toString(true);
		return mark;
	}

	private _renderExperienceStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-experience'));
		const grid = append(wrapper, $('.onboarding-backboard-mode-grid'));
		grid.setAttribute('role', 'radiogroup');
		grid.setAttribute('aria-label', localize('onboarding.backboard.experience.label', "Choose your workspace mode"));

		const cards: HTMLButtonElement[] = [];
		for (const option of ONBOARDING_EXPERIENCE_OPTIONS) {
			const card = this._registerStepFocusable(append(grid, $<HTMLButtonElement>('button.onboarding-backboard-mode-card')));
			card.type = 'button';
			card.dataset.id = option.id;
			card.setAttribute('role', 'radio');
			card.setAttribute('aria-checked', option.id === this.selectedExperience ? 'true' : 'false');
			card.setAttribute('aria-label', localize('onboarding.backboard.experience.card.aria', "{0}. {1}. {2}", option.label, option.eyebrow, option.description));
			cards.push(card);

			if (option.id === this.selectedExperience) {
				card.classList.add('selected');
			}

			const preview = append(card, $('.onboarding-backboard-mode-preview'));
			const lightPreview = append(preview, $<HTMLImageElement>('img.onboarding-backboard-mode-image.onboarding-backboard-mode-image-light'));
			lightPreview.alt = '';
			lightPreview.decoding = 'async';
			lightPreview.src = this._mediaUri(option.lightPreview);

			const darkPreview = append(preview, $<HTMLImageElement>('img.onboarding-backboard-mode-image.onboarding-backboard-mode-image-dark'));
			darkPreview.alt = '';
			darkPreview.decoding = 'async';
			darkPreview.src = this._mediaUri(option.darkPreview);

			const copy = append(card, $('.onboarding-backboard-mode-copy'));
			const eyebrow = append(copy, $('div.onboarding-backboard-mode-eyebrow'));
			eyebrow.textContent = option.eyebrow;

			const title = append(copy, $('div.onboarding-backboard-mode-title'));
			title.textContent = option.label;

			const description = append(copy, $('p.onboarding-backboard-mode-description'));
			description.textContent = option.description;

			this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this._selectExperience(option.id, cards);
				this.accessibilityService.alert(localize('onboarding.backboard.experience.selected.alert', "{0} selected", option.label));
			}));
		}

		const selectedExperienceIndex = ONBOARDING_EXPERIENCE_OPTIONS.findIndex(option => option.id === this.selectedExperience);
		this._setupRadioGroupNavigation(cards, Math.max(0, selectedExperienceIndex));
	}

	private _selectExperience(experience: OnboardingExperience, cards: readonly HTMLElement[]): void {
		this.selectedExperience = experience;
		this.hasConfirmedBackboardSignIn = false;
		this.hasImportedApiKey = false;
		this._logAction('selectExperience', undefined, experience);

		for (const card of cards) {
			const isSelected = card.dataset.id === experience;
			card.classList.toggle('selected', isSelected);
			card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
		}

		this._renderProgress();
		this._updateButtonStates();
	}

	private _renderThemeStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-theme'));
		const themeGrid = append(wrapper, $('.onboarding-a-theme-grid'));
		themeGrid.setAttribute('role', 'radiogroup');
		themeGrid.setAttribute('aria-label', localize('onboarding.personalize.themeLabel', "Choose a color theme"));

		const themes = product.onboardingThemes ?? [];
		if (!themes.length) {
			const empty = append(wrapper, $('p.onboarding-backboard-empty'));
			empty.textContent = localize('onboarding.backboard.theme.empty', "No onboarding themes are configured.");
			return;
		}

		const themeCards: HTMLButtonElement[] = [];
		for (const theme of themes) {
			this._createThemeCard(themeGrid, theme, themeCards);
		}

		const selectedThemeIndex = themes.findIndex(theme => theme.id === this.selectedThemeId);
		this._setupRadioGroupNavigation(themeCards, Math.max(0, selectedThemeIndex));
	}

	private _createThemeCard(parent: HTMLElement, theme: IOnboardingThemeOption, allCards: HTMLButtonElement[]): void {
		const card = this._registerStepFocusable(append(parent, $<HTMLButtonElement>('button.onboarding-a-theme-card')));
		card.type = 'button';
		card.dataset.id = theme.id;
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-checked', theme.id === this.selectedThemeId ? 'true' : 'false');
		card.setAttribute('aria-label', theme.label);
		allCards.push(card);

		if (theme.id === this.selectedThemeId) {
			card.classList.add('selected');
		}

		const preview = append(card, $('div.onboarding-a-theme-preview'));
		const img = append(preview, $<HTMLImageElement>('img.onboarding-a-theme-preview-img'));
		img.alt = '';
		img.decoding = 'async';
		img.src = this._mediaUri(`theme-preview-${theme.id}.svg`);

		const label = append(card, $('div.onboarding-a-theme-label'));
		label.textContent = theme.label;

		this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
			this._logAction('selectTheme', undefined, theme.id);
			void this._selectTheme(theme);

			for (const c of allCards) {
				const isSelected = c.dataset.id === theme.id;
				c.classList.toggle('selected', isSelected);
				c.setAttribute('aria-checked', isSelected ? 'true' : 'false');
			}

			this.accessibilityService.alert(localize('onboarding.theme.selected.alert', "{0} theme selected", theme.label));
		}));
	}

	private async _selectTheme(theme: IOnboardingThemeOption): Promise<void> {
		this.selectedThemeId = theme.id;
		const themes = await this.themeService.getColorThemes();
		const match = themes.find(candidate => candidate.settingsId === theme.themeId);
		if (match) {
			await this.themeService.setColorTheme(match.id, ConfigurationTarget.USER);
		}
	}

	private _renderImportSettingsStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-import'));
		const grid = append(wrapper, $('.onboarding-backboard-import-grid'));

		this._createImportCard(
			grid,
			'vscode',
			localize('onboarding.backboard.import.vscode', "VS Code"),
			localize('onboarding.backboard.import.vscode.description', "Bring keybindings and settings."),
			'onboarding-vscode.png'
		);

		this._createImportCard(
			grid,
			'cursor',
			localize('onboarding.backboard.import.cursor', "Cursor"),
			localize('onboarding.backboard.import.cursor.description', "Bring your Cursor setup."),
			'onboarding-cursor.png'
		);
	}

	private _createImportCard(parent: HTMLElement, id: string, label: string, description: string, icon: string): void {
		const card = append(parent, $('.onboarding-backboard-import-card'));

		const iconWrap = append(card, $('.onboarding-backboard-import-icon'));
		const img = append(iconWrap, $<HTMLImageElement>('img'));
		img.alt = '';
		img.decoding = 'async';
		img.src = this._mediaUri(icon);

		const copy = append(card, $('.onboarding-backboard-import-copy'));
		const title = append(copy, $('div.onboarding-backboard-import-title'));
		title.textContent = label;
		const desc = append(copy, $('p.onboarding-backboard-import-description'));
		desc.textContent = description;

		const button = this._registerStepFocusable(append(card, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-secondary.onboarding-backboard-import-button')));
		button.type = 'button';
		button.textContent = localize('onboarding.backboard.import.button', "Import");

		this.stepDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
			this._logAction('importSettings', undefined, id);
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('onboarding.backboard.import.pending', "{0} settings import is not wired up in the VS Code build yet.", label),
			});
		}));
	}

	private _renderSignInStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-connect.onboarding-backboard-connect-signin'));
		const panel = append(wrapper, $('.onboarding-backboard-connect-panel'));
		const mark = append(panel, $('.onboarding-backboard-connect-mark'));
		this._createBackboardMark(mark, 'onboarding-backboard-connect-mark-inner');

		const copy = append(panel, $('.onboarding-backboard-connect-copy'));
		const description = append(copy, $('p.onboarding-backboard-connect-description'));
		description.textContent = localize('onboarding.backboard.signIn.description', "To finish setup, set up a Backboard.io account.");

		const accountLink = this._registerStepFocusable(append(copy, $<HTMLAnchorElement>('a.onboarding-backboard-connect-account-link')));
		accountLink.href = BACKBOARD_SIGN_IN_URL;
		accountLink.textContent = localize('onboarding.backboard.signIn.link', "Set up Backboard.io account");

		this.stepDisposables.add(addDisposableListener(accountLink, EventType.CLICK, (event: MouseEvent) => {
			event.preventDefault();
			this._logAction('openBackboardSignIn');
			void this.openerService.open(URI.parse(BACKBOARD_SIGN_IN_URL), { openExternal: true });
			this.hasConfirmedBackboardSignIn = true;
			this._updateButtonStates();
			this.nextButton?.focus();
		}));
	}

	private _renderApiKeyStep(container: HTMLElement): void {
		const wrapper = append(container, $('.onboarding-backboard-connect.onboarding-backboard-connect-api-key'));
		const panel = append(wrapper, $('.onboarding-backboard-connect-panel'));
		const mark = append(panel, $('.onboarding-backboard-connect-mark'));
		this._createBackboardMark(mark, 'onboarding-backboard-connect-mark-inner');

		const copy = append(panel, $('.onboarding-backboard-connect-copy'));
		const description = append(copy, $('p.onboarding-backboard-connect-description'));
		description.textContent = localize('onboarding.backboard.apiKey.description', "To finish setup, create a Backboard API key.");

		const dashboardLink = this._registerStepFocusable(append(copy, $<HTMLAnchorElement>('a.onboarding-backboard-connect-account-link')));
		dashboardLink.href = BACKBOARD_API_KEYS_URL;
		dashboardLink.textContent = localize('onboarding.backboard.apiKey.dashboard', "Open API key dashboard");

		this.stepDisposables.add(addDisposableListener(dashboardLink, EventType.CLICK, (event: MouseEvent) => {
			event.preventDefault();
			this._logAction('openBackboardApiKeyDashboard');
			void this.openerService.open(URI.parse(BACKBOARD_API_KEYS_URL), { openExternal: true });
			this._showApiKeyImportDialog();
		}));
	}

	private _showApiKeyImportDialog(): void {
		if (!this.card) {
			return;
		}

		this.card.querySelector('.onboarding-backboard-api-import-overlay')?.remove();

		const overlay = append(this.card, $('.onboarding-backboard-api-import-overlay'));
		const dialog = append(overlay, $('.onboarding-backboard-api-import-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', localize('onboarding.backboard.apiKey.import.aria', "Import Backboard API key"));

		const title = append(dialog, $('h3.onboarding-backboard-api-import-title'));
		title.textContent = localize('onboarding.backboard.apiKey.importTitle', "Import API Key");

		const description = append(dialog, $('p.onboarding-backboard-api-import-description'));
		description.textContent = localize('onboarding.backboard.apiKey.importDescription', "Paste the key you created in Backboard.");

		const input = append(dialog, $<HTMLInputElement>('input.onboarding-backboard-api-import-input'));
		input.type = 'password';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = localize('onboarding.backboard.apiKey.inputPlaceholder', "espr_...");
		input.setAttribute('aria-label', localize('onboarding.backboard.apiKey.inputAria', "Backboard API key"));

		const errorText = append(dialog, $('p.onboarding-backboard-api-import-error'));
		errorText.setAttribute('role', 'alert');

		const actions = append(dialog, $('.onboarding-backboard-api-import-actions'));
		const cancelButton = append(actions, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-secondary'));
		cancelButton.type = 'button';
		cancelButton.textContent = localize('onboarding.backboard.apiKey.cancel', "Cancel");

		const importButton = append(actions, $<HTMLButtonElement>('button.onboarding-a-btn.onboarding-a-btn-primary'));
		importButton.type = 'button';
		importButton.textContent = localize('onboarding.backboard.apiKey.import', "Import API Key");

		const closeDialog = () => {
			input.value = '';
			overlay.remove();
		};

		const importApiKey = async () => {
			const apiKey = input.value.trim();
			if (!apiKey) {
				errorText.textContent = localize('onboarding.backboard.apiKey.empty', "Paste your Backboard API key to continue.");
				input.focus();
				return;
			}

			if (!BACKBOARD_API_KEY_PATTERN.test(apiKey)) {
				errorText.textContent = localize('onboarding.backboard.apiKey.invalid', "API keys must start with espr_ and use 43 letters, numbers, underscores, or dashes after that.");
				input.focus();
				input.select();
				return;
			}

			importButton.disabled = true;
			cancelButton.disabled = true;
			errorText.textContent = '';

			try {
				await this._saveBackboardApiKey(apiKey);
				this.hasImportedApiKey = true;
				this._logAction('importBackboardApiKey');
				this.accessibilityService.alert(localize('onboarding.backboard.apiKey.imported.alert', "Backboard API key imported"));
				this._updateButtonStates();
				closeDialog();
				this._dismiss('complete');
				const commandId = this.selectedExperience === OnboardingExperience.Simple
					? OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID
					: 'backboard.openPanel';
				const failureMessage = this.selectedExperience === OnboardingExperience.Simple
					? localize('onboarding.backboard.apiKey.openSandboxFailed', "Could not open Backboard Sandbox.")
					: localize('onboarding.backboard.apiKey.openPanelFailed', "Could not open Backboard chat.");
				void this.commandService.executeCommand(commandId).catch(err => {
					this.notificationService.notify({
						severity: Severity.Error,
						message: failureMessage,
						source: err instanceof Error ? err.message : undefined,
					});
				});
			} catch (err) {
				importButton.disabled = false;
				cancelButton.disabled = false;
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('onboarding.backboard.apiKey.importFailed', "Could not save the Backboard API key."),
					source: err instanceof Error ? err.message : undefined,
				});
			}
		};

		this.stepDisposables.add(addDisposableListener(cancelButton, EventType.CLICK, () => {
			closeDialog();
			this._updateButtonStates();
			this.nextButton?.focus();
		}));

		this.stepDisposables.add(addDisposableListener(importButton, EventType.CLICK, () => {
			void importApiKey();
		}));

		this.stepDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Enter) {
				event.preventDefault();
				void importApiKey();
			}
		}));

		this.stepDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
			if (!errorText.textContent) {
				return;
			}

			const apiKey = input.value.trim();
			if (!apiKey || BACKBOARD_API_KEY_PATTERN.test(apiKey)) {
				errorText.textContent = '';
			}
		}));

		this.stepDisposables.add(addDisposableListener(overlay, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				event.preventDefault();
				closeDialog();
				this.nextButton?.focus();
			}
		}));

		this.stepDisposables.add(toDisposable(() => {
			input.value = '';
			overlay.remove();
		}));

		getActiveWindow().requestAnimationFrame(() => {
			overlay.classList.add('visible');
			input.focus();
		});
	}

	private async _readBackboardConfigJson(configResource: URI): Promise<Record<string, unknown>> {
		try {
			const content = await this.fileService.readFile(configResource);
			const parsed: unknown = JSON.parse(content.value.toString());
			return isObjectRecord(parsed) ? parsed : {};
		} catch (error) {
			if (error instanceof SyntaxError || (error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND)) {
				return {};
			}
			throw error;
		}
	}

	private async _saveBackboardApiKey(apiKey: string): Promise<void> {
		const home = this.pathService.userHome({ preferLocal: true });
		const configDir = URI.joinPath(home, '.backboard_ide');
		const configResource = URI.joinPath(configDir, 'config.json');
		const config = await this._readBackboardConfigJson(configResource);
		const configuredEnv = this.configurationService.getValue<string>('backboard.env');
		const env = normalizeBackboardEnv(typeof config.env === 'string' ? config.env : configuredEnv);
		const envKeys = getBackboardEnvKeys(config);
		envKeys[env] = apiKey;

		await this.fileService.createFolder(configDir);
		await this.fileService.writeFile(configResource, VSBuffer.fromString(`${JSON.stringify({
			...config,
			env,
			api_key: apiKey,
			env_keys: envKeys
		}, undefined, '\t')}\n`), { atomic: { postfix: '.vsctmp' } });
	}

	private _mediaUri(fileName: string): string {
		return FileAccess.asBrowserUri(`vs/workbench/contrib/welcomeOnboarding/browser/media/${fileName}`).toString(true);
	}

	private _setupRadioGroupNavigation(items: readonly HTMLElement[], selectedIndex: number): void {
		for (let index = 0; index < items.length; index++) {
			items[index].setAttribute('tabindex', index === selectedIndex ? '0' : '-1');
		}

		for (let index = 0; index < items.length; index++) {
			this.stepDisposables.add(addDisposableListener(items[index], EventType.KEY_DOWN, (event: KeyboardEvent) => {
				const keyboardEvent = new StandardKeyboardEvent(event);
				let newIndex: number | undefined;

				if (keyboardEvent.keyCode === KeyCode.RightArrow || keyboardEvent.keyCode === KeyCode.DownArrow) {
					newIndex = (index + 1) % items.length;
				} else if (keyboardEvent.keyCode === KeyCode.LeftArrow || keyboardEvent.keyCode === KeyCode.UpArrow) {
					newIndex = (index - 1 + items.length) % items.length;
				} else if (keyboardEvent.keyCode === KeyCode.Home) {
					newIndex = 0;
				} else if (keyboardEvent.keyCode === KeyCode.End) {
					newIndex = items.length - 1;
				}

				if (newIndex !== undefined) {
					event.preventDefault();
					event.stopPropagation();
					items[index].setAttribute('tabindex', '-1');
					items[newIndex].setAttribute('tabindex', '0');
					items[newIndex].focus();
					items[newIndex].click();
				}
			}));
		}
	}

	private _trapTab(event: KeyboardEvent, shiftKey: boolean): void {
		const allFocusable = this._getFocusableElements();
		if (!allFocusable.length) {
			event.preventDefault();
			return;
		}

		const first = allFocusable[0];
		const last = allFocusable[allFocusable.length - 1];
		const activeElement = getActiveWindow().document.activeElement;

		if (shiftKey && activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!shiftKey && activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	private _getFocusableElements(): HTMLElement[] {
		return [...(this.closeButton ? [this.closeButton] : []), ...this.stepFocusableElements, ...this.footerFocusableElements].filter(element => this._isTabbable(element));
	}

	private _focusCurrentStepElement(): void {
		const stepFocusable = this.stepFocusableElements.find(element => this._isTabbable(element));
		(stepFocusable ?? this.nextButton ?? this.closeButton)?.focus();
	}

	private _registerStepFocusable<T extends HTMLElement>(element: T): T {
		this.stepFocusableElements.push(element);
		return element;
	}

	private _isTabbable(element: HTMLElement): boolean {
		if (!element.isConnected || element.getAttribute('aria-hidden') === 'true' || element.tabIndex === -1 || element.hasAttribute('disabled')) {
			return false;
		}

		const computedStyle = getActiveWindow().getComputedStyle(element);
		return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && element.getClientRects().length > 0;
	}

	private _logStepView(): void {
		const stepId = this.steps[this.currentStepIndex];
		const visibleSteps = this._visibleSteps();
		this.telemetryService.publicLog2<OnboardingStepViewEvent, OnboardingStepViewClassification>('welcomeOnboarding.stepView', {
			step: stepId,
			stepNumber: visibleSteps.indexOf(stepId) + 1,
		});
	}

	private _logAction(action: string, stepOverride?: OnboardingStepId, argument?: string): void {
		this.telemetryService.publicLog2<OnboardingActionEvent, OnboardingActionClassification>('welcomeOnboarding.actionExecuted', {
			action,
			step: stepOverride ?? this.steps[this.currentStepIndex],
			argument: argument ?? undefined,
		});
	}

	private _removeFromDOM(): void {
		this.stepDisposables.clear();
		this.disposables.clear();

		if (this.overlay) {
			this.overlay.remove();
			this.overlay = undefined;
		}

		this.card = undefined;
		this.bodyEl = undefined;
		this.progressContainer = undefined;
		this.stepLabelEl = undefined;
		this.titleEl = undefined;
		this.subtitleEl = undefined;
		this.contentEl = undefined;
		this.backButton = undefined;
		this.nextButton = undefined;
		this.closeButton = undefined;
		this.footerFocusableElements.length = 0;
		this.stepFocusableElements.length = 0;
		this._isShowing = false;
		this.currentStepIndex = 0;

		if (this.previouslyFocusedElement) {
			this.previouslyFocusedElement.focus();
			this.previouslyFocusedElement = undefined;
		}
	}

	override dispose(): void {
		this._removeFromDOM();
		super.dispose();
	}
}
