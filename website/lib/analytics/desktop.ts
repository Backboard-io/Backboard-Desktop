import type { AnalyticsEvent } from "./events";
import type { ServerConversion } from "./server";

// Conversions from the Backboard Desktop app. The app can't hold ad-platform
// secrets, so it authenticates with the user's own Backboard sign-in. Nothing
// it sends is taken on trust: who the person is comes from Backboard's
// userinfo endpoint, and a purchase only counts if it's in their billing
// ledger, with the amount read from there.

const API = (process.env.BACKBOARD_API_URL?.trim() || "https://app.backboard.io/api").replace(/\/+$/, "");

/** What the desktop app is allowed to report. */
export const DESKTOP_EVENTS: ReadonlySet<AnalyticsEvent> = new Set([
  "signed_in",
  "first_chat_message_sent",
  "checkout_started",
  "purchase_completed",
]);

const PAID_REASONS = new Set(["subscription_grant", "subscription_upgrade", "credit_purchase", "auto_reload"]);

export type DesktopBody = {
  event: AnalyticsEvent;
  event_id: string;
  transaction_id?: string;
  properties?: Record<string, string | number | boolean | null>;
};

type UserInfo = { sub: string; email?: string };
type LedgerEntry = { id: number; change_usd: number; reason: string; stripe_invoice_id?: string | null; created_at: string };

export type DesktopResult =
  | { ok: true; conversion: ServerConversion }
  | { ok: false; status: number; error: string };

export async function verifyDesktopConversion(
  authorization: string,
  body: DesktopBody,
  request: Request,
): Promise<DesktopResult> {
  if (!DESKTOP_EVENTS.has(body.event) || !body.event_id) {
    return { ok: false, status: 400, error: "unsupported desktop event" };
  }

  const user = await getJson<UserInfo>("/oauth/userinfo", authorization);
  if (!user?.sub) return { ok: false, status: 401, error: "Backboard sign-in not valid" };
  const email = user.email?.trim().toLowerCase();

  let value: number | undefined;
  let currency: string | undefined;
  let transactionId: string | undefined;
  let occurredAt: string | undefined;
  if (body.event === "purchase_completed") {
    // Needs Backboard-API's /billing/history to accept OAuth tokens
    // (get_current_user_with_db_dual); until then this returns 401.
    const ledger = await getJson<LedgerEntry[]>("/billing/history?limit=50", authorization);
    if (!ledger) return { ok: false, status: 503, error: "could not read the billing ledger" };
    const entry = ledger.find((e) => String(e.id) === body.transaction_id);
    if (!entry || !PAID_REASONS.has(entry.reason) || !(entry.change_usd > 0)) {
      return { ok: false, status: 422, error: "purchase not found in billing ledger" };
    }
    value = entry.change_usd;
    currency = "USD";
    transactionId = entry.stripe_invoice_id || String(entry.id);
    occurredAt = entry.created_at;
  }

  return {
    ok: true,
    conversion: {
      event: body.event,
      event_id: body.event_id,
      // Same identity the desktop app gives PostHog.
      user_id: email ?? `backboard:${user.sub}`,
      email,
      value,
      currency,
      transaction_id: transactionId,
      occurred_at: occurredAt,
      client_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
      user_agent: request.headers.get("user-agent") || undefined,
      action_source: "other",
      properties: { ...body.properties, source: "desktop" },
    },
  };
}

async function getJson<T>(path: string, authorization: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { authorization }, cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}
