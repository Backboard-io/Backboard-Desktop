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
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
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

// -- Shared card ----------------------------------------------------------------------------

/** Providers on the cards' scrolling strip: `provider-*` logo key and name. */
const FEATURED_PROVIDERS: readonly (readonly [string, string])[] = [
	['anthropic', 'Anthropic'],
	['open-ai', 'OpenAI'],
	['google', 'Google'],
	['x-ai', 'xAI'],
	['deep-seek', 'DeepSeek'],
	['mistral', 'Mistral'],
	['cohere', 'Cohere'],
	['bedrock', 'AWS Bedrock'],
];

/** How many provider logos float over the sign-in art. */
const FLOATING_PROVIDERS = 5;

interface IUpsellCardOptions {
	/** Picks the card's art: `media/card-<kind>.jpg`. */
	readonly kind: 'signin' | 'low' | 'out';
	readonly title: string;
	readonly text: string;
	readonly ctaLabel: string;
	readonly onCta: () => void;
	readonly onDismiss: () => void;
	/** A quiet way out under the button, e.g. "Keep using free models". */
	readonly link?: { readonly label: string; readonly run: () => void };
}

/**
 * The floating card both upsells use: product shot, dismiss button, title,
 * text, a strip of the models on offer, and one call to action. The caller
 * positions it and owns the returned store.
 */
function renderUpsellCard(container: HTMLElement, options: IUpsellCardOptions): { readonly element: HTMLElement; readonly cta: HTMLButtonElement; readonly store: DisposableStore } {
	const store = new DisposableStore();
	const card = append(container, $('.bb-upsell-card'));
	card.dataset.kind = options.kind;
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-label', options.title);
	store.add({ dispose: () => card.remove() });

	const media = append(card, $<HTMLButtonElement>('button.bb-upsell-card-media'));
	media.type = 'button';
	media.tabIndex = -1;
	media.setAttribute('aria-hidden', 'true');
	const image = append(media, $<HTMLImageElement>('img'));
	image.alt = '';
	// A missing image (e.g. a build that didn't ship it) shows the card's
	// gradient instead of a broken-image icon.
	store.add(addDisposableListener(image, EventType.ERROR, () => media.classList.add('bb-upsell-card-media-fallback')));
	image.src = FileAccess.asBrowserUri(`vs/workbench/contrib/backboardUpsell/browser/media/card-${options.kind}.jpg`).toString(true);
	{
		// The providers on offer, drifting up through the art (every card).
		const float = append(media, $('.bb-upsell-card-float'));
		FEATURED_PROVIDERS.slice(0, FLOATING_PROVIDERS).forEach(([logo], index) => {
			const bubble = append(float, $('span.bb-upsell-card-bubble'));
			bubble.style.setProperty('--i', String(index));
			append(bubble, $(`span.combined-model-logo.provider-${logo}`));
		});
	}
	store.add(addDisposableListener(media, EventType.CLICK, options.onCta));

	const close = append(card, $<HTMLButtonElement>('button.bb-upsell-card-close'));
	close.type = 'button';
	const closeLabel = localize('upsell.card.dismiss', "Dismiss");
	close.title = closeLabel;
	close.setAttribute('aria-label', closeLabel);
	close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
	store.add(addDisposableListener(close, EventType.CLICK, options.onDismiss));

	const body = append(card, $('.bb-upsell-card-body'));
	append(body, $('h3.bb-upsell-card-title')).textContent = options.title;
	append(body, $('p.bb-upsell-card-text')).textContent = options.text;
	append(body, $('.bb-upsell-card-label')).textContent = localize('upsell.card.providers', "Providers available");
	const marquee = append(body, $('.bb-upsell-card-marquee'));
	marquee.setAttribute('aria-hidden', 'true');
	const track = append(marquee, $('.bb-upsell-card-track'));
	// Two copies so the strip can loop seamlessly.
	for (let copy = 0; copy < 2; copy++) {
		for (const [logo, name] of FEATURED_PROVIDERS) {
			const item = append(track, $('span.bb-upsell-card-model'));
			append(item, $(`span.combined-model-logo.provider-${logo}`));
			append(item, $('span')).textContent = name;
		}
	}

	const cta = append(body, $<HTMLButtonElement>('button.bb-upsell-button.bb-upsell-button-primary'));
	cta.type = 'button';
	cta.textContent = options.ctaLabel;
	store.add(addDisposableListener(cta, EventType.CLICK, options.onCta));
	if (options.link) {
		const link = append(body, $<HTMLButtonElement>('button.bb-upsell-card-link'));
		link.type = 'button';
		link.textContent = options.link.label;
		store.add(addDisposableListener(link, EventType.CLICK, options.link.run));
	}
	return { element: card, cta, store };
}

// -- Sign-in card ---------------------------------------------------------------------------

/** The sign-in card open in this window, if any. */
const signInCard = new MutableDisposable<DisposableStore>();

/** Where the model picker was when the user picked a locked model (viewport pixels). */
interface IAnchorRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

const VIEWPORT_MARGIN = 8;

function isAnchorRect(value: unknown): value is IAnchorRect {
	const rect = value as Partial<IAnchorRect> | undefined;
	return !!rect && typeof rect.x === 'number' && typeof rect.y === 'number' && typeof rect.width === 'number' && typeof rect.height === 'number';
}

/**
 * "Sign in to use {model}": pops out beside the model picker when a
 * signed-out user picks a model that isn't free. Free models keep working
 * without an account.
 */
function showSignInCard(container: HTMLElement, commandService: ICommandService, modelName: string | undefined, anchor: IAnchorRect | undefined): void {
	const previousFocus = container.ownerDocument.activeElement;
	const close = () => {
		signInCard.clear();
		if (isHTMLElement(previousFocus)) {
			previousFocus.focus();
		}
	};
	const { element, cta, store } = renderUpsellCard(container, {
		kind: 'signin',
		title: modelName
			? localize('upsell.signIn.titleModel', "Sign in to use {0}", modelName)
			: localize('upsell.signIn.title', "Sign in to use every model"),
		text: localize('upsell.signIn.text', "Free models work without an account. Sign in to unlock every model."),
		// The Backboard sign-in page offers both signing up and logging in.
		ctaLabel: localize('upsell.signIn.continue', "Continue"),
		onCta: () => {
			close();
			void commandService.executeCommand('backboard.signIn');
		},
		onDismiss: close,
		link: { label: localize('upsell.signIn.keepFree', "Keep using free models"), run: close },
	});
	element.setAttribute('aria-modal', 'false');

	if (anchor) {
		// In the picker's place: same bottom-right corner, just above the model button.
		element.classList.add('bb-upsell-card-anchored');
		const { width, height } = element.getBoundingClientRect();
		const viewport = container.getBoundingClientRect();
		const left = Math.max(viewport.left + VIEWPORT_MARGIN, Math.min(anchor.x + anchor.width - width, viewport.right - width - VIEWPORT_MARGIN));
		const top = Math.max(viewport.top + VIEWPORT_MARGIN, Math.min(anchor.y + anchor.height - height, viewport.bottom - height - VIEWPORT_MARGIN));
		element.style.left = `${left - viewport.left}px`;
		element.style.top = `${top - viewport.top}px`;
	}

	store.add(addDisposableListener(element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
			event.preventDefault();
			close();
		}
	}));
	// A click anywhere else puts it away, like the picker it came from.
	store.add(addDisposableListener(container.ownerDocument, EventType.MOUSE_DOWN, event => {
		if (isHTMLElement(event.target) && !element.contains(event.target)) {
			close();
		}
	}, true));
	signInCard.value = store;
	cta.focus();
}

CommandsRegistry.registerCommand(SHOW_SIGN_IN_PROMPT_COMMAND_ID, (accessor, modelName?: unknown, anchor?: unknown) => {
	showSignInCard(
		accessor.get(ILayoutService).activeContainer,
		accessor.get(ICommandService),
		typeof modelName === 'string' && modelName.trim() ? modelName.trim() : undefined,
		isAnchorRect(anchor) ? anchor : undefined,
	);
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
		const { store } = renderUpsellCard(this.layoutService.activeContainer, balanceCardOptions(kind,
			() => {
				this.card.clear();
				void this.commandService.executeCommand(OPEN_BILLING_COMMAND_ID);
			},
			() => {
				this.storageService.store(`${DISMISSED_KEY_PREFIX}${kind}`, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
				this.card.clear();
			},
		));
		store.add({ dispose: () => this.shownKind = undefined });
		this.card.value = store;
		this.shownKind = kind;
	}
}

function balanceCardOptions(kind: BalanceCardKind, onCta: () => void, onDismiss: () => void): IUpsellCardOptions {
	return {
		kind,
		title: kind === 'out'
			? localize('upsell.card.outTitle', "You're out of credits")
			: localize('upsell.card.lowTitle', "You're running low on credits"),
		text: kind === 'out'
			? localize('upsell.card.outText', "Free models still work. Subscribe to get every model back.")
			: localize('upsell.card.lowText', "Subscribe to keep every model running without interruptions."),
		ctaLabel: localize('upsell.card.cta', "See Plans"),
		onCta,
		onDismiss,
	};
}

// -- Palette commands to show each popup on demand -------------------------------------------

/** A card opened from the Command Palette (one at a time). */
const previewCard = new MutableDisposable<DisposableStore>();

function showBalanceCardPreview(accessor: ServicesAccessor, kind: BalanceCardKind): void {
	const commandService = accessor.get(ICommandService);
	const { store } = renderUpsellCard(accessor.get(ILayoutService).activeContainer, balanceCardOptions(kind,
		() => {
			previewCard.clear();
			void commandService.executeCommand(OPEN_BILLING_COMMAND_ID);
		},
		() => previewCard.clear(),
	));
	previewCard.value = store;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'backboard.showSignInCard', title: localize2('upsell.cmd.signIn', "Show Sign-In Card"), category: localize2('backboard.category', "Backboard"), f1: true });
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(SHOW_SIGN_IN_PROMPT_COMMAND_ID, 'Claude Opus 5.5');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'backboard.showLowCreditsCard', title: localize2('upsell.cmd.low', "Show Low Credits Card"), category: localize2('backboard.category', "Backboard"), f1: true });
	}
	run(accessor: ServicesAccessor): void {
		showBalanceCardPreview(accessor, 'low');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'backboard.showOutOfCreditsCard', title: localize2('upsell.cmd.out', "Show Out of Credits Card"), category: localize2('backboard.category', "Backboard"), f1: true });
	}
	run(accessor: ServicesAccessor): void {
		showBalanceCardPreview(accessor, 'out');
	}
});

registerWorkbenchContribution2(BackboardBalanceUpsell.ID, BackboardBalanceUpsell, WorkbenchPhase.Eventually);
