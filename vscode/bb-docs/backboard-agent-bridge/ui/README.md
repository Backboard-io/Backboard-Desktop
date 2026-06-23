# Backboard Agent Bridge UI

## Visible Surfaces

- Backboard activity/view container and `backboard.panel` webview view.
- Commands for opening the panel, starting a new chat, showing history, setting API key, signing in, refreshing models, and checking/installing updates.
- Backboard Tools output channel.
- Status bar update item when a Backboard Studio update is available.
- Webview authentication, model/provider, chat/history, and panel state surfaces supplied by the Backboard extension.

## UI Elements

- Backboard-branded SVG assets and icon set under `extensions/backboard/media`.
- Webview retained context for the Backboard panel.
- Secret input prompt for `Backboard API Key`.
- OAuth prompts, copied redirect URI notification, and complete-callback input.
- Update notification actions: install/restart, download DMG, copy link, later.

## State Indicators

- `backboard.authenticated` context key tracks whether Backboard credentials exist.
- `backboard.updateAvailable` context key gates update command visibility.
- Panel state and thread history are watched from `~/.backboard_ide`.
- Backboard bridge lifecycle state is reflected through the panel and output channel.

## Source Anchors

- `extensions/backboard/package.json`
- `extensions/backboard/src/extension.ts`
- `extensions/backboard/bin/backboard-bridge`
- `src/vs/workbench/contrib/optimus`
- `src/vs/platform/agentHost/node/backboard`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Backboard extension, bridge binary, Backboard webview panel, OAuth, model refresh, updates, Optimus panel commands, and local state.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Backboard Agent Bridge                                           |
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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts
```

```ts
import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { OptimusEditor } from './optimusEditor.js';
import { OptimusEditorInput } from './optimusEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(OptimusEditor, OptimusEditor.ID, localize('optimusEditor', "Optimus")),
	[new SyncDescriptor(OptimusEditorInput)]
);

class OptimusEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Backboard Agent Bridge / ui.

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
