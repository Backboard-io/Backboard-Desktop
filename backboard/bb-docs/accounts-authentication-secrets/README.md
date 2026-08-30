# Accounts Authentication Secrets

This folder is the feature dossier for `accounts-authentication-secrets`. It splits the feature into UI, UX, endpoint, and implementation documentation so a reviewer can move from visible behavior to code ownership without guessing.

## Absolute Location

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accounts-authentication-secrets`

## Folder Map

```text
accounts-authentication-secrets/
|-- README.md
|-- ui/
|   |-- README.md
|   |-- source-inventory.md
|   |-- screen-map.md
|   L-- code-excerpts.md
|-- ux/
|   |-- README.md
|   |-- journeys.md
|   |-- states-and-errors.md
|   L-- validation-playbook.md
|-- endpoints/
|   |-- README.md
|   |-- endpoint-registry.md
|   |-- commands-settings-services.md
|   L-- risk-boundaries.md
L-- features/
    |-- README.md
    |-- implementation-map.md
    |-- ownership-and-files.md
    L-- extension-points.md
```

## Source Coverage

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

## Primary Files

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

## Quick Code Anchor

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
```

## Reviewer Entry Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'bb-docs/accounts-authentication-secrets' -maxdepth 3 -type f | sort
rg -n "registerAction2|CommandsRegistry|MenuRegistry|createDecorator|class |interface |package.json|contributes" 'extensions/github-authentication' 'extensions/microsoft-authentication' 'src/vs/platform/encryption' 'src/vs/platform/secrets' 'src/vs/workbench/contrib/authentication' 'src/vs/workbench/contrib/encryption' 'src/vs/workbench/services/accounts' 'src/vs/workbench/services/authentication' 'src/vs/workbench/services/secrets'
rg -n "accounts-authentication-secrets|Accounts Authentication Secrets" bb-docs/accounts-authentication-secrets
```

