# Backboard Credential And API Key Storage

This document explains where the Backboard API key is stored, how SSO writes it,
how manual API-key entry writes it, and how the TypeScript and Rust layers read
credentials.

Primary files:

- Isolated SSO code:
  `source-copies/typescript/extensions-backboard/sso/extension.sso.ts`
- Full extension host:
  `source-copies/typescript/extensions-backboard/src/extension.ts`
- Modular Rust config:
  `source-copies/rust/backboard/src/endpoints/config.rs`
- Larger Rust client/config:
  `source-copies/rust/backboard/src/backboard.rs`

## Storage Location

Backboard credentials are stored on disk at:

```text
~/.backboard_ide/config.json
```

In absolute form on this machine, that resolves to:

```text
/Users/erintomorri/.backboard_ide/config.json
```

The reference docs and copied source are in the repo, but the live credential
file is in the user's home directory. It is intentionally outside the workspace.

## What Gets Stored

The config file can contain:

```json
{
  "env": "prod",
  "api_key": "current-or-last-used-api-key",
  "api_url": "optional custom API URL",
  "env_keys": {
    "prod": "prod-api-key",
    "dev": "dev-api-key",
    "local": "local-api-key"
  },
  "oauth": {
    "access_token": "oauth-access-token",
    "refresh_token": "optional-refresh-token",
    "token_type": "Bearer",
    "expires_in": 3600,
    "scope": "openid email profile",
    "id_token": "optional-id-token",
    "assistant_id": "optional-assistant-id",
    "api_key": "direct-api-key-from-token-response",
    "backboard_api_key": "backboard-api-key-from-token-response",
    "personal_api_key": "personal-api-key-from-token-response",
    "selected_client_name": "optional-client-name",
    "obtained_at": "2026-06-17T00:00:00.000Z"
  }
}
```

Not every field is always present. The smallest useful API-key config is:

```json
{
  "env": "prod",
  "api_key": "bb-key",
  "env_keys": {
    "prod": "bb-key"
  }
}
```

The smallest useful OAuth-only config is:

```json
{
  "env": "prod",
  "oauth": {
    "access_token": "oauth-access-token",
    "obtained_at": "2026-06-17T00:00:00.000Z"
  }
}
```

For most normal SSO completions, the token response includes an API key or
personal key, so the extension saves both the OAuth block and top-level API key
fields.

## Who Writes The File

### SSO Flow

SSO writes credentials through:

```ts
saveBackboardOAuthTokens(tokens)
```

That function:

1. Requires `tokens.access_token`.
2. Chooses a usable API key from the token response.
3. Reads the existing config file.
4. Determines the active Backboard environment.
5. Saves the chosen API key into `api_key` and `env_keys[env]`.
6. Saves OAuth metadata under `oauth`.
7. Writes the config atomically.
8. Updates the VS Code auth context.

SSO API-key selection precedence:

1. `tokens.api_key`
2. `tokens.apiKey`
3. `tokens.backboard_api_key`
4. `tokens.personal_api_key`

Code shape:

```ts
const directApiKey = stringValueFromRecord(tokens.api_key) ?? stringValueFromRecord(tokens.apiKey);
const backboardApiKey = stringValueFromRecord(tokens.backboard_api_key);
const personalApiKey = stringValueFromRecord(tokens.personal_api_key);
const usableApiKey = directApiKey ?? backboardApiKey ?? personalApiKey;
```

If `usableApiKey` exists, the extension writes:

```json
{
  "api_key": "<usableApiKey>",
  "env_keys": {
    "<env>": "<usableApiKey>"
  }
}
```

It also keeps the source fields in the `oauth` block:

```json
{
  "oauth": {
    "api_key": "<directApiKey>",
    "backboard_api_key": "<backboardApiKey>",
    "personal_api_key": "<personalApiKey>"
  }
}
```

### Manual API Key Flow

Manual entry writes credentials through:

```ts
saveBackboardConfigApiKey(apiKey)
```

That function:

1. Reads existing config.
2. Determines the current environment.
3. Writes the key to top-level `api_key`.
4. Writes the same key to `env_keys[env]`.
5. Preserves unrelated config fields.

Example result:

```json
{
  "env": "prod",
  "api_key": "manual-key",
  "env_keys": {
    "prod": "manual-key"
  }
}
```

Manual clearing uses:

```ts
clearBackboardConfigApiKey()
```

That removes:

- top-level `api_key`
- `env_keys[env]`

It does not necessarily delete the `oauth` block.

### Rust Config Helpers

The modular Rust config also has:

```rust
BackboardConfig::save_api_key_for_current_env(api_key)
BackboardConfig::clear_api_key_for_current_env()
```

Those write to the same path:

```text
~/.backboard_ide/config.json
```

The larger `backboard.rs` client also includes `save_api_key_for_env`, which can
save a key for a specific environment and adjust `env`/`api_url` accordingly.

## File Permissions And Write Style

TypeScript write path:

```ts
writeBackboardConfigJson(config)
```

Behavior:

1. Creates `~/.backboard_ide`.
2. Writes to a temp file in that directory.
3. Uses file mode `0600` for the temp write.
4. Renames the temp file to `config.json`.
5. On non-Windows, chmods final `config.json` to `0600`.
6. Calls `updateBackboardAuthContext()`.

Rust modular config write path:

```rust
BackboardConfig::save()
```

Behavior:

1. Creates the config directory.
2. Writes pretty JSON.
3. On Unix, chmods `config.json` to `0600`.

The larger `backboard.rs` client writes atomically and also writes a backup in
its config helper path.

## Environment Scoping

The current environment is stored as:

```json
{
  "env": "prod"
}
```

Environment keys are stored as:

```json
{
  "env_keys": {
    "prod": "prod-key",
    "dev": "dev-key",
    "local": "local-key"
  }
}
```

TypeScript normalization:

| Input | Normalized |
| --- | --- |
| missing / empty | `prod` |
| `production` | `prod` |
| `development` | `dev` |
| anything else | lowercased trimmed value |

The current TypeScript save path writes the selected key to both:

- top-level `api_key`
- `env_keys[env]`

The top-level key acts as the first credential read by the simpler Rust config.
`env_keys` preserves per-environment keys.

## Credential Read Precedence

There are two Rust config implementations in the copied reference.

### Modular `endpoints/config.rs`

The modular config reads API keys in this order:

1. Top-level `api_key`
2. `env_keys[env]`
3. Environment variable `BACKBOARD_API_KEY`

If no key is found, `BackboardClient::from_config` returns missing API-key
errors.

This path only supports API-key auth:

```text
X-API-Key: <api key>
```

### Larger `backboard.rs`

The larger client reads auth in this order:

1. Top-level `api_key`
2. `env_keys[env]`
3. `oauth.access_token`

It represents that as:

```rust
enum BackboardAuth {
    ApiKey(String),
    OAuthAccessToken(String),
}
```

Header behavior:

| Auth source | Header |
| --- | --- |
| API key | `X-API-Key: <api key>` |
| OAuth access token | `Authorization: Bearer <access token>` |

Important distinction:

- API key is preferred over OAuth access token.
- OAuth access token is fallback auth only in the larger client path.
- The modular endpoint client has an environment-variable fallback, but the
  larger client snippet shown here does not use `BACKBOARD_API_KEY` in the same
  `api_key()` method.

## TypeScript Credential Reads

TypeScript checks credentials with:

```ts
hasBackboardCredentials()
```

That returns true if either exists:

- `backboardConfigApiKey(config)`
- `backboardConfigAccessToken(config)`

`backboardConfigApiKey(config)` reads:

1. top-level `api_key`
2. `env_keys[normalized env]`

`backboardConfigAccessToken(config)` reads:

```json
{
  "oauth": {
    "access_token": "..."
  }
}
```

TypeScript also passes the saved OAuth access token to the bridge request config:

```ts
{
  "config": {
    "env": "prod",
    "apiUrl": "optional override",
    "accessToken": "oauth access token if configured"
  }
}
```

The actual Rust handling of that access token depends on which bridge/client
path is active.

## API Key In Requests

When API-key auth is active, Rust sends:

```text
X-API-Key: <api key>
```

When OAuth access-token auth is active in the larger client, Rust sends:

```text
Authorization: Bearer <access token>
```

Realtime voice URL generation uses the API key as a query parameter:

```text
wss://app.backboard.io/api/threads/messages?api_key=<urlencoded api key>
```

If only OAuth access token auth exists, `BackboardAuth::api_key()` returns none,
so realtime URL generation needs an API key to produce a usable `api_key`
parameter.

## Config Watcher And UI State

The extension watches:

```text
~/.backboard_ide/config.json
```

On create/change/delete, it:

1. Updates `backboard.authenticated`.
2. Refreshes the Backboard panel state.

The context key is set by:

```ts
updateBackboardAuthContext()
```

This controls whether sign-in actions are shown in the Backboard UI.

## Bridge Restart After Credential Change

After SSO saves tokens:

```ts
bridge.restart()
```

After manual API-key save, the command caller also restarts the bridge.

Reason:

- The Rust bridge/client may have read credentials already.
- Restarting kills stale bridge process state.
- The next request starts a new bridge process and reloads config.

## Credential Examples

### SSO With API Key Returned

```json
{
  "env": "prod",
  "api_key": "bb-prod-key",
  "env_keys": {
    "prod": "bb-prod-key"
  },
  "oauth": {
    "access_token": "oauth-access-token",
    "refresh_token": "refresh-token",
    "token_type": "Bearer",
    "expires_in": 3600,
    "scope": "openid email profile",
    "id_token": "id-token",
    "assistant_id": "asst_123",
    "api_key": "bb-prod-key",
    "obtained_at": "2026-06-17T00:00:00.000Z"
  }
}
```

### SSO With Personal API Key Returned

```json
{
  "env": "prod",
  "api_key": "personal-key",
  "env_keys": {
    "prod": "personal-key"
  },
  "oauth": {
    "access_token": "oauth-access-token",
    "personal_api_key": "personal-key",
    "obtained_at": "2026-06-17T00:00:00.000Z"
  }
}
```

### OAuth Access Token Only

```json
{
  "env": "prod",
  "oauth": {
    "access_token": "oauth-access-token",
    "obtained_at": "2026-06-17T00:00:00.000Z"
  }
}
```

This may satisfy TypeScript's `backboard.authenticated` context. Whether API
calls work depends on whether the active Rust client path supports bearer auth.

### Multiple Environment Keys

```json
{
  "env": "dev",
  "api_key": "dev-key",
  "env_keys": {
    "prod": "prod-key",
    "dev": "dev-key",
    "local": "local-key"
  }
}
```

The key for the active `env` is stored under `env_keys[env]`. The top-level
`api_key` usually mirrors the most recently saved/current key.

### Environment Variable Fallback

For the modular Rust config:

```bash
export BACKBOARD_API_KEY=bb-env-key
```

If `api_key` and `env_keys[env]` are absent, that environment variable can be
used as a fallback.

## Security Notes

- `~/.backboard_ide/config.json` contains secrets.
- On macOS/Linux, the extension and Rust helper set file permissions to `0600`.
- The file is not stored in the OS keychain.
- SSO may save refresh tokens, access tokens, ID tokens, and API keys.
- The extension redacts sensitive keys in some logged request payloads, but the
  config file itself is plaintext JSON.
- Do not commit `~/.backboard_ide/config.json`.

## Troubleshooting

### API says missing key

Check:

```text
~/.backboard_ide/config.json
```

Look for either:

```json
{
  "api_key": "..."
}
```

or:

```json
{
  "env": "prod",
  "env_keys": {
    "prod": "..."
  }
}
```

For the modular client, also check:

```bash
echo "$BACKBOARD_API_KEY"
```

### SSO says complete but requests fail

Check:

- Did the token response include `api_key`, `apiKey`, `backboard_api_key`, or
  `personal_api_key`?
- Does config contain top-level `api_key`?
- Does `env` match the `env_keys` entry?
- Was the bridge restarted after save?
- Is the active Rust client path using API-key auth or bearer-token auth?

### Wrong environment key is used

Check:

```json
{
  "env": "prod",
  "env_keys": {
    "prod": "prod-key",
    "dev": "dev-key"
  }
}
```

Then check VS Code setting:

```text
backboard.env
```

The extension normalizes `production` to `prod` and `development` to `dev`.

### Need to reset credentials

Options:

- Use the manual API-key flow and submit an empty value to clear current env key.
- Edit `~/.backboard_ide/config.json` directly.
- Remove the file and restart/sign in again.

After editing manually, the file watcher should update UI auth state. Restarting
the bridge or window can clear stale runtime state if needed.

## Relevant Search Strings

```text
backboardConfigPath
BackboardConfig
api_key
env_keys
oauth
access_token
saveBackboardOAuthTokens
saveBackboardConfigApiKey
clearBackboardConfigApiKey
writeBackboardConfigJson
backboardConfigApiKey
backboardConfigAccessToken
configuredBackboardAccessToken
hasBackboardCredentials
updateBackboardAuthContext
BackboardAuth
OAuthAccessToken
api_key_header
X-API-Key
BACKBOARD_API_KEY
```
