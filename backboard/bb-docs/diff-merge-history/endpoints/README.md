# Diff, Merge, And History Endpoints

## Commands And Editors

- Diff and merge commands are registered through workbench command/action registries.
- Multi-diff editor has workbench contribution source under `multiDiffEditor`.
- Merge editor has contribution source under `mergeEditor`.
- Bulk edit routes through bulk-edit contribution and editor services.

## Extension Contribution Points

- `extensions/merge-conflict` contributes commands, menus, and configuration for conflict handling.
- `extensions/search-result` contributes the `search-result` language/grammar used by search result documents.

## File Endpoints

- Local history stores and reads file history through workbench file/history services.
- Edit sessions serialize/continue edits through workbench edit-session services and provider integrations.

## Network Endpoints

- There is no shared public HTTP endpoint for local diff/merge/history.
- Edit session continuation may involve provider-specific sync/source-control integrations.

<!-- BB-DEEP-DIVE:START -->
## Deep Endpoint Inventory

### Endpoint Types Used In This Feature Area

This repository uses more than HTTP endpoints. For Diff Merge History, inspect all applicable endpoint classes:

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

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bulkEdit` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mergeEditor` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/multiDiffEditor` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/search-result` (exists)

### Endpoint Discovery Commands

```sh
rg -n "registerAction2|CommandsRegistry|MenuId|configuration|contributes|activationEvents|register.*Provider|create.*Service|URI|scheme|http|https" src/vs/workbench/contrib/bulkEdit src/vs/workbench/contrib/editSessions src/vs/workbench/contrib/localHistory src/vs/workbench/contrib/mergeEditor src/vs/workbench/contrib/multiDiffEditor src/vs/workbench/contrib/timeline extensions/merge-conflict extensions/search-result
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

Use this section as a no-shortcuts review grid for Diff Merge History / endpoints.

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
