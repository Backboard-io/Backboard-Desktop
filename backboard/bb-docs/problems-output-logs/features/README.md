# Problems, Output, And Logs Features

## Capabilities

- Diagnostic marker storage and Problems view presentation.
- Marker navigation and severity grouping.
- Output channels for extensions, tasks, debug, Backboard Tools, MCP, and other providers.
- Log viewing and log level integration.
- Problem matcher/task integration.

## Boundaries

- Performance diagnostics are documented under `performance-telemetry-diagnostics`.
- Test result presentation is documented under `testing`.
- Backboard-specific output is documented under `backboard-agent-bridge`.

## Key Source Areas

- `src/vs/workbench/contrib/markers`
- `src/vs/workbench/contrib/output`
- `src/vs/workbench/contrib/logs`
- `src/vs/platform/markers`
- `src/vs/platform/log`

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Problems/markers, output channels, logs views, task/problem matchers, and diagnostic presentation.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markers` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/output` (exists)

### Source-Level Architecture Sketch

```text
+--------------------+       +----------------------+       +--------------------+
| User action / API  | ----> | Workbench contribution| ----> | Service / provider |
| command/menu/view  |       | Action2, registry,    |       | file, model, auth, |
| or extension point |       | view/editor glue      |       | terminal, remote   |
+--------------------+       +----------------------+       +--------------------+
          ^                              |                              |
          |                              v                              v
          |                    +-------------------+          +-------------------+
          +------------------- | Context / config  | <------- | Events / storage  |
                               +-------------------+          +-------------------+
```

### Representative Code Excerpt

Path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/logs/browser/logs.contribution.ts
```

```ts
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenWindowSessionLogFileAction } from '../common/logsActions.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { LogsDataCleaner } from '../common/logsDataCleaner.js';

class WebLogOutputChannels extends Disposable implements IWorkbenchContribution {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.registerWebContributions();
	}

	private registerWebContributions(): void {
		this.instantiationService.createInstance(LogsDataCleaner);

		this._register(registerAction2(class extends Action2 {
			constructor() {
```

### How To Extend Safely

1. Start from the source ownership paths above.
2. Use `rg` to find command IDs, context keys, settings, and services before editing.
3. Keep user-facing labels localized through the local source pattern.
4. Register disposables immediately when adding listeners, watchers, providers, or widgets.
5. Add source-level docs here when adding a new command, endpoint, storage file, network URL, or UI surface.
6. Validate the broad surface, not just the changed file: command palette, menu placement, keyboard focus, empty state, error state, and logs.

### Targeted Grep Commands

```sh
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/workbench/contrib/logs src/vs/workbench/contrib/markers src/vs/workbench/contrib/output
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/workbench/contrib/logs src/vs/workbench/contrib/markers src/vs/workbench/contrib/output
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Problems Output Logs / features.

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
