import type { Conversion } from "./events";

// Browser-side analytics config. Every destination is off until its env var is
// set, so the site ships with the whole pipeline wired and nothing loading.
// Next only inlines NEXT_PUBLIC_* when read as a literal `process.env.X`, so
// each one is spelled out instead of looked up by name.

type PerConversion = Partial<Record<Conversion, string>>;

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const pick = (m: Record<Conversion, string | undefined>): PerConversion =>
  Object.fromEntries(
    Object.entries(m).filter((e): e is [Conversion, string] => !!clean(e[1])),
  ) as PerConversion;

export const analyticsConfig = {
  posthog: {
    key: clean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
    host: clean(process.env.NEXT_PUBLIC_POSTHOG_HOST) ?? "https://us.i.posthog.com",
  },
  meta: {
    pixelId: clean(process.env.NEXT_PUBLIC_META_PIXEL_ID),
  },
  google: {
    // AW-XXXXXXXXX. Each conversion action has its own label from the
    // Google Ads UI (Goals -> Conversions -> Tag setup -> "send_to").
    adsId: clean(process.env.NEXT_PUBLIC_GOOGLE_ADS_ID),
    labels: pick({
      lead: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_LEAD,
      signup: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_SIGNUP,
      activation: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_ACTIVATION,
      checkout: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_CHECKOUT,
      trial: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_TRIAL,
      subscribe: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_SUBSCRIBE,
      purchase: process.env.NEXT_PUBLIC_GOOGLE_ADS_LABEL_PURCHASE,
    }),
  },
  x: {
    // The X pixel id, plus one event id (tw-xxxxx-yyyyy) per conversion
    // created in X Ads Manager -> Tools -> Events Manager.
    pixelId: clean(process.env.NEXT_PUBLIC_X_PIXEL_ID),
    events: pick({
      lead: process.env.NEXT_PUBLIC_X_EVENT_LEAD,
      signup: process.env.NEXT_PUBLIC_X_EVENT_SIGNUP,
      activation: process.env.NEXT_PUBLIC_X_EVENT_ACTIVATION,
      checkout: process.env.NEXT_PUBLIC_X_EVENT_CHECKOUT,
      trial: process.env.NEXT_PUBLIC_X_EVENT_TRIAL,
      subscribe: process.env.NEXT_PUBLIC_X_EVENT_SUBSCRIBE,
      purchase: process.env.NEXT_PUBLIC_X_EVENT_PURCHASE,
    }),
  },
  linkedin: {
    // Insight Tag partner id, plus one numeric conversion id per conversion
    // (Campaign Manager -> Analyze -> Conversion tracking).
    partnerId: clean(process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID),
    conversions: pick({
      lead: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_LEAD,
      signup: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_SIGNUP,
      activation: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_ACTIVATION,
      checkout: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_CHECKOUT,
      trial: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_TRIAL,
      subscribe: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_SUBSCRIBE,
      purchase: process.env.NEXT_PUBLIC_LINKEDIN_CONVERSION_PURCHASE,
    }),
  },
  /**
   * "granted" loads everything on first visit. "required" holds every
   * destination until setAnalyticsConsent(true) is called (wire that to a
   * cookie banner before running ads into the EU/UK).
   */
  consent:
    process.env.NEXT_PUBLIC_ANALYTICS_CONSENT === "required" ? "required" : "granted",
  /** Logs every event to the console instead of staying silent. */
  debug: process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "1",
} as const;

/** The cookie that carries attribution to app.backboard.io. */
export const ATTRIBUTION_COOKIE = "bb_attr";
export const ATTRIBUTION_COOKIE_DOMAIN =
  clean(process.env.NEXT_PUBLIC_ANALYTICS_COOKIE_DOMAIN) ?? ".backboard.io";
