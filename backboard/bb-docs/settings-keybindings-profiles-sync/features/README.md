# Settings, Keybindings, Profiles, And Sync Features

## Capabilities

- Settings UI and JSON editing.
- Configuration scope resolution and policy/read-only handling.
- Keyboard shortcut editing, recording, conflict detection, export, and reset.
- User profiles and profile-specific resource management.
- Settings Sync enablement, synchronization, conflict handling, and sync status.

## Boundaries

- Account authentication for sync is documented under `accounts-authentication-secrets`.
- Extension install/profile state intersects with `extensions-marketplace`.
- Feature-specific settings are documented in each feature folder's endpoint docs when important.

## Key Source Areas

- `src/vs/workbench/services/configuration`
- `src/vs/workbench/services/keybinding`
- `src/vs/workbench/services/userDataProfile`
- `src/vs/workbench/services/userDataSync`
- `src/vs/platform/configuration`

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Settings editor, keybindings, profiles, settings sync, policy export touch points, and preference editing.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindings` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindingsExport` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/preferences` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/userDataProfile` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/userDataSync` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/preferences` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/configuration` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/keybinding` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/userDataProfile` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/userDataSync` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/configuration` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/keybinding` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/userDataSync` (exists)

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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/keybindings/browser/keybindings.contribution.ts
```

```ts
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { showWindowLogActionId } from '../../../services/log/common/logConstants.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { $, addDisposableListener, append, getDomNodePagePosition, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { createCSSRule, createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Emitter } from '../../../../base/common/event.js';

class ToggleKeybindingsLogAction extends Action2 {
	static disposable: IDisposable | undefined;

	constructor() {
		super({
			id: 'workbench.action.toggleKeybindingsLog',
			title: nls.localize2('toggleKeybindingsLog', "Toggle Keyboard Shortcuts Troubleshooting"),
			category: Categories.Developer,
			f1: true
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
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/workbench/contrib/keybindings src/vs/workbench/contrib/keybindingsExport src/vs/workbench/contrib/preferences src/vs/workbench/contrib/userDataProfile src/vs/workbench/contrib/userDataSync src/vs/workbench/services/preferences src/vs/workbench/services/configuration src/vs/workbench/services/keybinding src/vs/workbench/services/userDataProfile src/vs/workbench/services/userDataSync
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/workbench/contrib/keybindings src/vs/workbench/contrib/keybindingsExport src/vs/workbench/contrib/preferences src/vs/workbench/contrib/userDataProfile src/vs/workbench/contrib/userDataSync src/vs/workbench/services/preferences src/vs/workbench/services/configuration src/vs/workbench/services/keybinding src/vs/workbench/services/userDataProfile src/vs/workbench/services/userDataSync
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Settings Keybindings Profiles Sync / features.

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
