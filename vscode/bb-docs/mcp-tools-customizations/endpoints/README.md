# MCP, Tools, And Customizations Endpoints

## MCP Commands

`src/vs/workbench/contrib/mcp/common/mcpCommandIds.ts` defines:

- `workbench.mcp.addConfiguration`
- `workbench.mcp.browseServers`
- `workbench.mcp.installFromManifest`
- `workbench.mcp.browseServersPage`
- `workbench.mcp.browseResources`
- `workbench.mcp.configureSamplingModels`
- `workbench.mcp.editStoredInput`
- `workbench.mcp.installFromActivation`
- `workbench.mcp.listServer`
- `workbench.mcp.agentHostServerOptions`
- `workbench.mcp.openRemoteUserMcpJson`
- `workbench.mcp.openUserMcpJson`
- `workbench.mcp.openWorkspaceFolderMcpJson`
- `workbench.mcp.openWorkspaceMcpJson`
- `workbench.mcp.removeStoredInput`
- `workbench.mcp.resetCachedTools`
- `workbench.mcp.resetTrust`
- `workbench.mcp.restartServer`
- `workbench.mcp.serverOptions`
- `workbench.mcp.serverOptionsInConfirmation`
- `workbench.mcp.setOAuthClientSecret`
- `workbench.mcp.showConfiguration`
- `workbench.mcp.showInstalledServers`
- `workbench.mcp.showOutput`
- `workbench.mcp.skipAutostart`
- `workbench.mcp.startPromptForServer`
- `workbench.mcp.startServer`
- `workbench.mcp.stopServer`

## MCP Configuration Files

- Workspace/user MCP files can include `mcp.json` and `.mcp.json` forms.
- `.mcp.json` uses the `mcpServers` key according to source handling.
- Settings-backed MCP configuration uses the `mcp` section.

## MCP Settings And Constants

Important configuration sections include:

- `mcp`
- `chat.mcp.discovery.enabled`
- `chat.mcp.serverSampling`
- `chat.mcp.collisionBehavior`
- `mcp.enterpriseManagedAuth.idp`

Discovery sources include Claude Desktop, Windsurf, Cursor global, and Cursor workspace configuration locations.

## MCP Server Types

- Stdio servers use command, cwd, args, envFile, env, sandbox, and dev/debug properties.
- HTTP server examples use URL and headers.
- Development mode can watch files and debug supported runtimes.

## Chat Tool Endpoints

Backboard Chat contributes language-model tools and tool sets in `extensions/copilot/package.json`. Tool rendering/authorization appears in chat UI; MCP server management appears in the MCP workbench UI.

## Network Endpoints

- MCP servers may be local stdio processes or HTTP servers defined by user/workspace/extension configuration.
- The product does not define one universal MCP HTTP endpoint; each server definition owns its command or URL.

<!-- BB-DEEP-DIVE:START -->
## Deep Endpoint Inventory

### Endpoint Types Used In This Feature Area

This repository uses more than HTTP endpoints. For Mcp Tools Customizations, inspect all applicable endpoint classes:

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

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/mcp` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/mcp` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/aiCustomization` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot` (exists)

### Endpoint Discovery Commands

```sh
rg -n "registerAction2|CommandsRegistry|MenuId|configuration|contributes|activationEvents|register.*Provider|create.*Service|URI|scheme|http|https" src/vs/workbench/contrib/mcp src/vs/workbench/services/mcp src/vs/platform/mcp src/vs/workbench/contrib/chat/browser/aiCustomization extensions/copilot
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

Use this section as a no-shortcuts review grid for Mcp Tools Customizations / endpoints.

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
