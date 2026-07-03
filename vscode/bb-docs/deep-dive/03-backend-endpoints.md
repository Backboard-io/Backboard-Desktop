# Backboard Backend — Endpoint Catalog

The backend is a **FastAPI** app (`main.py` + `app/` at the repo root of `Espri-API`).

```
Base URLs
  prod   https://app.backboard.io/api
  dev    https://dev.app.backboard.io/api
  local  http://localhost:8000
Auth
  X-API-Key header (IDE / CLI / SDK)      session cookies (web dashboard)
```

```
                          ┌────────────────────────────────────────┐
   IDE (Rust bridge) ────►│              FastAPI app               │
   Zed extension     ────►│  ┌──────────┐ ┌─────────┐ ┌─────────┐  │
   CLI               ────►│  │assistants│ │ threads │ │documents│  │──► Postgres
   Web dashboard     ────►│  ├──────────┤ ├─────────┤ ├─────────┤  │──► Redis
   3rd-party (OAuth) ────►│  │ memories │ │ models  │ │ billing │  │──► Turbopuffer (vectors)
                          │  ├──────────┤ ├─────────┤ ├─────────┤  │──► Stripe
                          │  │  auth    │ │dashboard│ │  admin  │  │──► SendGrid
                          │  └──────────┘ └─────────┘ └─────────┘  │──► 50+ LLM providers
                          │  middleware: IP blocking → CORS → CSRF │
                          └────────────────────────────────────────┘
```

## 1. Assistants (`app/.../assistants.py`)

| Method | Path | Purpose | Src |
|---|---|---|---|
| POST | `/assistants` | create assistant | :42 |
| GET | `/assistants` | list | :60 |
| GET | `/assistants/{id}` | get | :78 |
| PUT | `/assistants/{id}` | update | :98 |
| DELETE | `/assistants/{id}` | delete | :170 |
| POST | `/assistants/{id}/threads` | create thread | :127 |
| GET | `/assistants/{id}/threads` | list threads | :237 |
| POST | `/assistants/{id}/documents` | upload document | :199 |
| GET | `/assistants/{id}/documents` | list documents | :269 |

Body: `{name, system_prompt, llm_provider, model_name, tools, embedding_provider, embedding_model_name}`.

## 2. Threads & messages (`threads.py`) — the core conversation engine

| Method | Path | Purpose | Src |
|---|---|---|---|
| POST | `/threads` | create thread | :802 |
| GET | `/threads` | list | :679 |
| GET | `/threads/{id}` | get with messages | :712 |
| DELETE | `/threads/{id}` | delete | :2019 |
| GET | `/threads/{id}/messages` | list messages | :1691 |
| POST | `/threads/{id}/messages` | **add message** (form-data; `stream=true` → SSE) | :1506 |
| POST | `/threads/{id}/messages/stream` | stream response | :1731 |
| POST | `/threads/{id}/runs/{run_id}/submit-tool-outputs` | **continue after tool calls** (`stream=true` supported) | :1803 |
| GET | `/threads/{id}/documents` | list thread documents | :775 |
| GET | `/threads/{id}/context-usage` | context window usage | chat.py:311 |

Message form fields: `content, llm_provider, model_name, stream, memory (Auto|Readonly|off),
web_search (Auto|off), send_to_llm, metadata, files[]`.

**This pair — add-message + submit-tool-outputs, both streaming — is the agentic loop the IDE
drives through the Rust bridge (doc 04).**

## 3. Documents / RAG (`documents.py`)

| Method | Path | Purpose | Src |
|---|---|---|---|
| POST | `/threads/{id}/documents` | upload to thread | :374 |
| GET | `/documents/{id}/status` | processing status | :506 |
| DELETE | `/documents/{id}` | delete | :249 |

Status flow: `processing → completed | error`; chunked + vector-indexed (Turbopuffer) for RAG.
Accepts docs, text/data, code files, and images.

## 4. Memories (`memories.py`) — semantic memory per assistant

| Method | Path | Purpose | Src |
|---|---|---|---|
| GET | `/assistants/{id}/memories` | list | :48 |
| POST | `/assistants/{id}/memories` | add `{fact, category, importance, expires_at}` | :112 |
| GET | `/assistants/{id}/memories/{mid}` | get | :178 |
| PUT / DELETE | `/assistants/{id}/memories/{mid}` | update / delete | :409 / :306 |
| DELETE | `/assistants/{id}/memories` | delete all | :346 |
| GET | `/assistants/{id}/memories/stats` | stats | :248 |
| POST | `/assistants/{id}/memories/search` | semantic search | chat.py:1050 |
| GET | `/assistants/memories/operations/{op_id}` | async op status | :484 |

## 5. Models & providers (`models.py`)

| Method | Path | Purpose | Src |
|---|---|---|---|
| GET | `/models` | list (filters: type, provider, supports_tools/vision/thinking/…) | :52 |
| GET | `/models/providers` | list providers | :144 |
| GET | `/models/provider/{name}` | models for provider | :166 |
| GET | `/models/{name}` | one model (pricing + capabilities) | :200 |
| GET | `/models/embedding/all` / `/providers` / `/{name}` | embedding catalog | :229/:260/:282 |

## 6. Billing & credits (`billing.py`)

Wallet/ledger: `GET /billing/balance` (:193), `GET /billing/history` (:268),
`POST /billing/promo-codes/redeem` (:230), `GET /billing/invoices` (:647).

Usage: `GET /billing/usage/recent` (:725), `/usage/insights` (:830), `/usage/summary` (:991),
`/tokens/availability` (:1138).

Catalog/purchase: `/billing/models/catalog` (:1315), `/models/popular` (:1347),
`/tokens/catalog` (:1400), `POST /billing/subscribe` (:1520), `POST /billing/credits/checkout`
(:1636), `POST /billing/preview` (:1676 — cost estimate **without** running the message).

Subscription mgmt: `/billing/status`, `/cancel`, `/renew`, `/change-plan`, `/upgrade`,
`/cancel-downgrade`, `/payment-method`, `/update-payment-method`, `POST /billing/auto-reload`.
Stripe webhook: `POST /billing/webhooks/stripe` (:2954).

## 7. Auth (`auth.py`)

- Email magic link: `POST /auth/signup` (:43, Turnstile CAPTCHA), `POST /auth/signin` (:121),
  `GET /auth/verify-email` (:156), `GET|POST /auth/verify` (:224/:234), `POST /auth/signout` (:261)
- Session/profile: `GET /auth/status` (:281), `GET /auth/me` (:429), `PATCH /auth/profile` (:434),
  `GET /auth/preferences` (:401), `POST /auth/preferences/welcome-seen` (:410)
- Google: `GET /auth/google/client-id` (:479), `POST /auth/google/verify` (:499)
- Okta/SSO: `GET /auth/sso/check` (:550), `/auth/okta/client-id|initiate|callback` (:569/:580/:653),
  `PATCH /auth/admin/clients/{id}/sso` (:789)

## 8. OAuth provider — "Login with Backboard" (`oauth.py`, `developers.py`)

- App management: `GET|POST /developers/apps` (:30/:51), `GET|PATCH|DELETE /developers/apps/{id}`,
  `POST /developers/apps/{id}/rotate-secret` (:144)
- OIDC flows: `GET /oauth/authorize` (:144), `POST /oauth/token` (:680), `POST /oauth/revoke`
  (:789), `GET /oauth/userinfo` (:835), approve/deny (:580/:630)
- **IDE callback**: `GET /oauth/ide/callback` (:569) — custom redirect target for IDE sign-in
- Discovery: `GET /.well-known/openid-configuration` (main.py:394), `GET /.well-known/jwks.json` (:398)

## 9. CLI & IDE infrastructure (`cli_installer.py`, `releases.py`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/cli` `/cli/windows` `/cli/cmd` | install scripts (bash/ps1/bat) |
| GET | `/cli/version` `/cli/code-status` `/cli/download` | version + binary download |
| POST | `/cli/analytics` | usage telemetry |
| POST/GET/DELETE | `/cli/invite-codes[/{code}]` | invite code mgmt |
| GET | `/releases/{channel}/latest` | latest IDE release (channels: stable/preview/nightly) |
| GET | `/releases/{channel}/{version}[/asset]` | release info / download |
| GET | `/release_notes/v2/{channel}/{version}` | release notes |

## 10. Others

- **API keys** (`api_keys.py`): create/list/deactivate/delete keys (`/api-keys…`), plus
  user-supplied **provider keys** (`/api-keys/provider-keys…`) for BYO OpenAI/Anthropic keys.
- **Chat router** (`chat.py`): session-cookie twin of assistants/threads for the web dashboard
  (`/chat/assistants`, `/chat/threads`, `/chat/threads/{id}/messages[/stream]`, `/chat/models`,
  `/chat/overview`, `/chat/initialize`, `/chat/sync`).
- **Dashboard** (`dashboard.py`): metrics, analytics, admin user management — session-auth only,
  hidden from the public OpenAPI schema.
- **Admin** (`admin.py`): IP blocks (`/admin/ip-blocks…`), promo codes (`/admin/promo-codes…`).
- **Referral** (`referral.py`), **Hackathon** (`hackathon_submissions.py`), **Feedback**.

## What the IDE actually calls

```
   IDE turn lifecycle           Backend endpoint
   ──────────────────           ─────────────────────────────────────────────
   create/list assistants   →   POST/GET /assistants
   start conversation       →   POST /assistants/{id}/threads
   send user message        →   POST /threads/{id}/messages?stream=true   (SSE)
   agent requests tools     ←   SSE chunks containing tool_calls
   run tools locally (IDE)      …
   submit results           →   POST /threads/{id}/runs/{rid}/submit-tool-outputs?stream=true
   … loop until done        ←   SSE: content/reasoning/usage/done
   upload attachment/doc    →   POST /assistants/{id}/documents
   model picker             →   GET /models, GET /models/providers
   usage footer             →   GET /billing/usage/recent
```

The Rust client mirror of these endpoints lives in
`ide/zed/crates/backboard/src/endpoints/{assistants,threads,documents,memories,models,billing,tools}.rs`
with config in `backboard.rs` (env `BACKBOARD_API_KEY`, `BACKBOARD_API_URL`; config file
`~/.backboard/config.json`).
