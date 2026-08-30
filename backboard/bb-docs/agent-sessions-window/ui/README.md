# Agent Sessions Window UI

## Visible Surfaces

- Dedicated Agents Window implemented under `src/vs/sessions`.
- Fixed layout with titlebar, sidebar, sessions part, auxiliary bar, hidden/modal editor, and panel.
- Session grid with one or more visible session views.
- Sidebar sessions list, pinned sessions, workspace grouping, filters, and mobile adaptations.
- Auxiliary-bar changes and file-tree style session views.

## UI Elements

- Titlebar session picker showing provider icon, session title, workspace, branch/worktree, and changes summary.
- New chat/session view with workspace and session-type picker.
- Session header with status, metadata row, toolbar, context menu, rename, pin/close, read/unread actions.
- Chat composite bar for multi-chat sessions.
- Modal editor overlay for explicit editor workflows.
- Mobile single-session layout and mobile navigation stack.

## State Indicators

- Active visible session, sticky/non-sticky visible slots, empty new-session slot, maximized session state.
- Session status such as untitled, in progress, needs input, completed/read/unread.
- Provider/session type availability and selected model.
- Per-session changes, branch, workspace, and progress indicators.

## Source Anchors

- `src/vs/sessions/README.md`
- `src/vs/sessions/LAYOUT.md`
- `src/vs/sessions/SESSIONS.md`
- `src/vs/sessions/browser/parts`
- `src/vs/sessions/services/sessions`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Dedicated Agents Window under `src/vs/sessions`, session providers, session grid, changes, worktrees, and mobile session UX.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/agentHost` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/agentHost` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Agent Sessions Window                                            |
+----------------------+----------------------+--------------------+
| Entry points         | Primary surfaces     | Feedback surfaces  |
| - commands/menus     | - views/editors      | - status/progress   |
| - settings/actions   | - panels/tree/list   | - markers/toasts    |
| - extension points   | - webview/editor UI  | - output/logs       |
+----------------------+----------------------+--------------------+
| Source paths are listed above; use rg to jump from UI label to   |
| command/action registration before changing behavior.            |
+------------------------------------------------------------------+
```

### UI Audit Checklist

- Every visible action should map to a command ID, menu registration, or extension contribution.
- Every icon-only action needs a title, tooltip, ARIA label, or hover description in the owning source.
- Every tree/list/editor surface needs a clear empty state and a clear failure state.
- Every hidden or conditional UI element needs an explicit context key or capability gate.
- Every color, icon, and spacing decision should use workbench theme variables where possible.

### Representative Source Excerpt

Path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/menubar.contribution.ts
```

```ts
import { localize } from '../../../nls.js';
import { MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { IsMacNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import { Menus } from '../menus.js';

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarFileMenu,
	title: {
		value: 'File',
		original: 'File',
		mnemonicTitle: localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File"),
	},
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.MenubarEditMenu,
	title: {
		value: 'Edit',
		original: 'Edit',
		mnemonicTitle: localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit")
	},
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Agent Sessions Window / ui.

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
