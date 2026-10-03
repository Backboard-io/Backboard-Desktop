import { timingSafeEqual } from "node:crypto";
import { type DesktopBody, verifyDesktopConversion } from "@/lib/analytics/desktop";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import { type ServerConversion, sendConversion } from "@/lib/analytics/server";

// POST /api/conversions — the relay that hands conversions to the ad
// platforms (Meta, LinkedIn; Google Ads and X once their APIs are connected).
// Two kinds of caller:
//
// 1. Backboard Desktop. It sends the user's own Backboard access token:
//      Authorization: Bearer <backboard oauth access token>
//      { "event": "purchase_completed", "event_id": "ledger-123", "transaction_id": "123" }
//    The relay checks the token with app.backboard.io, uses the verified
//    email, and re-reads the purchase from the billing ledger. See
//    lib/analytics/desktop.ts and backboard/.../backboardConversions.ts.
//
// 2. A trusted backend (e.g. app.backboard.io's Stripe webhook):
//      Authorization: Bearer $CONVERSIONS_WEBHOOK_SECRET
//      { "event": "...", "event_id": "...", "user_id": "...", "email": "...", ... }
//
// Returns what each destination did. Destinations without keys are skipped.

const SERVER_EVENTS: ReadonlySet<AnalyticsEvent> = new Set([
  "signup_completed",
  "signed_in",
  "first_chat_message_sent",
  "checkout_started",
  "trial_started",
  "subscription_started",
  "purchase_completed",
]);

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S/i.test(authorization)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const secret = process.env.CONVERSIONS_WEBHOOK_SECRET?.trim();
  if (secret && matchesSecret(authorization, secret)) {
    const c = body as ServerConversion;
    if (!SERVER_EVENTS.has(c.event) || !c.event_id || !c.user_id) {
      return Response.json(
        { error: "event (a server event), event_id and user_id are required" },
        { status: 400 },
      );
    }
    return respond(await sendConversion(c));
  }

  const verified = await verifyDesktopConversion(authorization, body as DesktopBody, request);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: verified.status });
  // The app already sent this event to PostHog under the same identity.
  return respond(await sendConversion(verified.conversion, { posthog: false }));
}

function respond(destinations: Awaited<ReturnType<typeof sendConversion>>) {
  const ok = Object.values(destinations).every((d) => d.ok);
  return Response.json({ ok, destinations }, { status: ok ? 200 : 502 });
}

function matchesSecret(header: string, secret: string): boolean {
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}
