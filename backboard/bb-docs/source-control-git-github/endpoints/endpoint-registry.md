# Source Control Git Github Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/source-control-git-github/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `workbench.scm.action.focusPreviousInput` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.contribution.ts` |
| `workbench.scm.action.focusNextInput` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.contribution.ts` |
| `workbench.scm.action.focusPreviousResourceGroup` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.contribution.ts` |
| `workbench.scm.action.focusNextResourceGroup` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.contribution.ts` |
| `editor.action.dirtydiff.previous` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` |
| `editor.action.dirtydiff.next` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` |
| `workbench.action.editor.previousChange` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` |
| `workbench.action.editor.nextChange` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` |
| `workbench.scm.action.graph.addHistoryItemToChat` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryChatContext.ts` |
| `workbench.scm.action.graph.summarizeHistoryItem` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryChatContext.ts` |
| `workbench.scm.action.graph.addHistoryItemChangeToChat` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryChatContext.ts` |
| `workbench.scm.action.graph.pickRepository` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.pickHistoryItemRefs` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.revealCurrentHistoryItem` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.refresh` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.setListViewMode` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.setTreeViewMode` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.viewChanges` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.scm.action.graph.openFile` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| `workbench.view.scm` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/scm.ts` |
| `workbench.scm` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/scm.ts` |
| `workbench.scm.repositories` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/scm.ts` |
| `workbench.scm.history` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/scm.ts` |
| `backboard.github-authentication` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/githubServer.ts` |
| `git.api.getRepositories` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/api/api1.ts` |
| `git.api.getRepositoryState` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/api/api1.ts` |
| `git.api.getRemoteSources` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/api/api1.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | * |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | 1 entries |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | commandPalette |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | 3 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | 3 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | *, onEditSession:file, onFileSystem:git, onFileSystem:git-show |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | 183 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | title, properties |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | commandPalette, scm/title, scm/repositories/title, scm/repository, scm/sourceControl, scm/artifactGroup/context, scm/artifact/context, scm/resourceGroup/context |
| `contributes.keybindings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | 3 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` |  |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/package.json` | * |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/package.json` | 9 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/package.json` | 1 entries |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/package.json` | commandPalette, file/share, editor/context/share, explorer/context/share, editor/lineNumber/context, editor/title/context/share, scm/historyItem/context, timeline/item/context |

## Endpoint Flow

```text
UI gesture or extension activation
    |
    v
Command/action/menu/view contribution
    |
    v
Service, controller, provider, or extension host boundary
    |
    v
State update, editor update, terminal/process work, webview message, or filesystem/network operation
    |
    v
User-visible result, cancellation, notification, marker, log, or disabled affordance
```

## Endpoint Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.service.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.service.contribution.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISCMService, ISCMViewService } from '../common/scm.js';
import { SCMService } from '../common/scmService.js';
import { SCMViewService } from './scmViewService.js';

registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);
registerSingleton(ISCMViewService, SCMViewService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/git.contributions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/git.contributions.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IGitService } from '../common/gitService.js';
import { GitService } from './gitService.js';

registerSingleton(IGitService, GitService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json
    "vscode": "0.10.x"
  },
  "categories": [
    "Other"
  ],
  "activationEvents": [
    "*"
  ],
  "main": "./out/extension.js",
  "browser": "./dist/browser/extension.js",
  "icon": "resources/icons/git.png",
  "scripts": {
    "compile": "gulp compile-extension:git-base",
    "watch": "gulp watch-extension:git-base",
    "update-grammar": "node ./build/update-grammars.js"
  },
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "contributes": {
    "commands": [
      {
        "command": "git-base.api.getRemoteSources",
        "title": "%command.api.getRemoteSources%",
        "category": "Git Base API"
      }
    ],
    "menus": {
      "commandPalette": [
        {
          "command": "git-base.api.getRemoteSources",
          "when": "false"
        }
      ]
    },
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiff.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiff.contribution.ts
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IQuickDiffService } from '../common/quickDiff.js';
import { QuickDiffService } from '../common/quickDiffService.js';
import { QuickDiffWorkbenchController } from './quickDiffDecorator.js';
import { IQuickDiffModelService, QuickDiffModelService } from './quickDiffModel.js';
import { QuickDiffEditorController } from './quickDiffWidget.js';

MenuRegistry.appendMenuItem(MenuId.EditorLineNumberContext, {
	title: localize('quickDiffDecoration', "Diff Decorations"),
	submenu: MenuId.SCMQuickDiffDecorations,
	when: ContextKeyExpr.or(
		ContextKeyExpr.equals('config.scm.diffDecorations', 'all'),
		ContextKeyExpr.equals('config.scm.diffDecorations', 'gutter')),
	group: '9_quickDiffDecorations'
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(QuickDiffWorkbenchController, LifecyclePhase.Restored);

registerEditorContribution(QuickDiffEditorController.ID,
	QuickDiffEditorController, EditorContributionInstantiation.AfterFirstRender);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'scm',
	order: 5,
	title: localize('scmConfigurationTitle', "Source Control"),
	type: 'object',
	scope: ConfigurationScope.RESOURCE,
	properties: {
		'scm.diffDecorations': {
```

