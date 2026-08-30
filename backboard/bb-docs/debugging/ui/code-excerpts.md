# Debugging UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/debugging/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

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
	const result: { range: Range; options: IModelDecorationOptions }[] = [];
	breakpoints.forEach((breakpoint) => {
		if (breakpoint.lineNumber > model.getLineCount()) {
			return;
		}
		const hasOtherBreakpointsOnLine = breakpoints.some(bp => bp !== breakpoint && bp.lineNumber === breakpoint.lineNumber);
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

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { GlyphMarginLane, IModelDecorationOptions, IModelDeltaDecoration, OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { debugStackframe, debugStackframeFocused } from './debugIcons.js';
import { IDebugService, IStackFrame } from '../common/debug.js';
import './media/callStackEditorContribution.css';

export const topStackFrameColor = registerColor('editor.stackFrameHighlightBackground', { dark: '#ffff0033', light: '#ffff6673', hcDark: '#ffff0033', hcLight: '#ffff6673' }, localize('topStackFrameLineHighlight', 'Background color for the highlight of line at the top stack frame position.'));
export const focusedStackFrameColor = registerColor('editor.focusedStackFrameHighlightBackground', { dark: '#7abd7a4d', light: '#cee7ce73', hcDark: '#7abd7a4d', hcLight: '#cee7ce73' }, localize('focusedStackFrameLineHighlight', 'Background color for the highlight of line at focused stack frame position.'));
const stickiness = TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

// we need a separate decoration for glyph margin, since we do not want it on each line of a multi line statement.
const TOP_STACK_FRAME_MARGIN: IModelDecorationOptions = {
	description: 'top-stack-frame-margin',
	glyphMarginClassName: ThemeIcon.asClassName(debugStackframe),
	glyphMargin: { position: GlyphMarginLane.Right },
	zIndex: 9999,
	stickiness,
	overviewRuler: {
		position: OverviewRulerLane.Full,
		color: themeColorFromId(topStackFrameColor)
	}
};
const FOCUSED_STACK_FRAME_MARGIN: IModelDecorationOptions = {
	description: 'focused-stack-frame-margin',
	glyphMarginClassName: ThemeIcon.asClassName(debugStackframeFocused),
	glyphMargin: { position: GlyphMarginLane.Right },
	zIndex: 9999,
	stickiness,
	overviewRuler: {
		position: OverviewRulerLane.Full,
		color: themeColorFromId(focusedStackFrameColor)
	}
};
export const TOP_STACK_FRAME_DECORATION: IModelDecorationOptions = {
	description: 'top-stack-frame-decoration',
	isWholeLine: true,
	className: 'debug-top-stack-frame-line',
	stickiness
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'src/vs/workbench/contrib/debug' 'extensions/debug-auto-launch' 'extensions/debug-server-ready'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'src/vs/workbench/contrib/debug' 'extensions/debug-auto-launch' 'extensions/debug-server-ready'
```

