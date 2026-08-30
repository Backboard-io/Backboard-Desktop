# Backboard Agent Bridge Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-agent-bridge/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Backboard Agent Bridge        | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `backboard-agent-bridge`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg` - Command/action layer: exposes invokable behavior and menu integration.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/ai_backboard.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/blank.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/acp_registry.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_anthropic.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_backboard.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_bedrock.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_claude.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_deep_seek.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_edit.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_gemini.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_google.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_lm_studio.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_mistral.svg` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/ai_ollama.svg` - Implementation file participating in the feature surface or supporting source area.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg` |

## UI Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts
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
		return true;
	}

	serialize(editorInput: EditorInput): string {
		return '';
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts
import '../../../../optimus/browser/media/optimus.css';
import { Dimension } from '../../../../base/browser/dom.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { OptimusApp } from '../../../../optimus/browser/optimusApp.js';
import { OptimusRunStore } from '../../../../optimus/browser/optimusRunStore.js';
import { ElectronOptimusBackboardBridge } from '../../../../optimus/electron-browser/optimusBackboardBridge.js';
import { ElectronOptimusHistoryProvider } from '../../../../optimus/electron-browser/optimusHistoryService.js';
import { OptimusEditorInput } from './optimusEditorInput.js';

export class OptimusEditor extends EditorPane {

	static readonly ID = 'workbench.editor.optimus';

	private container: HTMLElement | undefined;
	private optimusApp: OptimusApp | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService
	) {
		super(OptimusEditor.ID, group, telemetryService, themeService, storageService);
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M9.66667 4.66667V11.3333C9.66667 11.663 9.76441 11.9852 9.94755 12.2593C10.1307 12.5334 10.391 12.747 10.6955 12.8731C11.0001 12.9993 11.3352 13.0323 11.6585 12.968C11.9818 12.9037 12.2788 12.7449 12.5118 12.5118C12.7449 12.2788 12.9037 11.9818 12.968 11.6585C13.0323 11.3352 12.9993 11.0001 12.8731 10.6955C12.747 10.391 12.5334 10.1307 12.2593 9.94755C11.9852 9.76441 11.663 9.66667 11.3333 9.66667H4.66667C4.33703 9.66667 4.0148 9.76441 3.74072 9.94755C3.46663 10.1307 3.25301 10.391 3.12687 10.6955C3.00072 11.0001 2.96772 11.3352 3.03203 11.6585C3.09633 11.9818 3.25507 12.2788 3.48816 12.5118C3.72124 12.7449 4.01822 12.9037 4.34152 12.968C4.66482 13.0323 4.99993 12.9993 5.30447 12.8731C5.60902 12.747 5.86931 12.5334 6.05245 12.2593C6.23559 11.9852 6.33333 11.663 6.33333 11.3333V4.66667C6.33333 4.33703 6.23559 4.0148 6.05245 3.74072C5.86931 3.46663 5.60902 3.25301 5.30447 3.12687C4.99993 3.00072 4.66482 2.96772 4.34152 3.03203C4.01822 3.09633 3.72124 3.25507 3.48816 3.48816C3.25507 3.72124 3.09633 4.01822 3.03203 4.34152C2.96772 4.66482 3.00072 4.99993 3.12687 5.30447C3.25301 5.60902 3.46663 5.86931 3.74072 6.05245C4.0148 6.23559 4.33703 6.33333 4.66667 6.33333H11.3333C11.663 6.33333 11.9852 6.23559 12.2593 6.05245C12.5334 5.86931 12.747 5.60902 12.8731 5.30447C12.9993 4.99993 13.0323 4.66482 12.968 4.34152C12.9037 4.01822 12.7449 3.72124 12.5118 3.48816C12.2788 3.25507 11.9818 3.09633 11.6585 3.03203C11.3352 2.96772 11.0001 3.00072 10.6955 3.12687C10.391 3.25301 10.1307 3.46663 9.94755 3.74072C9.76441 4.0148 9.66667 4.33703 9.66667 4.66667Z" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

