# Search And Navigation UI

## Visible Surfaces

- Search view and search editor.
- Quick access and quick open.
- Symbol/file navigation surfaces.
- Outline, references view, and search-result language documents.

## UI Elements

- Search input, replace input, include/exclude glob fields, match-case, whole-word, regex, preserve-case, and expand/collapse controls.
- Search results tree and inline match previews.
- Search editor document with search-result language support.
- Quick access picker and provider results.
- References view tree and peek-style navigation.

## State Indicators

- Search running/cancelled/completed state.
- Result count, file count, replace preview/apply state.
- Include/exclude and query option state.
- Quick access provider active state.

## Source Anchors

- `src/vs/workbench/contrib/search`
- `src/vs/workbench/contrib/searchEditor`
- `src/vs/workbench/contrib/quickaccess`
- `src/vs/workbench/contrib/outline`
- `extensions/search-result`
- `extensions/references-view`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Search view, search editor, quick access, outline/navigation surfaces, references view, and search-result documents.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/quickaccess` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/searchEditor` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Search Navigation                                                |
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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts
```

```ts
import { localize } from '../../../../nls.js';
import { IQuickAccessRegistry, Extensions } from '../../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { HelpQuickAccessProvider } from '../../../../platform/quickinput/browser/helpQuickAccess.js';
import { ViewQuickAccessProvider, OpenViewPickerAction, QuickAccessViewPickerAction } from './viewQuickAccess.js';
import { CommandsQuickAccessProvider, ShowAllCommandsAction, ClearCommandHistoryAction } from './commandsQuickAccess.js';
import { MenuRegistry, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { inQuickPickContext, getQuickNavigateHandler } from '../../../browser/quickaccess.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';

//#region Quick Access Proviers

const quickAccessRegistry = Registry.as<IQuickAccessRegistry>(Extensions.Quickaccess);

quickAccessRegistry.registerQuickAccessProvider({
	ctor: HelpQuickAccessProvider,
	prefix: HelpQuickAccessProvider.PREFIX,
	helpEntries: [{
		description: localize('helpQuickAccess', "Show all Quick Access Providers"),
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Search Navigation / ui.

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
