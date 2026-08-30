# Search Navigation States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/search-navigation/ux/states-and-errors.md`

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
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.common.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/replaceContributions.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.contribution.ts` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/searchQuickAccess.contribution.ts` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/quickaccess' 'src/vs/workbench/contrib/search' 'src/vs/workbench/contrib/searchEditor'
```

## State Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.common.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.common.contribution.ts
// Common search service registrations shared between the main workbench and the Agents window.

import * as nls from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerContributions as replaceContributions } from './replaceContributions.js';
import { registerContributions as notebookSearchContributions } from './notebookSearch/notebookSearchContributions.js';
import { ISearchHistoryService, SearchHistoryService } from '../common/searchHistoryService.js';
import { searchConfigurationNode } from '../common/search.js';

replaceContributions();
notebookSearchContributions();
registerSingleton(ISearchHistoryService, SearchHistoryService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...searchConfigurationNode,
	properties: {
		'search.searchOnType': {
			type: 'boolean',
			default: true,
			description: nls.localize('search.searchOnType', "Search all files as you type.")
		},
		'search.searchOnTypeDebouncePeriod': {
			type: 'number',
			default: 300,
			markdownDescription: nls.localize('search.searchOnTypeDebouncePeriod', "When {0} is enabled, controls the timeout in milliseconds between a character being typed and the search starting. Has no effect when {0} is disabled.", '`#search.searchOnType#`')
		},
	}
});
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts
import { IQuickAccessRegistry, Extensions } from '../../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { HelpQuickAccessProvider } from '../../../../platform/quickinput/browser/helpQuickAccess.js';
import { ViewQuickAccessProvider, OpenViewPickerAction, QuickAccessViewPickerAction } from './viewQuickAccess.js';
import { CommandsQuickAccessProvider, ShowAllCommandsAction, ClearCommandHistoryAction } from './commandsQuickAccess.js';
import { MenuRegistry, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { inQuickPickContext, getQuickNavigateHandler } from '../../../browser/quickaccess.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';

//#region Quick Access Proviers

const quickAccessRegistry = Registry.as<IQuickAccessRegistry>(Extensions.Quickaccess);

quickAccessRegistry.registerQuickAccessProvider({
	ctor: HelpQuickAccessProvider,
	prefix: HelpQuickAccessProvider.PREFIX,
	helpEntries: [{
		description: localize('helpQuickAccess', "Show all Quick Access Providers"),
		commandCenterOrder: 70,
		commandCenterLabel: localize('more', 'More')
	}]
});

quickAccessRegistry.registerQuickAccessProvider({
	ctor: ViewQuickAccessProvider,
	prefix: ViewQuickAccessProvider.PREFIX,
	contextKey: 'inViewsPicker',
	helpEntries: [{ description: localize('viewQuickAccess', "Open View"), commandId: OpenViewPickerAction.ID }]
});

quickAccessRegistry.registerQuickAccessProvider({
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/replaceContributions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/replaceContributions.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IReplaceService } from './replace.js';
import { ReplaceService, ReplacePreviewContentProvider } from './replaceService.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

export function registerContributions(): void {
	registerSingleton(IReplaceService, ReplaceService, InstantiationType.Delayed);
	registerWorkbenchContribution2(ReplacePreviewContentProvider.ID, ReplacePreviewContentProvider, WorkbenchPhase.BlockStartup /* registration only */);
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/search/browser/search.contribution.ts
import * as platform from '../../../../base/common/platform.js';
import * as nls from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { searchViewIcon } from './searchIcons.js';
import { SearchView } from './searchView.js';
import { registerContributions as searchWidgetContributions } from './searchWidget.js';
import { SearchViewModelWorkbenchService } from './searchTreeModel/searchModel.js';
import { ISearchViewModelWorkbenchService } from './searchTreeModel/searchViewModelWorkbenchService.js';
import { SearchSortOrder, SEARCH_EXCLUDE_CONFIG, VIEWLET_ID, ViewMode, VIEW_ID, DEFAULT_MAX_SEARCH_RESULTS, SemanticSearchBehavior } from '../../../services/search/common/search.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { assertType } from '../../../../base/common/types.js';
import { getWorkspaceSymbols, IWorkspaceSymbol, searchConfigurationNode } from '../common/search.js';
import * as Constants from '../common/constants.js';
import { SearchChatContextContribution } from './searchChatContext.js';

import './searchActionsCopy.js';
import './searchActionsFind.js';
import './searchActionsNav.js';
import './searchActionsRemoveReplace.js';
import './searchActionsTopBar.js';
import './searchActionsTextQuickAccess.js';
import './searchQuickAccess.contribution.js';
import './search.common.contribution.js';
import { TEXT_SEARCH_QUICK_ACCESS_PREFIX, TextSearchQuickAccess } from './quickTextSearch/textSearchQuickAccess.js';
import { Extensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SearchAccessibilityHelp } from './searchAccessibilityHelp.js';
```

