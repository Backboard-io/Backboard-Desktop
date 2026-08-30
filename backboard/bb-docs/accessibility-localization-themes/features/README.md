# Accessibility, Localization, And Themes Features

## Capabilities

- Keyboard and screen-reader-friendly command surfaces.
- Accessibility help, accessibility signals, and signal customization.
- Color themes, file icon themes, product icon themes, and high contrast modes.
- Language pack discovery and application.
- Sash, list/tree, scroll-locking, and style override behavior used by all workbench surfaces.

## Boundaries

- Feature-specific accessibility behavior remains owned by that feature, but global accessibility services and theme services are documented here.
- Custom webviews must consume workbench theme variables; their content implementation remains with the owning feature folder.

## Key Source Areas

- `src/vs/workbench/contrib/accessibility`
- `src/vs/workbench/contrib/accessibilitySignals`
- `src/vs/workbench/contrib/localization`
- `src/vs/workbench/contrib/themes`
- `extensions/theme-*`

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Accessibility help/signals, language packs, themes, icons, style overrides, and user-facing visual/a11y polish.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibilitySignals` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/localization` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/sash` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scrollLocking` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/styleOverrides` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/themes` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-abyss` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-defaults` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-kimbie-dark` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-monokai` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-monokai-dimmed` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-quietlight` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-red` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-seti` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-solarized-dark` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-solarized-light` (exists)
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-tomorrow-night-blue` (exists)

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
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/accessibility.contribution.ts
```

```ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { DynamicSpeechAccessibilityConfiguration, registerAccessibilityConfiguration } from './accessibilityConfiguration.js';
import { IWorkbenchContributionsRegistry, WorkbenchPhase, Extensions as WorkbenchExtensions, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { UnfocusedViewDimmingContribution } from './unfocusedViewDimmingContribution.js';
import { AccessibilityStatus } from './accessibilityStatus.js';
import { EditorAccessibilityHelpContribution } from './editorAccessibilityHelp.js';
import { SaveAccessibilitySignalContribution } from '../../accessibilitySignals/browser/saveAccessibilitySignal.js';
import { DiffEditorActiveAnnouncementContribution } from '../../accessibilitySignals/browser/openDiffEditorAnnouncement.js';
import { SpeechAccessibilitySignalContribution } from '../../speech/browser/speechAccessibilitySignal.js';
import { AccessibleViewInformationService, IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from './accessibleView.js';
import { AccesibleViewHelpContribution, AccesibleViewContributions } from './accessibleViewContributions.js';
import { ExtensionAccessibilityHelpDialogContribution } from './extensionAccesibilityHelp.contribution.js';

registerAccessibilityConfiguration();
registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);
registerSingleton(IAccessibleViewInformationService, AccessibleViewInformationService, InstantiationType.Delayed);

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
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
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/workbench/contrib/accessibility src/vs/workbench/contrib/accessibilitySignals src/vs/workbench/contrib/localization src/vs/workbench/contrib/sash src/vs/workbench/contrib/scrollLocking src/vs/workbench/contrib/styleOverrides src/vs/workbench/contrib/themes extensions/theme-abyss extensions/theme-defaults extensions/theme-kimbie-dark
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/workbench/contrib/accessibility src/vs/workbench/contrib/accessibilitySignals src/vs/workbench/contrib/localization src/vs/workbench/contrib/sash src/vs/workbench/contrib/scrollLocking src/vs/workbench/contrib/styleOverrides src/vs/workbench/contrib/themes extensions/theme-abyss extensions/theme-defaults extensions/theme-kimbie-dark
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Accessibility Localization Themes / features.

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
