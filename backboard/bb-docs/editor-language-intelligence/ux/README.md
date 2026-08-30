# Editor And Language Intelligence UX

## Expected User Flows

- Users can edit text with responsive cursor, selection, undo/redo, find, folding, and language-aware behavior.
- Users can invoke code actions, format content, expand snippets, and navigate symbol/hierarchy relationships.
- Language detection should help without surprising users who manually set a language.
- Inlay hints and inline assists should be readable and configurable.

## UX Requirements

- Editing must remain fast even when language providers are slow or absent.
- Provider results should be cancellable and should not block text input.
- Commands should respect editor focus and preserve selection when possible.
- Language-specific features should be scoped to the active language/provider.

## Empty And Error States

- No provider: hide provider-specific affordances rather than showing broken actions.
- Formatter conflict: ask the user to select a default formatter when needed.
- Provider error: route to output/problems where applicable and keep editor usable.

## QA Notes

- Test large files, readonly editors, untitled editors, notebook cells, webviews/custom editors where editor APIs are embedded, and remote files.
- Confirm language status and code actions update when changing language mode.

<!-- BB-DEEP-DIVE:START -->
## Deep UX Flow And Acceptance Notes

### Primary User Journey

```text
Start
  |
  v
Discover Editor Language Intelligence entry point
  |
  v
Open relevant workbench surface / editor / picker
  |
  v
Perform the feature action
  |
  +--> success: visible state changes, output appears, or command completes
  |
  +--> failure: actionable message + logs/output + no silent data loss
  |
  v
Return to previous work without losing focus, selection, or dirty state
```

### UX Risks To Keep Explicit

- Hidden state: features in this area often depend on context keys, provider capability, active editor type, workspace kind, or authentication state.
- Cross-window behavior: verify normal workbench, sessions window, web, desktop, remote, and auxiliary-window contexts when the feature applies to more than one surface.
- Focus behavior: commands launched from titlebars, panels, quick picks, and webviews must not strand keyboard focus.
- Undo/recovery: destructive operations need undo, confirmation, preview, or clear failure recovery.
- Loading behavior: slow providers should show progress without freezing the host surface.

### Acceptance Checklist

- The default path works with keyboard only.
- The empty state tells the user what to do next.
- The error state names the failing provider, command, file, or setting when possible.
- The command can be found through command palette or the owning UI surface.
- If state persists, the storage/service owner is identified in source.
- If the feature uses network, process, or file-system side effects, those endpoints are documented in the sibling `endpoints/README.md`.

### Inspection Commands

Run from:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode
```

```sh
rg -n "Editor|registerAction2|MenuId|ContextKey|configuration|views|commands" src/vs/workbench/contrib/bracketPairColorizer2Telemetry src/vs/workbench/contrib/callHierarchy src/vs/workbench/contrib/codeActions src/vs/workbench/contrib/codeEditor src/vs/workbench/contrib/dropOrPasteInto src/vs/workbench/contrib/emmet src/vs/workbench/contrib/folding src/vs/workbench/contrib/format src/vs/workbench/contrib/inlayHints src/vs/workbench/contrib/languageDetection
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Editor Language Intelligence / ux.

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
