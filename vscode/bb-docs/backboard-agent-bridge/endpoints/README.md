# Backboard Agent Bridge Endpoints

## Commands

`extensions/backboard/package.json` contributes:

- `backboard.setApiKey`
- `backboard.extension.signIn`
- `backboard.copyOAuthRedirectUri`
- `backboard.completeOAuthCallback`
- `backboard.refreshModels`
- `backboard.openRightPanel`
- `backboard.openPanel`
- `backboard.newChat`
- `backboard.showHistory`
- `backboard.checkForUpdates`
- `backboard.installAvailableUpdate`

## Settings

Backboard settings include:

- `backboard.apiKey`
- `backboard.env`
- `backboard.apiUrl`
- `backboard.oauthRedirectUri`
- `backboard.defaultProvider`
- `backboard.defaultModel`
- `backboard.mode`
- `backboard.intensity`
- `backboard.webSearch`
- `backboard.imageGeneration`
- `backboard.mcpFigma`
- `backboard.mcpNotion`
- `backboard.mcpGoogle`
- `backboard.voiceMode`
- `backboard.bridgePath`
- `backboard.workspaceRoot`
- `backboard.updates.enabled`
- `backboard.updates.manifestBaseUrl`
- `backboard.updates.channel`
- `backboard.updates.manifestUrl`
- `backboard.updates.checkIntervalMinutes`

## OAuth And Local Callback

- Authorize URL: `https://app.backboard.io/api/oauth/authorize`
- Token URL: `https://app.backboard.io/api/oauth/token`
- Default redirect URI: `http://127.0.0.1:49321/auth/callback`
- OAuth scope: `openid email profile`
- The extension also registers a VS Code URI handler and supports manual callback URL entry.

## Local Files

- Config: `~/.backboard_ide/config.json`
- Panel state: `~/.backboard_ide/panel-state.json`
- Threads: `~/.backboard_ide/threads`
- Optimus command file: `~/.backboard_ide/optimus-command.json`

## Update Endpoints

- Default manifest base URL: `https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases`
- Derived manifest path: `{base}/{channel}/latest/bbide/{platform}-{arch}.json`
- Environment overrides include `BBIDE_UPDATE_MANIFEST_URL`, `BACKBOARD_UPDATE_MANIFEST_URL`, `BBIDE_UPDATE_MANIFEST_BASE_URL`, `BACKBOARD_UPDATE_MANIFEST_BASE_URL`, `BBIDE_UPDATE_CHANNEL`, and `BACKBOARD_UPDATE_CHANNEL`.

## Agent Host Environment

Agent host startup reads Backboard-related settings and parent environment, then forwards:

- `VSCODE_BACKBOARD_ENV`
- `VSCODE_BACKBOARD_API_URL`

Backboard agent code also recognizes Backboard bridge/API credential environment values in `src/vs/platform/agentHost/node/backboard`.

<!-- BB-DEEP-DIVE:START -->
## Deep Endpoint Inventory

### Endpoint Types Used In This Feature Area

This repository uses more than HTTP endpoints. For Backboard Agent Bridge, inspect all applicable endpoint classes:

```text
Command endpoint      -> command ID registered through Action2, CommandsRegistry, or extension manifest
Menu endpoint         -> MenuId placement, submenu, when-clause, group/order
Setting endpoint      -> configuration key, default, scope, policy, machine/workspace behavior
Service endpoint      -> injected service contract or platform service boundary
URI/file endpoint     -> scheme, file path, workspace storage, virtual resource, or serializer
Provider endpoint     -> extension contribution, provider registration, language/debug/test/notebook/MCP/task provider
Network endpoint      -> concrete URL or dynamic provider URL only when source shows it
```

### Absolute Source Paths To Inspect

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard` (exists)

### Endpoint Discovery Commands

```sh
rg -n "registerAction2|CommandsRegistry|MenuId|configuration|contributes|activationEvents|register.*Provider|create.*Service|URI|scheme|http|https" src/vs/workbench/contrib/optimus extensions/backboard
```

### Code Pattern To Preserve

```ts
// Keep endpoint ownership explicit. Prefer command/service/provider contracts
// over reaching into another feature's private storage or DOM.
class FeatureAction extends Action2 {
  constructor() {
    super({
      id: 'owner.feature.commandId',
      title: localize2('feature.command.title', "Human Readable Command"),
      precondition: undefined,
      menu: { id: MenuId.CommandPalette }
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const commandService = accessor.get(ICommandService);
    await commandService.executeCommand('owner.lowerLevelCommand');
  }
}
```

### Endpoint Review Questions

- What command ID starts the flow?
- What context key gates it?
- What service owns the actual state mutation?
- What storage, URI, file, process, or network endpoint can it touch?
- What output/log/notification path explains failure?
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Backboard Agent Bridge / endpoints.

| Check | Evidence to collect | Pass condition |
|---|---|---|
| Source owner | Full absolute path from the deep-dive source list | The path exists or the doc explicitly says why it is dynamic/provider-owned. |
| Command/menu wiring | `rg -n "registerAction2|MenuId|CommandsRegistry|contributes|commands" <source paths>` | Every user action has a concrete registration point. |
| Context gating | `rg -n "ContextKey|when:|precondition|activationEvents" <source paths>` | Hidden/conditional UI is explained by a context key, activation event, or capability. |
| User-facing text | `rg -n "localize\(|localize2\(|title:|aria-label|tooltip" <source paths>` | Labels are localized or intentionally extension-manifest owned; icon-only UI has accessible naming. |
| Failure path | `rg -n "showErrorMessage|showWarningMessage|logService|output|reject|throw new Error" <source paths>` | Failures have an observable message, log, output channel, or returned error. |
| State persistence | `rg -n "storage|StorageScope|setItem|getItem|workspaceState|globalState|configuration" <source paths>` | Persisted state has an owner and does not reuse another component's private key. |

ASCII review loop:

```text
Read source path
   |
   v
Find registration ---- no ----> doc missing endpoint detail
   |
  yes
   v
Find state owner ------ no ----> doc missing service/storage detail
   |
  yes
   v
Find user feedback ---- no ----> doc missing UX failure detail
   |
  yes
   v
Feature doc is operationally reviewable
```

Minimum expectation for future edits:

- Add the changed full path.
- Add the changed command, setting, provider, URI, or file endpoint.
- Add a literal code excerpt when the behavior changed.
- Add the before/after user impact.
- Add validation evidence, not just intent.
<!-- BB-VERIFICATION-MATRIX:END -->
