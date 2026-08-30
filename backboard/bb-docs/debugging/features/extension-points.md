# Debugging Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/debugging/features/extension-points.md`

## Extension-Point Diagram

```text
package.json / contribution file
    |
    v
command, menu, view, provider, or service registration
    |
    v
activation and context-key gate
    |
    v
runtime implementation
    |
    v
visible feature behavior
```

## Declarative Extension Points

| Contribution type | Source file | Detail |
|---|---|---|
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json` | onStartupFinished |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.json` | onDebugResolve |
| `contributes.debuggers` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.json` | 1 entries |

## Runtime Extension Points

- `IDebugService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts`
- `IDebugVisualizerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts`
- `ILanguageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IContextMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `ILabelService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `IDebugService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `ILogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts`
- `IUriIdentityService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts`
- `IDebugService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts`
- `ILanguageFeatureDebounceService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `ILanguageFeaturesService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IModelService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IUriIdentityService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IDebugService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IHostService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`
- `IExtensionHostDebugService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`
- `IDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`
- `IFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts`

## Command/Menu Extension Points

- `debug.removeBreakpoint` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.debug.action.editBreakpointAction` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts`
- `debug.installAdditionalDebuggers` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.debug.action.toggleRepl` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- `workbench.debug.action.focusVariablesView` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- `workbench.debug.action.focusWatchView` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- `workbench.debug.action.focusCallStackView` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- `workbench.debug.action.focusBreakpointsView` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- `debug.addConfiguration` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `editor.debug.action.copyAddress` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `editor.debug.action.toggleBreakpoint` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `editor.debug.action.toggleInlineBreakpoint` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `debug.copyStackTrace` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.reverseContinue` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stepBack` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.restart` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.terminateThread` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stepOver` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stepInto` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stepIntoTarget` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stepOut` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.pause` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.disconnect` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.disconnectAndSuspend` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.stop` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.restartFrame` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.continue` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.debug.action.focusRepl` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `debug.jumpToCursor` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`
- `workbench.action.debug.focusProcess` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts`

## Extension Point Code Evidence

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
	inlineWidget?: InlineBreakpointWidget;
}

const breakpointHelperDecoration: IModelDecorationOptions = {
	description: 'breakpoint-helper-decoration',
	glyphMarginClassName: ThemeIcon.asClassName(icons.debugBreakpointHint),
	glyphMargin: { position: GlyphMarginLane.Right },
	glyphMarginHoverMessage: new MarkdownString().appendText(nls.localize('breakpointHelper', "Click to add a breakpoint")),
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
};

export function createBreakpointDecorations(accessor: ServicesAccessor, model: ITextModel, breakpoints: ReadonlyArray<IBreakpoint>, state: State, breakpointsActivated: boolean, showBreakpointsInOverviewRuler: boolean): { range: Range; options: IModelDecorationOptions }[] {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/callStackEditorContribution.css

```css
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/callStackEditorContribution.css
.monaco-editor .view-overlays .debug-top-stack-frame-line {
	background-color: var(--vscode-editor-stackFrameHighlightBackground);
}

.monaco-editor .view-overlays .debug-focused-stack-frame-line {
	background-color: var(--vscode-editor-focusedStackFrameHighlightBackground);
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json
    "virtualWorkspaces": false,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./out/extension",
  "scripts": {
    "compile": "gulp compile-extension:debug-auto-launch",
    "watch": "gulp watch-extension:debug-auto-launch"
  },
  "contributes": {
    "commands": [
      {
        "command": "extension.node-debug.toggleAutoAttach",
        "title": "%toggle.auto.attach%",
        "category": "Debug"
      }
    ]
  },
  "devDependencies": {
    "@types/node": "24.x"
  },
  "prettier": {
    "printWidth": 100,
    "trailingComma": "all",
    "singleQuote": true,
    "arrowParens": "avoid"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/microsoft/vscode.git"
  }
}
```

