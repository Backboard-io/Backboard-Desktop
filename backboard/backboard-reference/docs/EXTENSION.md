# Backboard VS Code Extension Reference

This document explains the Backboard extension layer itself: what VS Code
loads, what commands/views/settings it contributes, how the webview works, how
it starts the Rust bridge, and how it connects UI actions to Backboard runtime
requests.

Primary copied files:

```text
source-copies/typescript/extensions-backboard/package.json
source-copies/typescript/extensions-backboard/src/extension.ts
source-copies/typescript/extensions-backboard/sso/extension.sso.ts
source-copies/typescript/extensions-backboard/sso/package.json
```

The full extension implementation is in `src/extension.ts`. The `sso` folder is
an extracted reference copy of the auth-related parts only.

## What This Extension Is

The `extensions/backboard` extension is a VS Code extension packaged into
Backboard Studio. It provides:

- A Backboard chat webview in the secondary sidebar.
- Commands for opening Backboard, starting chats, showing history, signing in,
  refreshing models, and checking updates.
- Settings for Backboard environment, model, mode, reasoning intensity, memory,
  web search, image generation, voice, MCP toggles, OAuth redirect URI, and
  custom API URL.
- OAuth/SSO and legacy API-key setup.
- A TypeScript host adapter that spawns the Rust `backboard-bridge` binary.
- A JSON-line bridge protocol between TypeScript and Rust.
- Local execution for most IDE/workspace tools requested by the model.
- Panel state persistence under `~/.backboard_ide`.

## Package Manifest

Manifest copy:

```text
source-copies/typescript/extensions-backboard/package.json
```

Important manifest fields:

| Field | Meaning |
| --- | --- |
| `name` | Extension id/name: `backboard`. |
| `displayName` | UI display name: `Backboard`. |
| `main` | Compiled extension entry: `./out/extension`. |
| `extensionKind` | Runs as both `workspace` and `ui` extension where supported. |
| `categories` | `AI`. |
| `capabilities.untrustedWorkspaces.supported` | Limited support in untrusted workspaces. |

The source implementation is TypeScript, but VS Code loads the compiled
JavaScript entry from `out/extension`.

## Activation Events

The extension activates on:

```json
[
  "onView:backboard.panel",
  "onCommand:backboard.newChat",
  "onCommand:backboard.showHistory",
  "onCommand:backboard.signIn",
  "onCommand:backboard.copyOAuthRedirectUri",
  "onCommand:backboard.completeOAuthCallback",
  "onCommand:backboard.refreshModels",
  "onCommand:backboard.checkForUpdates",
  "onCommand:backboard.openPanel",
  "onCommand:backboard.openRightPanel"
]
```

That means the extension is lazy-loaded when the Backboard panel opens or when a
Backboard command is invoked.

## Commands

Commands contributed by `package.json`:

| Command | Title | What it does |
| --- | --- | --- |
| `backboard.openPanel` | Open Backboard | Opens Backboard view container/panel. |
| `backboard.openRightPanel` | Open Backboard in Right Sidebar | Opens Backboard in the secondary sidebar. |
| `backboard.newChat` | New Chat | Opens Backboard and posts a `newChat` UI command. |
| `backboard.showHistory` | Show History | Opens Backboard and posts a `showHistory` UI command. |
| `backboard.signIn` | Sign in with SSO | Starts the OAuth/SSO flow. |
| `backboard.copyOAuthRedirectUri` | Copy OAuth Redirect URI | Copies default callback URI. |
| `backboard.completeOAuthCallback` | Complete OAuth Callback | Manual callback paste fallback. |
| `backboard.refreshModels` | Refresh Models | Refreshes model metadata via Rust bridge. |
| `backboard.checkForUpdates` | Check for Updates | Checks packaged app update manifest. |

Commands registered in `activate()`:

- `backboard.setApiKey`
- `backboard.signIn`
- `backboard.copyOAuthRedirectUri`
- `backboard.completeOAuthCallback`
- `backboard.refreshModels`
- `backboard.checkForUpdates`
- `backboard.openRightPanel`
- `backboard.openPanel`
- `backboard.newChat`
- `backboard.showHistory`

`backboard.setApiKey` is registered but not listed in the copied manifest's
commands section. It is a legacy API-key input route.

## Views And Menus

The extension contributes a secondary-sidebar view container:

```json
{
  "id": "backboard",
  "title": "\u200B",
  "icon": "media/blank.svg"
}
```

And a webview view:

```json
{
  "id": "backboard.panel",
  "type": "webview",
  "name": "\u200B"
}
```

The invisible title (`\u200B`) is intentional branding/chrome behavior.

Menu behavior:

- `newChat`, `showHistory`, and `refreshModels` appear in the Backboard view
  container title.
- `signIn` appears when `backboard.authenticated` is false.
- `signIn` also appears on the view title when the panel is unauthenticated.

The auth context key is updated by:

```ts
updateBackboardAuthContext()
```

## Settings

Important Backboard settings:

| Setting | Purpose |
| --- | --- |
| `backboard.apiKey` | Legacy API-key fallback setting. Prefer SSO. |
| `backboard.env` | `prod`, `dev`, or `local`. |
| `backboard.apiUrl` | Custom API base URL override. |
| `backboard.oauthRedirectUri` | OAuth callback URI override. |
| `backboard.defaultProvider` | Default LLM provider. |
| `backboard.defaultModel` | Default model name. |
| `backboard.mode` | Tool mode: `agent`, `ask`, `manual`, `free`. |
| `backboard.intensity` | Reasoning intensity: `fast`, `balanced`, `deep`. |
| `backboard.memoryMode` | Memory mode: `Auto`, `Readonly`, `off`, `ProAuto`, `ProReadonly`. |
| `backboard.webSearch` | Web search mode, commonly `off` or `Auto`. |
| `backboard.imageGeneration` | Image generation mode. |
| `backboard.voiceMode` | Voice mode. |
| MCP toggles | Enable/disable MCP integrations such as Figma/Notion/Google. |

The extension reads these with:

```ts
readSettings()
```

The returned `config` object sent to the bridge includes:

```json
{
  "env": "prod",
  "apiUrl": "optional custom URL",
  "accessToken": "optional OAuth access token"
}
```

## Activation Function

`activate(context)` wires everything together.

It creates:

- Output channel: `Backboard Tools`
- `BackboardBridge`
- `BackboardPanelProvider`

It registers:

- Commands.
- URI handler for OAuth callback.
- Config file watcher.
- Panel-state watcher.
- Thread snapshot watcher.
- Webview view provider for `backboard.panel`.

It starts:

- Auth context update.
- Update checks.

High-level activation shape:

```text
activate()
  create Backboard Tools output
  create BackboardBridge
  create BackboardPanelProvider
  register commands
  register OAuth URI handler
  watch ~/.backboard_ide/config.json
  watch ~/.backboard_ide/panel-state.json
  watch ~/.backboard_ide/threads/*.json
  register backboard.panel webview provider
  start update checks
```

## Webview Provider

Class:

```ts
BackboardPanelProvider
```

Main responsibilities:

- Owns the current `vscode.WebviewView`.
- Produces the panel HTML.
- Handles messages from the webview JavaScript.
- Sends prompt requests to the Rust bridge.
- Renders streaming bridge events into panel messages.
- Executes tool requests and submits tool outputs.
- Saves and restores panel state.
- Handles UI commands such as new chat, history, refresh, settings, and context
  insertion.

The webview is registered with:

```ts
vscode.window.registerWebviewViewProvider('backboard.panel', panelProvider, {
  webviewOptions: { retainContextWhenHidden: true }
})
```

`retainContextWhenHidden: true` keeps the panel state alive when hidden.

## Webview Messages

The extension handles messages from webview JavaScript in `resolveWebviewView`.

Important message types:

| Message type | Host behavior |
| --- | --- |
| `send` | Run a text prompt. |
| `sendVoice` | Run a voice/audio prompt. |
| `cancel` | Cancel current run token. |
| `reviewChanges` | Opens SCM view. |
| `setApiKey` | Starts SSO flow. |
| `signIn` | Starts SSO flow. |
| `insertActiveFile` | Sends active file context to composer. |
| `insertSelection` | Sends current selection context. |
| `insertBranchDiff` | Sends branch diff context. |
| `ready` | Posts panel state/model/tool metadata. |
| `refreshModels` | Refreshes model metadata. |
| `refreshUsage` | Posts usage snapshot. |
| `saveSettings` | Saves panel options. |
| `panelState` | Persists panel state. |
| `syncPanelState` | Re-posts state snapshot. |

The webview itself is generated by `panelHtml(...)` inside `extension.ts`.

## Prompt Flow From Extension

The panel prompt path:

```text
webview message: send / sendVoice
  -> BackboardPanelProvider.runPrompt()
  -> BackboardPanelProvider.sendPrompt()
  -> bridge.send('sendPrompt', sessionId, params, onEvent, token)
  -> Rust bridge sends Backboard API request
  -> Rust bridge streams events
  -> renderBridgeEvent()
  -> panel sink updates webview
  -> toolRequested events are queued
  -> TypeScript executes tools
  -> bridge.send('submitToolResult', ...)
```

The session id for panel chats is shaped like:

```text
panel:<workspace-or-default>:<chatId-or-default>
```

The panel sends these prompt parameters to Rust:

```json
{
  "content": "user prompt",
  "workspace": "/path/to/workspace",
  "provider": "aws-bedrock",
  "model": "anthropic.claude-sonnet-4-6",
  "mode": "free",
  "intensity": "fast",
  "memoryMode": "Auto",
  "webSearch": "off",
  "imageGeneration": "auto or undefined",
  "voiceMode": "off / tts / stt / conversation",
  "audioFile": "optional voice attachment",
  "mcpCalls": "optional MCP payload",
  "config": {
    "env": "prod",
    "apiUrl": "optional custom URL",
    "accessToken": "optional access token"
  }
}
```

## Rust Bridge Process

Class:

```ts
BackboardBridge
```

This class owns the standalone extension's child process.

Responsibilities:

- Starts `backboard-bridge`.
- Sends JSON-line requests to stdin.
- Parses JSON-line events from stdout.
- Tracks pending requests by `requestId`.
- Handles cancellation and inactivity timeout.
- Caches model and tool metadata.
- Provides `listModels`, `listTools`, `runRustTool`, `callApi`, and generic
  `send`.

Bridge binary resolution checks locations like:

```text
extensions/backboard/bin/backboard-bridge
extensions/backboard/rust/target/debug/backboard-bridge
```

The agent-host integration has a similar but separate class named:

```ts
BackboardBridgeProcess
```

in:

```text
source-copies/typescript/agent-host/backboard/backboardAgent.ts
```

## Model And Tool Metadata Cache

`BackboardBridge` caches:

- Models in `models.json`
- Tools in `tools.json`

Both are under the extension global storage URI.

Cache constants:

| Cache | TTL | Version |
| --- | --- | --- |
| Models | 24 hours | `2` |
| Tools | 24 hours | `1` |

Model refresh path:

```text
refreshModels()
  -> listModels(forceRefresh=true)
  -> fetchAndCacheModels()
  -> bridge.send('listModels')
```

Tool refresh path:

```text
listTools(mode)
  -> fetchAndCacheTools(mode)
  -> bridge.send('listTools')
```

## Local State Files

The extension uses `~/.backboard_ide` for shared state:

| File/dir | Purpose |
| --- | --- |
| `~/.backboard_ide/config.json` | API key, env, OAuth tokens. |
| `~/.backboard_ide/panel-state.json` | Current panel state/history snapshot. |
| `~/.backboard_ide/threads/*.json` | Per-thread panel snapshots. |

The extension watches these paths and refreshes UI state when they change.

Panel state is written through:

```ts
writeSharedPanelState(state)
writeSharedPanelThreads(state)
```

Thread snapshot files are written with sanitized file names from thread IDs.

## SSO In The Extension

The extension implements SSO directly in `extension.ts`.

High-level path:

```text
backboard.signIn
  -> promptBackboardSso()
  -> signInBackboard()
  -> startBackboardOAuthCallbackServer()
  -> openBackboardOAuthAuthorizeUrl()
  -> completeBackboardOAuthCallback()
  -> exchangeBackboardOAuthCode()
  -> saveBackboardOAuthTokens()
  -> bridge.restart()
```

See:

```text
docs/SSO.md
docs/CREDENTIALS.md
```

for the full auth and credential-storage walkthrough.

## Tool Calls In The Extension

The extension receives `toolRequested` bridge events from Rust. For panel chats,
it queues tool requests and runs local tools before submitting results.

Main pieces:

- `renderBridgeEvent`
- `enqueueToolResultRequest`
- tool execution helpers in `extension.ts`
- `bridge.send('submitToolResult', ...)`

For the newer agent-host integration, local tool execution is documented in:

```text
source-copies/typescript/agent-host/backboard/backboardAgent.ts
```

and the main switch is:

```ts
executeBackboardTool(...)
```

See:

```text
docs/TOOL_CALLS_AND_API.md
```

## Update Checks

The extension also manages Backboard Studio update checks.

Important pieces:

- `startBackboardUpdateChecks`
- `checkBackboardUpdates`
- `fetchBackboardUpdateManifest`
- `installBackboardUpdate`

Default manifest base:

```text
https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases
```

This is separate from Backboard API/auth/tool-call behavior, but it lives in the
same extension entry file.

## Agent-Host Versus Extension Host

There are two TypeScript Backboard host paths in the reference:

| Path | Role |
| --- | --- |
| `extensions-backboard/src/extension.ts` | Standalone Backboard extension and webview panel. |
| `agent-host/backboard/backboardAgent.ts` | Workbench agent-host integration implementing `IAgent`. |

They both use the Rust bridge, but they surface Backboard differently:

- `extension.ts` owns a custom Backboard webview UI.
- `backboardAgent.ts` adapts Backboard into the platform agent session model.

Both paths need to be checked when changing shared Backboard runtime behavior.

## Extension Debugging Checklist

If the Backboard panel does not load:

1. Check activation events in `package.json`.
2. Check `activate()` runs.
3. Check `registerWebviewViewProvider('backboard.panel', ...)`.
4. Check the view contribution ids: `backboard` and `backboard.panel`.
5. Check webview local resource roots.
6. Check DevTools/webview console for panel script errors.

If prompts do not send:

1. Check webview message type `send`.
2. Check `runPrompt`.
3. Check `sendPrompt`.
4. Check `BackboardBridge.ensureProcess`.
5. Check bridge binary path.
6. Check `bridge.send('sendPrompt', ...)`.
7. Check `Backboard Bridge` and `Backboard Tools` output channels.

If model/tool lists are stale:

1. Check cache TTL/version.
2. Run `backboard.refreshModels`.
3. Check `listModels` bridge command.
4. Check `listTools` for the current mode.
5. Delete extension global storage cache if necessary.

If sign-in UI is wrong:

1. Check `~/.backboard_ide/config.json`.
2. Check `hasBackboardCredentials`.
3. Check `updateBackboardAuthContext`.
4. Check `backboard.authenticated` context.
5. Check config file watcher.

## Useful Search Strings

```text
activate(
BackboardPanelProvider
resolveWebviewView
panelHtml
runPrompt
sendPrompt
renderBridgeEvent
enqueueToolResultRequest
BackboardBridge
ensureProcess
bridge.send
listModels
listTools
runRustTool
callApi
readSettings
postPanelState
writeSharedPanelState
writeSharedPanelThreads
backboard.panel
backboard.authenticated
registerWebviewViewProvider
registerCommand
registerUriHandler
```
