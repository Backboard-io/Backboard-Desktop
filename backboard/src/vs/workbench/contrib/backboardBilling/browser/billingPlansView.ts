/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/billingPlans.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { BackboardOAuth } from '../../chat/common/backboardAuth.js';
import { BillingOperation, billingPlanAction, IBackboardBillingService, IBillingCatalog, IBillingPlan, IBillingStatus } from '../common/backboardBilling.js';

/** Plans offered in the app, in display order. Enterprise is sold by sales, not Stripe. */
const OFFERED_PLANS = ['builder', 'scale'] as const;
type OfferedPlanId = typeof OFFERED_PLANS[number];

const STATEFUL = localize('billingPlans.f.stateful', "Stateful API + automatic context management");
const PROVIDER_COST = localize('billingPlans.f.providerCost', "Tokens at provider cost");

/**
 * What a card says beyond price. Prices and credits come from the billing
 * API's catalog; these lists match app.backboard.io's billing page.
 */
const PLAN_DETAILS: Record<OfferedPlanId | 'enterprise', { readonly name: string; readonly fallbackPrice: number | undefined; readonly popular?: boolean; readonly features: readonly string[] }> = {
	builder: {
		name: localize('billingPlans.builder', "Builder"),
		fallbackPrice: 20,
		features: [
			STATEFUL, PROVIDER_COST,
			localize('billingPlans.f.rag36', "RAG $0.0036/read"),
			localize('billingPlans.f.memLite36', "Memory Lite $0.0036/op"),
			localize('billingPlans.f.memPro10', "Memory Pro $0.01/op"),
			localize('billingPlans.f.reload', "Auto-reload or buy credits after plan credits"),
		],
	},
	scale: {
		name: localize('billingPlans.scale', "Scale"),
		fallbackPrice: 400,
		popular: true,
		features: [
			STATEFUL, PROVIDER_COST,
			localize('billingPlans.f.rag34', "RAG $0.0034/read"),
			localize('billingPlans.f.memLite34', "Memory Lite $0.0034/op"),
			localize('billingPlans.f.memPro8', "Memory Pro $0.008/op"),
			localize('billingPlans.f.fde', "FDE, SOC2"),
			localize('billingPlans.f.priority', "Priority support"),
		],
	},
	enterprise: {
		name: localize('billingPlans.enterprise', "Enterprise"),
		fallbackPrice: undefined,
		features: [
			STATEFUL,
			localize('billingPlans.f.customRates', "Custom rates"),
			localize('billingPlans.f.hipaa', "HIPAA, FDE Plus"),
			localize('billingPlans.f.dedicated', "Dedicated support"),
			localize('billingPlans.f.sla', "Custom SLA"),
		],
	},
};

const ENTERPRISE_CONTACT = 'mailto:support@backboard.io?subject=Enterprise%20Plan';

/** One card's data. */
export interface IPlanCard {
	readonly id: OfferedPlanId | 'enterprise';
	readonly name: string;
	/** e.g. "$20"; "Custom" for Enterprise. */
	readonly price: string;
	readonly monthly: boolean;
	readonly features: readonly string[];
	readonly popular: boolean;
	/** The catalog plan behind the card, when the billing API provided one. */
	readonly plan?: IBillingPlan;
}

/**
 * The cards to show. Uses the billing API's catalog when it loaded; until the
 * desktop billing API is deployed the cards fall back to the published prices.
 */
export function planCards(catalog: IBillingCatalog | undefined): IPlanCard[] {
	const cards: IPlanCard[] = [];
	for (const id of OFFERED_PLANS) {
		const plan = catalog?.plans.find(candidate => candidate.id === id);
		if (catalog && !plan) {
			continue;
		}
		const details = PLAN_DETAILS[id];
		const included = plan ? [localize('billingPlans.f.included', "{0} included credits per month", money(plan.included_credits_usd))] : [];
		cards.push({
			id,
			name: plan?.name ?? details.name,
			price: money(plan?.monthly_price_usd ?? details.fallbackPrice ?? 0),
			monthly: true,
			features: [...included, ...details.features],
			popular: !!details.popular,
			plan,
		});
	}
	const enterprise = PLAN_DETAILS.enterprise;
	cards.push({ id: 'enterprise', name: enterprise.name, price: localize('billingPlans.custom', "Custom"), monthly: false, features: enterprise.features, popular: false });
	return cards;
}

export interface IBillingPlansViewOptions {
	/**
	 * `onboarding`: shown right after sign-up, with "Continue on Free".
	 * `standalone`: opened from the account menu or usage panel.
	 */
	readonly mode: 'onboarding' | 'standalone';
	/** The user is finished here: Continue on Free, Continue or Done. */
	readonly onDone: () => void;
	/** Called after every render with the view's buttons, for focus handling. */
	readonly onDidRender?: (focusable: readonly HTMLElement[]) => void;
}

/**
 * Plans and subscription management, drawn as plan cards. All billing goes
 * through {@link IBackboardBillingService}: it pins the account, opens Stripe,
 * keeps interrupted checkouts and verifies payment with the server.
 */
export class BillingPlansView extends Disposable {

	private static mounted = 0;

	/** True while any plans view is on screen in this window. */
	static get isShowing(): boolean {
		return BillingPlansView.mounted > 0;
	}

	private readonly element: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private focusable: HTMLElement[] = [];
	/** The plan whose checkout the user just opened; shows the "finish in your browser" screen. */
	private checkoutPlan: IPlanCard | undefined;

	constructor(
		parent: HTMLElement,
		private readonly options: IBillingPlansViewOptions,
		@IBackboardBillingService private readonly billing: IBackboardBillingService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = append(parent, $('.bb-plans'));
		BillingPlansView.mounted++;
		this._register({ dispose: () => { BillingPlansView.mounted--; this.element.remove(); } });
		this._register(billing.onDidChange(() => this.render()));
		this.render();
	}

	/** Billing data is usable: the desktop billing API answered for this account. */
	private get live(): boolean {
		return !!this.billing.status && !!this.billing.catalog && !this.billing.needsSignIn;
	}

	private render(): void {
		this.renderDisposables.clear();
		this.focusable = [];
		clearNode(this.element);

		if (this.checkoutPlan) {
			this.renderCheckout(this.checkoutPlan);
		} else {
			this.renderPlans();
		}
		this.options.onDidRender?.(this.focusable);
	}

	private renderPlans(): void {
		const status = this.live ? this.billing.status : undefined;
		const catalog = this.live ? this.billing.catalog : undefined;

		this.text(this.element, 'h1.bb-plans-title', localize('billingPlans.title', "Choose your plan"));
		this.text(this.element, 'p.bb-plans-subtitle', catalog
			? localize('billingPlans.subtitle.fee', "Monthly prices in USD, plus a {0}% service fee. Stripe shows the final total before you pay.", catalog.service_fee_percent)
			: localize('billingPlans.subtitle', "Tokens at provider cost on every plan. Change or cancel any time."));

		// Messages describe live billing; before the billing API is deployed they
		// would only say it's unavailable, while the cards still work.
		const message = this.live ? this.billing.message : '';
		if (message || this.billing.loading) {
			const notice = this.text(this.element, 'p.bb-plans-notice', message || localize('billingPlans.loading', "Loading your plan…"));
			notice.setAttribute('role', 'status');
			notice.setAttribute('aria-live', 'polite');
		}

		if (status) {
			this.renderCurrentPlan(status);
		}

		const grid = append(this.element, $('.bb-plans-grid'));
		for (const card of planCards(catalog)) {
			this.renderCard(grid, card, status);
		}

		if (this.options.mode === 'onboarding') {
			this.link(this.element, status?.plan ? localize('billingPlans.continue', "Continue") : localize('billingPlans.skip', "Continue on Free"), () => this.options.onDone());
		} else if (this.billing.needsSignIn) {
			this.link(this.element, localize('billingPlans.signIn', "Sign In to Manage Billing in the App"), async () => {
				await this.commandService.executeCommand('backboard.signIn');
				await this.billing.refresh();
			});
		}
	}

	private renderCurrentPlan(status: IBillingStatus): void {
		const section = append(this.element, $('section.bb-plans-current'));
		const plan = status.plan;
		const account = status.account.is_personal ? localize('billingPlans.personal', "Personal account") : status.account.name;
		this.text(section, 'p.bb-plans-current-name', plan
			? localize('billingPlans.currentPlan', "{0} plan · {1}", titleCase(plan.plan_name), account)
			: localize('billingPlans.noPlan', "Free · {0}", account));

		if (!status.can_manage_billing) {
			this.text(section, 'p.bb-plans-muted', localize('billingPlans.admin', "An account admin manages this subscription and payment details."));
		}
		if (!plan) {
			return;
		}

		const end = formatDate(plan.current_period_end_ts ?? plan.current_period_end);
		this.text(section, 'p.bb-plans-muted', plan.cancel_at_period_end
			? localize('billingPlans.ends', "Access ends {0}", end)
			: localize('billingPlans.renews', "Renews {0}", end));
		if (plan.scheduled_downgrade_plan) {
			this.text(section, 'p.bb-plans-muted', localize('billingPlans.scheduled', "Changes to {0} on {1}", titleCase(plan.scheduled_downgrade_plan), formatDate(plan.scheduled_downgrade_date ?? plan.current_period_end_ts)));
		}
		const legacy = ['BASE', 'INDIE', 'TEAM'].includes(plan.plan_name);
		if (plan.plan_name === 'ENTERPRISE') {
			this.text(section, 'p.bb-plans-muted', localize('billingPlans.enterpriseManaged', "Contact your account team for Enterprise plan changes."));
		}
		if (legacy) {
			this.text(section, 'p.bb-plans-muted', localize('billingPlans.legacy', "This legacy plan is no longer offered. Choose a new plan after it expires."));
		}

		const actions = append(section, $('.bb-plans-actions'));
		const disabled = !status.can_manage_billing || this.billing.busy || this.billing.loading || !!this.billing.pending;
		if (!plan.cancel_at_period_end) {
			this.button(actions, localize('billingPlans.cancelRenewal', "Cancel Renewal"), () => this.confirm('cancel', localize('billingPlans.cancelConfirm', "Cancel renewal? Your current plan stays available until {0}.", end), localize('billingPlans.cancelRenewal', "Cancel Renewal")), { disabled });
		} else if (!legacy) {
			this.button(actions, localize('billingPlans.resumeRenewal', "Resume Renewal"), () => this.billing.run('renew'), { disabled });
		}
		if (plan.scheduled_downgrade_plan) {
			this.button(actions, localize('billingPlans.cancelDowngrade', "Cancel Scheduled Downgrade"), () => this.billing.run('cancel-downgrade'), { disabled });
		}
		this.button(actions, localize('billingPlans.payment', "Update Payment Details"), () => this.billing.run('update-payment-method'), { disabled });
		if (this.billing.pending) {
			this.button(actions, localize('billingPlans.resume', "Resume Checkout"), () => this.billing.resumeCheckout(), {
				primary: true,
				disabled: this.billing.loading || this.billing.busy || !status.can_manage_billing || this.billing.pending.accountId !== status.account.id,
			});
		}
	}

	private renderCard(grid: HTMLElement, card: IPlanCard, status: IBillingStatus | undefined): void {
		const element = append(grid, $('.bb-plan-card'));
		element.classList.toggle('bb-plan-card-popular', card.popular);
		if (card.popular) {
			this.text(element, 'span.bb-plan-badge', localize('billingPlans.popular', "Popular"));
		}
		const head = append(element, $('.bb-plan-head'));
		this.text(head, 'h2.bb-plan-name', card.name);
		const price = append(head, $('.bb-plan-price'));
		this.text(price, 'span.bb-plan-amount', card.price);
		if (card.monthly) {
			this.text(price, 'span.bb-plan-period', localize('billingPlans.perMonth', "/mo"));
		}
		const features = append(element, $('ul.bb-plan-features'));
		for (const feature of card.features) {
			this.text(features, 'li', feature);
		}

		if (card.id === 'enterprise') {
			this.button(element, localize('billingPlans.contactSales', "Contact Sales"), async () => { await this.openerService.open(ENTERPRISE_CONTACT, { openExternal: true }); }, { secondary: true });
			return;
		}

		if (!status || !card.plan) {
			// Before the desktop billing API is live: finish on app.backboard.io.
			this.button(element, localize('billingPlans.subscribePrice', "Subscribe {0}", card.price), () => this.openWebCheckout(card), { primary: true });
			return;
		}

		const isCurrent = status.plan?.plan_name.toLowerCase() === card.id;
		const action = billingPlanAction(status, card.plan);
		if (isCurrent) {
			this.button(element, localize('billingPlans.current', "Current Plan"), async () => { }, { disabled: true, secondary: true });
			return;
		}
		if (!action) {
			return;
		}
		const disabled = this.billing.loading || this.billing.busy || !!this.billing.pending;
		const plan = card.plan;
		switch (action) {
			case 'subscribe':
				this.button(element, localize('billingPlans.subscribePrice', "Subscribe {0}", card.price), () => this.startCheckout(card, 'subscribe'), { primary: true, disabled });
				break;
			case 'upgrade':
				this.button(element, localize('billingPlans.upgrade', "Upgrade"), () => this.startCheckout(card, 'change-plan'), { primary: true, disabled });
				break;
			case 'downgrade':
				this.button(element, localize('billingPlans.downgrade', "Downgrade"), () => this.confirm('change-plan',
					localize('billingPlans.downgradeConfirm', "Change to {0} on {1}? Your current plan stays active until then.", plan.name, formatDate(status.plan?.current_period_end_ts ?? status.plan?.current_period_end)),
					localize('billingPlans.scheduleDowngrade', "Schedule Downgrade"), plan.id), { disabled });
				break;
		}
	}

	private renderCheckout(card: IPlanCard): void {
		const status = this.live ? this.billing.status : undefined;
		const done = status?.plan?.plan_name.toLowerCase() === card.id && !this.billing.pending;
		const element = append(this.element, $('.bb-plans-checkout'));
		this.text(element, 'h1.bb-plans-title', done
			? localize('billingPlans.done.title', "You're on {0}", card.name)
			: localize('billingPlans.waiting.title', "Finish checkout in your browser"));
		const notice = this.text(element, 'p.bb-plans-subtitle', done
			? localize('billingPlans.done.subtitle', "Your subscription and credits are ready.")
			: (status && this.billing.message) || localize('billingPlans.waiting.subtitle', "Your {0} plan turns on as soon as payment goes through.", card.name));
		notice.setAttribute('role', 'status');
		notice.setAttribute('aria-live', 'polite');

		const finishLabel = this.options.mode === 'onboarding' ? localize('billingPlans.continue', "Continue") : localize('billingPlans.done', "Done");
		this.button(element, finishLabel, async () => this.options.onDone(), { primary: true });
		if (!done && status && this.billing.pending?.url) {
			this.button(element, localize('billingPlans.reopen', "Reopen Checkout"), () => this.billing.resumeCheckout(), { disabled: this.billing.busy || this.billing.loading });
		}
		if (!done) {
			this.link(element, localize('billingPlans.back', "Choose a Different Plan"), () => {
				this.checkoutPlan = undefined;
				this.render();
			});
		}
	}

	private async startCheckout(card: IPlanCard, operation: 'subscribe' | 'change-plan'): Promise<void> {
		const accountId = this.billing.status?.account.id;
		await this.billing.run(operation, card.id, accountId);
		// The service opens Stripe and keeps the attempt as `pending`; anything
		// else (an error, an immediate plan change) is shown on the cards.
		if (this.billing.pending?.sessionId) {
			this.checkoutPlan = card;
			this.render();
		}
	}

	private async openWebCheckout(card: IPlanCard): Promise<void> {
		const origin = new URL(BackboardOAuth.tokenUrl).origin;
		await this.openerService.open(`${origin}/dashboard/billing?plan=${encodeURIComponent(card.id)}`, { openExternal: true });
		this.checkoutPlan = card;
		this.render();
	}

	private async confirm(operation: BillingOperation, message: string, primaryButton: string, plan?: string): Promise<void> {
		// Pin the account now: a dialog answered after switching accounts must
		// not change the newly selected one.
		const accountId = this.billing.status?.account.id;
		const result = await this.dialogService.confirm({ type: 'info', message, primaryButton });
		if (result.confirmed && accountId !== undefined) {
			await this.billing.run(operation, plan, accountId);
		}
	}

	private text(parent: HTMLElement, selector: string, value: string): HTMLElement {
		const node = append(parent, $(selector));
		node.textContent = value;
		return node;
	}

	private button(parent: HTMLElement, label: string, run: () => Promise<unknown>, options: { readonly primary?: boolean; readonly secondary?: boolean; readonly disabled?: boolean } = {}): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.bb-plan-cta'));
		button.type = 'button';
		button.classList.toggle('bb-plan-cta-secondary', !options.primary);
		button.textContent = label;
		button.disabled = !!options.disabled;
		this.renderDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
			// The billing service renders its own failures.
			void run().catch(() => { });
		}));
		this.focusable.push(button);
		return button;
	}

	private link(parent: HTMLElement, label: string, run: () => unknown): HTMLButtonElement {
		const link = append(parent, $<HTMLButtonElement>('button.bb-plans-link'));
		link.type = 'button';
		link.textContent = label;
		this.renderDisposables.add(addDisposableListener(link, EventType.CLICK, () => { void run(); }));
		this.focusable.push(link);
		return link;
	}
}

function money(value: number): string {
	return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function titleCase(plan: string): string {
	return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
}

function formatDate(value: number | string | undefined): string {
	if (value === undefined) {
		return localize('billingPlans.periodEnd', "the end of the billing period");
	}
	return (typeof value === 'number' ? new Date(value * 1000) : new Date(value)).toLocaleDateString();
}
