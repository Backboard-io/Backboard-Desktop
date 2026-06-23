# Backboard Agent Bridge States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-agent-bridge/ux/states-and-errors.md`

## State Machine

```text
[inactive]
    | contribution registered or extension activated
    v
[available]
    | command/menu/view invoked
    v
[working]
    | success        | cancel        | failure
    v              v               v
[ready]       [cancelled]      [error-recovery]
    |              |               |
    +--------------+---------------+--> [available]
```

## State And Failure Matrix

| Condition | User-facing requirement | Source evidence |
|---|---|---|
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/ai_backboard.svg` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/optimus' 'extensions/backboard'
```

## State Code Anchors

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

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return OptimusEditorInput.instance;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(OptimusEditorInput.ID, OptimusEditorInputSerializer);
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

	protected override createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'optimus-editor-container';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/command.svg
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M9.66667 4.66667V11.3333C9.66667 11.663 9.76441 11.9852 9.94755 12.2593C10.1307 12.5334 10.391 12.747 10.6955 12.8731C11.0001 12.9993 11.3352 13.0323 11.6585 12.968C11.9818 12.9037 12.2788 12.7449 12.5118 12.5118C12.7449 12.2788 12.9037 11.9818 12.968 11.6585C13.0323 11.3352 12.9993 11.0001 12.8731 10.6955C12.747 10.391 12.5334 10.1307 12.2593 9.94755C11.9852 9.76441 11.663 9.66667 11.3333 9.66667H4.66667C4.33703 9.66667 4.0148 9.76441 3.74072 9.94755C3.46663 10.1307 3.25301 10.391 3.12687 10.6955C3.00072 11.0001 2.96772 11.3352 3.03203 11.6585C3.09633 11.9818 3.25507 12.2788 3.48816 12.5118C3.72124 12.7449 4.01822 12.9037 4.34152 12.968C4.66482 13.0323 4.99993 12.9993 5.30447 12.8731C5.60902 12.747 5.86931 12.5334 6.05245 12.2593C6.23559 11.9852 6.33333 11.663 6.33333 11.3333V4.66667C6.33333 4.33703 6.23559 4.0148 6.05245 3.74072C5.86931 3.46663 5.60902 3.25301 5.30447 3.12687C4.99993 3.00072 4.66482 2.96772 4.34152 3.03203C4.01822 3.09633 3.72124 3.25507 3.48816 3.48816C3.25507 3.72124 3.09633 4.01822 3.03203 4.34152C2.96772 4.66482 3.00072 4.99993 3.12687 5.30447C3.25301 5.60902 3.46663 5.86931 3.74072 6.05245C4.0148 6.23559 4.33703 6.33333 4.66667 6.33333H11.3333C11.663 6.33333 11.9852 6.23559 12.2593 6.05245C12.5334 5.86931 12.747 5.60902 12.8731 5.30447C12.9993 4.99993 13.0323 4.66482 12.968 4.34152C12.9037 4.01822 12.7449 3.72124 12.5118 3.48816C12.2788 3.25507 11.9818 3.09633 11.6585 3.03203C11.3352 2.96772 11.0001 3.00072 10.6955 3.12687C10.391 3.25301 10.1307 3.46663 9.94755 3.74072C9.76441 4.0148 9.66667 4.33703 9.66667 4.66667Z" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const optimusEditorIcon = registerIcon('optimus-editor-label-icon', Codicon.sparkle, localize('optimusEditorLabelIcon', 'Icon of the Optimus editor label.'));

export class OptimusEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.optimus';
	static readonly RESOURCE = URI.from({ scheme: 'optimus', path: 'default' });

	private static _instance: OptimusEditorInput | undefined;

	static get instance(): OptimusEditorInput {
		if (!OptimusEditorInput._instance || OptimusEditorInput._instance.isDisposed()) {
			OptimusEditorInput._instance = new OptimusEditorInput();
		}
		return OptimusEditorInput._instance;
	}

	override get typeId(): string {
		return OptimusEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return OptimusEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	readonly resource = OptimusEditorInput.RESOURCE;

	override getName(): string {
```

