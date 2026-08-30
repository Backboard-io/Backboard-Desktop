# Diff Merge History Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/diff-merge-history/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Diff Merge History            | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `diff-merge-history`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.service.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistory.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/electron-browser/localHistory.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mergeEditor/browser/mergeEditor.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mergeEditor/electron-browser/mergeEditor.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/multiDiffEditor/browser/icons.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bulkEdit/browser/preview/bulkEdit.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bulkEdit/browser/bulkEditService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsStorageService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts` - Command/action layer: exposes invokable behavior and menu integration.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/electron-browser/localHistoryCommands.ts` - Command/action layer: exposes invokable behavior and menu integration.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mergeEditor/electron-browser/devCommands.ts` - Command/action layer: exposes invokable behavior and menu integration.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/multiDiffEditor/browser/actions.ts` - Command/action layer: exposes invokable behavior and menu integration.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mergeEditor/browser/commands/commands.ts` - Command/action layer: exposes invokable behavior and menu integration.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.service.contribution.ts` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistory.contribution.ts` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/electron-browser/localHistory.contribution.ts` |

## UI Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.service.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.service.contribution.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITimelineService } from '../common/timeline.js';
import { TimelineService } from '../common/timelineService.js';

registerSingleton(ITimelineService, TimelineService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ILifecycleService, LifecyclePhase, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';
import { Action2, IAction2Options, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IEditSessionsStorageService, Change, ChangeType, Folder, EditSession, FileType, EDIT_SESSION_SYNC_CATEGORY, EDIT_SESSIONS_CONTAINER_ID, EditSessionSchemaVersion, IEditSessionsLogService, EDIT_SESSIONS_VIEW_ICON, EDIT_SESSIONS_TITLE, EDIT_SESSIONS_SHOW_VIEW, EDIT_SESSIONS_DATA_VIEW_ID, decodeEditSessionFileContent, hashedEditSessionId, editSessionsLogId, EDIT_SESSIONS_PENDING } from '../common/editSessions.js';
import { ISCMRepository, ISCMService } from '../../scm/common/scm.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, joinPath, relativePath } from '../../../../base/common/resources.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProgress, IProgressService, IProgressStep, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { EditSessionsWorkbenchService } from './editSessionsStorageService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { UserDataSyncErrorCode, UserDataSyncStoreError } from '../../../../platform/userDataSync/common/userDataSync.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { getFileNamesMessage, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./out/mergeConflictMain",
  "browser": "./dist/browser/mergeConflictMain",
  "scripts": {
    "compile": "gulp compile-extension:merge-conflict",
    "watch": "gulp watch-extension:merge-conflict",
    "compile-web": "npm-run-all2 -lp bundle-web typecheck-web",
    "bundle-web": "node ./esbuild.browser.mts",
    "typecheck-web": "tsgo --project ./tsconfig.json --noEmit",
    "watch-web": "npm-run-all2 -lp watch-bundle-web watch-typecheck-web",
    "watch-bundle-web": "node ./esbuild.browser.mts --watch",
    "watch-typecheck-web": "tsgo --project ./tsconfig.json --noEmit --watch"
  },
  "contributes": {
    "commands": [
      {
        "category": "%command.category%",
        "title": "%command.accept.all-current%",
        "original": "Accept All Current",
        "command": "merge-conflict.accept.all-current",
        "enablement": "!isMergeEditor"
      },
      {
```

