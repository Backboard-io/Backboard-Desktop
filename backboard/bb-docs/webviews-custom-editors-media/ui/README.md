# Webviews, Custom Editors, And Media UI

## Visible Surfaces

- Webview panels and webview views.
- Custom editors for contributed file types.
- Simple Browser and browser view surfaces.
- Image/media preview and image carousel.
- Webview-backed Markdown preview and Backboard panel dependencies.

## UI Elements

- Webview iframe/content area, toolbar actions, context menus, reload/open externally actions where contributed.
- Custom editor tabs and reopen-as-text/source/preview actions.
- Image preview zoom/copy controls.
- Simple Browser open controls and external URI handling.
- Browser view panes/editors.

## State Indicators

- Webview loading/ready/disposed state.
- Custom editor dirty/save/revert state.
- Media zoom level and unsupported media state.
- Simple Browser URL/load/error state.

## Source Anchors

- `src/vs/workbench/contrib/webview`
- `src/vs/workbench/contrib/webviewPanel`
- `src/vs/workbench/contrib/webviewView`
- `src/vs/workbench/contrib/customEditor`
- `extensions/media-preview`
- `extensions/simple-browser`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Webviews, webview panels/views, custom editors, simple browser, image/media preview, and image carousel.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Webviews Custom Editors Media                                    |
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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts
```

```ts
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { ComplexCustomWorkingCopyEditorHandler, CustomEditorDiffInputSerializer, CustomEditorInputSerializer, CustomEditorSideBySideDiffInputSerializer } from './customEditorInputFactory.js';
import { ICustomEditorService } from '../common/customEditor.js';
import { WebviewEditor } from '../../webviewPanel/browser/webviewEditor.js';
import { CustomEditorInput } from './customEditorInput.js';
import { CustomEditorDiffInput, CustomEditorSideBySideDiffInput } from './customEditorDiffInput.js';
import { CustomEditorService } from './customEditors.js';

registerSingleton(ICustomEditorService, CustomEditorService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(
			WebviewEditor,
			WebviewEditor.ID,
			'Webview Editor',
		), [
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Webviews Custom Editors Media / ui.

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
