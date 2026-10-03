// The one event taxonomy every destination shares. PostHog gets every event
// under these names; the ad platforms only get the ones mapped to a
// conversion below, translated into each platform's own vocabulary.
//
// The desktop app (backboard/src/vs/workbench/services/backboardAnalytics)
// and app.backboard.io should send the same names so one PostHog funnel
// spans site -> signup -> download -> onboarding -> first chat -> purchase.

export type AnalyticsEvent =
  // Website
  | "cta_clicked"
  | "download_clicked"
  | "install_command_copied"
  | "outbound_clicked"
  // Account (app.backboard.io, or the desktop sign-in)
  | "signup_started"
  | "signup_completed"
  | "signed_in"
  // Desktop onboarding + activation
  | "app_first_opened"
  | "onboarding_started"
  | "onboarding_step_viewed"
  | "onboarding_completed"
  | "onboarding_skipped"
  | "first_chat_message_sent"
  // Money
  | "checkout_started"
  | "trial_started"
  | "subscription_started"
  | "purchase_completed";

export type EventProps = Record<string, string | number | boolean | null | undefined>;

/** Conversions the ad platforms optimise on. Everything else is PostHog-only. */
export type Conversion =
  | "lead"
  | "signup"
  | "activation"
  | "checkout"
  | "trial"
  | "subscribe"
  | "purchase";

export const CONVERSION_FOR_EVENT: Partial<Record<AnalyticsEvent, Conversion>> = {
  download_clicked: "lead",
  install_command_copied: "lead",
  signup_completed: "signup",
  // The desktop app's first sign-in for an account on that machine. It can't
  // tell a brand-new account from an existing one, so this is "new desktop
  // user" rather than strictly a new signup.
  signed_in: "signup",
  first_chat_message_sent: "activation",
  checkout_started: "checkout",
  trial_started: "trial",
  subscription_started: "subscribe",
  purchase_completed: "purchase",
};

/**
 * Meta's standard event for each conversion. Standard events are the ones
 * Meta can optimise campaigns against; "activation" has no standard twin, so
 * it goes out as a custom event.
 */
export const META_EVENT: Record<Conversion, { name: string; custom?: true }> = {
  lead: { name: "Lead" },
  signup: { name: "CompleteRegistration" },
  activation: { name: "Activated", custom: true },
  checkout: { name: "InitiateCheckout" },
  trial: { name: "StartTrial" },
  subscribe: { name: "Subscribe" },
  purchase: { name: "Purchase" },
};

/** Conversions that carry money, so value/currency are forwarded. */
export const VALUE_CONVERSIONS: ReadonlySet<Conversion> = new Set([
  "checkout",
  "trial",
  "subscribe",
  "purchase",
]);
