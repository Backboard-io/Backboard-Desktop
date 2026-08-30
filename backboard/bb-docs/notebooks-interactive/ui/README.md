# Notebooks And Interactive UI

## Visible Surfaces

- Notebook editor and notebook cell UI.
- Interactive window and REPL notebook surfaces.
- IPYNB serializer/editor contributions.
- Notebook renderer output surfaces.
- Notebook chat participants/tools where Backboard Chat contributes notebook support.

## UI Elements

- Code and Markdown cells, cell toolbar, notebook toolbar, execution controls, output area, kernel/controller picker, and cell status.
- Notebook output copy/open/add-to-chat actions.
- Notebook diff and cell-level editor integrations.
- Interactive/repl input and output cells.

## State Indicators

- Cell running, queued, succeeded, failed, cancelled, collapsed, or dirty state.
- Notebook kernel/controller selected and unavailable state.
- Output trusted/untrusted/rendered/error state.
- Serializer/editor mode for `jupyter-notebook`, `interactive`, and `repl`.

## Source Anchors

- `src/vs/workbench/contrib/notebook`
- `src/vs/workbench/contrib/interactive`
- `src/vs/workbench/contrib/replNotebook`
- `extensions/ipynb`
- `extensions/notebook-renderers`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Notebook editor, interactive window, IPYNB serializer, REPL notebooks, renderers, and notebook chat/tooling.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/interactive` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/notebook` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/replNotebook` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Notebooks Interactive                                            |
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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/interactive/browser/interactive.contribution.ts
```

```ts
import { Iterable } from '../../../../base/common/iterator.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { parse } from '../../../../base/common/marshalling.js';
import { Schemas } from '../../../../base/common/network.js';
import { extname, isEqual } from '../../../../base/common/resources.js';
import { isFalsyOrWhitespace } from '../../../../base/common/strings.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IBulkEditService } from '../../../../editor/browser/services/bulkEditService.js';
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { peekViewBorder } from '../../../../editor/contrib/peekView/browser/peekView.js';
import { Context as SuggestContext } from '../../../../editor/contrib/suggest/browser/suggest.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Notebooks Interactive / ui.

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
