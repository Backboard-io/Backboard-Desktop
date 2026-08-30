# Backboard Changes Endpoints

## New Or Changed Command IDs

### New Sessions Window Command

```text
workbench.action.sessions.addBrowserAreaScreenshotToChat
```

Registered in:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

Runs:

```ts
await commandService.executeCommand(BrowserViewCommandId.AddAreaScreenshotToChat);
```

### Existing Browser Command Used By New Action

```text
BrowserViewCommandId.AddAreaScreenshotToChat
```

Imported from:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/browserView.ts
```

Used by:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts
```

## New Or Changed Menu Placements

### Sessions Titlebar Right Layout

Menu:

```text
Menus.TitleBarRightLayout
```

Added item:

```text
Add Area Screenshot to Chat
```

Group/order:

```text
group: navigation
order: -1
```

### Browser Actions Toolbar

Menu:

```text
MenuId.BrowserActionsToolbar
```

Added screenshot action:

```text
group: BrowserActionGroup.Tools
order: 1
```

### Browser Chat Actions Menu

Menu:

```text
MenuId.BrowserChatActionsMenu
```

Screenshot action remains:

```text
group: 2_screenshots
order: 2
```

### Chat Input Status

Removed placement:

```ts
menu: {
	id: MenuId.ChatInputStatus,
	order: 1,
	group: 'navigation',
	when: ChatContextKeys.inQuickChat.negate()
}
```

Command class remains:

```text
BackboardUsageMetricsAction
```

## New Or Changed Context Gates

### Sessions Screenshot Action

```text
ChatContextKeys.enabled
browserEditorOpen
not IsAuxiliaryWindowContext
not SessionsWelcomeVisibleContext
not IsPhoneLayoutContext
```

### Browser Toolbar Screenshot Action

Before:

```ts
ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate(), ChatContextKeys.enabled)
```

After:

```ts
ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, ChatContextKeys.enabled)
```

Meaning:

- The action is no longer hidden solely because `CONTEXT_BROWSER_HAS_ERROR` is true.
- It still requires an active browser editor, URL, and chat enablement.

## Changed Services

The new sessions titlebar action pulls three services:

```ts
const editorService = accessor.get(IEditorService);
const browserViewService = accessor.get(IBrowserViewWorkbenchService);
const commandService = accessor.get(ICommandService);
```

The account widget now depends on:

```ts
@IEditorService private readonly editorService: IEditorService
```

And watches:

```ts
this._register(this.editorService.onDidActiveEditorChange(() => this.updateBrowserVisibility()));
```

## File/DOM Endpoints

### Sidebar Header

Code now calls:

```ts
this.setHeaderArea(navigation);
```

CSS now targets:

```css
.monaco-workbench .part.sidebar > .sidebar-activity-navigation-header
```

Instead of:

```css
.monaco-workbench .part.sidebar > .title > .sidebar-activity-navigation
```

### Backboard Composer

Removed DOM endpoint:

```text
usageBtn
```

Removed button map entry:

```ts
usage: document.getElementById('usageBtn')
```

Removed event listeners:

```ts
buttons.usage.addEventListener('click', ...)
buttons.usage.addEventListener('mouseenter', ...)
buttons.usage.addEventListener('focus', ...)
```

<!-- BB-DEEP-DIVE:START -->
## Deep Endpoint Inventory

### Endpoint Types Used In This Feature Area

This repository uses more than HTTP endpoints. For Backboard Changes, inspect all applicable endpoint classes:

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

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat` (exists)

### Endpoint Discovery Commands

```sh
rg -n "registerAction2|CommandsRegistry|MenuId|configuration|contributes|activationEvents|register.*Provider|create.*Service|URI|scheme|http|https" src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts extensions/backboard/src/extension.ts src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts extensions/backboard src/vs/sessions src/vs/workbench/browser/parts/sidebar src/vs/workbench/contrib/browserView src/vs/workbench/contrib/chat
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

Use this section as a no-shortcuts review grid for Backboard Changes / endpoints.

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
