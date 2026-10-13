/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const OPEN_BILLING_COMMAND_ID = 'backboard.openBilling';
export const IBackboardBillingService = createDecorator<IBackboardBillingService>('backboardBillingService');

export interface IBillingPlan {
	readonly id: string;
	readonly name: string;
	readonly monthly_price_usd: number;
	readonly included_credits_usd: number;
}

export interface IBillingCatalog {
	readonly currency: string;
	readonly service_fee_percent: number;
	readonly credit_purchase_minimum_usd?: number;
	readonly auto_reload_minimum_threshold_usd?: number;
	readonly auto_reload_minimum_amount_usd?: number;
	readonly plans: readonly IBillingPlan[];
}

export interface IBillingStatus {
	readonly pending_checkout?: IPendingAccountCheckout | null;
	readonly can_purchase_credits?: boolean;
	readonly account: { readonly id: number; readonly name: string; readonly is_personal: boolean | null };
	readonly can_manage_billing: boolean;
	readonly plan: {
		readonly plan_name: string;
		readonly status: string;
		readonly plan_amount_usd: number;
		readonly included_credits_usd: number;
		readonly current_period_end_ts?: number;
		readonly current_period_end?: string;
		readonly cancel_at_period_end: boolean;
		readonly scheduled_downgrade_plan?: string;
		readonly scheduled_downgrade_date?: number;
	} | null;
	readonly wallet: {
		readonly plan_grant_remaining_usd: number;
		readonly balance_usd?: number;
		readonly purchased_balance_usd?: number;
		readonly has_payment_method: boolean;
		readonly auto_reload_enabled?: boolean;
		readonly auto_reload_threshold_usd?: number;
		readonly auto_reload_amount_usd?: number;
	};
}

export interface IBillingAutoReload {
	readonly enabled: boolean;
	readonly threshold_usd: number;
	readonly amount_usd: number;
}

export interface IPendingAccountCheckout {
	readonly state: 'creating' | 'open' | 'processing' | 'requires_review';
	readonly operation: string;
	readonly target_plan?: string;
	readonly amount_usd?: number;
	readonly expires_at?: number;
	readonly is_initiator: boolean;
	readonly can_resume: boolean;
	readonly can_cancel: boolean;
	readonly operation_id?: string;
}

export type BillingOperation = 'subscribe' | 'change-plan' | 'cancel' | 'renew' | 'cancel-downgrade' | 'update-payment-method';

export interface IPendingBillingCheckout {
	readonly operationId?: string;
	readonly accountId: number;
	readonly requestId?: string;
	readonly operation?: 'subscribe' | 'change-plan' | 'credits/checkout';
	readonly plan?: string;
	readonly amountUsd?: number;
	readonly sessionId?: string;
	readonly url?: string;
}

export interface IBackboardBillingService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly status: IBillingStatus | undefined;
	readonly catalog: IBillingCatalog | undefined;
	readonly pending: IPendingBillingCheckout | undefined;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly message: string;
	readonly needsSignIn: boolean;
	refresh(sessionId?: string): Promise<void>;
	run(operation: BillingOperation, plan?: string, expectedAccountId?: number): Promise<void>;
	buyCredits(amountUsd: number, expectedAccountId?: number): Promise<void>;
	configureAutoReload(config: IBillingAutoReload, expectedAccountId?: number): Promise<boolean>;
	resumeCheckout(): Promise<void>;
	cancelCheckout(): Promise<void>;
}

export function isBillingSessionId(value: unknown): value is string {
	return typeof value === 'string' && /^cs_[A-Za-z0-9_]{1,252}$/.test(value);
}

export function parsePendingCheckout(value: unknown): IPendingBillingCheckout | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const record = value as Record<string, unknown>;
	if (!Number.isSafeInteger(record.accountId) || (record.accountId as number) <= 0) { return undefined; }
	if (record.sessionId !== undefined && !isBillingSessionId(record.sessionId)) { return undefined; }
	if (record.operationId !== undefined && (typeof record.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.operationId))) { return undefined; }
	if (record.requestId !== undefined && (typeof record.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.requestId))) { return undefined; }
	if (record.operation !== undefined && !['subscribe', 'change-plan', 'credits/checkout'].includes(record.operation as string)) { return undefined; }
	if (record.amountUsd !== undefined && !isBillingCreditAmount(record.amountUsd)) { return undefined; }
	if (record.plan !== undefined && !['starter', 'builder', 'scale'].includes(record.plan as string)) { return undefined; }
	if (record.url !== undefined && (typeof record.url !== 'string' || !record.sessionId)) { return undefined; }
	if (!record.operationId && !record.sessionId && !(record.requestId && record.operation
		&& (record.operation === 'credits/checkout' ? record.amountUsd !== undefined : record.plan))) { return undefined; }
	return {
		accountId: record.accountId as number, requestId: record.requestId as string | undefined, ...(record.operationId ? { operationId: record.operationId as string } : {}),
		operation: record.operation as IPendingBillingCheckout['operation'], plan: record.plan as string | undefined,
		...(record.amountUsd !== undefined ? { amountUsd: record.amountUsd as number } : {}),
		sessionId: record.sessionId as string | undefined, url: record.url as string | undefined
	};
}

/** Currency inputs must have whole cents; never silently increase a requested charge. */
export function isBillingCreditAmount(value: unknown, minimum = 5): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum
		&& Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

export function billingReturn(uri: { authority: string; path: string; query: string; fragment: string }): { sessionId?: string } | undefined {
	if (uri.authority !== 'billing' || uri.fragment || !['/return', '/cancel', '/payment-method-return'].includes(uri.path)) { return undefined; }
	const query = new URLSearchParams(uri.query);
	const sessionId = query.get('session_id');
	if (sessionId && !isBillingSessionId(sessionId)) { return undefined; }
	return { sessionId: uri.path === '/return' ? sessionId ?? undefined : undefined };
}

export function billingPlanAction(status: IBillingStatus, plan: IBillingPlan): 'subscribe' | 'upgrade' | 'downgrade' | undefined {
	if (!status.can_manage_billing) { return undefined; }
	if (!status.plan) { return 'subscribe'; }
	const ranks: Record<string, number> = { STARTER: 1, BUILDER: 2, SCALE: 3 };
	const current = ranks[status.plan.plan_name];
	const target = ranks[plan.id.toUpperCase()];
	if (!current || !target || current === target) { return undefined; }
	return target > current ? 'upgrade' : 'downgrade';
}
