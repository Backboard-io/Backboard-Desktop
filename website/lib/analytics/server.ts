import { createHash } from "node:crypto";
import type { Attribution } from "./attribution";
import {
  type AnalyticsEvent,
  type Conversion,
  CONVERSION_FOR_EVENT,
  META_EVENT,
  VALUE_CONVERSIONS,
} from "./events";

// Server-side conversions: the half of tracking that sees money. Purchases
// and signups are confirmed by app.backboard.io's backend (e.g. a Stripe
// webhook), not by a browser, so that backend POSTs them to /api/conversions
// and this fans them out. The browser pixel and this send share `event_id`,
// so each platform de-duplicates and counts the conversion once.
//
// Every destination is skipped until its server env vars are set.

export type ServerConversion = {
  event: AnalyticsEvent;
  /** Same id the browser used, when there was a browser event. */
  event_id: string;
  /** Backboard account id. PostHog distinct id and Meta external_id. */
  user_id: string;
  email?: string;
  value?: number;
  currency?: string;
  transaction_id?: string;
  /** ISO time the conversion happened; defaults to now. */
  occurred_at?: string;
  /** The bb_attr cookie, stored on the account at signup. */
  attribution?: Attribution;
  /** Meta's _fbp / _fbc cookies, if app.backboard.io can read them. */
  fbp?: string;
  fbc?: string;
  client_ip?: string;
  user_agent?: string;
  page_url?: string;
  /** Anything else for PostHog (plan, seats, interval...). */
  properties?: Record<string, string | number | boolean | null>;
  /**
   * Meta's action_source. "website" for things that happened on a site;
   * the desktop app reports "other" (Meta's bucket for software outside a
   * browser or registered mobile app).
   */
  action_source?: "website" | "other";
};

export type SendOptions = {
  /** False when the caller already sent this event to PostHog itself. */
  posthog?: boolean;
};

export type DestinationResult = { ok: boolean; skipped?: string; status?: number; error?: string };

const env = (k: string) => process.env[k]?.trim() || undefined;
const sha256 = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

export async function sendConversion(
  c: ServerConversion,
  options: SendOptions = {},
): Promise<Record<string, DestinationResult>> {
  const conversion = CONVERSION_FOR_EVENT[c.event];
  const [posthog, meta, linkedin, google, x] = await Promise.all([
    settle(options.posthog === false ? skip("sent by the app") : sendPosthog(c)),
    settle(conversion ? sendMeta(c, conversion) : skip("not an ad conversion")),
    settle(conversion ? sendLinkedIn(c, conversion) : skip("not an ad conversion")),
    settle(conversion ? sendGoogleAds(c, conversion) : skip("not an ad conversion")),
    settle(conversion ? sendX(c, conversion) : skip("not an ad conversion")),
  ]);
  return { posthog, meta, linkedin, google, x };
}

async function sendPosthog(c: ServerConversion): Promise<DestinationResult> {
  const key = env("POSTHOG_KEY") ?? env("NEXT_PUBLIC_POSTHOG_KEY");
  if (!key) return skip("POSTHOG_KEY not set");
  const host = env("POSTHOG_HOST") ?? env("NEXT_PUBLIC_POSTHOG_HOST") ?? "https://us.i.posthog.com";
  const last = c.attribution?.last ?? {};
  const res = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: c.event,
      distinct_id: c.user_id,
      timestamp: c.occurred_at,
      properties: {
        ...c.properties,
        event_id: c.event_id,
        value: c.value,
        currency: c.currency,
        transaction_id: c.transaction_id,
        utm_source: last.utm_source,
        utm_campaign: last.utm_campaign,
        first_utm_source: c.attribution?.first?.utm_source,
        $set: c.email ? { email: c.email } : undefined,
      },
    }),
  });
  return result(res);
}

async function sendMeta(c: ServerConversion, conversion: Conversion): Promise<DestinationResult> {
  const pixelId = env("META_PIXEL_ID") ?? env("NEXT_PUBLIC_META_PIXEL_ID");
  const token = env("META_CAPI_ACCESS_TOKEN");
  if (!pixelId || !token) return skip("META_PIXEL_ID / META_CAPI_ACCESS_TOKEN not set");

  const fbclid = c.attribution?.last?.fbclid;
  const at = c.attribution?.last?.at ?? Date.now();
  const m = META_EVENT[conversion];
  const body = {
    data: [
      {
        event_name: m.name,
        event_time: Math.floor(new Date(c.occurred_at ?? Date.now()).getTime() / 1000),
        event_id: c.event_id,
        action_source: c.action_source ?? "website",
        event_source_url: c.page_url,
        user_data: {
          em: c.email ? [sha256(c.email)] : undefined,
          external_id: [sha256(c.user_id)],
          fbp: c.fbp,
          // Rebuilt from the stored click id when the _fbc cookie isn't available.
          fbc: c.fbc ?? (fbclid ? `fb.1.${at}.${fbclid}` : undefined),
          client_ip_address: c.client_ip,
          client_user_agent: c.user_agent,
        },
        custom_data: VALUE_CONVERSIONS.has(conversion)
          ? { value: c.value, currency: c.currency ?? "USD", order_id: c.transaction_id }
          : undefined,
      },
    ],
    test_event_code: env("META_TEST_EVENT_CODE"),
  };
  const version = env("META_GRAPH_VERSION") ?? "v23.0";
  const res = await fetch(
    `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return result(res);
}

async function sendLinkedIn(c: ServerConversion, conversion: Conversion): Promise<DestinationResult> {
  const token = env("LINKEDIN_CAPI_ACCESS_TOKEN");
  const ruleId = env(`LINKEDIN_CONVERSION_${conversion.toUpperCase()}`) ??
    env(`NEXT_PUBLIC_LINKEDIN_CONVERSION_${conversion.toUpperCase()}`);
  if (!token || !ruleId) return skip("LINKEDIN_CAPI_ACCESS_TOKEN or conversion id not set");

  const userIds: Array<{ idType: string; idValue: string }> = [];
  if (c.email) userIds.push({ idType: "SHA256_EMAIL", idValue: sha256(c.email) });
  const liFatId = c.attribution?.last?.li_fat_id;
  if (liFatId) userIds.push({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: liFatId });
  if (userIds.length === 0) return skip("no email or li_fat_id to match on");

  const res = await fetch("https://api.linkedin.com/rest/conversionEvents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "linkedin-version": env("LINKEDIN_API_VERSION") ?? "202509",
      "x-restli-protocol-version": "2.0.0",
    },
    body: JSON.stringify({
      conversion: `urn:lla:llaPartnerConversion:${ruleId}`,
      conversionHappenedAt: new Date(c.occurred_at ?? Date.now()).getTime(),
      conversionValue:
        VALUE_CONVERSIONS.has(conversion) && c.value !== undefined
          ? { currencyCode: c.currency ?? "USD", amount: String(c.value) }
          : undefined,
      eventId: c.event_id,
      user: { userIds },
    }),
  });
  return result(res);
}

/**
 * Google Ads server-side uploads go through the Google Ads API
 * (ConversionUploadService.UploadClickConversions), which needs a developer
 * token, an OAuth refresh token and the customer id. Until those exist the
 * browser gtag conversion (with enhanced conversions) is the Google signal.
 * The gclid/gbraid/wbraid needed for the upload are already in attribution.
 */
async function sendGoogleAds(c: ServerConversion, _conversion: Conversion): Promise<DestinationResult> {
  const hasClick = c.attribution?.last?.gclid || c.attribution?.last?.gbraid || c.attribution?.last?.wbraid;
  if (!hasClick) return skip("no Google click id on this account");
  return skip("Google Ads API upload not connected yet (needs developer token + OAuth)");
}

/**
 * X's Conversions API (POST ads-api.x.com/12/measurement/conversions/{pixel})
 * requires OAuth 1.0a request signing with an Ads API app. The browser twq
 * event covers X until those credentials exist; twclid is already stored.
 */
async function sendX(c: ServerConversion, _conversion: Conversion): Promise<DestinationResult> {
  if (!c.attribution?.last?.twclid && !c.email) return skip("no twclid or email to match on");
  return skip("X Conversions API not connected yet (needs OAuth 1.0a Ads API app)");
}

function skip(reason: string): Promise<DestinationResult> {
  return Promise.resolve({ ok: true, skipped: reason });
}

async function result(res: Response): Promise<DestinationResult> {
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
}

async function settle(p: Promise<DestinationResult>): Promise<DestinationResult> {
  try {
    return await p;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
