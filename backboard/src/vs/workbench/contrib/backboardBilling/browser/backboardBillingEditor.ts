/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { safeIntl } from '../../../../base/common/date.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IBackboardBillingService, BillingOperation, billingPlanAction } from '../common/backboardBilling.js';
import { BackboardBillingEditorInput } from './backboardBillingEditorInput.js';
import './media/backboardBilling.css';

const $ = DOM.$;
const moneyFormat = safeIntl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
const money = (value: number) => moneyFormat.value.format(value || 0);
const date = (value: number | string | undefined) => value ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleDateString() : 'the end of your billing period';

export class BackboardBillingEditor extends EditorPane {
	static readonly ID = 'workbench.editor.backboardBilling';
	private container: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IBackboardBillingService private readonly billing: IBackboardBillingService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(BackboardBillingEditor.ID, group, telemetryService, themeService, storageService);
		this._register(billing.onDidChange(() => this.render()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.backboard-billing'));
		this.container.tabIndex = -1;
		this.render();
	}

	override async setInput(input: BackboardBillingEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		void this.billing.refresh();
	}

	override layout(dimension: DOM.Dimension): void { if (this.container) { this.container.style.height = `${dimension.height}px`; } }
	override focus(): void { this.container?.focus(); }

	private button(parent: HTMLElement, label: string, run: () => Promise<unknown>, disabled = false, primary = false): void {
		const button = DOM.append(parent, $<HTMLButtonElement>(primary ? 'button.billing-button.primary' : 'button.billing-button'));
		button.type = 'button';
		button.textContent = label;
		button.disabled = disabled;
		this.renderDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			void run().catch(() => { /* Billing service renders operation failures. */ });
		}));
	}

	private text(parent: HTMLElement, selector: string, value: string): HTMLElement {
		const node = DOM.append(parent, $(selector));
		node.textContent = value;
		return node;
	}

	private render(): void {
		if (!this.container) { return; }
		this.renderDisposables.clear();
		DOM.clearNode(this.container);
		const header = DOM.append(this.container, $('header.billing-header'));
		this.text(header, 'h1', localize('backboardBilling.title', "Billing"));
		const navigation = DOM.append(header, $('.billing-actions'));
		this.button(navigation, 'Refresh', () => this.billing.refresh(), this.billing.loading || this.billing.busy);
		this.button(navigation, 'Back to app', async () => this.editorGroupsService.activeModalEditorPart?.close());
		const notice = this.text(this.container, 'p.billing-notice', this.billing.message || (this.billing.loading ? 'Loading billing…' : ''));
		notice.setAttribute('role', 'status');
		notice.setAttribute('aria-live', 'polite');
		if (this.billing.needsSignIn) {
			this.button(this.container, 'Sign in to manage billing', async () => { await this.commandService.executeCommand('backboard.signIn'); await this.billing.refresh(); }, this.billing.busy, true);
			return;
		}
		const status = this.billing.status;
		const catalog = this.billing.catalog;
		if (!status || !catalog) { return; }
		this.text(this.container, 'p.billing-account', `${status.account.is_personal ? 'Personal account' : 'Billing account'} · ${status.account.name}`);
		if (!status.can_manage_billing) { this.text(this.container, 'p.billing-muted', 'An account admin manages this subscription and payment details.'); }
		const current = DOM.append(this.container, $('section.billing-current'));
		this.text(current, 'h2', status.plan ? `${status.plan.plan_name} plan` : 'No active subscription');
		const metrics = DOM.append(current, $('.billing-metrics'));
		this.text(metrics, 'p', `Subscription credits available: ${money(status.wallet.plan_grant_remaining_usd)}`);
		if (status.plan) {
			this.text(metrics, 'p', `Monthly plan: ${money(status.plan.plan_amount_usd)} USD`);
			const end = date(status.plan.current_period_end_ts ?? status.plan.current_period_end);
			this.text(metrics, 'p', `${status.plan.cancel_at_period_end ? 'Access ends' : 'Renews'} ${end}`);
			if (status.plan.scheduled_downgrade_plan) { this.text(current, 'p.billing-muted', `Changes to ${status.plan.scheduled_downgrade_plan.toUpperCase()} on ${date(status.plan.scheduled_downgrade_date ?? status.plan.current_period_end_ts)}`); }
			const managed = status.plan.plan_name === 'ENTERPRISE';
			const legacy = ['BASE', 'INDIE', 'TEAM'].includes(status.plan.plan_name);
			if (managed) { this.text(current, 'p.billing-muted', 'Contact your account team for Enterprise plan changes.'); }
			if (legacy) { this.text(current, 'p.billing-muted', 'This legacy plan is no longer offered. Choose a new plan after it expires.'); }
			const actions = DOM.append(current, $('.billing-actions'));
			const disabled = !status.can_manage_billing || this.billing.busy || this.billing.loading || !!this.billing.pending;
			if (!status.plan.cancel_at_period_end) {
				this.button(actions, 'Cancel renewal', () => this.confirm('cancel', `Cancel renewal? Your current plan remains available until ${end}.`, 'Cancel renewal'), disabled);
			} else if (!legacy) { this.button(actions, 'Resume renewal', () => this.billing.run('renew'), disabled); }
			if (status.plan.scheduled_downgrade_plan) { this.button(actions, 'Cancel scheduled downgrade', () => this.billing.run('cancel-downgrade'), disabled); }
		}
		const accountActions = DOM.append(current, $('.billing-actions'));
		this.button(accountActions, 'Update payment details', () => this.billing.run('update-payment-method'), !status.can_manage_billing || this.billing.loading || this.billing.busy || !!this.billing.pending);
		if (this.billing.pending) {
			this.button(this.container, 'Resume checkout', () => this.billing.resumeCheckout(), this.billing.loading || this.billing.busy || !status.can_manage_billing || this.billing.pending.accountId !== status.account.id, true);
		}
		this.text(this.container, 'h2', 'Choose a plan');
		this.text(this.container, 'p.billing-muted', `Monthly prices in USD, plus a ${catalog.service_fee_percent}% service fee. Stripe shows the final charge and any applicable taxes before payment.`);
		const plans = DOM.append(this.container, $('.billing-plans'));
		for (const plan of catalog.plans) {
			const card = DOM.append(plans, $('section.billing-plan'));
			this.text(card, 'h3', plan.name);
			this.text(card, 'p.billing-price', `${money(plan.monthly_price_usd)} / month`);
			this.text(card, 'p.billing-muted', `${money(plan.included_credits_usd)} included credits per month`);
			this.text(card, 'p.billing-muted', `Service fee: ${money(plan.monthly_price_usd * catalog.service_fee_percent / 100)} / month`);
			if (status.plan?.plan_name.toLowerCase() === plan.id) { this.text(card, 'p.billing-current-label', 'Current plan'); }
			const action = billingPlanAction(status, plan);
			if (action) {
				const label = { subscribe: 'Subscribe', upgrade: 'Upgrade', downgrade: 'Downgrade' }[action];
				this.button(card, label, () => action === 'downgrade'
					? this.confirm('change-plan', `Change to ${plan.name} on ${date(status.plan?.current_period_end_ts ?? status.plan?.current_period_end)}? Your current plan stays active until then.`, 'Schedule downgrade', plan.id)
					: this.billing.run(action === 'subscribe' ? 'subscribe' : 'change-plan', plan.id), this.billing.loading || this.billing.busy || !!this.billing.pending, true);
			}
		}
	}

	private async confirm(operation: BillingOperation, message: string, primaryButton: string, plan?: string): Promise<void> {
		const accountId = this.billing.status?.account.id;
		const result = await this.dialogService.confirm({ type: 'info', message, primaryButton });
		if (result.confirmed && accountId !== undefined) { await this.billing.run(operation, plan, accountId); }
	}
}
