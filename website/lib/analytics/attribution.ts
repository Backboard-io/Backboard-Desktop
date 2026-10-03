import { ATTRIBUTION_COOKIE, ATTRIBUTION_COOKIE_DOMAIN } from "./config";

// Ad click ids and UTMs, captured on landing and kept for 90 days. The
// purchase happens later on app.backboard.io, so this is what lets that
// server-side "someone paid" event be tied back to the ad that brought them:
// the cookie is scoped to .backboard.io, and decorateUrl() also appends it to
// outbound signup links in case the cookie can't cross.

const PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid", // Meta
  "gclid", // Google Ads
  "gbraid", // Google Ads (iOS app -> web)
  "wbraid", // Google Ads (web -> app)
  "twclid", // X
  "li_fat_id", // LinkedIn
  "msclkid", // Microsoft Ads, free to keep
] as const;

export type AttributionParam = (typeof PARAMS)[number];
export type Touch = Partial<Record<AttributionParam, string>> & {
  landing_page?: string;
  referrer?: string;
  at?: number;
};
export type Attribution = { first?: Touch; last?: Touch };

const MAX_AGE_S = 60 * 60 * 24 * 90;
const STORE_KEY = "bb_attr";

function readStore(): Attribution {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Attribution;
  } catch {
    return {};
  }
}

function writeStore(a: Attribution) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(a));
  } catch {
    // Private mode or blocked storage: the cookie still carries it.
  }
  const domain = location.hostname.endsWith("backboard.io")
    ? `; domain=${ATTRIBUTION_COOKIE_DOMAIN}`
    : "";
  document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(
    JSON.stringify(a),
  )}; path=/; max-age=${MAX_AGE_S}; samesite=lax${domain}${
    location.protocol === "https:" ? "; secure" : ""
  }`;
}

/** Reads ad params off the current URL; only a visit that has any becomes a touch. */
export function captureAttribution(): Attribution {
  const stored = readStore();
  const qs = new URLSearchParams(location.search);
  const touch: Touch = {};
  for (const p of PARAMS) {
    const v = qs.get(p);
    if (v) touch[p] = v.slice(0, 500);
  }
  if (Object.keys(touch).length === 0) return stored;

  touch.landing_page = location.pathname;
  touch.referrer = document.referrer || undefined;
  touch.at = Date.now();
  const next: Attribution = { first: stored.first ?? touch, last: touch };
  writeStore(next);
  return next;
}

export function getAttribution(): Attribution {
  return typeof window === "undefined" ? {} : readStore();
}

/** Flat props for events: last-touch values plus first-touch source/campaign. */
export function attributionProps(): Record<string, string | undefined> {
  const { first, last } = getAttribution();
  const out: Record<string, string | undefined> = {};
  for (const p of PARAMS) out[p] = last?.[p];
  out.first_utm_source = first?.utm_source;
  out.first_utm_campaign = first?.utm_campaign;
  return out;
}

/**
 * Adds the last touch's click ids/UTMs to a link into app.backboard.io so the
 * signup page can store them against the new account even when the cookie is
 * blocked. Leaves non-Backboard links untouched.
 */
export function decorateUrl(href: string): string {
  try {
    const url = new URL(href, location.href);
    if (!url.hostname.endsWith("backboard.io")) return href;
    const last = getAttribution().last ?? {};
    for (const p of PARAMS) {
      const v = last[p];
      if (v && !url.searchParams.has(p)) url.searchParams.set(p, v);
    }
    return url.toString();
  } catch {
    return href;
  }
}
