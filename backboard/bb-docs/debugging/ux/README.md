# Debugging UX

## Expected User Flows

- Users can start a debug session from launch configurations, dynamic providers, commands, or test/task integrations.
- Users can set breakpoints from the editor and inspect program state when execution stops.
- Users can use the debug console for evaluation and logs.
- Server-ready patterns can open a URL when the debug target exposes one.

## UX Requirements

- Debug actions should reflect adapter capability and current session state.
- Breakpoint edits must be immediate and reversible.
- Failed launch configuration should provide a specific error and route users to configuration where possible.
- Stopping/disconnecting should make the difference between terminating the target and detaching clear.

## Empty And Error States

- No debugger configured: show launch configuration/setup affordances.
- Missing adapter: show extension/install/setup guidance from the debugger contribution.
- Adapter failure: keep logs available and avoid losing user breakpoints.

## QA Notes

- Test single and multi-session debugging, compound launches, breakpoints, logpoints, exceptions, debug console, and restart.
- Confirm debug UI remains accessible through keyboard and command palette.

<!-- BB-DEEP-DIVE:START -->
## Deep UX Flow And Acceptance Notes

### Primary User Journey

```text
Start
  |
  v
Discover Debugging entry point
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
rg -n "Debugging|registerAction2|MenuId|ContextKey|configuration|views|commands" src/vs/workbench/contrib/debug extensions/debug-auto-launch extensions/debug-server-ready
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Debugging / ux.

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
