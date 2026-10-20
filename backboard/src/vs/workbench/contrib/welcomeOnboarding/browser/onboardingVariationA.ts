/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getActiveWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Severity, INotificationService } from '../../../../platform/notification/common/notification.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EXTENSION_IDENTIFIER_REGEX, EXTENSION_INSTALL_SKIP_PUBLISHER_TRUST_CONTEXT, EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT, IExtensionGalleryService, IExtensionIdentifier, IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { IFileService, FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';
import product from '../../../../platform/product/common/product.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IBackboardBillingService } from '../../backboardBilling/common/backboardBilling.js';
import { BillingPlansView } from '../../backboardBilling/browser/billingPlansView.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../chat/common/constants.js';
import { SessionType } from '../../chat/common/chatSessionsService.js';
import { ADD_PROVIDER_KEY_COMMAND_ID } from '../../chat/browser/byokKeys/byokKeys.js';
import { BYOK_PROVIDERS } from '../../../../platform/agentHost/common/byokProviders.js';
import { IOnboardingService } from '../common/onboardingService.js';
import {
	getOnboardingStepSubtitle,
	getOnboardingStepTitle,
	IBackboardOnboardingState,
	IOnboardingThemeOption,
	OnboardingDismissReason,
	OnboardingExperience,
	ONBOARDING_STORAGE_KEY,
	ONBOARDING_EXPERIENCE_OPTIONS,
	OnboardingStepId,
	ONBOARDING_STEPS,
} from '../common/onboardingTypes.js';
import { createCustomizePanel, IThemePreviewPalette, OTHER_PREVIEW_PALETTE, ThemeChoice } from './onboardingCustomize.js';
import { createMadeByFooter, createSignInPanel, setSignInRetryVisible } from './onboardingSignIn.js';

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

interface ISettingsImportSource {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly userDataHome: URI;
	readonly extensionsHome: URI;
}

interface ISettingsImportResult {
	readonly imported: string[];
	readonly missing: string[];
}

interface ISettingsImportSelection {
	readonly settings: boolean;
	readonly keybindings: boolean;
	readonly extensions: boolean;
}

interface ISettingsImportExtension {
	readonly identifier: IExtensionIdentifier;
	readonly preRelease?: boolean;
}

interface ISettingsImportSelector {
	readonly container: HTMLElement;
	readonly sourceLabel: HTMLElement;
	readonly importButton: HTMLButtonElement;
	readonly settings: HTMLInputElement;
	readonly keybindings: HTMLInputElement;
	readonly extensions: HTMLInputElement;
	source: ISettingsImportSource | undefined;
}

const BACKBOARD_SIGN_IN_URL = 'https://app.backboard.io/signup';
const BACKBOARD_API_KEYS_URL = 'https://app.backboard.io/dashboard/api-keys';
const BACKBOARD_API_KEY_PATTERN = /^espr_[A-Za-z0-9_-]{43}$/;
const LOCAL_AGENT_HOST_PROVIDER_ID = 'local-agent-host';
/** Each screen fades out, then the next fades in, over this many milliseconds. */
const STEP_FADE_MS = 100;
const SOURCE_SETTINGS_RESOURCE_NAMES = ['settings.json', 'keybindings.json'] as const;
const DEFAULT_SETTINGS_IMPORT_SELECTION: ISettingsImportSelection = {
	settings: true,
	keybindings: true,
	extensions: true,
};
const SETTINGS_IMPORT_EXTENSION_ID_REPLACEMENTS = new Map<string, string>([
	['anysphere.remote-ssh', 'ms-vscode-remote.remote-ssh'],
]);
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

	private readonly _onDidFinishOnboardingFlow = this._register(new Emitter<OnboardingDismissReason>());
	readonly onDidFinishOnboardingFlow: Event<OnboardingDismissReason> = this._onDidFinishOnboardingFlow.event;

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
	private readonly stepFade = this._register(new MutableDisposable());

	/** What Enter does on the current screen, as on Devin's onboarding. */
	private enterAction: (() => void) | undefined;
	/** The control the current screen wants focused, if not its first one. */
	private initialFocus: HTMLElement | undefined;

	private previouslyFocusedElement: HTMLElement | undefined;
	private _isShowing = false;
	private postOnboardingSignInPromptShown = false;
	private selectedThemeId = 'backboard-obsidian';
	private themeChange: Promise<void> = Promise.resolve();
	private selectedExperience = OnboardingExperience.Simple;
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
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
		@IBackboardBillingService private readonly billingService: IBackboardBillingService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
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
		this.selectedExperience = OnboardingExperience.Simple;
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
		this.closeButton.setAttribute('aria-label', localize('onboarding.skip', "Skip Onboarding"));
		this.closeButton.textContent = localize('onboarding.skipButton', "Skip");

		const header = append(this.card, $('.onboarding-a-header'));
		this.progressContainer = append(header, $('.onboarding-a-progress'));
		this.stepLabelEl = append(this.progressContainer, $('span.onboarding-a-step-label'));
		this._renderProgress();

		this.bodyEl = append(this.card, $('.onboarding-a-body'));
		this.titleEl = append(this.bodyEl, $('h2.onboarding-a-step-title'));
		this.subtitleEl = append(this.bodyEl, $('p.onboarding-a-step-subtitle'));
		this.contentEl = append(this.bodyEl, $('.onboarding-a-step-content'));
		createMadeByFooter(this.card);
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

		this.disposables.add(addDisposableListener(this.nextButton, EventType.CLICK, async () => {
			if (this._isLastStep()) {
				await this.themeChange;
				if (!this.overlay || !this._isLastStep()) {
					return;
				}
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

		// Enter runs the screen's main action wherever focus is, the way Devin's
		// onboarding does, so it still works if whatever opened onboarding (such
		// as the command palette) kept focus.
		this.disposables.add(addDisposableListener(this.overlay.ownerDocument, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented || !this.enterAction || this._handlesOwnEnter(event.target)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.enterAction();
		}, true));

		getActiveWindow().requestAnimationFrame(() => {
			this.overlay?.classList.add('visible');
		});

		this._focusCurrentStepElement();
		// Whatever opened onboarding (such as the command palette) may restore
		// its own focus once it closes; take it back so Enter works right away.
		disposableTimeout(() => {
			if (this.overlay && !this.overlay.contains(getActiveWindow().document.activeElement)) {
				this._focusCurrentStepElement();
			}
		}, 80, this.disposables);
	}

	/** Pickers, dialogs, onboarding's own text fields and links keep Enter for themselves. */
	private _handlesOwnEnter(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}
		const picker = target.closest<HTMLElement>('.quick-input-widget, .monaco-dialog-box');
		if (picker) {
			return picker.ownerDocument.defaultView?.getComputedStyle(picker).display !== 'none';
		}
		if (!this.overlay?.contains(target)) {
			return false;
		}
		return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && (target as HTMLInputElement).type !== 'checkbox'
			|| target.classList.contains('onboarding-signin-link');
	}

	reset(): void {
		if (this.overlay) {
			this._removeFromDOM();
		}

		this.currentStepIndex = 0;
		this.selectedExperience = OnboardingExperience.Simple;
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
		if (reason === 'skip') {
			this.postOnboardingSignInPromptShown = true;
		}
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
			const postDismissWork = reason === 'complete'
				? this._openSelectedExperienceAfterOnboarding().then(() => this._promptBackboardSsoAfterOnboarding())
				: this._promptBackboardSsoAfterOnboarding();
			postDismissWork
				.catch(error => {
					this.notificationService.notify({
						severity: Severity.Error,
						message: localize('onboarding.backboard.postDismissFailed', "Could not finish Backboard onboarding setup."),
						source: error instanceof Error ? error.message : undefined,
					});
				})
				.finally(() => this._onDidFinishOnboardingFlow.fire(reason));
		};

		this.overlay.addEventListener('transitionend', onTransitionEnd, { once: true });
		setTimeout(onTransitionEnd, 400);
	}

	private _storeOnboardingState(reason: 'complete' | 'skip'): void {
		const state: IBackboardOnboardingState = {
			version: 1,
			completed: reason === 'complete',
			allowAutomaticTours: reason === 'complete',
			dismissedReason: reason,
			experience: this.selectedExperience,
			themeId: this.selectedThemeId,
			apiKeyImported: this.hasImportedApiKey,
		};

		this.storageService.store(ONBOARDING_STORAGE_KEY, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private async _openSelectedExperienceAfterOnboarding(): Promise<void> {
		if (this.selectedExperience === OnboardingExperience.Advanced) {
			if (!this.environmentService.isOptimusWindow) {
				await this.commandService.executeCommand(this.environmentService.isSessionsWindow ? 'agents.openOptimusWindow' : 'workbench.action.openOptimusWindow');
			}
			return;
		}
		if (this.selectedExperience === OnboardingExperience.Developer) {
			if (this.environmentService.isSessionsWindow || this.environmentService.isOptimusWindow) {
				await this.commandService.executeCommand('agents.openSessionInVSCode');
			}
			return;
		}
		if (this.environmentService.isSessionsWindow && !this.environmentService.isOptimusWindow) {
			return;
		}
		await this.commandService.executeCommand(this.environmentService.isOptimusWindow ? 'agents.openAgentsWindow' : OPEN_AGENTS_WINDOW_COMMAND_ID, {
			preferredSessionType: {
				providerId: LOCAL_AGENT_HOST_PROVIDER_ID,
				sessionTypeId: SessionType.CopilotCLI,
			}
		});
	}

	private async _promptBackboardSsoAfterOnboarding(): Promise<void> {
		if (this.postOnboardingSignInPromptShown || !this._isBackboardProduct()) {
			return;
		}

		if (await this._hasBackboardCredentials()) {
			return;
		}

		this.postOnboardingSignInPromptShown = true;
		this._showBackboardSsoPromptDialog();
	}

	private _showBackboardSsoPromptDialog(): void {
		const promptDisposables = new DisposableStore();
		const overlay = append(this.layoutService.activeContainer, $('.onboarding-backboard-sso-overlay'));
		overlay.setAttribute('role', 'presentation');

		const dialog = append(overlay, $('.onboarding-backboard-sso-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', localize('onboarding.backboard.ssoPrompt.aria', "Sign in to Backboard"));

		this._createBackboardMark(dialog, 'onboarding-backboard-sso-logo');

		const title = append(dialog, $('h3.onboarding-backboard-sso-title'));
		title.textContent = localize('onboarding.backboard.ssoPrompt.title', "Sign in to Backboard");

		const description = append(dialog, $('p.onboarding-backboard-sso-description'));
		description.textContent = localize('onboarding.backboard.ssoPrompt.description', "Use single sign-on to enable Backboard Chat and Agents.");

		const actions = append(dialog, $('.onboarding-backboard-sso-actions'));
		const signInButton = append(actions, $<HTMLButtonElement>('button.onboarding-backboard-sso-primary'));
		signInButton.type = 'button';
		signInButton.textContent = localize('onboarding.backboard.ssoPrompt.signIn', "Sign in with SSO");

		const laterButton = append(actions, $<HTMLButtonElement>('button.onboarding-backboard-sso-secondary'));
		laterButton.type = 'button';
		laterButton.textContent = localize('onboarding.backboard.ssoPrompt.later', "Later");

		const close = () => {
			promptDisposables.dispose();
			overlay.remove();
		};

		promptDisposables.add(addDisposableListener(signInButton, EventType.CLICK, () => {
			close();
			void this.commandService.executeCommand('backboard.signIn');
		}));
		promptDisposables.add(addDisposableListener(laterButton, EventType.CLICK, close));
		promptDisposables.add(addDisposableListener(overlay, EventType.CLICK, event => {
			if (event.target === overlay) {
				close();
			}
		}));
		promptDisposables.add(addDisposableListener(getActiveWindow(), EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				close();
			}
		}));

		getActiveWindow().requestAnimationFrame(() => signInButton.focus());
	}

	private async _hasBackboardCredentials(): Promise<boolean> {
		const home = this.pathService.userHome({ preferLocal: true });
		const configResource = URI.joinPath(home, '.backboard_ide', 'config.json');
		const config = await this._readBackboardConfigJson(configResource);
		const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
		if (apiKey) {
			return true;
		}

		const configuredEnv = this.configurationService.getValue<string>('backboard.env');
		const env = normalizeBackboardEnv(typeof config.env === 'string' ? config.env : configuredEnv);
		const envKey = getBackboardEnvKeys(config)[env]?.trim();
		if (envKey) {
			return true;
		}

		const oauth = isObjectRecord(config.oauth) ? config.oauth : undefined;
		return typeof oauth?.access_token === 'string' && Boolean(oauth.access_token.trim());
	}

	private _isBackboardProduct(): boolean {
		return product.defaultChatAgent?.provider?.default?.id === 'backboard';
	}

	private _nextStep(): void {
		const nextStepIndex = this._nextVisibleStepIndex();
		if (nextStepIndex === undefined) {
			return;
		}

		this.currentStepIndex = nextStepIndex;
		this._renderStepFrame();
	}

	/**
	 * Advances to the next visible step, or completes the onboarding when the
	 * current step is the last one. Used by terminal actions (such as the
	 * Welcome step's sign-in and skip controls) so the flow finishes cleanly
	 * regardless of how many steps follow.
	 */
	private _advanceOrComplete(): void {
		if (this._isLastStep()) {
			this._logAction('complete');
			this._dismiss('complete');
			return;
		}

		this._nextStep();
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
		this._fadeSwap(() => {
			this._renderStep();
			this._renderProgress();
			this._updateButtonStates();
			this._focusCurrentStepElement();
			this._logStepView();
		});
	}

	/** Fades the current screen out, runs `paint`, and fades the result back in. */
	private _fadeSwap(paint: () => void): void {
		const body = this.bodyEl;
		if (!body || this.accessibilityService.isMotionReduced()) {
			paint();
			return;
		}
		body.classList.add('onboarding-a-body-fading');
		this.stepFade.value = disposableTimeout(() => {
			paint();
			body.classList.remove('onboarding-a-body-fading');
		}, STEP_FADE_MS);
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
			return step === OnboardingStepId.ImportSettings;
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
		this.enterAction = undefined;
		this.initialFocus = undefined;

		const stepId = this.steps[this.currentStepIndex];
		const isWelcome = stepId === OnboardingStepId.Welcome;
		const isConnectAI = stepId === OnboardingStepId.ConnectAI;
		const isExperience = stepId === OnboardingStepId.Experience;
		const isImportSettings = stepId === OnboardingStepId.ImportSettings;

		const isTheme = stepId === OnboardingStepId.Theme;
		const isBilling = stepId === OnboardingStepId.Billing;
		this.overlay?.classList.toggle('onboarding-a-overlay-launch', isWelcome || isConnectAI || isTheme || isBilling);
		this.card.classList.toggle('onboarding-a-card-welcome', isWelcome);
		this.card.classList.toggle('onboarding-a-card-connect', isConnectAI);
		this.card.classList.toggle('onboarding-a-card-mode', isExperience);
		this.card.classList.toggle('onboarding-a-card-import', isImportSettings);
		this.titleEl.style.display = isWelcome || isConnectAI || isExperience || isImportSettings || isTheme || isBilling ? 'none' : '';
		this.subtitleEl.style.display = isWelcome || isConnectAI || isExperience || isImportSettings || isTheme || isBilling ? 'none' : '';
		this.titleEl.textContent = getOnboardingStepTitle(stepId);
		this.subtitleEl.textContent = getOnboardingStepSubtitle(stepId);

		clearNode(this.contentEl);

		switch (stepId) {
			case OnboardingStepId.Welcome:
				this._renderWelcomeStep(this.contentEl);
				break;
			case OnboardingStepId.Billing:
				this._renderBillingStep(this.contentEl);
				break;
			case OnboardingStepId.ConnectAI:
				this._renderConnectAIStep(this.contentEl);
				break;
			case OnboardingStepId.Experience:
				this._renderExperienceStep(this.contentEl);
				break;
			case OnboardingStepId.Theme:
				this._renderCustomizeStep(this.contentEl);
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
		const position = visibleSteps.indexOf(stepId);
		this.bodyEl.setAttribute('aria-label', position < 0
			? getOnboardingStepTitle(stepId)
			: localize('onboarding.step.aria', "Step {0} of {1}: {2}", position + 1, visibleSteps.length, getOnboardingStepTitle(stepId)));
	}

	private _updateButtonStates(): void {
		if (this.backButton) {
			this.backButton.style.display = this._previousVisibleStepIndex() === undefined ? 'none' : '';
		}

		if (!this.nextButton) {
			return;
		}

		const currentStep = this.steps[this.currentStepIndex];
		// The plans view has its own Continue / Continue on Free.
		this.nextButton.style.display = currentStep === OnboardingStepId.Welcome || currentStep === OnboardingStepId.ConnectAI || currentStep === OnboardingStepId.Billing ? 'none' : '';
		this.nextButton.disabled =
			(currentStep === OnboardingStepId.SignIn && !this.hasConfirmedBackboardSignIn)
			|| (currentStep === OnboardingStepId.ApiKey && !this.hasImportedApiKey);

		if (this._isLastStep()) {
			this.nextButton.textContent = localize('onboarding.backboard.startBuilding', "Enter Simple Mode");
		} else if (currentStep === OnboardingStepId.Welcome) {
			this.nextButton.textContent = localize('onboarding.backboard.continue', "Continue");
		} else {
			this.nextButton.textContent = localize('onboarding.next', "Continue");
		}
	}

	private _renderWelcomeStep(container: HTMLElement): void {
		this._renderConnectAIStep(container);
	}

	private _renderConnectAIStep(container: HTMLElement): void {
		const panel = createSignInPanel(container);
		const { element, signUpButton, logInButton, apiKeyButton, skipButton, retryButton } = panel;
		for (const button of [signUpButton, logInButton, retryButton, apiKeyButton, skipButton]) {
			this._registerStepFocusable(button);
		}
		this.enterAction = () => signUpButton.click();

		let didContinueWithoutAccount = false;

		this.stepDisposables.add(addDisposableListener(skipButton, EventType.CLICK, () => {
			didContinueWithoutAccount = true;
			this.postOnboardingSignInPromptShown = true;
			this._logAction('skipWelcomeSignIn');
			this._advanceOrComplete();
		}));

		this.stepDisposables.add(addDisposableListener(apiKeyButton, EventType.CLICK, () => {
			didContinueWithoutAccount = true;
			this._logAction('chooseOwnKey');
			this._fadeSwap(() => {
				this.stepDisposables.clear();
				this.stepFocusableElements.length = 0;
				this.enterAction = undefined;
				clearNode(container);
				this._renderProviderKeySetup(container);
			});
		}));

		// Completing onboarding reloads this window into the chosen experience,
		// which would kill an in-flight sign-in (the extension host dies with the
		// reload before the device-code flow can open the browser or save the
		// tokens). So wait for the sign-in to finish before advancing; the
		// browser opens once the device code is ready, and this page stays up
		// until approval. Signing up and logging in share the Backboard SSO
		// page, which offers both. Retrying starts a new device login, which
		// supersedes the pending one; only the latest attempt updates this page.
		let attempt = 0;
		let idleLabel: { label: Element; text: string | null } | undefined;
		const startSignIn = async (sourceButton: HTMLButtonElement | undefined, action: string): Promise<void> => {
			if (sourceButton && signUpButton.disabled) {
				return;
			}
			const thisAttempt = ++attempt;
			this._logAction(action);
			signUpButton.disabled = logInButton.disabled = true;
			setSignInRetryVisible(panel, true);
			const label = sourceButton?.querySelector('.onboarding-signin-btn-label');
			if (label) {
				idleLabel = { label, text: label.textContent };
				label.textContent = localize('onboarding.backboard.signInConnecting', "Connecting to Backboard…");
			}
			try {
				// Resolves true once the tokens are saved; false when the sign-in
				// failed or was denied (the extension already surfaced that error).
				const connected = await this.commandService.executeCommand<boolean>('backboard.signIn');
				if (thisAttempt !== attempt) {
					return;
				}
				if (connected && !didContinueWithoutAccount && element.isConnected) {
					this.hasConfirmedBackboardSignIn = true;
					this.postOnboardingSignInPromptShown = true;
					this._advanceOrComplete();
					return;
				}
			} catch (error) {
				if (thisAttempt !== attempt) {
					return;
				}
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('onboarding.connectionFailed', "Could not connect. Please try again."),
					source: error instanceof Error ? error.message : undefined,
				});
			}
			signUpButton.disabled = logInButton.disabled = false;
			setSignInRetryVisible(panel, false);
			if (idleLabel) {
				idleLabel.label.textContent = idleLabel.text;
				idleLabel = undefined;
			}
		};

		this.stepDisposables.add(addDisposableListener(retryButton, EventType.CLICK, () => {
			void startSignIn(undefined, 'retryBackboardSignIn');
		}));

		this.stepDisposables.add(addDisposableListener(signUpButton, EventType.CLICK, () => {
			void startSignIn(signUpButton, 'signUpBackboard');
		}));
		this.stepDisposables.add(addDisposableListener(logInButton, EventType.CLICK, () => {
			void startSignIn(logInButton, 'openBackboardSso');
		}));
	}

	/**
	 * The plans, as onboarding's own page after sign-in. Everyone sees it:
	 * signed-in accounts can subscribe here, signed-out users continue on Free.
	 */
	private _renderBillingStep(container: HTMLElement): void {
		this._logAction('viewPlans');
		void this.billingService.refresh();
		this.stepDisposables.add(this.instantiationService.createInstance(BillingPlansView, container, {
			mode: 'onboarding',
			onDone: () => {
				this._logAction('closePlans');
				this._advanceOrComplete();
			},
			onDidRender: focusable => {
				this.stepFocusableElements.length = 0;
				this.stepFocusableElements.push(...focusable);
			},
		}));
	}

	private _renderProviderKeySetup(container: HTMLElement): void {
		const form = append(container, $('div.onboarding-provider-setup'));
		const title = append(form, $('h2.onboarding-backboard-title'));
		title.textContent = localize('onboarding.byok.title', "Bring Your Own Key");
		const description = append(form, $('p'));
		description.textContent = localize('onboarding.byok.description', "Billed by your provider.");
		const providerLabel = append(form, $('label'));
		providerLabel.textContent = localize('onboarding.byok.provider', "Provider");
		const provider = this._registerStepFocusable(append(providerLabel, $<HTMLSelectElement>('select')));
		for (const definition of BYOK_PROVIDERS) {
			const option = append(provider, $<HTMLOptionElement>('option'));
			option.value = definition.id;
			option.textContent = definition.label;
		}
		const keyLabel = append(form, $('label'));
		keyLabel.textContent = localize('onboarding.byok.key', "API Key");
		const { input: key, toggle: keyVisibilityToggle } = this._appendSecretInput(keyLabel);
		this._registerStepFocusable(key);
		this._registerStepFocusable(keyVisibilityToggle);
		key.placeholder = localize('onboarding.byok.placeholder', "Paste your provider API key");
		const privacy = append(form, $('p.onboarding-backboard-provider-hint'));
		privacy.textContent = localize('onboarding.byok.storage', "Stored encrypted on this device.");
		const status = append(form, $('p.onboarding-provider-status'));
		status.setAttribute('role', 'status');
		const save = this._registerStepFocusable(append(form, $<HTMLButtonElement>('button.onboarding-backboard-sign-in-button')));
		save.type = 'button';
		save.textContent = localize('onboarding.byok.connect', "Connect Provider");
		save.disabled = true;
		const back = this._registerStepFocusable(append(form, $<HTMLButtonElement>('button.onboarding-backboard-account-link')));
		back.type = 'button';
		back.textContent = localize('onboarding.byok.back', "Back");
		let saving = false;
		const submit = async (): Promise<void> => {
			if (saving || !key.value.trim()) {
				return;
			}
			saving = true;
			save.disabled = back.disabled = provider.disabled = key.disabled = true;
			status.textContent = localize('onboarding.byok.verifying', "Verifying your key…");
			try {
				// The same key store as the API Keys page: validated, kept in the OS
				// keychain, and handed to the agent host. Rejects when the key is refused.
				await this.commandService.executeCommand(ADD_PROVIDER_KEY_COMMAND_ID, provider.value, key.value.trim());
				key.value = '';
				if (!form.isConnected) {
					return;
				}
				this.hasImportedApiKey = true;
				this.postOnboardingSignInPromptShown = true;
				this._logAction('connectOwnKey');
				this._advanceOrComplete();
			} catch (error) {
				status.textContent = error instanceof Error ? error.message : localize('onboarding.byok.failed', "Could not connect. Check your key and try again.");
				saving = false;
				save.disabled = back.disabled = provider.disabled = key.disabled = false;
				key.focus();
			}
		};
		this.stepDisposables.add(addDisposableListener(key, EventType.INPUT, () => { save.disabled = !key.value.trim(); }));
		this.stepDisposables.add(addDisposableListener(key, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void submit();
			}
		}));
		this.stepDisposables.add(addDisposableListener(save, EventType.CLICK, () => { void submit(); }));
		this.stepDisposables.add(addDisposableListener(back, EventType.CLICK, () => this._renderStepFrame()));
		provider.focus();
	}

	/**
	 * Appends a masked key input with an eye button that shows or hides its value.
	 */
	private _appendSecretInput(parent: HTMLElement, inputClassName?: string): { input: HTMLInputElement; toggle: HTMLButtonElement } {
		const field = append(parent, $('.onboarding-secret-field'));
		const input = append(field, $<HTMLInputElement>(inputClassName ? `input.${inputClassName}` : 'input'));
		input.type = 'password';
		input.autocomplete = 'off';
		input.spellcheck = false;

		const toggle = append(field, $<HTMLButtonElement>('button.onboarding-secret-visibility'));
		toggle.type = 'button';
		const icon = append(toggle, $('span'));
		icon.setAttribute('aria-hidden', 'true');
		const updateVisibility = (visible: boolean) => {
			input.type = visible ? 'text' : 'password';
			icon.className = ThemeIcon.asClassName(visible ? Codicon.eyeClosed : Codicon.eye);
			const label = visible
				? localize('onboarding.secretInput.hide', "Hide API key")
				: localize('onboarding.secretInput.show', "Show API key");
			toggle.title = label;
			toggle.setAttribute('aria-label', label);
			toggle.setAttribute('aria-pressed', String(visible));
		};
		updateVisibility(false);
		this.stepDisposables.add(addDisposableListener(toggle, EventType.CLICK, (event: MouseEvent) => {
			// The BYOK field sits inside a <label>; keep the click from re-targeting the input.
			event.preventDefault();
			const start = input.selectionStart;
			const end = input.selectionEnd;
			updateVisibility(input.type === 'password');
			input.focus();
			input.setSelectionRange(start, end);
		}));
		return { input, toggle };
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
		const wrapper = append(container, $('.onboarding-backboard-mode'));
		const body = append(wrapper, $('.onboarding-backboard-mode-layout'));

		const intro = append(body, $('.onboarding-backboard-mode-intro'));
		const title = append(intro, $('h1.onboarding-backboard-mode-heading'));
		title.textContent = getOnboardingStepTitle(OnboardingStepId.Experience);
		const description = append(intro, $('p.onboarding-backboard-mode-subtitle'));
		description.textContent = getOnboardingStepSubtitle(OnboardingStepId.Experience);

		const grid = append(body, $('.onboarding-backboard-mode-grid'));
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

			const cardTitle = append(card, $('div.onboarding-backboard-mode-title'));
			cardTitle.textContent = option.label;

			const cardDescription = append(card, $('p.onboarding-backboard-mode-description'));
			cardDescription.textContent = localize('onboarding.backboard.experience.quote', "\u201c{0}\u201d", option.description);

			const preview = append(card, $('.onboarding-backboard-mode-preview'));
			this._createModePreview(preview, option.id);

			this.stepDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this._selectExperience(option.id, cards);
				this.accessibilityService.alert(localize('onboarding.backboard.experience.selected.alert', "{0} selected", option.label));
				this._renderProgress();
				this._updateButtonStates();
			}));
		}

		const selectedExperienceIndex = ONBOARDING_EXPERIENCE_OPTIONS.findIndex(option => option.id === this.selectedExperience);
		this._setupRadioGroupNavigation(cards, Math.max(0, selectedExperienceIndex));
	}

	private _createModePreview(parent: HTMLElement, experience: OnboardingExperience): void {
		switch (experience) {
			case OnboardingExperience.Simple:
				parent.classList.add('onboarding-backboard-mode-preview-clean');
				this._appendModePreviewPill(parent, 'assistant');
				this._appendModePreviewPill(parent, 'user');
				this._appendModePreviewPill(parent, 'composer');
				break;
			case OnboardingExperience.Developer: {
				parent.classList.add('onboarding-backboard-mode-preview-editor');
				const files = append(parent, $('.onboarding-backboard-mode-preview-files'));
				for (const width of ['32px', '40px', '26px']) {
					this._appendModePreviewLine(files, width);
				}
				const code = append(parent, $('.onboarding-backboard-mode-preview-code'));
				for (const width of ['92px', '120px', '68px', '104px', '76px']) {
					this._appendModePreviewLine(code, width);
				}
				break;
			}
			case OnboardingExperience.Advanced:
				parent.classList.add('onboarding-backboard-mode-preview-advanced');
				for (const column of ['running', 'review', 'done']) {
					const lane = append(parent, $(`.onboarding-backboard-mode-preview-lane.onboarding-backboard-mode-preview-lane-${column}`));
					this._appendModePreviewLine(lane, '36px');
					this._appendModePreviewBlock(lane, '51px');
					this._appendModePreviewBlock(lane, column === 'review' ? '41px' : '48px');
				}
				break;
		}
	}

	private _appendModePreviewPill(parent: HTMLElement, kind: string): void {
		const pill = append(parent, $(`.onboarding-backboard-mode-preview-pill.onboarding-backboard-mode-preview-pill-${kind}`));
		append(pill, $('.onboarding-backboard-mode-preview-line'));
	}

	private _appendModePreviewLine(parent: HTMLElement, width: string): void {
		const line = append(parent, $('.onboarding-backboard-mode-preview-line'));
		line.style.width = width;
	}

	private _appendModePreviewBlock(parent: HTMLElement, width: string): void {
		const block = append(parent, $('.onboarding-backboard-mode-preview-block'));
		block.style.width = width;
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
			card.tabIndex = isSelected ? 0 : -1;
		}

		this._renderProgress();
		this._updateButtonStates();
	}

	private _renderCustomizeStep(container: HTMLElement): void {
		const themes = product.onboardingThemes ?? [];
		const lightTheme = themes.find(theme => theme.type === 'light');
		const darkTheme = themes.find(theme => theme.type === 'dark');
		const terminalCommand = isWindows ? undefined : product.applicationName;
		const panel = createCustomizePanel(container, { terminalCommand });

		for (const card of panel.themeCards.values()) {
			this._registerStepFocusable(card);
		}
		if (panel.terminalCheckbox) {
			this._registerStepFocusable(panel.terminalCheckbox);
		}
		this._registerStepFocusable(panel.importToggle);
		this._registerStepFocusable(panel.nextButton);
		this.initialFocus = panel.nextButton;

		// The cards follow the live theme, including one picked under "Other".
		const syncTheme = (): void => {
			const current = this.themeService.getColorTheme();
			const choice: ThemeChoice = current.settingsId === lightTheme?.themeId ? 'light' : current.settingsId === darkTheme?.themeId ? 'dark' : 'other';
			panel.setSelectedTheme(choice);
			panel.setThemePalette('other', choice === 'other' ? this._previewPalette(current) : OTHER_PREVIEW_PALETTE);
		};
		syncTheme();
		this.stepDisposables.add(this.themeService.onDidColorThemeChange(syncTheme));

		const chooseTheme = (theme: IOnboardingThemeOption | undefined): void => {
			if (!theme) {
				return;
			}
			this._logAction('selectTheme', undefined, theme.id);
			this.themeChange = this.themeChange.then(() => this._selectTheme(theme)).catch(() => {
				this.notificationService.error(localize('onboarding.theme.failed', "Could not apply this theme. Choose another theme or try again."));
			});
		};
		this.stepDisposables.add(addDisposableListener(panel.themeCards.get('light')!, EventType.CLICK, () => chooseTheme(lightTheme)));
		this.stepDisposables.add(addDisposableListener(panel.themeCards.get('dark')!, EventType.CLICK, () => chooseTheme(darkTheme)));
		this.stepDisposables.add(addDisposableListener(panel.themeCards.get('other')!, EventType.CLICK, async () => {
			this._logAction('selectOtherTheme');
			// The theme picker opens under the onboarding overlay unless the
			// overlay steps back below it while the picker is up.
			this.overlay?.classList.add('onboarding-a-overlay-picking');
			try {
				await this.commandService.executeCommand('workbench.action.selectTheme');
			} finally {
				this.overlay?.classList.remove('onboarding-a-overlay-picking');
				panel.themeCards.get('other')?.focus();
			}
		}));

		if (panel.terminalHelp) {
			this._registerStepFocusable(panel.terminalHelp);
		}

		let importSource: ISettingsImportSource | undefined;
		let importExpanded = false;
		this.stepDisposables.add(addDisposableListener(panel.importToggle, EventType.CLICK, () => {
			importExpanded = !importExpanded;
			panel.importList.hidden = !importExpanded;
			panel.importToggle.setAttribute('aria-expanded', String(importExpanded));
			panel.importToggle.classList.toggle('expanded', importExpanded);
		}));
		for (const source of this._getSettingsImportSources()) {
			void this.fileService.exists(source.userDataHome).then(exists => {
				if (!exists || !panel.element.isConnected) {
					return;
				}
				const row = this._registerStepFocusable(panel.addImportSource(source.id, source.label, this._mediaUri(source.icon)));
				this.stepDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					importSource = importSource === source ? undefined : source;
					panel.setSelectedImport(importSource?.id);
				}));
			}, () => undefined);
		}

		const next = (): void => {
			this._logAction('customizeNext', undefined, `terminal:${panel.terminalCheckbox?.checked === true},import:${importSource?.id ?? 'none'}`);
			if (panel.terminalCheckbox?.checked && terminalCommand) {
				// Best effort, like Devin's: a failure here must not hold up onboarding.
				this.commandService.executeCommand('backboard.installTerminalCommand', terminalCommand).then(undefined, () => undefined);
			}
			if (importSource) {
				void this._importSettingsInBackground(importSource);
			}
			this._nextStep();
		};
		this.stepDisposables.add(addDisposableListener(panel.nextButton, EventType.CLICK, next));
		this.enterAction = next;
	}

	/** The colours of a real theme, for the "Other" card's miniature editor. */
	private _previewPalette(theme: IWorkbenchColorTheme): IThemePreviewPalette {
		const color = (id: string, fallback: string): string => theme.getColor(id)?.toString() ?? fallback;
		return {
			editorBg: color('editor.background', OTHER_PREVIEW_PALETTE.editorBg),
			chromeBg: color('sideBar.background', OTHER_PREVIEW_PALETTE.chromeBg),
			border: color('panel.border', OTHER_PREVIEW_PALETTE.border),
			fg: color('editor.foreground', OTHER_PREVIEW_PALETTE.fg),
			keyword: color('textLink.foreground', OTHER_PREVIEW_PALETTE.keyword),
			name: color('charts.purple', OTHER_PREVIEW_PALETTE.name),
			text: color('charts.green', OTHER_PREVIEW_PALETTE.text),
		};
	}

	/**
	 * Imports settings, keybindings, snippets and extensions after the
	 * Customize screen. The theme picked on that screen wins over the one the
	 * imported settings name, and is written in the same edit so a later
	 * settings reload cannot undo it.
	 */
	private async _importSettingsInBackground(source: ISettingsImportSource): Promise<void> {
		try {
			await this.themeChange;
			const result = await this._copySettingsFromSource(source, DEFAULT_SETTINGS_IMPORT_SELECTION, this.themeService.getColorTheme().settingsId);
			if (result.imported.length) {
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('onboarding.backboard.import.complete', "Imported {0}: {1}.", source.label, result.imported.join(', ')),
				});
			}
		} catch (error) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('onboarding.backboard.import.failed', "Could not import from {0}.", source.label),
				source: error instanceof Error ? error.message : undefined,
			});
		}
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
		wrapper.setAttribute('aria-label', getOnboardingStepTitle(OnboardingStepId.ImportSettings));

		const title = append(wrapper, $('h1.onboarding-backboard-import-heading'));
		title.textContent = localize('onboarding.backboard.import.heading', "Import from Your Editor");

		const options = append(wrapper, $('.onboarding-backboard-import-options'));
		const sourceOptions = this._getSettingsImportSources().map(source => ({
			source,
			button: this._createImportOption(options, source),
		}));
		const selector = this._createImportSelector(wrapper);
		for (const { source, button } of sourceOptions) {
			this._registerImportOption(button, options, source, selector);
		}

		const skipButton = this._registerStepFocusable(append(wrapper, $<HTMLButtonElement>('button.onboarding-backboard-import-skip')));
		skipButton.type = 'button';
		skipButton.textContent = localize('onboarding.backboard.import.skip', "Skip Import");
		this.stepDisposables.add(addDisposableListener(skipButton, EventType.CLICK, () => {
			this._logAction('skipImportSettings');
			this._nextStep();
		}));
	}

	private _createImportOption(parent: HTMLElement, source: ISettingsImportSource): HTMLButtonElement {
		const button = this._registerStepFocusable(append(parent, $<HTMLButtonElement>('button.onboarding-backboard-import-option')));
		button.type = 'button';
		button.dataset.id = source.id;
		button.title = source.description;
		button.setAttribute('aria-expanded', 'false');
		button.setAttribute('aria-label', localize('onboarding.backboard.import.option.aria', "Choose what to import from {0}. {1}", source.label, source.description));

		const img = append(button, $<HTMLImageElement>('img.onboarding-backboard-import-option-icon'));
		img.alt = '';
		img.decoding = 'async';
		img.src = this._mediaUri(source.icon);

		const label = append(button, $('span.onboarding-backboard-import-option-label'));
		label.textContent = source.label;

		return button;
	}

	private _registerImportOption(button: HTMLButtonElement, parent: HTMLElement, source: ISettingsImportSource, selector: ISettingsImportSelector): void {
		button.setAttribute('aria-controls', selector.container.id);
		this.stepDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
			for (const option of Array.from(parent.querySelectorAll<HTMLButtonElement>('.onboarding-backboard-import-option'))) {
				const isSelected = option === button;
				option.classList.toggle('selected', isSelected);
				option.setAttribute('aria-expanded', isSelected ? 'true' : 'false');
			}
			selector.source = source;
			selector.sourceLabel.textContent = localize('onboarding.backboard.import.selector.source', "Import from {0}", source.label);
			selector.container.hidden = false;
			selector.container.classList.add('visible');
			selector.importButton.focus();
		}));
	}

	private _createImportSelector(parent: HTMLElement): ISettingsImportSelector {
		const container = append(parent, $('.onboarding-backboard-import-selector'));
		container.id = `onboarding-backboard-import-selector-${Date.now().toString(36)}`;
		container.hidden = true;

		const sourceLabel = append(container, $('div.onboarding-backboard-import-selector-source'));
		sourceLabel.textContent = localize('onboarding.backboard.import.selector.source.empty', "Select What to Import");

		const heading = append(container, $('div.onboarding-backboard-import-selector-heading'));
		heading.textContent = localize('onboarding.backboard.import.selector.heading', "Select What to Import");

		const choices = append(container, $('div.onboarding-backboard-import-selector-choices'));
		const settings = this._createImportCheckbox(choices, 'settings', localize('onboarding.backboard.import.selector.settings', "Settings"), localize('onboarding.backboard.import.selector.settings.description', "Includes snippets"));
		const keybindings = this._createImportCheckbox(choices, 'keybindings', localize('onboarding.backboard.import.selector.keybindings', "Keyboard Shortcuts"));
		const extensions = this._createImportCheckbox(choices, 'extensions', localize('onboarding.backboard.import.selector.extensions', "Extensions"));

		const importButton = this._registerStepFocusable(append(container, $<HTMLButtonElement>('button.onboarding-backboard-import-confirm')));
		importButton.type = 'button';
		importButton.textContent = localize('onboarding.backboard.import.confirm', "Import");

		const selector: ISettingsImportSelector = {
			container,
			sourceLabel,
			importButton,
			settings,
			keybindings,
			extensions,
			source: undefined,
		};

		const updateImportButton = () => {
			importButton.disabled = !this._getImportSelection(selector).settings && !this._getImportSelection(selector).keybindings && !this._getImportSelection(selector).extensions;
		};
		for (const checkbox of [settings, keybindings, extensions]) {
			this.stepDisposables.add(addDisposableListener(checkbox, EventType.CHANGE, updateImportButton));
		}
		updateImportButton();

		this.stepDisposables.add(addDisposableListener(importButton, EventType.CLICK, () => {
			if (!selector.source) {
				return;
			}
			void this._importSettingsFromSource(selector.source, importButton, this._getImportSelection(selector));
		}));

		return selector;
	}

	private _createImportCheckbox(parent: HTMLElement, id: string, label: string, description?: string): HTMLInputElement {
		const wrapper = append(parent, $('label.onboarding-backboard-import-selector-choice'));
		const checkbox = this._registerStepFocusable(append(wrapper, $<HTMLInputElement>('input.onboarding-backboard-import-selector-checkbox')));
		checkbox.type = 'checkbox';
		checkbox.checked = true;
		checkbox.dataset.importItem = id;

		const copy = append(wrapper, $('span.onboarding-backboard-import-selector-choice-copy'));
		const labelEl = append(copy, $('span.onboarding-backboard-import-selector-choice-label'));
		labelEl.textContent = label;
		if (description) {
			const descriptionEl = append(copy, $('span.onboarding-backboard-import-selector-choice-description'));
			descriptionEl.textContent = description;
		}

		return checkbox;
	}

	private _getImportSelection(selector: ISettingsImportSelector): ISettingsImportSelection {
		return {
			settings: selector.settings.checked,
			keybindings: selector.keybindings.checked,
			extensions: selector.extensions.checked,
		};
	}

	private _getSettingsImportSources(): readonly ISettingsImportSource[] {
		return [
			{
				id: 'vscode',
				label: localize('onboarding.backboard.import.vscode', "Visual Studio Code"),
				description: localize('onboarding.backboard.import.vscode.description', "Bring settings, keyboard shortcuts, snippets, and extensions."),
				icon: 'onboarding-vscode.png',
				userDataHome: this._getExternalUserDataHome('Code'),
				extensionsHome: this._getExternalExtensionsHome('.vscode'),
			},
			{
				id: 'cursor',
				label: localize('onboarding.backboard.import.cursor', "Cursor"),
				description: localize('onboarding.backboard.import.cursor.description', "Bring settings, keyboard shortcuts, snippets, and extensions."),
				icon: 'onboarding-cursor.png',
				userDataHome: this._getExternalUserDataHome('Cursor'),
				extensionsHome: this._getExternalExtensionsHome('.cursor'),
			},
		];
	}

	private _getExternalUserDataHome(applicationDataFolderName: string): URI {
		const home = this.pathService.userHome({ preferLocal: true });
		if (isMacintosh) {
			return URI.joinPath(home, 'Library', 'Application Support', applicationDataFolderName, 'User');
		}
		if (isWindows) {
			return URI.joinPath(home, 'AppData', 'Roaming', applicationDataFolderName, 'User');
		}
		if (isLinux) {
			return URI.joinPath(home, '.config', applicationDataFolderName, 'User');
		}
		return URI.joinPath(home, '.config', applicationDataFolderName, 'User');
	}

	private _getExternalExtensionsHome(folderName: string): URI {
		return URI.joinPath(this.pathService.userHome({ preferLocal: true }), folderName, 'extensions');
	}

	private async _importSettingsFromSource(source: ISettingsImportSource, button: HTMLButtonElement, selection: ISettingsImportSelection = DEFAULT_SETTINGS_IMPORT_SELECTION): Promise<void> {
		if (button.disabled) {
			return;
		}

		button.disabled = true;
		button.classList.add('importing');
		button.setAttribute('aria-busy', 'true');
		this._logAction('importSettings', undefined, `${source.id}:${this._settingsImportSelectionArgument(selection)}`);

		try {
			const result = await this._copySettingsFromSource(source, selection);
			if (!result.imported.length) {
				this.notificationService.notify({
					severity: Severity.Warning,
					message: localize('onboarding.backboard.import.noneFound', "No selected {0} items were found to import.", source.label),
					source: source.userDataHome.fsPath,
				});
				this.accessibilityService.alert(localize('onboarding.backboard.import.noneFound.alert', "No selected {0} items were found to import.", source.label));
				return;
			}

			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('onboarding.backboard.import.complete', "Imported {0}: {1}.", source.label, result.imported.join(', ')),
			});
			this.accessibilityService.alert(localize('onboarding.backboard.import.complete.alert', "Imported from {0}", source.label));
			this._nextStep();
		} catch (error) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('onboarding.backboard.import.failed', "Could not import from {0}.", source.label),
				source: error instanceof Error ? error.message : undefined,
			});
		} finally {
			button.disabled = false;
			button.classList.remove('importing');
			button.removeAttribute('aria-busy');
		}
	}

	private _settingsImportSelectionArgument(selection: ISettingsImportSelection): string {
		const selected: string[] = [];
		if (selection.settings) {
			selected.push('settings');
		}
		if (selection.keybindings) {
			selected.push('keybindings');
		}
		if (selection.extensions) {
			selected.push('extensions');
		}
		return selected.join(',');
	}

	/**
	 * Copies the selected settings buckets from another editor. With
	 * `keepColorTheme`, the copied settings name that theme instead of their own.
	 */
	private async _copySettingsFromSource(source: ISettingsImportSource, selection: ISettingsImportSelection, keepColorTheme?: string): Promise<ISettingsImportResult> {
		const profile = this.userDataProfileService.currentProfile;
		const imported: string[] = [];
		const missing: string[] = [];

		await this._tryCreateFolder(profile.location);

		if (selection.settings) {
			const keepTheme = keepColorTheme === undefined ? undefined : (contents: string) => applyEdits(contents, setProperty(contents, ['workbench.colorTheme'], keepColorTheme, { tabSize: 4, insertSpaces: true, eol: '\n' }));
			const settingsImported = await this._copySettingsResource(source, SOURCE_SETTINGS_RESOURCE_NAMES[0], profile.settingsResource, keepTheme);
			const snippetCount = await this._copySnippets(URI.joinPath(source.userDataHome, 'snippets'), profile.snippetsHome);
			if (settingsImported || snippetCount > 0) {
				imported.push(localize('onboarding.backboard.import.resource.settings', "Settings"));
				if (snippetCount > 0) {
					imported.push(localize('onboarding.backboard.import.resource.snippets', "Snippets"));
				}
			} else {
				missing.push(localize('onboarding.backboard.import.resource.settings', "Settings"));
			}
		}

		if (selection.keybindings) {
			if (await this._copySettingsResource(source, SOURCE_SETTINGS_RESOURCE_NAMES[1], profile.keybindingsResource)) {
				imported.push(localize('onboarding.backboard.import.resource.keybindings', "Keyboard Shortcuts"));
			} else {
				missing.push(localize('onboarding.backboard.import.resource.keybindings', "Keyboard Shortcuts"));
			}
		}

		if (selection.extensions && await this._importExtensionsFromSource(source) > 0) {
			imported.push(localize('onboarding.backboard.import.resource.extensions', "Extensions"));
		} else if (selection.extensions) {
			missing.push(localize('onboarding.backboard.import.resource.extensions', "Extensions"));
		}

		return { imported, missing };
	}

	private async _copySettingsResource(source: ISettingsImportSource, sourceName: string, target: URI, transform?: (contents: string) => string): Promise<boolean> {
		const contents = await this._tryReadFile(URI.joinPath(source.userDataHome, sourceName));
		if (contents === undefined) {
			return false;
		}

		await this.fileService.writeFile(target, VSBuffer.fromString(transform ? transform(contents) : contents));
		return true;
	}

	private async _importExtensionsFromSource(source: ISettingsImportSource): Promise<number> {
		if (!this.extensionGalleryService.isEnabled()) {
			return 0;
		}

		const sourceExtensions = await this._readExtensionsFromSource(source.extensionsHome);
		if (!sourceExtensions.length) {
			return 0;
		}

		const profile = this.userDataProfileService.currentProfile;
		const installedExtensions = await this.extensionManagementService.getInstalled(ExtensionType.User, profile.extensionsResource);
		const extensionsToInstall = sourceExtensions.filter(sourceExtension =>
			!installedExtensions.some(installedExtension => areSameExtensions(installedExtension.identifier, sourceExtension.identifier)));
		if (!extensionsToInstall.length) {
			return 0;
		}

		try {
			const targetPlatform = await this.extensionManagementService.getTargetPlatform();
			const galleryExtensions = await this.extensionGalleryService.getExtensions(
				extensionsToInstall.map(sourceExtension => ({ ...sourceExtension.identifier, preRelease: sourceExtension.preRelease })),
				{ targetPlatform, compatible: true },
				CancellationToken.None
			);
			let installedCount = 0;
			for (const sourceExtension of extensionsToInstall) {
				const galleryExtension = galleryExtensions.find(extension => areSameExtensions(extension.identifier, sourceExtension.identifier));
				if (!galleryExtension || await this.extensionManagementService.canInstall(galleryExtension) !== true) {
					continue;
				}

				try {
					await this.extensionManagementService.installFromGallery(galleryExtension, {
						isMachineScoped: false,
						donotIncludePackAndDependencies: true,
						installPreReleaseVersion: sourceExtension.preRelease,
						profileLocation: profile.extensionsResource,
						context: {
							[EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true,
							[EXTENSION_INSTALL_SKIP_PUBLISHER_TRUST_CONTEXT]: true,
						},
					});
					installedCount++;
				} catch {
					// Keep onboarding moving if a source extension is unavailable or fails to install.
				}
			}
			return installedCount;
		} catch {
			return 0;
		}
	}

	private async _readExtensionsFromSource(extensionsHome: URI): Promise<ISettingsImportExtension[]> {
		const extensionsJson = await this._tryReadFile(URI.joinPath(extensionsHome, 'extensions.json'));
		if (extensionsJson !== undefined) {
			const extensions = this._parseExtensionsJson(extensionsJson);
			if (extensions.length) {
				return extensions;
			}
		}

		return this._readExtensionsFromFolders(extensionsHome);
	}

	private _parseExtensionsJson(contents: string): ISettingsImportExtension[] {
		let rawExtensions: unknown;
		try {
			rawExtensions = JSON.parse(contents);
		} catch {
			return [];
		}
		if (!Array.isArray(rawExtensions)) {
			return [];
		}

		const extensions = new Map<string, ISettingsImportExtension>();
		for (const rawExtension of rawExtensions) {
			if (!isObjectRecord(rawExtension) || rawExtension.isBuiltin === true) {
				continue;
			}

			const identifier = this._getExtensionIdentifier(rawExtension);
			if (!identifier) {
				continue;
			}

			const metadata = isObjectRecord(rawExtension.metadata) ? rawExtension.metadata : undefined;
			extensions.set(identifier.id.toLowerCase(), {
				identifier,
				preRelease: rawExtension.preRelease === true || metadata?.isPreReleaseVersion === true || metadata?.preRelease === true,
			});
		}

		return [...extensions.values()];
	}

	private async _readExtensionsFromFolders(extensionsHome: URI): Promise<ISettingsImportExtension[]> {
		const extensionsStat = await this._tryResolve(extensionsHome);
		if (!extensionsStat?.isDirectory) {
			return [];
		}

		const extensions = new Map<string, ISettingsImportExtension>();
		for (const child of extensionsStat.children ?? []) {
			if (!child.isDirectory) {
				continue;
			}

			const manifestContents = await this._tryReadFile(URI.joinPath(child.resource, 'package.json'));
			if (manifestContents === undefined) {
				continue;
			}

			const extension = this._parseExtensionManifest(manifestContents);
			if (extension) {
				extensions.set(extension.identifier.id.toLowerCase(), extension);
			}
		}

		return [...extensions.values()];
	}

	private _parseExtensionManifest(contents: string): ISettingsImportExtension | undefined {
		let manifest: unknown;
		try {
			manifest = JSON.parse(contents);
		} catch {
			return undefined;
		}
		if (!isObjectRecord(manifest)) {
			return undefined;
		}

		const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : undefined;
		const name = typeof manifest.name === 'string' ? manifest.name : undefined;
		if (!publisher || !name) {
			return undefined;
		}

		const identifier = this._createExtensionIdentifier(`${publisher}.${name}`);
		if (!identifier) {
			return undefined;
		}

		const metadata = isObjectRecord(manifest.__metadata) ? manifest.__metadata : undefined;
		return {
			identifier,
			preRelease: metadata?.isPreReleaseVersion === true || metadata?.preRelease === true,
		};
	}

	private _getExtensionIdentifier(rawExtension: Record<string, unknown>): IExtensionIdentifier | undefined {
		const identifier = rawExtension.identifier;
		if (isObjectRecord(identifier) && typeof identifier.id === 'string') {
			return this._createExtensionIdentifier(identifier.id, typeof identifier.uuid === 'string' ? identifier.uuid : undefined);
		}
		if (typeof identifier === 'string') {
			return this._createExtensionIdentifier(identifier);
		}
		if (typeof rawExtension.id === 'string') {
			return this._createExtensionIdentifier(rawExtension.id);
		}
		return undefined;
	}

	private _createExtensionIdentifier(id: string, uuid?: string): IExtensionIdentifier | undefined {
		const normalizedId = id.trim();
		if (!EXTENSION_IDENTIFIER_REGEX.test(normalizedId)) {
			return undefined;
		}
		const replacementId = SETTINGS_IMPORT_EXTENSION_ID_REPLACEMENTS.get(normalizedId.toLowerCase());
		if (replacementId) {
			return { id: replacementId };
		}
		return uuid ? { id: normalizedId, uuid } : { id: normalizedId };
	}

	private async _copySnippets(sourceSnippetsHome: URI, targetSnippetsHome: URI): Promise<number> {
		const sourceStat = await this._tryResolve(sourceSnippetsHome);
		if (!sourceStat?.isDirectory) {
			return 0;
		}

		const snippetFiles = (sourceStat.children ?? []).filter(child => {
			const name = child.name.toLowerCase();
			return child.isFile && (name.endsWith('.json') || name.endsWith('.code-snippets'));
		});
		if (!snippetFiles.length) {
			return 0;
		}

		await this._tryCreateFolder(targetSnippetsHome);
		for (const snippetFile of snippetFiles) {
			await this.fileService.copy(snippetFile.resource, URI.joinPath(targetSnippetsHome, snippetFile.name), true);
		}
		return snippetFiles.length;
	}

	private async _tryReadFile(resource: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(resource)).value.toString();
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw error;
		}
	}

	private async _tryResolve(resource: URI) {
		try {
			return await this.fileService.resolve(resource);
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw error;
		}
	}

	private async _tryCreateFolder(resource: URI): Promise<void> {
		try {
			await this.fileService.createFolder(resource);
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_IS_DIRECTORY) {
				throw error;
			}
		}
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
			this.analytics.capture('signup_started');
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

		const { input } = this._appendSecretInput(dialog, 'onboarding-backboard-api-import-input');
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
				return;
			}

			if ((event.metaKey || event.ctrlKey) && keyboardEvent.keyCode === KeyCode.KeyV) {
				event.preventDefault();
				void this.clipboardService.readText().then(text => {
					this._insertApiKeyInputText(input, text);
					errorText.textContent = '';
				});
			}
		}));

		this.stepDisposables.add(addDisposableListener(input, EventType.PASTE, (event: ClipboardEvent) => {
			const text = event.clipboardData?.getData('text');
			if (typeof text !== 'string') {
				return;
			}

			event.preventDefault();
			this._insertApiKeyInputText(input, text);
			errorText.textContent = '';
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

	private _insertApiKeyInputText(input: HTMLInputElement, text: string): void {
		const pasteText = text.trim();
		if (!pasteText) {
			return;
		}

		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? input.value.length;
		input.setRangeText(pasteText, start, end, 'end');
		const inputEvent = input.ownerDocument.createEvent('Event');
		inputEvent.initEvent('input', true, true);
		input.dispatchEvent(inputEvent);
		input.focus();
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
		if (this.initialFocus && this._isTabbable(this.initialFocus)) {
			this.initialFocus.focus();
			return;
		}
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
		const stepNumber = visibleSteps.indexOf(stepId) + 1;
		this.telemetryService.publicLog2<OnboardingStepViewEvent, OnboardingStepViewClassification>('welcomeOnboarding.stepView', {
			step: stepId,
			stepNumber,
		});

		if (stepNumber === 1) {
			this.analytics.capture('onboarding_started', { step: stepId });
		}
		this.analytics.capture('onboarding_step_viewed', { step: stepId, step_number: stepNumber, step_count: visibleSteps.length });
	}

	private _logAction(action: string, stepOverride?: OnboardingStepId, argument?: string): void {
		this.telemetryService.publicLog2<OnboardingActionEvent, OnboardingActionClassification>('welcomeOnboarding.actionExecuted', {
			action,
			step: stepOverride ?? this.steps[this.currentStepIndex],
			argument: argument ?? undefined,
		});

		const step = stepOverride ?? this.steps[this.currentStepIndex];
		if (action === 'dismiss') {
			this.analytics.capture(argument === 'complete' ? 'onboarding_completed' : 'onboarding_skipped', { step });
			return;
		}
		if (action === 'selectExperience' && argument) {
			// Every later event can be split by the workspace the user chose.
			this.analytics.register({ experience: argument });
		}
		this.analytics.capture('onboarding_action', { action, step, argument });
	}

	private _removeFromDOM(): void {
		this.stepFade.clear();
		this.stepDisposables.clear();
		this.disposables.clear();
		this.enterAction = undefined;
		this.initialFocus = undefined;

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
