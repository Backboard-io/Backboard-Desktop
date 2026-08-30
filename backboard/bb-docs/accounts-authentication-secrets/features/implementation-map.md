# Accounts Authentication Secrets Implementation Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accounts-authentication-secrets/features/implementation-map.md`

## Architecture Map

```text
Accounts Authentication Secrets
|
|-- Contribution layer
|   |-- package.json, *.contribution.ts, workbench registration
|   L-- command/menu/view/context declarations
|
|-- Runtime layer
|   |-- services, controllers, providers, registries
|   L-- events, state, disposables, async operations
|
|-- Presentation layer
|   |-- browser/view/widget/editor/webview files
|   L-- css, icons, labels, focus, overflow, empty states
|
L-- Validation layer
    |-- tests when present
    L-- manual checks in ux/validation-playbook.md
```

## Source Inventory

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/esbuild.browser.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/.vscodeignore`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/dist`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/esbuild.mts` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption/electron-main` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/secrets` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/secrets/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/secrets/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption/electron-browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/accounts` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/accounts/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/accounts/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets/electron-browser` |

## Implementation Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/authentication.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption/electron-browser/encryption.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationAccessService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationExtensionsService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationMcpAccessService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationMcpService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationMcpUsageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationQueryService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationUsageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/dynamicAuthenticationProviderStorageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets/browser/secretStorageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets/electron-browser/secretStorageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test/browser/authenticationAccessService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test/browser/authenticationMcpAccessService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test/browser/authenticationQueryService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test/browser/authenticationQueryServiceMocks.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/test/browser/authenticationService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageAccountPreferencesForExtensionAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageAccountPreferencesForMcpServerAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageAccountsAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageDynamicAuthenticationProvidersAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageTrustedExtensionsForAccountAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/manageTrustedMcpServersForAccountAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/actions/signOutOfAccountAction.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/common/experimentationService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption/common/encryptionService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/secrets/test/common/testSecretStorageService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication/packageMocks/keytar/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption/electron-main/encryptionMainService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/authServer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/buffer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/crypto.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/fetch.ts` | Implementation file participating in the feature surface or supporting source area. |

## Implementation Code Anchors

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

		const headers = [
			localize('authenticationlabel', "Label"),
			localize('authenticationid', "ID"),
			localize('authenticationMcpAuthorizationServers', "MCP Authorization Servers")
		];
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

	isAccessAllowed(providerId: string, accountName: string, extensionId: string): boolean | undefined {
		const trustedExtensionAuthAccess = this._productService.trustedExtensionAuthAccess;
		const extensionKey = ExtensionIdentifier.toKey(extensionId);
		if (Array.isArray(trustedExtensionAuthAccess)) {
			if (trustedExtensionAuthAccess.includes(extensionKey)) {
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
	readonly onDidChangeAccountPreference = this._onDidAccountPreferenceChange.event;

	private _inheritAuthAccountPreferenceParentToChildren: Record<string, string[]>;
	private _inheritAuthAccountPreferenceChildToParent: { [extensionId: string]: string };

	constructor(
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationMcpAccessService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication/browser/authenticationMcpAccessService.ts
 * WHATWG URL form, so cosmetic differences in the origin (host case, default port, encoding) and a root
 * trailing slash ("foo.com" vs "foo.com/") don't force a spurious re-consent - while a trailing slash on
 * a path ("foo.com/a" vs "foo.com/a/") is preserved as a meaningful difference between endpoints.
 */
export function urlsEqual(a: string | undefined, b: string | undefined): boolean {
	if (a === b) {
		return true;
	}
	if (a === undefined || b === undefined) {
		return false;
	}
	try {
		return new URL(a).toString() === new URL(b).toString();
	} catch {
		return false;
	}
}

export interface AllowedMcpServer {
	id: string;
	name: string;
	/**
	 * If true or undefined, the extension is allowed to use the account
	 * If false, the extension is not allowed to use the account
	 * FOLLOWUP: undefined shouldn't be a valid value, but it is for now
	 */
	allowed?: boolean;
	lastUsed?: number;
	// If true, this comes from the product.json
	trusted?: boolean;
	/**
	 * The MCP server URL the grant was made for. A token is only released to a server whose current
	 * URL matches this, so changing the URL while keeping the same id requires the user to re-consent.
	 * Undefined for stdio servers, which have no URL.
	 */
	url?: string;
}

export const IAuthenticationMcpAccessService = createDecorator<IAuthenticationMcpAccessService>('IAuthenticationMcpAccessService');
export interface IAuthenticationMcpAccessService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeMcpSessionAccess: Event<{ providerId: string; accountName: string }>;
```

