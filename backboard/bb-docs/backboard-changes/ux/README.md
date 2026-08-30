# Backboard Changes UX

## Product Intent By Change

### 1. Reduce Composer Crowding

The Backboard panel composer previously exposed usage metrics as an always-visible pulse button beside web/image/voice/send controls. The current diff removes that direct entry point.

UX effect:

- The composer has fewer small icons competing for attention.
- Primary turn controls remain visible.
- Usage metrics are no longer one click from the composer row.

Risk:

- If users relied on the pulse button, discoverability is reduced unless usage is exposed elsewhere.

### 2. Put Screenshot-To-Chat Where Users Need It

The browser screenshot action is now available in two places:

- Browser editor toolbar.
- Agents Window titlebar, if a browser editor exists.

UX effect:

- Users do not have to hunt inside nested browser chat menus.
- If they are in Agents Window and a browser is open but not active, the action activates the browser editor first.

Failure behavior:

- If no contextual browser input exists, the command returns early and does nothing.

### 3. Keep Browser Editor Titlebar Clean

When the browser editor is active, account widget UI hides.

UX effect:

- Browser controls have more room.
- Account widget does not remain visually hidden but keyboard reachable.
- Any account menu/hover is closed to prevent floating stale UI.

### 4. Make Right-Side Layout Less Heavy

Auxiliary bar width logic was reduced from wide defaults to narrow defaults.

UX effect:

- Users can keep a right-side browser/auxiliary surface open without starving the editor/session area.
- Narrow panels need truncation and compact actions, which the CSS now provides.

### 5. Turn Sidebar Navigation Into A Real Header

The sidebar activity navigation no longer gets prepended into the title area. It now uses `setHeaderArea(...)`.

UX effect:

- DOM structure matches the visual layout better.
- The title area is less overloaded.
- Compact navigation gets its own styling and focus ring behavior.

### 6. Make Chat Tabs Look Like Tabs

The chat title tab strip now uses tab variables, fade masking, calmer close opacity, and active/hover transitions.

UX effect:

- Active tab is easier to identify.
- Overflow is visually suggested by the mask.
- Close icons are less noisy until hover/active.

## User Flow: Browser Screenshot To Chat

```text
1. User opens or already has a browser editor.
2. User sees a screen icon in the Agents Window titlebar.
3. User clicks "Add Area Screenshot to Chat".
4. If needed, IDE opens the contextual browser editor.
5. IDE executes BrowserViewCommandId.AddAreaScreenshotToChat.
6. User selects the browser area.
7. Screenshot is added to chat context.
```

## UX Acceptance Checklist

- The titlebar screenshot action is hidden on phone layouts.
- The action is hidden while the sessions welcome surface is visible.
- The action is hidden when chat is disabled.
- The action does not show in auxiliary windows.
- The account widget is not keyboard reachable while hidden.
- The auxiliary bar can be narrow without label overflow breaking layout.
- Chat tab close buttons remain usable after opacity changes.
- Backboard composer still supports web/image/voice/stop/send after usage button removal.

<!-- BB-DEEP-DIVE:START -->
## Deep UX Flow And Acceptance Notes

### Primary User Journey

```text
Start
  |
  v
Discover Backboard Changes entry point
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
rg -n "Backboard|registerAction2|MenuId|ContextKey|configuration|views|commands" src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts extensions/backboard/src/extension.ts src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts extensions/backboard src/vs/sessions src/vs/workbench/browser/parts/sidebar src/vs/workbench/contrib/browserView src/vs/workbench/contrib/chat
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Backboard Changes / ux.

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
