# Diff Merge History Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/diff-merge-history/features/extension-points.md`

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
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json` | onStartupFinished |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json` | 10 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json` | title, properties |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/merge-conflict/package.json` | scm/resourceState/context, editor/title |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/search-result/package.json` | onLanguage:search-result |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/search-result/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/search-result/package.json` | 1 entries |

## Runtime Extension Points

- `ITimelineService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/timeline/browser/timeline.service.contribution.ts`
- `ILifecycleService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IEditSessionsStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IEditSessionsLogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `ISCMService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IWorkspaceContextService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IProgressService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `INotificationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IFileDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IProductService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IOpenerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IQuickInputService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IViewsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IEditSessionIdentityService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IOutputService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IActivityService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IRemoteAgentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IExtensionsWorkbenchService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `IUserDataProfilesService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`

## Command/Menu Extension Points

- `workbench.editSessions.actions.showOutputChannel` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.action.continueOn.extensions` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.editSessions.actions.showEditSessions` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.editSessions.actions.resumeLatest` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.editSessions.actions.resumeFromSerializedPayload` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.editSessions.actions.storeCurrent` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessions.contribution.ts`
- `workbench.editSessions.actions.resetAuth` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsStorageService.ts`
- `workbench.action.localHistory.compareWithFile` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.compareWithPrevious` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.selectForCompare` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.compareWithSelected` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.open` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.restoreViaEditor` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.restore` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.restoreViaPicker` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.rename` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.delete` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.deleteAll` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.create` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistoryCommands.ts`
- `workbench.action.localHistory.revealInOS` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/electron-browser/localHistoryCommands.ts`
- `workbench.editSessions.actions.resume` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsViews.ts`
- `workbench.editSessions.actions.store` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsViews.ts`
- `workbench.editSessions.actions.delete` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsViews.ts`
- `workbench.editSessions.actions.deleteAll` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsViews.ts`
- `vscode.diff` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/browser/editSessionsViews.ts`
- `workbench.view.editSessions` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/common/editSessions.ts`
- `workbench.views.editSessions.data` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editSessions/common/editSessions.ts`

## Extension Point Code Evidence

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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getVirtualWorkspaceLocation } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { Schemas } from '../../../../base/common/network.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IExtensionService, isProposedApiEnabled } from '../../../services/extensions/common/extensions.js';
import { EditSessionsLogService } from '../common/editSessionsLogService.js';
import { IViewContainersRegistry, Extensions as ViewExtensions, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
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
        "category": "%command.category%",
        "title": "%command.accept.all-incoming%",
        "original": "Accept All Incoming",
        "command": "merge-conflict.accept.all-incoming",
        "enablement": "!isMergeEditor"
      },
      {
        "category": "%command.category%",
        "title": "%command.accept.all-both%",
        "original": "Accept All Both",
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistory.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localHistory/browser/localHistory.contribution.ts
import './localHistoryCommands.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { LocalHistoryTimeline } from './localHistoryTimeline.js';

// Register Local History Timeline
registerWorkbenchContribution2(LocalHistoryTimeline.ID, LocalHistoryTimeline, WorkbenchPhase.BlockRestore /* registrations only */);
```

