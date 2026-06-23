# Backboard Changes Feature Breakdown

## Feature 1: Add Browser Area Screenshot To Chat From Sessions Titlebar

Full path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

What changed:

- Added imports for action registration, browser command ID, command service, browser editor input, browser view workbench service, editor service, and sessions menus/context keys.
- Added `BrowserEditorOpenContext`.
- Added `AddBrowserAreaScreenshotToChatFromSessionAction`.
- Registered the action.

Why it changed:

- The user needs a direct, visible Agents Window action for browser screenshot capture into chat.
- The action handles the case where the browser editor exists but is not active.

Operational behavior:

```text
if active editor is contextual browser:
  execute browser screenshot command
else if there is any contextual browser input:
  open that browser input
  execute browser screenshot command
else:
  return without side effects
```

## Feature 2: Browser Toolbar Screenshot Action Is More Available

Full path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts
```

What changed:

- Removed `CONTEXT_BROWSER_HAS_ERROR.negate()` from precondition.
- Added browser toolbar menu placement.
- Changed Add to Chat submenu order from `1` to `1.1`.

Why it changed:

- The area screenshot action should be more prominent and not hidden behind only the chat submenu.
- The action should still depend on active browser, URL, and chat.

## Feature 3: Hide Account Widget During Browser Editor Mode

Full path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts
```

What changed:

- Imported `BrowserEditorInput`.
- Injected `IEditorService`.
- Registered active editor change listener.
- Added `updateBrowserVisibility()`.
- Called `updateBrowserVisibility()` during render.

Why it changed:

- Browser editor actions need titlebar room.
- A hidden widget must not leave stale popover/hover state around.

## Feature 4: Backboard Panel Composer De-Clutter

Full path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts
```

What changed:

- Removed `.usageFeatureButton.hasUsage` styling.
- Removed `<button id="usageBtn"...>`.
- Removed `usage` from the `buttons` map.
- Removed usage button active/label/title syncing.
- Removed `usage` from renderers list.
- Removed click, mouseenter, and focus listeners for usage button.

What did not change:

- `renderUsagePopover()` still exists.
- `requestUsageSnapshot()` still exists.
- Latest/account usage state can still be part of the script internals.

Why it changed:

- Composer controls became too dense.
- Removing always-visible usage reduces icon overload.

## Feature 5: Narrower Auxiliary Bar

Full paths:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css
```

What changed:

- `DEFAULT_MINIMUM_WIDTH` lowered to `120`.
- Restored width floor lowered to `220`.
- Workbench split math uses `0.22`, `0.32`, and `0.24` ratios instead of wider `0.36`, `0.48`, and `0.38` ratios.
- CSS title/action heights and gaps are compacted.
- Overflow handling added.

Why it changed:

- Browser/right-panel/auxiliary content was taking too much width.
- Users need editor/session content to remain usable with right-side panels open.

## Feature 6: Sidebar Activity Header

Full paths:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css
```

What changed:

- Replaced `createTitleArea(...)` override with `create(...)`.
- Removed `prepend` import.
- Created `.sidebar-activity-navigation-header`.
- Called `setHeaderArea(navigation)`.
- Updated CSS selectors from title-child navigation to header navigation.

Why it changed:

- The sidebar activity row is conceptually a header, not a title label child.
- The CSS can be simpler and more stable when the row has a dedicated container.

## Feature 7: Chat Title Tab Polish

Full path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/media/chatViewTitleControl.css
```

What changed:

- Added `mask-image`/`-webkit-mask-image` for scroll fade.
- Changed tab gap/padding/border color.
- Switched to tab color variables.
- Added transition.
- Adjusted active background formula.
- Changed close opacity behavior.

Why it changed:

- Tabs need clearer active and overflow states.
- Close icons should be visible enough on active/hover without dominating idle tabs.

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Current Backboard-related worktree diffs, recent commit timeline, exact paths, code excerpts, and ASCII diagrams describing what changed and why.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat` (exists)

### Source-Level Architecture Sketch

```text
+--------------------+       +----------------------+       +--------------------+
| User action / API  | ----> | Workbench contribution| ----> | Service / provider |
| command/menu/view  |       | Action2, registry,    |       | file, model, auth, |
| or extension point |       | view/editor glue      |       | terminal, remote   |
+--------------------+       +----------------------+       +--------------------+
          ^                              |                              |
          |                              v                              v
          |                    +-------------------+          +-------------------+
          +------------------- | Context / config  | <------- | Events / storage  |
                               +-------------------+          +-------------------+
```

### Representative Code Excerpt

Path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

```ts
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
```

### How To Extend Safely

1. Start from the source ownership paths above.
2. Use `rg` to find command IDs, context keys, settings, and services before editing.
3. Keep user-facing labels localized through the local source pattern.
4. Register disposables immediately when adding listeners, watchers, providers, or widgets.
5. Add source-level docs here when adding a new command, endpoint, storage file, network URL, or UI surface.
6. Validate the broad surface, not just the changed file: command palette, menu placement, keyboard focus, empty state, error state, and logs.

### Targeted Grep Commands

```sh
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts extensions/backboard/src/extension.ts src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts extensions/backboard src/vs/sessions src/vs/workbench/browser/parts/sidebar src/vs/workbench/contrib/browserView src/vs/workbench/contrib/chat
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts extensions/backboard/src/extension.ts src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts extensions/backboard src/vs/sessions src/vs/workbench/browser/parts/sidebar src/vs/workbench/contrib/browserView src/vs/workbench/contrib/chat
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Backboard Changes / features.

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
