/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/backboardUpsell.css';
// Provider logos for the model strip on the balance cards.
import '../../chat/browser/widget/input/media/combinedModelProviderPicker.css';
import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { OPEN_BILLING_COMMAND_ID } from '../../backboardBilling/common/backboardBilling.js';
import { backboardApiBaseUrl, BackboardAuthContextKeys, backboardConfigAccessToken, backboardConfigApiKey, backboardConfigResource, readBackboardConfigJson, SHOW_SIGN_IN_PROMPT_COMMAND_ID } from '../../chat/common/backboardAuth.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';

// -- Sign-in prompt -------------------------------------------------------------------------

/** The sign-in popup open in this window, if any. */
const signInPrompt = new MutableDisposable<DisposableStore>();

function markUri(): string {
	return FileAccess.asBrowserUri('vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg').toString(true);
}

/**
 * "Sign in to use {model}": shown when a signed-out user picks a model that
 * isn't free. Free models keep working without an account.
 */
function showSignInPrompt(container: HTMLElement, commandService: ICommandService, modelName: string | undefined): void {
	const store = new DisposableStore();
	const previousFocus = container.ownerDocument.activeElement;
	const backdrop = append(container, $('.bb-upsell-modal-backdrop'));
	store.add({ dispose: () => backdrop.remove() });
	const close = () => {
		signInPrompt.clear();
		if (isHTMLElement(previousFocus)) {
			previousFocus.focus();
		}
	};

	const modal = append(backdrop, $('.bb-upsell-modal'));
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	const mark = append(modal, $<HTMLImageElement>('img.bb-upsell-modal-mark'));
	mark.alt = '';
	mark.src = markUri();
	const title = append(modal, $('h2.bb-upsell-modal-title'));
	title.textContent = modelName
		? localize('upsell.signIn.titleModel', "Sign in to use {0}", modelName)
		: localize('upsell.signIn.title', "Sign in to use every model");
	modal.setAttribute('aria-label', title.textContent);
	append(modal, $('p.bb-upsell-modal-text')).textContent = localize('upsell.signIn.text', "Free models work without an account. Signing up is free and unlocks every model.");

	const signIn = append(modal, $<HTMLButtonElement>('button.bb-upsell-button.bb-upsell-button-primary'));
	signIn.type = 'button';
	signIn.textContent = localize('upsell.signIn.button', "Sign In");
	const notNow = append(modal, $<HTMLButtonElement>('button.bb-upsell-link'));
	notNow.type = 'button';
	notNow.textContent = localize('upsell.signIn.notNow', "Not Now");

	store.add(addDisposableListener(signIn, EventType.CLICK, () => {
		close();
		void commandService.executeCommand('backboard.signIn');
	}));
	store.add(addDisposableListener(notNow, EventType.CLICK, close));
	store.add(addDisposableListener(backdrop, EventType.MOUSE_DOWN, event => {
		if (event.target === backdrop) {
			close();
		}
	}));
	store.add(addDisposableListener(backdrop, EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
			event.preventDefault();
			close();
		}
	}));
	signInPrompt.value = store;
	signIn.focus();
}

CommandsRegistry.registerCommand(SHOW_SIGN_IN_PROMPT_COMMAND_ID, (accessor, modelName?: unknown) => {
	showSignInPrompt(accessor.get(ILayoutService).activeContainer, accessor.get(ICommandService), typeof modelName === 'string' && modelName.trim() ? modelName.trim() : undefined);
});

// -- Balance cards --------------------------------------------------------------------------

type BalanceCardKind = 'low' | 'out';

/** Below this much spendable credit (USD) the "running low" card shows. */
const LOW_BALANCE_USD = 2;
const CHECK_INTERVAL_MS = 15 * 60_000;
const FOCUS_RECHECK_MIN_MS = 5 * 60_000;
const AFTER_CHAT_DELAY_MS = 60_000;
/** A dismissed card stays hidden this long. */
const DISMISS_FOR_MS = 24 * 60 * 60_000;
const DISMISSED_KEY_PREFIX = 'backboardUpsell.balanceCard.dismissed.';

/** Flagships on the cards' model strip: `provider-*` logo key and name. */
const FEATURED_MODELS: readonly (readonly [string, string])[] = [
	['claude', 'Claude Opus 5.5'],
	['open-ai', 'GPT-6.1 Sol'],
	['google', 'Gemini 3.1 Pro'],
	['x-ai', 'Grok 4.7'],
	['deep-seek', 'DeepSeek V4 Pro'],
];

/** The subset of `GET /billing/balance` (Backboard-API `CreditWallet`) the cards read. */
interface IWalletBalance {
	readonly paid_credit_usd?: number;
	readonly subscription_credits_usd?: number;
}

/**
 * Floating card in the bottom-left corner when a signed-in account is low on
 * or out of credit, offering a subscription. Free credit is left out of the
 * sum: it only pays for memory and documents, never model tokens.
 */
class BackboardBalanceUpsell extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardBalanceUpsell';

	private readonly card = this._register(new MutableDisposable<DisposableStore>());
	private readonly afterChat = this._register(new RunOnceScheduler(() => void this.check(), AFTER_CHAT_DELAY_MS));
	private lastFocusCheck = 0;
	private checking = false;
	private shownKind: BalanceCardKind | undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IHostService hostService: IHostService,
		@IChatService chatService: IChatService,
	) {
		super();
		const signedInKeys = new Set([BackboardAuthContextKeys.signedIn.key]);
		this._register(contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(signedInKeys)) {
				void this.check();
			}
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused && Date.now() - this.lastFocusCheck > FOCUS_RECHECK_MIN_MS) {
				void this.check();
			}
		}));
		// Credit runs out while chatting; look again shortly after a message.
		this._register(chatService.onDidSubmitRequest(() => this.afterChat.schedule()));
		const interval = this._register(new IntervalTimer());
		interval.cancelAndSet(() => void this.check(), CHECK_INTERVAL_MS);
		void this.check();
	}

	private async check(): Promise<void> {
		if (this.checking) {
			return;
		}
		this.checking = true;
		this.lastFocusCheck = Date.now();
		try {
			if (this.contextKeyService.getContextKeyValue<boolean>(BackboardAuthContextKeys.signedIn.key) !== true) {
				this.card.clear();
				return;
			}
			const spendable = await this.spendableCredit();
			if (spendable === undefined) {
				return;
			}
			const kind: BalanceCardKind | undefined = spendable <= 0.005 ? 'out' : spendable < LOW_BALANCE_USD ? 'low' : undefined;
			if (!kind || this.dismissedRecently(kind)) {
				this.card.clear();
				return;
			}
			if (this.shownKind === kind) {
				return;
			}
			this.showCard(kind);
		} finally {
			this.checking = false;
		}
	}

	private async spendableCredit(): Promise<number | undefined> {
		const config = await readBackboardConfigJson(this.fileService, await backboardConfigResource(this.pathService));
		const apiKey = this.configurationService.getValue<string>('backboard.apiKey') || backboardConfigApiKey(config);
		const accessToken = backboardConfigAccessToken(config);
		const headers: Record<string, string> | undefined = apiKey ? { 'X-API-Key': apiKey } : accessToken ? { 'Authorization': `Bearer ${accessToken}` } : undefined;
		if (!headers) {
			return undefined;
		}
		const base = backboardApiBaseUrl(config, this.configurationService.getValue<string>('backboard.apiUrl') || undefined, this.configurationService.getValue<string>('backboard.env') || undefined);
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: `${base}/billing/balance`,
				headers,
				timeout: 15_000,
				callSite: 'backboardUpsell.balance',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				this.logService.trace(`[Backboard] Balance check returned ${status}.`);
				return undefined;
			}
			const wallet = JSON.parse((await streamToBuffer(context.stream)).toString()) as IWalletBalance;
			return (wallet.paid_credit_usd ?? 0) + (wallet.subscription_credits_usd ?? 0);
		} catch (error) {
			this.logService.trace('[Backboard] Balance check failed.', error);
			return undefined;
		}
	}

	private dismissedRecently(kind: BalanceCardKind): boolean {
		const at = this.storageService.getNumber(`${DISMISSED_KEY_PREFIX}${kind}`, StorageScope.APPLICATION, 0);
		return Date.now() - at < DISMISS_FOR_MS;
	}

	private showCard(kind: BalanceCardKind): void {
		const store = new DisposableStore();
		const card = append(this.layoutService.activeContainer, $('.bb-upsell-card'));
		card.dataset.kind = kind;
		card.setAttribute('role', 'complementary');
		store.add({
			dispose: () => {
				card.remove();
				this.shownKind = undefined;
			}
		});

		const openPlans = () => {
			this.card.clear();
			void this.commandService.executeCommand(OPEN_BILLING_COMMAND_ID);
		};

		const media = append(card, $<HTMLButtonElement>('button.bb-upsell-card-media'));
		media.type = 'button';
		media.setAttribute('aria-label', localize('upsell.card.seePlans', "See Plans"));
		const image = append(media, $<HTMLImageElement>('img'));
		image.alt = '';
		image.src = FileAccess.asBrowserUri('vs/workbench/contrib/welcomeOnboarding/browser/media/onboarding-simple-dark.png').toString(true);
		store.add(addDisposableListener(media, EventType.CLICK, openPlans));

		const close = append(card, $<HTMLButtonElement>('button.bb-upsell-card-close'));
		close.type = 'button';
		const closeLabel = localize('upsell.card.dismiss', "Dismiss");
		close.title = closeLabel;
		close.setAttribute('aria-label', closeLabel);
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		store.add(addDisposableListener(close, EventType.CLICK, () => {
			this.storageService.store(`${DISMISSED_KEY_PREFIX}${kind}`, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.card.clear();
		}));

		const body = append(card, $('.bb-upsell-card-body'));
		const title = append(body, $('h3.bb-upsell-card-title'));
		title.textContent = kind === 'out'
			? localize('upsell.card.outTitle', "You're out of credits")
			: localize('upsell.card.lowTitle', "You're running low on credits");
		card.setAttribute('aria-label', title.textContent);
		append(body, $('p.bb-upsell-card-text')).textContent = kind === 'out'
			? localize('upsell.card.outText', "Free models still work. Subscribe to get every model back.")
			: localize('upsell.card.lowText', "Subscribe to keep every model running without interruptions.");

		append(body, $('.bb-upsell-card-label')).textContent = localize('upsell.card.models', "Models available");
		const marquee = append(body, $('.bb-upsell-card-marquee'));
		marquee.setAttribute('aria-hidden', 'true');
		const track = append(marquee, $('.bb-upsell-card-track'));
		// Two copies so the strip can loop seamlessly.
		for (let copy = 0; copy < 2; copy++) {
			for (const [logo, name] of FEATURED_MODELS) {
				const item = append(track, $('span.bb-upsell-card-model'));
				append(item, $(`span.combined-model-logo.provider-${logo}`));
				append(item, $('span')).textContent = name;
			}
		}

		const cta = append(body, $<HTMLButtonElement>('button.bb-upsell-button.bb-upsell-button-primary'));
		cta.type = 'button';
		cta.textContent = localize('upsell.card.cta', "See Plans");
		store.add(addDisposableListener(cta, EventType.CLICK, openPlans));

		this.card.value = store;
		this.shownKind = kind;
	}
}

registerWorkbenchContribution2(BackboardBalanceUpsell.ID, BackboardBalanceUpsell, WorkbenchPhase.Eventually);
