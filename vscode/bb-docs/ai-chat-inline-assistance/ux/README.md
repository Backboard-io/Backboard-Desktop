# AI Chat And Inline Assistance UX

## Expected User Flows

- Users can ask questions, generate or edit code, review changes, attach context, and run tools from chat.
- Users can invoke inline chat from an editor selection and apply edits without losing editor focus.
- Inline completions should be low-friction, cancellable, and avoid blocking normal typing.
- Tool usage must expose clear pending, approved, rejected, and failed states.

## UX Requirements

- Always preserve the user's editor/workbench context when opening chat from code.
- Tool calls should explain what will happen before any risky operation.
- Chat-generated edits need review affordances: diff, accept, discard, and apply-next actions where appropriate.
- Model/provider unavailable states should tell the user what action can resolve the issue.
- Debug-only commands should stay hidden unless their gating context/configuration is enabled.

## Empty And Error States

- No provider/model: show setup or sign-in actions instead of a dead input.
- Request failure: show the failure in the conversation and keep retry/resubmit possible.
- Tool failure: keep tool output visible enough to diagnose but avoid leaking secrets.

## QA Notes

- Validate editor selection, file attachment, problem attachment, and source-control attachment flows.
- Check cancellation while tools are running.
- Check keyboard navigation and screen-reader labels on chat input, attachments, and tool controls.

<!-- BB-DEEP-DIVE:START -->
## Deep UX Flow And Acceptance Notes

### Primary User Journey

```text
Start
  |
  v
Discover Ai Chat Inline Assistance entry point
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
rg -n "Ai|registerAction2|MenuId|ContextKey|configuration|views|commands" src/vs/workbench/contrib/agentsVoice src/vs/workbench/contrib/chat src/vs/workbench/contrib/inlineChat src/vs/workbench/contrib/inlineCompletions src/vs/workbench/contrib/speech src/vs/workbench/services/chat src/vs/workbench/services/inlineCompletions src/vs/workbench/services/aiEmbeddingVector src/vs/workbench/services/aiRelatedInformation src/vs/workbench/services/aiSettingsSearch
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Ai Chat Inline Assistance / ux.

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
