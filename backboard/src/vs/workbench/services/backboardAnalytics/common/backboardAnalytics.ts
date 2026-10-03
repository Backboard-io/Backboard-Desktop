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
	| 'signed_in'
	| 'onboarding_started'
	| 'onboarding_step_viewed'
	| 'onboarding_action'
	| 'onboarding_completed'
	| 'onboarding_skipped'
	| 'chat_message_sent'
	| 'first_chat_message_sent'
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

	/** Properties sent with every later event (e.g. the chosen experience). */
	register(props: BackboardAnalyticsProps): void;
}
