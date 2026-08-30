# Extensions Marketplace Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extensions-marketplace/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `extension.open` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.installExtension` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.uninstallExtension` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.search` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.focusExtensionsView` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showRecommendedKeymapExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showLanguageExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.checkForUpdates` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.enableAutoUpdate` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.disableAutoUpdate` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.updateAllExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.enableAll` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.enableAllWorkspace` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.disableAll` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.disableAllWorkspace` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installExtensionFromLocation` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showPopularExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showRecommendedExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.recentlyPublishedExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installedExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.listBuiltInExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.extensionUpdates` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showEnabledExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showDisabledExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.clearExtensionsSearchResults` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.refreshExtension` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installWorkspaceRecommendedExtensions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showPreReleaseVersion` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.showReleasedVersion` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.switchToPreRlease` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.switchToRelease` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installUnsigned` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installAndDonotSync` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.installPrereleaseAndDonotSync` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.copyExtension` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.copyExtensionId` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.copyLink` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.configure` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |
| `workbench.extensions.action.download` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| Declarative contributions | Source scan | No package-level contribution block surfaced from the selected inventory scan. |

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
import { IViewContainersRegistry, Extensions as ViewContainerExtensions, ViewContainerLocation } from '../../../common/views.js';
import { DEFAULT_ACCOUNT_SIGN_IN_COMMAND } from '../../../services/accounts/browser/defaultAccount.js';
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

