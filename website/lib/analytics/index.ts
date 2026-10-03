import type { PostHog } from "posthog-js";
import { attributionProps, captureAttribution, decorateUrl } from "./attribution";
import { analyticsConfig as cfg } from "./config";
import {
  type AnalyticsEvent,
  type Conversion,
  type EventProps,
  CONVERSION_FOR_EVENT,
  META_EVENT,
  VALUE_CONVERSIONS,
} from "./events";
import { loadGoogleAds, loadLinkedIn, loadMeta, loadX } from "./pixels";

export { decorateUrl } from "./attribution";
export type { AnalyticsEvent, EventProps } from "./events";

// Client-side analytics: one track() call fans out to PostHog and every ad
// pixel that has an id configured. With no env vars set this whole module is
// inert — no scripts load and track() is a no-op (or a console line when
// NEXT_PUBLIC_ANALYTICS_DEBUG=1).

const CONSENT_KEY = "bb_consent";

let started = false;
let posthog: PostHog | undefined;
let posthogQueue: Array<(ph: PostHog) => void> = [];
let email: string | undefined;

function onPosthog(fn: (ph: PostHog) => void) {
  if (posthog) fn(posthog);
  else if (cfg.posthog.key) posthogQueue.push(fn);
}

function hasConsent(): boolean {
  if (cfg.consent === "granted") return true;
  try {
    return localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

/** Runs once from instrumentation-client.ts, before hydration. */
export function initAnalytics() {
  if (typeof window === "undefined") return;
  // Click ids are first-party bookkeeping, captured even before consent so a
  // later "yes" still credits the ad that brought the visitor.
  captureAttribution();
  installLinkTracking();
  if (hasConsent()) start();
}

/**
 * One delegated listener instead of an onClick per link: every outbound link
 * is tracked, and links into app.backboard.io (signup, dashboard) carry the
 * visitor's click ids along. data-track="<cta name>" on any link or button
 * also sends cta_clicked.
 */
function installLinkTracking() {
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>("a[href], [data-track]");
      if (!el) return;
      const cta = el.dataset.track;
      if (cta) track("cta_clicked", { cta, path: location.pathname });
      if (!(el instanceof HTMLAnchorElement)) return;
      const url = new URL(el.href, location.href);
      if (url.origin === location.origin) return;
      if (url.hostname.endsWith("backboard.io")) el.href = decorateUrl(el.href);
      if (url.hostname === "app.backboard.io" && url.pathname.startsWith("/signup")) {
        track("signup_started", { path: location.pathname, cta });
      }
      track("outbound_clicked", { host: url.hostname, href: url.origin + url.pathname, path: location.pathname });
    },
    { capture: true },
  );
}

/** Call from a cookie banner. Only matters with NEXT_PUBLIC_ANALYTICS_CONSENT=required. */
export function setAnalyticsConsent(granted: boolean) {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch {}
  if (granted) start();
  else posthog?.opt_out_capturing();
}

function start() {
  if (started) return;
  started = true;

  if (cfg.meta.pixelId) loadMeta(cfg.meta.pixelId);
  if (cfg.google.adsId) loadGoogleAds(cfg.google.adsId);
  if (cfg.x.pixelId) loadX(cfg.x.pixelId);
  if (cfg.linkedin.partnerId) loadLinkedIn(cfg.linkedin.partnerId);

  if (cfg.posthog.key) {
    const key = cfg.posthog.key;
    void import("posthog-js").then(({ default: ph }) => {
      ph.init(key, {
        api_host: cfg.posthog.host,
        defaults: "2026-08-30",
        person_profiles: "identified_only",
        // Ad attribution rides on every event so PostHog funnels can be split
        // by campaign without joining anything.
        loaded: (p) => p.register(stripEmpty(attributionProps())),
      });
      posthog = ph;
      const queued = posthogQueue;
      posthogQueue = [];
      queued.forEach((fn) => fn(ph));
    });
  }
}

/** Called on every client-side route change (see instrumentation-client.ts). */
export function trackPageview(url: string) {
  if (!started) return;
  // PostHog and the Meta pixel follow history changes on their own; Google
  // Ads only counts the page it loaded on unless told.
  if (cfg.google.adsId) window.gtag?.("event", "page_view", { page_location: url });
}

/**
 * Track one event everywhere it belongs. Pass `value`/`currency` on money
 * events and an `event_id` when the server will also report the same event
 * (see /api/conversions) so the ad platforms count it once.
 */
export function track(event: AnalyticsEvent, props: EventProps = {}) {
  if (typeof window === "undefined") return;
  const eventId = String(props.event_id ?? crypto.randomUUID());
  const all = stripEmpty({ ...props, event_id: eventId });
  if (cfg.debug) console.info("[analytics]", event, all);
  if (!started) return;

  onPosthog((ph) => ph.capture(event, all));
  const conversion = CONVERSION_FOR_EVENT[event];
  if (conversion) fireConversion(conversion, all, eventId);
}

/**
 * Tie this browser to a known account (after signup/sign-in). The email is
 * hashed by each ad platform's own tag before it leaves the browser.
 */
export function identify(userId: string, traits: { email?: string; plan?: string } = {}) {
  if (typeof window === "undefined" || !started) return;
  email = traits.email;
  onPosthog((ph) => ph.identify(userId, stripEmpty(traits)));
  if (email) {
    if (cfg.meta.pixelId) window.fbq?.("init", cfg.meta.pixelId, { em: email, external_id: userId });
    if (cfg.google.adsId) window.gtag?.("set", "user_data", { email });
  }
}

export function resetIdentity() {
  email = undefined;
  posthog?.reset();
}

function fireConversion(conversion: Conversion, props: EventProps, eventId: string) {
  const money = VALUE_CONVERSIONS.has(conversion)
    ? stripEmpty({ value: props.value, currency: props.currency ?? "USD" })
    : {};

  if (cfg.meta.pixelId && window.fbq) {
    const m = META_EVENT[conversion];
    window.fbq(m.custom ? "trackCustom" : "track", m.name, money, { eventID: eventId });
  }

  const label = cfg.google.labels[conversion];
  if (cfg.google.adsId && label && window.gtag) {
    window.gtag("event", "conversion", {
      send_to: `${cfg.google.adsId}/${label}`,
      ...money,
      transaction_id: props.transaction_id ?? eventId,
    });
  }

  const xEvent = cfg.x.events[conversion];
  if (cfg.x.pixelId && xEvent && window.twq) {
    window.twq("event", xEvent, stripEmpty({ ...money, conversion_id: eventId, email_address: email }));
  }

  const liConversion = cfg.linkedin.conversions[conversion];
  if (cfg.linkedin.partnerId && liConversion && window.lintrk) {
    window.lintrk("track", { conversion_id: Number(liConversion), event_id: eventId });
  }
}

function stripEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Partial<T>;
}
