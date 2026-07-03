# Backboard Backend — Endpoint Catalog

The backend is a **FastAPI** app (`main.py` + `app/` at the repo root of `Espri-API`) with
`root_path="/api"` (`main.py:128`), so every path below is served under
`https://app.backboard.io/api`. Default Swagger/ReDoc/`openapi.json` are disabled; docs are a
filtered Scalar page at `/docs` (`main.py:698`).

```
Base URLs
  prod   https://app.backboard.io/api
  dev    https://dev.app.backboard.io/api
  local  http://localhost:8000
Data stores
  MySQL / AWS RDS   (SQLAlchemy; PyMySQL/aiomysql; app/core/database.py:34)
  Redis             (api-key cache, IP-block cache, billing accumulator)
  Turbopuffer       (vector store: RAG documents AND assistant memories)
Auth
  X-API-Key header (IDE / CLI / SDK)     session token cookie `bb_session` (web dashboard)
  OAuth2 + PKCE access tokens ("Login with Backboard")
```

```
                          ┌────────────────────────────────────────┐
   IDE (Rust bridge) ────►│              FastAPI app               │
   Zed extension     ────►│  ┌──────────┐ ┌─────────┐ ┌─────────┐  │──► MySQL/RDS
   CLI               ────►│  │assistants│ │ threads │ │documents│  │──► Redis
   Web dashboard     ────►│  ├──────────┤ ├─────────┤ ├─────────┤  │──► Turbopuffer
   3rd-party (OAuth) ────►│  │ memories │ │ models  │ │ billing │  │──► Stripe
                          │  ├──────────┤ ├─────────┤ ├─────────┤  │──► Resend (email)
                          │  │  auth    │ │ oauth   │ │  admin  │  │──► LangChain/LangGraph
                          │  └──────────┘ └─────────┘ └─────────┘  │──► 50+ LLM providers
                          │  middleware: IPBlock → CORS → timing   │──► S3 / Bedrock (boto3)
                          └────────────────────────────────────────┘
```

## Routers & prefixes (`main.py:273-411`)

| Router | Prefix | Auth model |
|---|---|---|
| `threads.py` | `/threads` | **dual** (X-API-Key or session) — the IDE's main path |
| `assistants.py` | `/assistants` | dual |
| `documents.py` | *(none)* | dual |
| `memories.py` | `/assistants` | dual |
| `models.py` | `/models` | dual |
| `billing.py` | `/billing` | session / dual / public / Stripe-sig |
| `auth.py` | `/auth` | public / session-token |
| `oauth.py` | `/oauth` | OAuth2/OIDC provider |
| `developers.py` | `/developers` | session |
| `api_keys.py` | `/api-keys` | session / internal |
| `chat.py` | `/chat` | **session-token** (web-dashboard twin) |
| `cli_installer.py` | `/cli` | public / admin |
| `releases.py` | *(none)* | public |
| `dashboard.py` | `/dashboard` | X-API-Key + superadmin |
| `admin.py` | `/admin` | X-API-Key + superadmin |
| `voice_ws.py` | `/threads` | WebSocket |
| `feedback.py` / `referral.py` / `hackathon_submissions.py` | various | mixed |

App-root (no prefix): `GET /.well-known/openid-configuration` (`main.py:394`),
`GET /.well-known/jwks.json` (`:398`), `GET /docs` Scalar (`:698`), `GET /openapi-custom.json`
(`:417`).

**Auth mechanisms** (`app/core/dependencies.py`): `X-API-Key` via `APIKeyHeader` (`:41`,
Redis-cached `:43`); opaque **session token** via `Authorization: Bearer` / `X-Session-Token` /
cookie `bb_session` (httponly, 30-day, `auth.py:173`); the dual dependency
`get_current_user_with_db_dual` (`:172`) tries API key first, falls back to session/OAuth token.

## 1. Threads — the conversation engine (`threads.py`, `/threads`)

| Method | Path | Function | Line |
|---|---|---|---|
| GET | `/threads` | `list_threads` | :679 |
| GET | `/threads/{id}` | `get_thread` (thread + messages) | :712 |
| GET | `/threads/{id}/documents` | `list_thread_documents` | :775 |
| POST | `/threads/{id}/messages` | **`add_message_to_thread`** — JSON or multipart; `stream=true`→SSE | :802 |
| POST | `/threads/{id}/runs/{run_id}/submit-tool-outputs` | **`submit_tool_outputs_for_run`** — `?stream=true`→SSE | :1506 |
| POST | `/threads/{id}/runs/{run_id}/cancel` | `cancel_run` (streams poll & bail) | :1691 |
| POST | `/threads/tool-outputs` | `submit_tool_outputs_simple` (resolves run_id from latest REQUIRES_ACTION) | :1731 |
| POST | `/threads/messages` | `send_message_stateless` (auto-creates assistant+thread) | :1803 |
| DELETE | `/threads/{id}` | `delete_thread` | :2019 |

> **Corrections vs. the older draft:** `add_message_to_thread` is at **`:802`** (not `:1506` —
> that's submit-tool-outputs). There is **no** `POST /threads` create endpoint here (commented,
> `:650`) — thread creation is `POST /assistants/{id}/threads`, `POST /chat/threads`, or implicit in
> `send_message_stateless`. There is **no context-usage endpoint** — `context_usage` is a computed
> field embedded in responses and the `run_ended` SSE event.

### Add-message input (`MessageInput`, `threads.py:402-430`)

JSON or multipart, dispatched by `parse_message_input` on Content-Type (`:625`). Fields & defaults:

```python
content: Optional[str] = None
llm_provider: Optional[str] = None            # default openai downstream
model_name: Optional[str] = None              # default gpt-4o downstream
image_generation: str = "off"                 # "auto" needs image_model_provider + name
stream: bool = False
thinking: Any = None                          # {"effort":"high"} | {"budget_tokens":8192} | {}
memory: str = "off"                           # "Auto" | "Readonly" | "off"
memory_pro: Optional[str] = None              # "Auto" | "Readonly"; mutually exclusive w/ memory
web_search: str = "off"                       # "Auto" | "off"
send_to_llm: str = "true"
json_output: bool = False
metadata: Optional[str] = None                # JSON string
files: List[UploadFile] = []                  # multipart only; 400 if sent as JSON
audio_file: Optional[UploadFile] = None       # STT
voice: Optional[Any] = None                   # {stt:{...}, tts:{...}}
tools: Optional[List[Any]] = None             # per-run OpenAI-style tool override
system_prompt: Optional[str] = None           # per-run override
```

### submit-tool-outputs body (`SubmitToolOutputsRequest`, `app/schemas/message.py:221`)

```python
tool_outputs: List[ToolOutput]         # ToolOutput = {tool_call_id: str, output: str}
tools: Optional[List[Dict]] = None     # per-run tool override (add/remove MCP tools mid-thread)
# stream: bool via ?stream=true query param
```

**This pair — add-message + submit-tool-outputs, both streaming — is the agentic loop the IDE
drives through the Rust bridge** (docs 04 and 09).

## 2. Assistants (`assistants.py`, `/assistants`, dual)

POST create (`:42`), GET list (`:60`), GET `/{id}` (`:78`), PUT update (`:98`), POST `/{id}/clone`
(`:127`), DELETE (`:170`), POST `/{id}/threads` **create-thread** (`:199`), GET `/{id}/threads`
(`:237`), GET `/{id}/documents` (`:269`), POST `/{id}/documents` upload (`:292`).
Body: `{name, system_prompt, llm_provider, model_name, tools, embedding_provider, embedding_model_name}`.

## 3. Documents / RAG (`documents.py`, dual)

DELETE `/documents/{id}` (`:249`), POST `/threads/{id}/documents` upload (`:374`), GET
`/documents/{id}/status` (`:506`). Upload field is `file: UploadFile`; a row is created
`status=PENDING`, then the **RAG pipeline runs as a `BackgroundTask` → `process_document`**
(`document_processor.py`): LangChain `RecursiveCharacterTextSplitter` (adaptive chunking) + Gemini
Vision (`gemini-2.0-flash`) for embedded images → upsert into **Turbopuffer** namespaced by
`assistant_id` (optional `thread_id` filter). Status flow: `PENDING → processing → completed | error`.

## 4. Memories (`memories.py`, `/assistants`, dual)

GET list (`:48`), POST add (`:112`), GET insights (`:178`), GET `/{mid}` (`:248`), DELETE all
(`:306`), DELETE one (`:346`), PUT (`:409`), GET stats (`:484`), GET `/memories/operations/{op_id}`
(`:536`), POST `/{id}/memories/search` semantic (`:581`). Backed by `memory_service` over
**Turbopuffer** plus relational `MemoryTracking`/`MemoryOperation` tables.

## 5. Models & providers (`models.py`, `/models`, dual)

`GET /models` (`:52`) → `ModelsListResponse {models, total}` — **the IDE model picker**, with
pricing, `context_limit`, `supports_tools/vision/thinking`, `thinking_controls`, `api_mode`. Plus
`GET /models/providers` (`:144`), `/provider/{name}` (`:166`), `/{name}` (`:200`), and image/embedding
variants.

## 6. Billing & credits (`billing.py`, `/billing`)

- **`GET /billing/balance` (`:193`, session)** → `CreditWallet {balance_usd, auto_reload_*}` — the
  IDE-polled credits endpoint.
- Usage: `/usage/recent` (`:725`), `/usage/insights` (`:830`), `/usage/summary` (`:991`).
- Catalog/purchase: `/models/catalog` (`:1315`, public), `/tokens/catalog` (`:1400`, public),
  `POST /subscribe` (`:1520`), `POST /credits/checkout` (`:1636`), **`POST /preview` (`:1676`)** —
  cost estimate *without* running the message.
- Subscription mgmt: `/status`, `/cancel`, `/renew`, `/change-plan` (`:2395`), `/upgrade` (`:2739`),
  `/auto-reload`. **Stripe webhook** `POST /billing/webhooks/stripe` (`:2954`, signature-verified via
  `stripe.Webhook.construct_event`).

## 7. Auth (`auth.py`, `/auth`)

- Email magic link: `POST /signup` (`:43`, Turnstile CAPTCHA), `POST /signin` (`:121`), `GET
  /verify-email` (`:156`, sets `bb_session`), `GET|POST /verify` (`:224`/`:234`), `POST /signout`
  (`:261`).
- Session/profile: `GET /status` (`:281`), `/me` (`:429`), `PATCH /profile` (`:434`), `/preferences`
  (`:401`).
- Google: `GET /google/client-id` (`:479`), `POST /google/verify` (`:499`).
- Okta/SSO: `GET /sso/check` (`:550`), `/okta/initiate` (`:580`), `/okta/callback` (`:653`).

## 8. OAuth provider — "Login with Backboard" (`oauth.py`, `/oauth` + `developers.py`)

OIDC provider, RS256. `GET /app-info` (`:149`), `GET /authorize` (`:196`, → consent SPA), **`GET
/oauth/ide/callback` (`:246`)** — deep-links `code`/`state` into
`code-oss://backboard.backboard/auth/callback` (`IDE_OAUTH_CALLBACK_URI`, `:75`); `POST
/authorize/approve` (`:292`, mints code), `POST /authorize/deny` (`:374`); **`POST /token` (`:406`)** —
`authorization_code`+PKCE (`code_verifier`) or `refresh_token`. The token response adds Backboard
extras `assistant_id, backboard_api_key, personal_api_key, selected_client_name` alongside the
standard `access_token/refresh_token/id_token`. Also `POST /revoke` (`:604`), `GET /userinfo` (`:634`).
Discovery at app-root `/.well-known/openid-configuration` + `/jwks.json`.

`developers.py` (`/developers`, session): GET/POST `/apps` (`:30`/`:51`), GET/PATCH/DELETE
`/apps/{id}`, `POST /apps/{id}/rotate-secret` (`:144`).

## 9. CLI & IDE infrastructure (`cli_installer.py`, `releases.py`)

`GET /cli` bash (`:2318`), `/cli/windows` PS (`:2346`), `/cli/cmd` (`:2384`), `GET /cli/version`
update check (`:2417`), `/cli/code-status` (`:2446`), `GET /cli/download` (`:2476`), `POST
/cli/analytics` (`:2537`); admin invite codes (`:2573`+). Releases (public): `GET
/releases/{channel}/{version}/asset` (`:17`, `?os&arch&asset=bbide`), `/releases/{channel}/latest`
(`:39`), `/release_notes/v2/{channel}/{version}` (`:78`). Channels: stable/preview/nightly.

## 10. API keys & the web-dashboard twin

- **API keys** (`api_keys.py`, `/api-keys`): Backboard keys `POST /user` (`:55`), `POST /` (`:123`,
  internal), GET (`:175`), deactivate (`:201`), delete (`:231`). **BYO provider keys** `GET
  /provider-keys` (`:263`), `POST /provider-keys` (`:283`, `{provider, api_key}`), DELETE (`:335`) —
  when set, that provider's tokens aren't billed to the user.
- **Chat router** (`chat.py`, `/chat`, **session-token** only): the web-dashboard twin of
  threads/assistants/memories, incl. streaming `POST /chat/threads/{id}/messages/stream` (`:612`).
- **Dashboard** (`dashboard.py`): ~40 analytics/user/org endpoints, X-API-Key + superadmin.
- **Admin** (`admin.py`): IP blocks `POST/GET/DELETE /admin/ip-blocks` (`:35`/`:63`/`:133`) + promo
  codes; `require_superadmin` (`:25`).

## Middleware chain (`main.py`)

Starlette applies middleware in reverse-add order, so the **first-added runs outermost**:

```
   Incoming HTTP request
          ▼
 ┌────────────────────────────────────────────┐
 │ IPBlockMiddleware        (main.py:232)       │  OUTERMOST. X-Forwarded-For[0];
 │  Redis + in-proc TTL cache; fail-closed 403  │  403 IP_BLOCKED if listed
 └────────────────────────────────────────────┘
          ▼
 ┌────────────────────────────────────────────┐
 │ CORSMiddleware           (main.py:235)       │  allow_origins=["*"],
 │  allow_credentials=False, methods/hdrs=["*"] │  credential-less public API
 └────────────────────────────────────────────┘
          ▼
 ┌────────────────────────────────────────────┐
 │ request_timing_middleware (main.py:246)      │  opt-in perf log
 └────────────────────────────────────────────┘
          ▼
   Router endpoint → per-endpoint Depends() auth (X-API-Key / session / OAuth / superadmin)
          ▼
   Exception handlers: 5xx sanitized to generic message (main.py:135), catch-all 500 (:154)
```

> **There is no CSRF middleware** — the API is stateless and CORS runs credential-less; the
> dashboard is same-origin. IP is trusted from the leftmost `X-Forwarded-For` entry (the proxy must
> overwrite it).

## What the IDE actually calls

```
   IDE turn lifecycle           Backend endpoint
   ──────────────────           ─────────────────────────────────────────────
   create/list assistants   →   POST/GET /assistants
   start conversation       →   POST /assistants/{id}/threads   (or stateless auto-create)
   send user message        →   POST /threads/{id}/messages?stream=true          (SSE)
   agent requests tools     ←   SSE: tool_submit_required {run_id, tool_calls}
   run tools locally (IDE)      …
   submit results           →   POST /threads/{id}/runs/{run_id}/submit-tool-outputs?stream=true
   … loop until done        ←   SSE: content_streaming / reasoning_* / run_ended (usage inline)
   upload attachment/doc    →   POST /assistants|threads/{id}/documents
   model picker             →   GET /models
   credits footer           →   GET /billing/balance
```

The Rust client mirror lives in
`ide/zed/crates/backboard/src/endpoints/{threads,tools,assistants,documents,memories,models,billing,stream}.rs`
with config in `config.rs` (env `BACKBOARD_API_KEY`, `BACKBOARD_API_URL`; config file
`~/.backboard_ide/config.json`). See [04](04-rust-typescript-bridge.md) and
[09](09-streaming-sse-protocol.md).
