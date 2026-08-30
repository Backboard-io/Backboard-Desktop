# Webviews Custom Editors Media UX Journeys

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/webviews-custom-editors-media/ux/journeys.md`

## Primary Journey

```text
User intent
   |
   v
Find entry point for webviews-custom-editors-media
   |
   v
Command/menu/view/editor contribution activates
   |
   v
Workbench service or extension code updates state
   |
   v
UI renders state, result, failure, or recovery action
   |
   v
User continues, cancels, retries, or switches context
```

## Journey Table

| Phase | User action | System behavior | Code path to inspect |
|---|---|---|---|
| Discover | User opens command palette, menu, view, editor, or extension surface. | Contribution and context keys decide visibility. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts` |
| Invoke | User selects the command or starts the flow. | Command/action delegates to a service, controller, provider, or extension activation. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser/imageCarousel.contribution.ts` |
| Work | Feature reads state, writes state, starts a task, or renders content. | Events and services keep the UI synchronized. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/webview.contribution.ts` |
| Recover | User hits an error, cancellation, offline state, unavailable context, or disabled workspace. | Notification, inline message, log, disabled state, or fallback flow communicates recovery. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/webview.web.contribution.ts` |

## UX Detail Notes

- Keep text action labels tied to the exact command or menu label in source.
- Verify focus order when the feature owns toolbar, tree, editor, webview, terminal, notebook, or quick access UI.
- Verify cancellation and retry affordances where source shows async work, token usage, network calls, process execution, or extension activation.
- Verify reduced-width and high-contrast behavior where CSS or workbench layout files are part of the source inventory.

## Code Anchor For Journey Review

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts
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
		new SyncDescriptor(CustomEditorInput),
		new SyncDescriptor(CustomEditorDiffInput),
		new SyncDescriptor(CustomEditorSideBySideDiffInput),
	]);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(CustomEditorInputSerializer.ID, CustomEditorInputSerializer);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(CustomEditorDiffInputSerializer.ID, CustomEditorDiffInputSerializer);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser/imageCarousel.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser/imageCarousel.contribution.ts
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ImageCarouselEditor } from './imageCarouselEditor.js';
import { ImageCarouselEditorInput } from './imageCarouselEditorInput.js';
import { ICarouselImage, IImageCarouselCollection } from './imageCarouselTypes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ExplorerFolderContext } from '../../files/common/files.js';
import { IExplorerService } from '../../files/browser/files.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, dirname, extname } from '../../../../base/common/resources.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// --- Configuration ---

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'imageCarousel',
	title: localize('imageCarouselConfigurationTitle', "Images Preview"),
	type: 'object',
	properties: {
		'imageCarousel.explorerContextMenu.enabled': {
			type: 'boolean',
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/package.json
  "main": "./out/extension",
  "browser": "./dist/browser/extension.js",
  "categories": [
    "Other"
  ],
  "activationEvents": [],
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "contributes": {
    "configuration": {
      "type": "object",
      "title": "Media Previewer",
      "properties": {
        "mediaPreview.video.autoPlay": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "%videoPreviewerAutoPlay%"
        },
        "mediaPreview.video.loop": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "%videoPreviewerLoop%"
        }
      }
    },
    "customEditors": [
      {
        "viewType": "imagePreview.previewEditor",
        "displayName": "%customEditor.imagePreview.displayName%",
        "priority": "builtin",
```

