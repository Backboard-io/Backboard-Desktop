# Debugging

This folder is the feature dossier for `debugging`. It splits the feature into UI, UX, endpoint, and implementation documentation so a reviewer can move from visible behavior to code ownership without guessing.

## Absolute Location

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/debugging`

## Folder Map

```text
debugging/
|-- README.md
|-- ui/
|   |-- README.md
|   |-- source-inventory.md
|   |-- screen-map.md
|   L-- code-excerpts.md
|-- ux/
|   |-- README.md
|   |-- journeys.md
|   |-- states-and-errors.md
|   L-- validation-playbook.md
|-- endpoints/
|   |-- README.md
|   |-- endpoint-registry.md
|   |-- commands-settings-services.md
|   L-- risk-boundaries.md
L-- features/
    |-- README.md
    |-- implementation-map.md
    |-- ownership-and-files.md
    L-- extension-points.md
```

## Source Coverage

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/esbuild.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/esbuild.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/electron-browser` |

## Primary Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/extensionHostDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/electron-browser/extensionHostDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugActionViewItems.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/callStackEditorContribution.css` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/debug.contribution.css` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/nullDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/debugViewModel.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/disassemblyViewInput.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |

## Quick Code Anchor

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { DebugService } from './debugService.js';
import { IDebugService } from '../common/debug.js';
import { IDebugVisualizerService, DebugVisualizerService } from '../common/debugVisualizers.js';

registerSingleton(IDebugService, DebugService, InstantiationType.Delayed);
registerSingleton(IDebugVisualizerService, DebugVisualizerService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts
import { generateUuid } from '../../../../base/common/uuid.js';
import { ContentWidgetPositionPreference, IActiveCodeEditor, ICodeEditor, IContentWidget, IContentWidgetPosition, IEditorMouseEvent, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { GlyphMarginLane, IModelDecorationOptions, IModelDecorationOverviewRulerOptions, IModelDecorationsChangeAccessor, ITextModel, OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import * as nls from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { registerThemingParticipant, themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { GutterActionsRegistry } from '../../codeEditor/browser/editorLineNumberMenu.js';
import { getBreakpointMessageAndIcon } from './breakpointsView.js';
import { BreakpointWidget } from './breakpointWidget.js';
import * as icons from './debugIcons.js';
import { BREAKPOINT_EDITOR_CONTRIBUTION_ID, BreakpointWidgetContext, CONTEXT_BREAKPOINT_WIDGET_VISIBLE, DebuggerString, IBreakpoint, IBreakpointEditorContribution, IBreakpointUpdateData, IDebugConfiguration, IDebugService, IDebugSession, State } from '../common/debug.js';

const $ = dom.$;

interface IBreakpointDecoration {
	decorationId: string;
	breakpoint: IBreakpoint;
	range: Range;
```

## Reviewer Entry Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'bb-docs/debugging' -maxdepth 3 -type f | sort
rg -n "registerAction2|CommandsRegistry|MenuRegistry|createDecorator|class |interface |package.json|contributes" 'extensions/debug-auto-launch' 'extensions/debug-server-ready' 'src/vs/workbench/contrib/debug'
rg -n "debugging|Debugging" bb-docs/debugging
```

