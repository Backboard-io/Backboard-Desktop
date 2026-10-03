# Desktop billing

The shared contribution registers `backboard.openBilling`, which opens the plans view (`BillingPlansView`) as a full-window overlay in Simple, Editor, and Advanced modes. Onboarding shows the same view right after a Backboard sign-in. Until the desktop billing API is deployed, the cards fall back to published prices and Subscribe opens the app.backboard.io billing page. It uses stored SSO OAuth credentials and `IRequestService`; billing never uses the shared organization API key. The API origin comes from the existing Desktop SSO configuration.

`BackboardBillingService` loads `/billing/status` and `/billing/plans`. Purchases carry a stable UUID, `source=desktop`, and the displayed account ID. The backend independently resolves and authorizes that account. Pending attempts and sessions persist in application storage and survive restarts. Stripe opens through the system browser, restricted to Stripe's HTTPS checkout and billing hosts.

The early URL contribution handles only `backboard://billing/return`, `/cancel`, and `/payment-method-return`. A checkout return is verified through `/billing/checkout-status`; a query parameter cannot grant credits or prove success. Polling stops after 60 seconds, including stalled requests, and retains an unfinished session for the next Billing open or app focus. OAuth rotation is shared with the existing account metadata resolver.

## Backend rollout

Deploy the accompanying Espri API changes and public frontend routes before releasing Desktop. Serve `/desktop/billing/return`, `/desktop/billing/cancel`, and `/desktop/billing/payment-method-return` through the frontend SPA. These pages do not require browser login or expose account details. Configure the signed Stripe webhook endpoint to deliver both `checkout.session.completed` and `checkout.session.async_payment_succeeded`, alongside the existing subscription and invoice events. No schema migration is required.

An old or unavailable API shows a retryable error. OAuth tokens without `selected_client_id` require another SSO login.

## Validation

From the `backboard` repository directory:

```sh
npm run typecheck-client
npm run transpile-client
node test/unit/browser/index.js --browser chromium \
  --run src/vs/workbench/contrib/backboardBilling/test/browser/backboardBilling.test.ts \
  --run src/vs/workbench/contrib/chat/test/browser/backboardUserInfo.test.ts
npm --prefix extensions/backboard run typecheck
```

From the Espri API repository directory, run the focused backend regression suite:

```sh
venv/bin/python -m pytest -q \
  tests/test_desktop_billing.py \
  tests/test_oauth_device_flow.py \
  tests/test_oauth_context_resolution.py \
  tests/test_prepaid_billing.py \
  tests/test_credit_purchase_eligibility_and_tax.py \
  tests/test_subscription_sync.py \
  tests/test_subscription_stripe_e2e.py
npm --prefix frontend test -- --watch=false DesktopBillingReturnPage.test.js
npm --prefix frontend run build
```

The live Stripe lifecycle tests are opt-in and skipped by the default command. The backend suite checks membership authorization, account context during token rotation (including rollback and refresh-token replay), checkout ownership, invoice/checkout webhook ordering, discounts, and duplicate delivery. Desktop tests check interrupted attempts, concurrent refresh, account changes during confirmation and verification, polling deadlines, and pending-session restoration. Frontend tests check protocol link validation and the fallback when launch is blocked.

### Local payment setup

Use an isolated test database, Redis, and Stripe test resources. Configure `ENV=local`, `FRONTEND_URL=http://localhost:3000`, and `BACKBOARD_BASE_URL=http://localhost:8000/api`, plus the existing authentication settings, `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, and test price IDs for Starter, Builder, and Scale. Start the API with `venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000` and the frontend with `REACT_APP_API_URL=http://localhost:8000/api npm --prefix frontend start`.

Run `stripe listen --forward-to http://localhost:8000/billing/webhooks/stripe` and put that listener's signing secret in `STRIPE_TEST_WEBHOOK_SECRET` before starting or restarting the API. The public API normally uses `/api`; the router's direct local webhook path is `/billing/webhooks/stripe`.

Desktop currently ships with production SSO URLs. For a test build, update both `src/vs/workbench/contrib/chat/common/backboardAuth.ts` (token/user-info URLs) and `extensions/backboard/src/backboardExtension.ts` (device-code/token/user-info URLs) to the same test API, retaining `/api/oauth/...`, then sign in again. Changing a generic model API URL does not retarget billing. The existing OAuth configuration lives in `~/.backboard_ide/config.json`; a separate Electron user-data directory alone does not isolate that file. Keep these endpoint changes local to the test build. Launch Desktop with `npm run dev`.

In a signed-out browser, visit each public return route and confirm it renders without the dashboard login. A direct or malformed link must never claim payment succeeded. Use a packaged build registered for `backboard://` to test OS handoff; a development window alone does not establish protocol ownership.

Before release, use Stripe test mode with a Desktop build whose SSO targets the matching test API. Complete an initial subscription and a paid upgrade and verify the backend-confirmed plan and wallet credits. Repeat for a personal account, an organization admin, and a read-only organization member; delayed payment and repeated webhook delivery; checkout cancellation; a closed Desktop app; and browsers that block automatic protocol launching. Check cancellation and downgrade effective dates. Test the return flow on every supported packaged desktop platform. Automated tests do not replace these payment and OS protocol checks.
