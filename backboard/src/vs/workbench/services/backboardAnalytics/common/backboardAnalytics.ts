/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Product analytics events the desktop app sends to PostHog. The names match
 * the website's taxonomy (website/lib/analytics/events.ts) so a single PostHog
 * funnel runs from ad click to first chat to purchase.
 */
export type BackboardAnalyticsEvent =
	| 'app_first_opened'
	| 'app_opened'
	| 'ad_attribution_received'
	| 'signup_started'
	| 'signed_in'
	| 'signed_out'
	| 'account_session_started'
	| 'onboarding_started'
	| 'onboarding_step_viewed'
	| 'onboarding_action'
	| 'onboarding_completed'
	| 'onboarding_skipped'
	| 'chat_message_sent'
	| 'first_chat_message_sent'
	| 'billing_viewed'
	| 'billing_status_loaded'
	| 'billing_subscription_changed'
	| 'billing_operation_requested'
	| 'billing_operation_failed'
	| 'billing_auto_reload_updated'
	| 'billing_checkout_resumed'
	| 'billing_checkout_cancel_requested'
	| 'billing_checkout_completed'
	| 'billing_checkout_expired'
	| 'billing_checkout_failed'
	| 'checkout_started'
	| 'purchase_completed';

export type BackboardAnalyticsProps = Record<string, string | number | boolean | undefined>;

export const IBackboardAnalyticsService = createDecorator<IBackboardAnalyticsService>('backboardAnalyticsService');

export interface IBackboardAnalyticsService {
	readonly _serviceBrand: undefined;

	/** False when no PostHog key is configured or telemetry is turned off. */
	readonly enabled: boolean;

	capture(event: BackboardAnalyticsEvent, props?: BackboardAnalyticsProps): void;

	/** Merge the anonymous install into a known account. */
	identify(userId: string, traits?: BackboardAnalyticsProps): void;

	/** Clear account identity and start a fresh anonymous session after logout. */
	reset(): void;

	/** Properties sent with every later event (e.g. the chosen experience). */
	register(props: BackboardAnalyticsProps): void;

	/** Accept the consented browser campaign handoff, without accepting identity or credentials. */
	recordAttribution(props: BackboardAnalyticsProps): void;
}

export const AD_ATTRIBUTION_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_content', 'utm_term', 'campaign_id', 'ad_id', 'adset_id', 'fbclid', 'ttclid', 'gclid', 'gbraid', 'wbraid'] as const;

/** Only campaign fields may cross the browser/desktop boundary. */
export function attributionFromQuery(query: string): BackboardAnalyticsProps {
	const params = new URLSearchParams(query);
	if (params.get('marketing_consent') !== 'granted') { return { marketing_consent: 'denied' }; }
	const props: BackboardAnalyticsProps = { marketing_consent: 'granted' };
	for (const key of AD_ATTRIBUTION_PARAMS) {
		for (const name of [key, `first_${key}`]) {
			const value = params.get(name)?.trim();
			if (value) { props[name] = value.slice(0, 500); }
		}
	}
	return props;
}
