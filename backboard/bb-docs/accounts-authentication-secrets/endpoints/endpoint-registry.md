# Accounts Authentication Secrets Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accounts-authentication-secrets/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `workbench.getCodeExchangeProxyEndpoints` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/authentication.contribution.ts` |
| `workbench.action.manageAccounts` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageAccountsAction.ts` |
| `workbench.actions.accounts.signIn` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/accounts/browser/defaultAccount.ts` |
| `backboard.github-authentication` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/githubServer.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` |  |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/package.json` |  |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/package.json` | 2 entries |

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

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/authentication.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/authentication.contribution.ts
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { SignOutOfAccountAction } from './actions/signOutOfAccountAction.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { Extensions, IExtensionFeatureTableRenderer, IExtensionFeaturesRegistry, IRenderedData, IRowData, ITableData } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { ManageTrustedExtensionsForAccountAction } from './actions/manageTrustedExtensionsForAccountAction.js';
import { ManageAccountPreferencesForExtensionAction } from './actions/manageAccountPreferencesForExtensionAction.js';
import { IAuthenticationUsageService } from '../../../services/authentication/browser/authenticationUsageService.js';
import { ManageAccountPreferencesForMcpServerAction } from './actions/manageAccountPreferencesForMcpServerAction.js';
import { ManageTrustedMcpServersForAccountAction } from './actions/manageTrustedMcpServersForAccountAction.js';
import { RemoveDynamicAuthenticationProvidersAction } from './actions/manageDynamicAuthenticationProvidersAction.js';
import { ManageAccountsAction } from './actions/manageAccountsAction.js';

const codeExchangeProxyCommand = CommandsRegistry.registerCommand('workbench.getCodeExchangeProxyEndpoints', function (accessor, _) {
	const environmentService = accessor.get(IBrowserWorkbenchEnvironmentService);
	return environmentService.options?.codeExchangeProxyEndpoints;
});

class AuthenticationDataRenderer extends Disposable implements IExtensionFeatureTableRenderer {

	readonly type = 'table';

	shouldRender(manifest: IExtensionManifest): boolean {
		return !!manifest.contributes?.authentication;
	}

	render(manifest: IExtensionManifest): IRenderedData<ITableData> {
		const authentication = manifest.contributes?.authentication || [];
		if (!authentication.length) {
			return { data: { headers: [], rows: [] }, dispose: () => { } };
		}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption/electron-browser/encryption.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption/electron-browser/encryption.contribution.ts
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

class EncryptionContribution implements IWorkbenchContribution {
	constructor(
		@IJSONEditingService private readonly jsonEditingService: IJSONEditingService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService
	) {
		this.migrateToGnomeLibsecret();
	}

	/**
	 * Migrate the user from using the gnome or gnome-keyring password-store to gnome-libsecret.
	 * FOLLOWUP@TylerLeonhardt: This migration can be removed in 3 months or so and then storage
	 * can be cleaned up.
	 */
	private async migrateToGnomeLibsecret(): Promise<void> {
		if (!isLinux || this.storageService.getBoolean('encryption.migratedToGnomeLibsecret', StorageScope.APPLICATION, false)) {
			return;
		}
		try {
			const content = await this.fileService.readFile(this.environmentService.argvResource);
			const argv = parse<{ 'password-store'?: string }>(content.value.toString());
			if (argv['password-store'] === 'gnome' || argv['password-store'] === 'gnome-keyring') {
				this.jsonEditingService.write(this.environmentService.argvResource, [{ path: ['password-store'], value: 'gnome-libsecret' }], true);
			}
			this.storageService.store('encryption.migratedToGnomeLibsecret', true, StorageScope.APPLICATION, StorageTarget.USER);
		} catch (error) {
			console.error(error);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(EncryptionContribution, LifecyclePhase.Eventually);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationAccessService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationAccessService.ts
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AllowedExtension } from '../common/authentication.js';

export const IAuthenticationAccessService = createDecorator<IAuthenticationAccessService>('IAuthenticationAccessService');
export interface IAuthenticationAccessService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeExtensionSessionAccess: Event<{ providerId: string; accountName: string }>;

	/**
	 * Check extension access to an account
	 * @param providerId The id of the authentication provider
	 * @param accountName The account name that access is checked for
	 * @param extensionId The id of the extension requesting access
	 * @returns Returns true or false if the user has opted to permanently grant or disallow access, and undefined
	 * if they haven't made a choice yet
	 */
	isAccessAllowed(providerId: string, accountName: string, extensionId: string): boolean | undefined;
	readAllowedExtensions(providerId: string, accountName: string): AllowedExtension[];
	updateAllowedExtensions(providerId: string, accountName: string, extensions: AllowedExtension[]): void;
	removeAllowedExtensions(providerId: string, accountName: string): void;
}

// FOLLOWUP@TylerLeonhardt: Move this class to MainThreadAuthentication
// FOLLOWUP@TylerLeonhardt: Should this class only keep track of allowed things and throw away disallowed ones?
export class AuthenticationAccessService extends Disposable implements IAuthenticationAccessService {
	_serviceBrand: undefined;

	private _onDidChangeExtensionSessionAccess: Emitter<{ providerId: string; accountName: string }> = this._register(new Emitter<{ providerId: string; accountName: string }>());
	readonly onDidChangeExtensionSessionAccess: Event<{ providerId: string; accountName: string }> = this._onDidChangeExtensionSessionAccess.event;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IProductService private readonly _productService: IProductService
	) {
		super();
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationExtensionsService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationExtensionsService.ts
import { Disposable, DisposableStore, dispose, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { scopesMatch } from '../../../../base/common/oauth.js';
import * as nls from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IActivityService, NumberBadge } from '../../activity/common/activity.js';
import { IAuthenticationAccessService } from './authenticationAccessService.js';
import { IAuthenticationUsageService } from './authenticationUsageService.js';
import { AuthenticationSession, IAuthenticationProvider, IAuthenticationService, IAuthenticationExtensionsService, AuthenticationSessionAccount, IAuthenticationWwwAuthenticateRequest, isAuthenticationWwwAuthenticateRequest } from '../common/authentication.js';
import { Emitter } from '../../../../base/common/event.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';

// OAuth2 spec prohibits space in a scope, so use that to join them.
const SCOPESLIST_SEPARATOR = ' ';

interface SessionRequest {
	disposables: IDisposable[];
	requestingExtensionIds: string[];
}

interface SessionRequestInfo {
	[scopesList: string]: SessionRequest;
}

// FOLLOWUP@TylerLeonhardt: This should all go in MainThreadAuthentication
export class AuthenticationExtensionsService extends Disposable implements IAuthenticationExtensionsService {
	declare readonly _serviceBrand: undefined;
	private _signInRequestItems = new Map<string, SessionRequestInfo>();
	private _sessionAccessRequestItems = new Map<string, { [extensionId: string]: { disposables: IDisposable[]; possibleSessions: AuthenticationSession[] } }>();
	private readonly _accountBadgeDisposable = this._register(new MutableDisposable());

	private _onDidAccountPreferenceChange: Emitter<{ providerId: string; extensionIds: string[] }> = this._register(new Emitter<{ providerId: string; extensionIds: string[] }>());
```

