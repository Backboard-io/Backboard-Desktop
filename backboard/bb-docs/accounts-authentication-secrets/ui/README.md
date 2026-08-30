# Accounts, Authentication, And Secrets UI

## Visible Surfaces

- Account menu and sign-in prompts.
- Authentication provider flows from built-in GitHub and Microsoft authentication extensions.
- Secret-backed settings and credential prompts.
- Notifications for expired credentials, missing credentials, permission prompts, and sign-out events.

## UI Elements

- Account/profile entry points in the title bar, activity/sidebar footer, command palette, and settings.
- Provider-specific sign-in prompts supplied by authentication extensions.
- Secret text setting controls such as Backboard API key presentation.
- Output/log channels when providers expose diagnostic details.

## State Indicators

- Signed-in account identity, provider availability, and authentication session state.
- Context keys that gate commands or menus based on authentication state.
- Prompt/error notifications when authentication providers cannot complete a request.

## Source Anchors

- `src/vs/workbench/contrib/authentication`
- `src/vs/workbench/services/accounts`
- `src/vs/workbench/services/authentication`
- `src/vs/workbench/services/secrets`
- `extensions/github-authentication`
- `extensions/microsoft-authentication`

<!-- BB-DEEP-DIVE:START -->
## Deep UI Surface Inventory

### Scope

Account menu, authentication providers, credential storage, encryption, GitHub/Microsoft auth extensions, and auth-related prompts.

### Absolute Source Paths

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/encryption` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/accounts` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/authentication` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/secrets` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/secrets` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/encryption` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/microsoft-authentication` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication` (exists)

### ASCII UI Map

```text
+------------------------------------------------------------------+
| Accounts Authentication Secrets                                  |
+----------------------+----------------------+--------------------+
| Entry points         | Primary surfaces     | Feedback surfaces  |
| - commands/menus     | - views/editors      | - status/progress   |
| - settings/actions   | - panels/tree/list   | - markers/toasts    |
| - extension points   | - webview/editor UI  | - output/logs       |
+----------------------+----------------------+--------------------+
| Source paths are listed above; use rg to jump from UI label to   |
| command/action registration before changing behavior.            |
+------------------------------------------------------------------+
```

### UI Audit Checklist

- Every visible action should map to a command ID, menu registration, or extension contribution.
- Every icon-only action needs a title, tooltip, ARIA label, or hover description in the owning source.
- Every tree/list/editor surface needs a clear empty state and a clear failure state.
- Every hidden or conditional UI element needs an explicit context key or capability gate.
- Every color, icon, and spacing decision should use workbench theme variables where possible.

### Representative Source Excerpt

Path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/authentication/browser/authentication.contribution.ts
```

```ts
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
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Accounts Authentication Secrets / ui.

| Check | Evidence to collect | Pass condition |
|---|---|---|
| Source owner | Full absolute path from the deep-dive source list | The path exists or the doc explicitly says why it is dynamic/provider-owned. |
| Command/menu wiring | `rg -n "registerAction2|MenuId|CommandsRegistry|contributes|commands" <source paths>` | Every user action has a concrete registration point. |
| Context gating | `rg -n "ContextKey|when:|precondition|activationEvents" <source paths>` | Hidden/conditional UI is explained by a context key, activation event, or capability. |
| User-facing text | `rg -n "localize\(|localize2\(|title:|aria-label|tooltip" <source paths>` | Labels are localized or intentionally extension-manifest owned; icon-only UI has accessible naming. |
| Failure path | `rg -n "showErrorMessage|showWarningMessage|logService|output|reject|throw new Error" <source paths>` | Failures have an observable message, log, output channel, or returned error. |
| State persistence | `rg -n "storage|StorageScope|setItem|getItem|workspaceState|globalState|configuration" <source paths>` | Persisted state has an owner and does not reuse another component's private key. |

ASCII review loop:

```text
Read source path
   |
   v
Find registration ---- no ----> doc missing endpoint detail
   |
  yes
   v
Find state owner ------ no ----> doc missing service/storage detail
   |
  yes
   v
Find user feedback ---- no ----> doc missing UX failure detail
   |
  yes
   v
Feature doc is operationally reviewable
```

Minimum expectation for future edits:

- Add the changed full path.
- Add the changed command, setting, provider, URI, or file endpoint.
- Add a literal code excerpt when the behavior changed.
- Add the before/after user impact.
- Add validation evidence, not just intent.
<!-- BB-VERIFICATION-MATRIX:END -->
