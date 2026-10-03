# Analytics and ad conversions

Everything is wired and **off**. Each destination turns on when its key is set,
and nothing loads or sends until then.

## Turning it on

| Destination | Where the key goes |
| --- | --- |
| PostHog (website) | `NEXT_PUBLIC_POSTHOG_KEY` in Vercel env |
| PostHog (desktop app) | `backboardAnalytics.posthogKey` in `backboard/product.json` |
| Meta pixel | `NEXT_PUBLIC_META_PIXEL_ID`, plus `META_CAPI_ACCESS_TOKEN` for server purchases |
| Google Ads | `NEXT_PUBLIC_GOOGLE_ADS_ID` plus one `NEXT_PUBLIC_GOOGLE_ADS_LABEL_*` per conversion |
| X | `NEXT_PUBLIC_X_PIXEL_ID` plus one `NEXT_PUBLIC_X_EVENT_*` per conversion |
| LinkedIn | `NEXT_PUBLIC_LINKEDIN_PARTNER_ID` plus one `NEXT_PUBLIC_LINKEDIN_CONVERSION_*` per conversion, plus `LINKEDIN_CAPI_ACCESS_TOKEN` for server purchases |
| Desktop → ad platforms | `backboardAnalytics.conversionsUrl` in `backboard/product.json` = `https://<this site>/api/conversions` |
| Server conversions from a backend | `CONVERSIONS_WEBHOOK_SECRET` |

The full list is in `website/.env.example`. To see events in the console
without any keys, set `NEXT_PUBLIC_ANALYTICS_DEBUG=1`.

## The funnel

One set of event names everywhere (`events.ts`), so one PostHog funnel runs from
the ad to the purchase.

| Event | Fired by | Ad conversion |
| --- | --- | --- |
| `$pageview` | website (automatic) | page view |
| `download_clicked` | website download button | lead |
| `install_command_copied` | website CLI install copy | lead |
| `outbound_clicked`, `cta_clicked` | website (any external link, or `data-track="name"`) | – |
| `signup_started` | website link to `app.backboard.io/signup` | – |
| `signup_completed` | **app.backboard.io backend** → `/api/conversions` | signup |
| `app_first_opened`, `app_opened` | desktop app | – |
| `onboarding_started` / `_step_viewed` / `_action` / `_completed` / `_skipped` | desktop onboarding | – |
| `signed_in` | desktop app (first time per account per install) | signup |
| `chat_message_sent`, `first_chat_message_sent` | desktop app | activation (first only) |
| `checkout_started` | desktop app (Upgrade / Manage Budget clicked) | checkout |
| `purchase_completed` | desktop app (new paid row in the billing ledger) | purchase |
| `trial_started`, `subscription_started` | app.backboard.io backend → `/api/conversions` (optional) | trial / subscribe |

## Desktop conversions

The desktop app can't run ad pixels (no ad cookies) and must not ship ad
secrets, so it sends conversions to `/api/conversions` with the **user's own
Backboard sign-in token**. The relay doesn't trust what the app says:

- It verifies the token with `app.backboard.io/api/oauth/userinfo` and uses the
  verified email. Meta and LinkedIn match the ad on that email (hashed), plus
  IP and user agent.
- A purchase only counts if its ledger id is in the user's
  `/billing/history`. The amount comes from the ledger, not the app.
- The app may only send `signed_in`, `first_chat_message_sent`,
  `checkout_started` and `purchase_completed`.

The app finds purchases by reading the billing ledger. It checks at startup, when
the window regains focus (people pay in the browser and come back), every
minute for 20 minutes after an Upgrade click, and every 30 minutes otherwise.
The first check for an account only records a baseline, so past purchases are
never reported. Paid rows are `subscription_grant`, `subscription_upgrade`,
`credit_purchase` and `auto_reload`, valued at their `change_usd`.

**Needed in Backboard-API:** `/billing/history` uses
`app.routers.auth.get_current_user_with_db`, which rejects OAuth sign-in tokens.
Switch it to `app.core.dependencies.get_current_user_with_db_dual`, which accepts
them. Until then:
- Purchases still reach PostHog for users who have an API key in the app.
- The relay can't verify purchases (it returns 503), so purchases don't reach
  the ad platforms. Sign-ins, first chats and checkouts work regardless.

## Purchases

Purchases happen on app.backboard.io, outside this repo. To report one:

1. **On signup**, app.backboard.io reads the `bb_attr` cookie (scoped to
   `.backboard.io`; the website also appends the same click ids to signup links)
   and the `_fbp`/`_fbc` cookies, and stores them on the account.
2. **When payment is confirmed** (e.g. in the Stripe webhook), it calls:

```http
POST https://<site>/api/conversions
Authorization: Bearer $CONVERSIONS_WEBHOOK_SECRET
Content-Type: application/json

{
  "event": "purchase_completed",
  "event_id": "<stripe invoice or payment id>",
  "user_id": "<user email, lowercased>",
  "email": "user@example.com",
  "value": 20,
  "currency": "USD",
  "transaction_id": "<stripe invoice id>",
  "attribution": <the stored bb_attr object>,
  "fbp": "<stored _fbp>",
  "client_ip": "...",
  "user_agent": "..."
}
```

The endpoint forwards it to PostHog, the Meta Conversions API, and the LinkedIn
Conversions API. It returns what each destination did. If the browser also fired
the same event, reuse its `event_id` so each platform counts it once.

**Identity:** the desktop app identifies users by **lowercased email**. Use the
same value as `user_id` and in `identify()` on app.backboard.io, so PostHog
merges website visits, the app, and payments into one person.

## Not connected yet

- **Google Ads server uploads** need the Google Ads API: a developer token, an
  OAuth refresh token, and a customer id. Until those exist, the browser gtag
  conversion with enhanced conversions is the Google signal. The `gclid` is
  already stored.
- **X Conversions API** needs an Ads API app with OAuth 1.0a signing. Until
  then, the browser `twq` event covers X. The `twclid` is already stored.
- **Cookie banner:** set `NEXT_PUBLIC_ANALYTICS_CONSENT=required` and call
  `setAnalyticsConsent(true)` from a banner before running ads into the EU or UK.
