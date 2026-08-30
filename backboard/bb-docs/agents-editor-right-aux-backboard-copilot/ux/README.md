# Agents Editor Right Aux Backboard Copilot UX

## Mental Model

The user experiences the area as one continuous agent workspace, but the implementation is layered:

```text
User opens or resumes an agent session
    |
    v
Sessions workbench lays out chat, auxiliary panel, and editor
    |
    +--> right auxiliary panel shows files/browser/Backboard details
    +--> editor shows code, browser editor, diffs, or normal editor input
    +--> Backboard webview runs its own composer/state machine
    L--> Copilot sessions use native chat/session editors and participants
```

## UX Rules

- The right auxiliary panel should feel like a compact details rail, not a second full editor.
- The editor should be able to expand by hiding the auxiliary panel through push-right.
- Backboard's composer should read as a compact tool surface: model, mode, web/image/voice, stop, send.
- Copilot should read as native VS Code chat/session functionality, not as part of the Backboard webview.
- Screenshot/share actions only make sense when a browser editor exists and can be brought active.

## BB-DEEP-DIVE:START

The primary UX contract is continuity across separate implementation layers. A user can move from a session conversation to a file/browser detail view, then into the editor, without needing to understand that the surfaces are owned by different code paths.

Important source paths:

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts` defines the push-right and pull-left editor actions.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` registers the Browser container and screenshot action in the auxiliary panel.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` owns Backboard run state, cancellation, status updates, and history transitions.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatHistoryBuilder.ts` converts Copilot/Claude session records into native chat history.

```text
Good UX path
|
|-- open agent session
|-- inspect compact right-side context
|-- expand editor when code needs more room
|-- restore right auxiliary panel for files/browser/Backboard
L-- continue agent conversation through Backboard or native Copilot chat/session UI
```

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| UX behavior | Source evidence |
|---|---|
| Editor can reclaim horizontal space | `workbench.action.agentSessions.pushEditorRight` hides `Parts.AUXILIARYBAR_PART`. |
| Right panel can come back | `workbench.action.agentSessions.pullEditorLeft` shows `Parts.AUXILIARYBAR_PART`. |
| Backboard run can be cancelled | `cancelActiveRun()` and the `cancel` webview message cancel the current token. |
| Copilot sessions feel native | Copilot registers chat/session content providers instead of rendering a standalone panel. |

## BB-VERIFICATION-MATRIX:END
