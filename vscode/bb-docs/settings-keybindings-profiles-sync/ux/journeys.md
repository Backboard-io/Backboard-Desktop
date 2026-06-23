# Settings Keybindings Profiles Sync UX Journeys

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/settings-keybindings-profiles-sync/ux/journeys.md`

## Primary Journey

```text
User intent
   |
   v
Find entry point for settings-keybindings-profiles-sync
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
| Discover | User opens command palette, menu, view, editor, or extension surface. | Contribution and context keys decide visibility. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindings/browser/keybindings.contribution.ts` |
| Invoke | User selects the command or starts the flow. | Command/action delegates to a service, controller, provider, or extension activation. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindingsExport/electron-browser/keybindingsExport.contribution.ts` |
| Work | Feature reads state, writes state, starts a task, or renders content. | Events and services keep the UI synchronized. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/preferences/browser/keybindingsEditorContribution.ts` |
| Recover | User hits an error, cancellation, offline state, unavailable context, or disabled workspace. | Notification, inline message, log, disabled state, or fallback flow communicates recovery. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts` |

## UX Detail Notes

- Keep text action labels tied to the exact command or menu label in source.
- Verify focus order when the feature owns toolbar, tree, editor, webview, terminal, notebook, or quick access UI.
- Verify cancellation and retry affordances where source shows async work, token usage, network calls, process execution, or extension activation.
- Verify reduced-width and high-contrast behavior where CSS or workbench layout files are part of the source inventory.

## Code Anchor For Journey Review

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindings/browser/keybindings.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindings/browser/keybindings.contribution.ts
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { showWindowLogActionId } from '../../../services/log/common/logConstants.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { $, addDisposableListener, append, getDomNodePagePosition, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { createCSSRule, createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Emitter } from '../../../../base/common/event.js';

class ToggleKeybindingsLogAction extends Action2 {
	static disposable: IDisposable | undefined;

	constructor() {
		super({
			id: 'workbench.action.toggleKeybindingsLog',
			title: nls.localize2('toggleKeybindingsLog', "Toggle Keyboard Shortcuts Troubleshooting"),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor): void {
		const logging = accessor.get(IKeybindingService).toggleLogging();
		if (logging) {
			const commandService = accessor.get(ICommandService);
			commandService.executeCommand(showWindowLogActionId);
		}

		if (ToggleKeybindingsLogAction.disposable) {
			ToggleKeybindingsLogAction.disposable.dispose();
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindingsExport/electron-browser/keybindingsExport.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindingsExport/electron-browser/keybindingsExport.contribution.ts
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { join } from '../../../../base/common/path.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IKeybindingItem, KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { KeybindingParser } from '../../../../base/common/keybindingParser.js';
import { IExtensionDescription, IKeyBinding } from '../../../../platform/extensions/common/extensions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IKeyboardMapper } from '../../../../platform/keyboardLayout/common/keyboardMapper.js';
import { IMacLinuxKeyboardMapping, IWindowsKeyboardMapping } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { MacLinuxKeyboardMapper } from '../../../services/keybinding/common/macLinuxKeyboardMapper.js';
import { WindowsKeyboardMapper } from '../../../services/keybinding/common/windowsKeyboardMapper.js';
import { IKeymapInfo, KeymapInfo } from '../../../services/keybinding/common/keymapInfo.js';
import { EN_US_WIN_LAYOUT } from '../../../services/keybinding/browser/keyboardLayouts/en.win.js';
import { EN_US_DARWIN_LAYOUT } from '../../../services/keybinding/browser/keyboardLayouts/en.darwin.js';
import { EN_US_LINUX_LAYOUT } from '../../../services/keybinding/browser/keyboardLayouts/en.linux.js';
import { KeybindingIO, OutputBuilder } from '../../../services/keybinding/common/keybindingIO.js';
import { getAllUnboundCommands } from '../../../services/keybinding/browser/unboundCommands.js';

export class KeybindingsExportContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.keybindingsExport';

	constructor(
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/preferences/browser/keybindingsEditorContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/preferences/browser/keybindingsEditorContribution.ts
import * as nls from '../../../../nls.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { registerEditorContribution, EditorContributionInstantiation } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { SmartSnippetInserter } from '../common/smartSnippetInserter.js';
import { DefineKeybindingOverlayWidget } from './keybindingWidgets.js';
import { parseTree, Node } from '../../../../base/common/json.js';
import { WindowsNativeResolvedKeybinding } from '../../../services/keybinding/common/windowsKeyboardMapper.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { ThemeColor } from '../../../../base/common/themables.js';
import { overviewRulerInfo, overviewRulerError } from '../../../../editor/common/core/editorColorRegistry.js';
import { IModelDeltaDecoration, ITextModel, TrackedRangeStickiness, OverviewRulerLane } from '../../../../editor/common/model.js';
import { KeybindingParser } from '../../../../base/common/keybindingParser.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { DEFINE_KEYBINDING_EDITOR_CONTRIB_ID, IDefineKeybindingEditorContribution } from '../../../services/preferences/common/preferences.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';

const NLS_KB_LAYOUT_ERROR_MESSAGE = nls.localize('defineKeybinding.kbLayoutErrorMessage', "You won't be able to produce this key combination under your current keyboard layout.");

class DefineKeybindingEditorContribution extends Disposable implements IDefineKeybindingEditorContribution {

	private readonly _keybindingDecorationRenderer = this._register(new MutableDisposable<KeybindingEditorDecorationsRenderer>());

	private readonly _defineWidget: DefineKeybindingOverlayWidget;

	constructor(
```

