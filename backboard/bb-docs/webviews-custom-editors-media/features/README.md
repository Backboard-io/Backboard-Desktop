# Webviews, Custom Editors, And Media Features

## Capabilities

- Webview base infrastructure, panel views, and view contributions.
- Custom editor lifecycle and save/revert integration.
- Image/media preview commands and custom editors.
- Simple Browser and browser view support.
- Image carousel contribution.
- Shared dependency for Markdown preview, notebooks, MCP server editor, Backboard panel, and extension-contributed webviews.

## Boundaries

- Feature-specific webview content is documented by the owning feature folder.
- External URI and tunnel behavior is documented under `remote-tunnels-network`.
- Markdown preview is documented under `markdown-preview-docs`.

## Key Source Areas

- `src/vs/workbench/contrib/webview`
- `src/vs/workbench/contrib/webviewPanel`
- `src/vs/workbench/contrib/webviewView`
- `src/vs/workbench/contrib/customEditor`
- `extensions/media-preview`
- `extensions/simple-browser`

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Webviews, webview panels/views, custom editors, simple browser, image/media preview, and image carousel.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers` (exists)

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

### How To Extend Safely

1. Start from the source ownership paths above.
2. Use `rg` to find command IDs, context keys, settings, and services before editing.
3. Keep user-facing labels localized through the local source pattern.
4. Register disposables immediately when adding listeners, watchers, providers, or widgets.
5. Add source-level docs here when adding a new command, endpoint, storage file, network URL, or UI surface.
6. Validate the broad surface, not just the changed file: command palette, menu placement, keyboard focus, empty state, error state, and logs.

### Targeted Grep Commands

```sh
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/workbench/contrib/customEditor src/vs/workbench/contrib/imageCarousel src/vs/workbench/contrib/webview src/vs/workbench/contrib/webviewPanel src/vs/workbench/contrib/webviewView extensions/media-preview extensions/simple-browser extensions/notebook-renderers
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/workbench/contrib/customEditor src/vs/workbench/contrib/imageCarousel src/vs/workbench/contrib/webview src/vs/workbench/contrib/webviewPanel src/vs/workbench/contrib/webviewView extensions/media-preview extensions/simple-browser extensions/notebook-renderers
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Webviews Custom Editors Media / features.

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
