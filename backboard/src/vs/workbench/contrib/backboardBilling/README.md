# Desktop billing

The shared contribution registers `backboard.openBilling`, which opens the plans view (`BillingPlansView`) as a full-window overlay in Simple, Editor, and Advanced modes. Onboarding shows the same view right after a Backboard sign-in. Until the desktop billing API is deployed, the cards fall back to published prices and Subscribe opens the app.backboard.io billing page. It uses stored SSO OAuth credentials and `IRequestService`; billing never uses the shared organization API key. The API origin comes from the existing Desktop SSO configuration.

`BackboardBillingService` loads `/billing/status` and `/billing/plans`. Purchases carry a stable UUID, `source=desktop`, and the displayed account ID. The backend independently resolves and authorizes that account. Pending attempts and sessions persist in application storage and survive restarts. Stripe opens through the system browser, restricted to Stripe's HTTPS checkout and billing hosts.

The early URL contribution handles only `backboard://billing/return`, `/cancel`, and `/payment-method-return`. A checkout return is verified through `/billing/checkout-status`; a query parameter cannot grant credits or prove success. Polling stops after 60 seconds, including stalled requests, and retains an unfinished session for the next Billing open or app focus. OAuth rotation is shared with the existing account metadata resolver.

## Backend rollout

Apply Espri API's `migrations/add_billing_coordination.py` during its documented billing maintenance cutover, then deploy all backend workers and public frontend routes before releasing Desktop. The migration creates `billing_operations` and `billing_fulfillments`; credits and automatic reload reuse these tables. Keep `BILLING_RECONCILER_ENABLED=true` to recover interrupted purchases and process deferred automatic reloads.

Serve `/desktop/billing/return`, `/desktop/billing/cancel`, and `/desktop/billing/payment-method-return` through the frontend SPA. These pages do not require browser login or expose account details. Configure the signed Stripe webhook destination for completed, async payment success and expired checkout events, paid invoice events, and the existing subscription lifecycle events.

Release builds use `https://app.backboard.io/api/oauth/...` for SSO and derive billing's origin from the same configuration. Use production deployment secrets and `ENV=prod` for the API and web dashboard. Do not ship local endpoint overrides or reuse Stripe CLI webhook secrets in production. Developers switching back from local SSO must sign out and sign in again.

An old or unavailable API shows a retryable error. OAuth tokens without `selected_client_id` require another SSO login.

## Validation

From the `backboard` repository directory:

```sh
npm run typecheck-client
node build/next/index.ts transpile --out out-build
node test/unit/browser/index.js --build --browser chromium \
  --runGlob '{vs/workbench/contrib/backboardBilling/test/browser,vs/workbench/contrib/chat/test/browser}/backboard*.test.js'
npm --prefix extensions/backboard run typecheck
```

From the Espri API repository directory, run the focused backend regression suite:

```sh
venv/bin/python -m pytest -q \
  tests/test_desktop_billing.py \
  tests/test_billing_coordination.py \
  tests/test_auto_reload_concurrency.py \
  tests/test_oauth_device_flow.py \
  tests/test_oauth_context_resolution.py \
  tests/test_prepaid_billing.py \
  tests/test_credit_purchase_eligibility_and_tax.py \
  tests/test_subscription_sync.py \
  tests/test_subscription_stripe_e2e.py
npm --prefix frontend test -- --watch=false DesktopBillingReturnPage.test.js
npm --prefix frontend run build
```

The real Stripe sandbox lifecycle tests are opt-in and skipped by the default command. The backend suite checks membership authorization, account context during token rotation (including rollback and refresh-token replay), checkout ownership, invoice/checkout webhook ordering, discounts, and duplicate delivery. Desktop tests check interrupted attempts, concurrent refresh, account changes during confirmation and verification, polling deadlines, and pending-session restoration. Frontend tests check protocol link validation and the fallback when launch is blocked.

### Release acceptance

Use an isolated test deployment with matching database, Redis, SSO and Stripe sandbox resources. Release source must retain the production SSO endpoints. Keep any test-build overrides outside the release changes. Changing a generic model API URL does not retarget billing. Credentials live in `~/.backboard_ide/config.json`; a separate Electron user-data directory alone does not isolate them.

In a signed-out browser, visit each public return route and confirm it renders without the dashboard login. A direct or malformed link must never claim payment succeeded. Use a packaged build registered for `backboard://` to test OS handoff; a development window alone does not establish protocol ownership.

Before release, use Stripe test mode with a Desktop build whose SSO targets the matching test API. Complete an initial subscription and a paid upgrade and verify the backend-confirmed plan and wallet credits. Repeat for a personal account, an organization admin, and a read-only organization member; delayed payment and repeated webhook delivery; checkout cancellation; a closed Desktop app; and browsers that block automatic protocol launching. Check cancellation and downgrade effective dates. Test the return flow on every supported packaged desktop platform. Automated tests do not replace these payment and OS protocol checks.
