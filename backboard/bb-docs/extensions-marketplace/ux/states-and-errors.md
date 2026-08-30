# Extensions Marketplace States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extensions-marketplace/ux/states-and-errors.md`

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
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.web.contribution.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/unsupportedExtensionsMigrationContribution.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/electron-browser/devtoolsExtensionHost.contribution.ts` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/electron-browser/extensions.contribution.ts` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/extensions' 'src/vs/workbench/services/extensionManagement' 'src/vs/workbench/services/extensionRecommendations' 'src/vs/workbench/services/extensions' 'src/vs/platform/extensionManagement' 'src/vs/platform/extensions'
```

## State Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { MultiCommand } from '../../../../editor/browser/editorExtensions.js';
import { CopyAction, CutAction, PasteAction } from '../../../../editor/contrib/clipboard/browser/clipboard.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, IAction2Options, IMenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionGalleryManifestStatus, ExtensionGalleryResourceType, ExtensionGalleryServiceUrlConfigKey, getExtensionGalleryManifestResourceUri, IExtensionGalleryManifest, IExtensionGalleryManifestService } from '../../../../platform/extensionManagement/common/extensionGalleryManifest.js';
import { EXTENSION_INSTALL_SOURCE_CONTEXT, ExtensionInstallSource, ExtensionRequestsTimeoutConfigKey, ExtensionsLocalizedLabel, FilterType, IExtensionGalleryService, IExtensionManagementService, PreferencesLocalizedLabel, SortBy, VerifyExtensionSignatureConfigKey } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions, getIdAndVersion } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { IExtensionRecommendationNotificationService } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { EXTENSION_CATEGORIES, ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import * as jsonContributionRegistry from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Extensions, IQuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { Extensions as ConfigurationMigrationExtensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { IsSessionsWindowContext, ResourceContextKey, WorkbenchStateContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, registerWorkbenchContribution2, Extensions as WorkbenchExtensions, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.web.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.web.contribution.ts
import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { RuntimeExtensionsEditor } from './browserRuntimeExtensionsEditor.js';
import { RuntimeExtensionsInput } from '../common/runtimeExtensionsInput.js';
import { EditorExtensions } from '../../../common/editor.js';
import { ShowRuntimeExtensionsAction } from './abstractRuntimeExtensionsEditor.js';

// Running Extensions
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(RuntimeExtensionsEditor, RuntimeExtensionsEditor.ID, localize('runtimeExtension', "Running Extensions")),
	[new SyncDescriptor(RuntimeExtensionsInput)]
);

registerAction2(ShowRuntimeExtensionsAction);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/unsupportedExtensionsMigrationContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/unsupportedExtensionsMigrationContribution.ts
import { IExtensionGalleryService, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { migrateUnsupportedExtensions } from '../../../../platform/extensionManagement/common/unsupportedExtensionsMigration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionManagementServerService } from '../../../services/extensionManagement/common/extensionManagement.js';

export class UnsupportedExtensionsMigrationContrib implements IWorkbenchContribution {

	constructor(
		@IExtensionManagementServerService extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionGalleryService extensionGalleryService: IExtensionGalleryService,
		@IExtensionStorageService extensionStorageService: IExtensionStorageService,
		@IGlobalExtensionEnablementService extensionEnablementService: IGlobalExtensionEnablementService,
		@ILogService logService: ILogService,
	) {
		// Unsupported extensions are not migrated for local extension management server, because it is done in shared process
		if (extensionManagementServerService.remoteExtensionManagementServer) {
			migrateUnsupportedExtensions(undefined, extensionManagementServerService.remoteExtensionManagementServer.extensionManagementService, extensionGalleryService, extensionStorageService, extensionEnablementService, logService);
		}
		if (extensionManagementServerService.webExtensionManagementServer) {
			migrateUnsupportedExtensions(undefined, extensionManagementServerService.webExtensionManagementServer.extensionManagementService, extensionGalleryService, extensionStorageService, extensionEnablementService, logService);
		}
	}

}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/electron-browser/devtoolsExtensionHost.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/electron-browser/devtoolsExtensionHost.contribution.ts
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { DebugExtensionHostInDevToolsAction } from './debugExtensionHostAction.js';

registerAction2(DebugExtensionHostInDevToolsAction);
```

