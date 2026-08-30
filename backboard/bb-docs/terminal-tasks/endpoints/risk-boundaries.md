# Terminal Tasks Endpoint Risk Boundaries

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/terminal-tasks/endpoints/risk-boundaries.md`

## Boundary Diagram

```text
trusted UI state
    |
    v
command/action/menu endpoint
    |
    v
service/controller/provider boundary
    |
    +--> workspace trust / profile / remote authority / extension host
    +--> filesystem / terminal / process / network / webview / authentication when present
    +--> notification / marker / log / telemetry when present
    |
    v
visible result
```

## Risk Table

| Boundary | Failure mode | Review action | Source anchor |
|---|---|---|---|
| Command visibility | Command appears in the wrong context or remains hidden when valid. | Inspect when clauses, context keys, and menu groups. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.ts` |
| Service call | Service dependency is unavailable, delayed, or disposed. | Inspect constructor injection, lifecycle, and Disposable handling. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/common/capabilities/partialCommandDetectionCapability.ts` |
| Async boundary | Cancellation, error, or concurrent invocation leaves UI in stale state. | Inspect CancellationToken, promises, event listeners, and finally blocks. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.ts` |
| External boundary | Filesystem, network, extension host, browser view, terminal, or secret store returns failure. | Inspect validation, message routing, and recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.ts` |

## Boundary Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.ts
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { combinedDisposable, Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { listInactiveSelectionBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { registerColor, transparent } from '../../../../../platform/theme/common/colorUtils.js';
import { PANEL_BORDER } from '../../../../common/theme.js';
import { IDetachedTerminalInstance, ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type IDetachedCompatibleTerminalContributionContext, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { terminalCommandGuideConfigSection, TerminalCommandGuideSettingId, type ITerminalCommandGuideConfiguration } from '../common/terminalCommandGuideConfiguration.js';
import { isFullTerminalCommand } from '../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';

// #region Terminal Contributions

class TerminalCommandGuideContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.commandGuide';

	static get(instance: ITerminalInstance | IDetachedTerminalInstance): TerminalCommandGuideContribution | null {
		return instance.getContribution<TerminalCommandGuideContribution>(TerminalCommandGuideContribution.ID);
	}

	private _xterm: IXtermTerminal & { raw: RawXtermTerminal } | undefined;
	private readonly _activeCommandGuide = this._register(new MutableDisposable());

	constructor(
		private readonly _ctx: ITerminalContributionContext | IDetachedCompatibleTerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/common/capabilities/partialCommandDetectionCapability.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/common/capabilities/partialCommandDetectionCapability.ts
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPartialCommandDetectionCapability, TerminalCapability } from './capabilities.js';
import type { IMarker, Terminal } from '@xterm/headless';

const enum Constants {
	/**
	 * The minimum size of the prompt in which to assume the line is a command.
	 */
	MinimumPromptLength = 2
}

/**
 * This capability guesses where commands are based on where the cursor was when enter was pressed.
 * It's very hit or miss but it's often correct and better than nothing.
 */
export class PartialCommandDetectionCapability extends DisposableStore implements IPartialCommandDetectionCapability {
	readonly type = TerminalCapability.PartialCommandDetection;

	private readonly _commands: IMarker[] = [];

	get commands(): readonly IMarker[] { return this._commands; }

	private readonly _onCommandFinished = this.add(new Emitter<IMarker>());
	readonly onCommandFinished = this._onCommandFinished.event;

	constructor(
		private readonly _terminal: Terminal,
		private _onDidExecuteText: Event<void> | undefined
	) {
		super();
		this.add(this._terminal.onData(e => this._onData(e)));
		this.add(this._terminal.parser.registerCsiHandler({ final: 'J' }, params => {
			if (params.length >= 1 && (params[0] === 2 || params[0] === 3)) {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.ts
import * as nls from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { URI } from '../../../../base/common/uri.js';
import { MenuId, MenuRegistry, IMenuItem } from '../../../../platform/actions/common/actions.js';
import { ITerminalGroupService, ITerminalService as IIntegratedTerminalService } from '../../terminal/browser/terminal.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { getMultiSelectedResources, IExplorerService } from '../../files/browser/files.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Schemas } from '../../../../base/common/network.js';
import { distinct } from '../../../../base/common/arrays.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { dirname, basename } from '../../../../base/common/path.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IExternalTerminalConfiguration, IExternalTerminalService } from '../../../../platform/externalTerminal/common/externalTerminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

const OPEN_IN_TERMINAL_COMMAND_ID = 'openInTerminal';
const OPEN_IN_INTEGRATED_TERMINAL_COMMAND_ID = 'openInIntegratedTerminal';

function registerOpenTerminalCommand(id: string, explorerKind: 'integrated' | 'external') {
	CommandsRegistry.registerCommand({
		id: id,
		handler: async (accessor, resource: URI) => {

			const configurationService = accessor.get(IConfigurationService);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.ts
import * as nls from '../../../../nls.js';
import * as paths from '../../../../base/common/path.js';
import { IExternalTerminalSettings } from '../../../../platform/externalTerminal/common/externalTerminal.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Schemas } from '../../../../base/common/network.js';
import { IConfigurationRegistry, Extensions, ConfigurationScope, type IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { IExternalTerminalService } from '../../../../platform/externalTerminal/electron-browser/externalTerminalService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { URI } from '../../../../base/common/uri.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

const OPEN_NATIVE_CONSOLE_COMMAND_ID = 'workbench.action.terminal.openNativeConsole';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: OPEN_NATIVE_CONSOLE_COMMAND_ID,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC,
	when: ContextKeyExpr.and(TerminalContextKeys.notFocus, IsSessionsWindowContext.negate()),
	weight: KeybindingWeight.WorkbenchContrib,
	handler: async (accessor) => {
		const historyService = accessor.get(IHistoryService);
		// Open external terminal in local workspaces
		const terminalService = accessor.get(IExternalTerminalService);
		const configurationService = accessor.get(IConfigurationService);
```

