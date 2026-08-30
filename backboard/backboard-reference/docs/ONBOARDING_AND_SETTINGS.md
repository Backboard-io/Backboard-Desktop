# Backboard Onboarding And Settings

This doc points to copied reference snapshots of the current onboarding, sign-in, API-key, and settings code. These are reference copies only. Edit the original source files in the VS Code repo when changing product behavior.

## Copied Files

### Workbench Chat Setup

Reference copies:

```text
source-copies/typescript/workbench-chat-setup/chatSetup.ts
source-copies/typescript/workbench-chat-setup/chatSetupRunner.ts
source-copies/typescript/workbench-chat-setup/chatSetupContributions.ts
source-copies/typescript/workbench-chat-setup/media/chatSetup.css
```

Original source:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetup.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupRunner.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/media/chatSetup.css
```

What these own:

- Chat setup strategy enum values.
- Backboard setup strategy selection.
- Backboard SSO setup entry point.
- Backboard API-key setup dialog.
- API-key save logic for `~/.backboard_ide/config.json`.
- Account/titlebar sign-in actions.
- Setup dialog styling and Backboard icon treatment.

Important current strategy values:

```ts
SetupWithBackboardApiKey = 7
SetupWithBackboardProvider = 8
```

Important command path:

```text
workbench.action.chat.triggerSetup
  -> ChatSetup.run(...)
  -> SetupWithBackboardProvider
  -> backboard.signIn
```

Important API-key path:

```text
workbench.action.chat.triggerSetup
  -> ChatSetup.run(...)
  -> SetupWithBackboardApiKey
  -> showBackboardApiKeyDialog()
  -> saveBackboardApiKey()
  -> ~/.backboard_ide/config.json
```

## Backboard Extension Panel Settings

Reference copy:

```text
source-copies/typescript/extensions-backboard/settings/extension.settings-and-onboarding.ts
```

Original source:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts
```

What this owns:

- Backboard panel webview.
- Auth overlay.
- Sign-in message handling.
- Settings controls inside the Backboard panel.
- Provider/model/mode/reasoning/memory/web/image/voice/MCP options.
- `readSettings()`.
- `resolveTurnSettings()`.
- `publicSettings()`.
- Model/tool metadata refresh for the panel.
- Usage/account UI in the panel.

Important settings functions:

```text
readSettings()
resolveTurnSettings(...)
mcpCallsPayload(...)
publicSettings(...)
postInitialPanelState(...)
```

Important webview message paths:

```text
message.type === 'signIn'
message.type === 'saveSettings'
message.type === 'settings'
message.type === 'usage'
message.type === 'usageSnapshot'
```

Important persisted credential path:

```text
~/.backboard_ide/config.json
```

Important persisted panel state paths:

```text
~/.backboard_ide/panel-state.json
~/.backboard_ide/threads
```

## What Goes Where

### Backboard setup from normal Chat

Use:

```text
src/vs/workbench/contrib/chat/browser/chatSetup
```

This is where normal Chat setup, account sign-in actions, and API-key setup should live.

Do not put normal Chat setup in the Backboard Rust bridge.

### Backboard panel settings

Use:

```text
extensions/backboard/src/extension.ts
```

This is where the existing standalone Backboard panel owns its local webview settings.

If the product moves settings into workbench Chat/Sandbox, use this file as the behavior reference but implement the UI in the workbench layer.

### Backboard turn settings

Use:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

This is where agent-host sessions should translate session config into bridge params:

```text
provider
model
mode
intensity
memoryMode
webSearch
imageGeneration
mcpCalls
config
```

### API key storage

Keep using:

```text
~/.backboard_ide/config.json
```

Do not route Backboard credentials through:

```text
extensions/copilot/src/platform/authentication
```

That service is GitHub/Copilot-specific.

## Rewire Notes

When replacing Copilot setup with Backboard setup:

1. Make sure Backboard Chat routing works first.
2. Keep `SetupWithBackboardProvider` for SSO.
3. Keep `SetupWithBackboardApiKey` for direct API-key entry.
4. Make missing-auth errors open Backboard setup, not GitHub Copilot setup.
5. Remove or rewrite GitHub-specific copy only in flows that now launch Backboard.
6. Keep AI UI hidden when chat AI features are disabled.

## Quick Checks

Search current setup/settings code:

```sh
rg -n "Backboard|SetupWithBackboard|backboard.signIn|saveBackboardApiKey|readSettings|saveSettings|api key|SSO" src/vs/workbench/contrib/chat/browser/chatSetup extensions/backboard/src/extension.ts
```

Validate after changes:

```sh
PATH="/Users/erintomorri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
```

