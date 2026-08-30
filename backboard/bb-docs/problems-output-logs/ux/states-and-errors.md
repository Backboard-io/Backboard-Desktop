# Problems Output Logs States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/problems-output-logs/ux/states-and-errors.md`

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
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/browser/logs.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/electron-browser/logs.contribution.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers/browser/markers.contribution.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/output/browser/output.contribution.ts` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/output/browser/outputServices.ts` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/logs' 'src/vs/workbench/contrib/markers' 'src/vs/workbench/contrib/output'
```

## State Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/browser/logs.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/browser/logs.contribution.ts
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenWindowSessionLogFileAction } from '../common/logsActions.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { LogsDataCleaner } from '../common/logsDataCleaner.js';

class WebLogOutputChannels extends Disposable implements IWorkbenchContribution {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.registerWebContributions();
	}

	private registerWebContributions(): void {
		this.instantiationService.createInstance(LogsDataCleaner);

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: OpenWindowSessionLogFileAction.ID,
					title: OpenWindowSessionLogFileAction.TITLE,
					category: Categories.Developer,
					f1: true
				});
			}
			run(servicesAccessor: ServicesAccessor): Promise<void> {
				return servicesAccessor.get(IInstantiationService).createInstance(OpenWindowSessionLogFileAction, OpenWindowSessionLogFileAction.ID, OpenWindowSessionLogFileAction.TITLE.value).run();
			}
		}));
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/electron-browser/logs.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/electron-browser/logs.contribution.ts
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenLogsFolderAction, OpenExtensionLogsFolderAction } from './logsActions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OpenLogsFolderAction.ID,
			title: OpenLogsFolderAction.TITLE,
			category: Categories.Developer,
			f1: true
		});
	}
	run(servicesAccessor: ServicesAccessor): Promise<void> {
		return servicesAccessor.get(IInstantiationService).createInstance(OpenLogsFolderAction, OpenLogsFolderAction.ID, OpenLogsFolderAction.TITLE.value).run();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OpenExtensionLogsFolderAction.ID,
			title: OpenExtensionLogsFolderAction.TITLE,
			category: Categories.Developer,
			f1: true
		});
	}
	run(servicesAccessor: ServicesAccessor): Promise<void> {
		return servicesAccessor.get(IInstantiationService).createInstance(OpenExtensionLogsFolderAction, OpenExtensionLogsFolderAction.ID, OpenExtensionLogsFolderAction.TITLE.value).run();
	}
});
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers/browser/markersViewActions.css

```css
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers/browser/markersViewActions.css
.markers-panel-action-filter > .markers-panel-filter-controls > .monaco-action-bar .action-label.markers-filters.checked {
	border-color: var(--vscode-inputOption-activeBorder);
	color: var(--vscode-inputOption-activeForeground);
	background-color: var(--vscode-inputOption-activeBackground);
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers/browser/markers.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers/browser/markers.contribution.ts
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Marker, RelatedInformation, ResourceMarkers } from './markersModel.js';
import { MarkersView } from './markersView.js';
import { MenuId, registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { MarkersViewMode, Markers, MarkersContextKeys } from '../common/markers.js';
import Messages from './messages.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IMarkersView } from './markers.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment, IStatusbarEntry } from '../../../services/statusbar/browser/statusbar.js';
import { IMarkerService, MarkerStatistics } from '../../../../platform/markers/common/markers.js';
import { ViewContainer, IViewContainersRegistry, Extensions as ViewContainerExtensions, ViewContainerLocation, IViewsRegistry, WindowEnablement } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getVisbileViewContextKey, FocusedViewContext } from '../../../common/contextkeys.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { viewFilterSubmenu } from '../../../browser/parts/views/viewFilter.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { problemsConfigurationNodeBase } from '../../../common/configuration.js';
import { MarkerChatContextContribution } from './markersChatContext.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ProblemsAccessibilityHelp } from './markersAccessibilityHelp.js';

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: Markers.MARKER_OPEN_ACTION_ID,
	weight: KeybindingWeight.WorkbenchContrib,
```

