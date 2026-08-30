# Webviews Custom Editors Media UI Source Inventory

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/webviews-custom-editors-media/ui/source-inventory.md`

## Source-To-UI Map

```text
webviews-custom-editors-media
|
|-- docs
|   |-- ui
|   |-- ux
|   |-- endpoints
|   L-- features
|
L-- source inventory
   |-- extensions/media-preview
   |-- extensions/notebook-renderers
   |-- extensions/simple-browser
   |-- src/vs/workbench/contrib/customEditor
   |-- src/vs/workbench/contrib/imageCarousel
   |-- src/vs/workbench/contrib/webview
   |-- src/vs/workbench/contrib/webviewPanel
   L-- src/vs/workbench/contrib/webviewView
```

## Full Source Paths

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/esbuild.browser.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers/esbuild.notebook.mts`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/notebook-renderers/media` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/esbuild.browser.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/common` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/AGENTS.md`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/electron-browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel/browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView/browser` |

## UI-Relevant Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser/imageCarousel.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/webview.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/webview.web.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/electron-browser/webview.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel/browser/webviewPanel.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView/browser/webviewView.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/test/browser/imageCarousel.contribution.test.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/webviewService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/electron-browser/webviewService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewView/browser/webviewViewService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/electron-browser/webviewCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webviewPanel/browser/webviewCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/common/webview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/webview/browser/pre/service-worker.js` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/audioPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/binarySizeStatusBarEntry.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/extension.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/mediaPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/ownedStatusBarEntry.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/videoPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/preview-src/events.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/preview-src/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/src/dispose.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/src/extension.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/src/simpleBrowserManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/src/simpleBrowserView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/simple-browser/src/uuid.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/imagePreview/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/imagePreview/sizeStatusBarEntry.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/imagePreview/zoomStatusBarEntry.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/util/dispose.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/util/dom.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/media-preview/src/util/uuid.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditorDiffInput.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditorInput.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditorInputFactory.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/customEditor/browser/customEditors.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/imageCarousel/browser/imageCarouselEditor.ts` | Implementation file participating in the feature surface or supporting source area. |

## Concrete Source Evidence

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
	.registerEditorSerializer(CustomEditorSideBySideDiffInputSerializer.ID, CustomEditorSideBySideDiffInputSerializer);

registerWorkbenchContribution2(ComplexCustomWorkingCopyEditorHandler.ID, ComplexCustomWorkingCopyEditorHandler, WorkbenchPhase.BlockStartup);
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
			default: true,
			markdownDescription: localize('imageCarousel.explorerContextMenu.enabled', "Controls whether the **Open in Images Preview** option appears in the Explorer context menu."),
			tags: ['experimental'],
		},
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
        "selector": [
          {
            "filenamePattern": "*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}"
          }
```

## Repository Inspection Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "class .*View|registerAction2|MenuId\.|toolbar|title|pane|widget|view|css|render|layout" 'src/vs/workbench/contrib/customEditor' 'src/vs/workbench/contrib/imageCarousel' 'src/vs/workbench/contrib/webview' 'src/vs/workbench/contrib/webviewPanel' 'src/vs/workbench/contrib/webviewView' 'extensions/media-preview' 'extensions/simple-browser' 'extensions/notebook-renderers'
find 'bb-docs/webviews-custom-editors-media/ui' -maxdepth 1 -type f | sort
```

