# Agents Editor Right Aux Backboard Copilot UI

## What The User Sees

```text
+--------------------------------------------------------------------------------------------------+
| Agent Sessions Workbench                                                                          |
|                                                                                                  |
| +------------------------+ +--------------------------------+ +---------------+ +-------------+ |
| | sessions/chat column    | | right auxiliary panel          | | editor column | | optional     | |
| |                         | |                                | |               | | bottom panel  | |
| | conversation, sessions, | | Files / Browser / Backboard    | | code editor,   | | logs/output   | |
| | cloud/local agent cards | | detail panes, compact titlebar  | | browser editor | | terminals     | |
| +------------------------+ +--------------------------------+ +---------------+ +-------------+ |
|                                                                                                  |
| Backboard panel visual: status row, recent tabs, log/history stack, compact composer card.        |
| Composer controls: Mode, Model, Web, Image, Voice, Stop, Send. Usage button was removed.          |
| Copilot visual: native chat/session editors and agent participants, not Backboard's webview HTML. |
+--------------------------------------------------------------------------------------------------+
```

The important detail is that Backboard and Copilot do not use the same visual shell. Backboard renders a custom webview panel. Copilot registers native chat participants and chat-session providers, so the Copilot UI appears through VS Code chat/session editors rather than Backboard's HTML.

## Backboard Panel Look

```text
Backboard panel
|
|-- top/status
|   |-- elapsed run clock
|   |-- status text
|   L-- recent chat tabs
|
|-- content stack
|   |-- chat log with assistant/user/tool cards
|   |-- empty state
|   |-- history pane
|   L-- change stack / checkpoint strip
|
|-- composer
|   |-- hidden state controls for provider/model/mode/intensity/web/image/voice/MCP toggles
|   |-- popover for mode, model, web, image, voice
|   |-- textarea and action bar
|   L-- right actions: web, image, voice, stop, send
|
L-- auth overlay
    L-- SSO sign-in card when Backboard credentials are not present
```

## Copilot Look

```text
Copilot implementation
|
|-- participant layer
|   |-- default Copilot participant
|   |-- edits/agent participant
|   |-- terminal participant
|   |-- notebook/editor participants
|   L-- remote/dynamic participants
|
|-- chat-session layer
|   |-- Claude session scheme and content provider
|   |-- Copilot CLI session type and content provider
|   |-- cloud sessions provider
|   L-- session item providers for history/listing
|
|-- execution layer
|   |-- worktree/session metadata services
|   |-- tool and subagent invocation formatting
|   |-- telemetry/trace linking
|   L-- model provider registration through vscode.lm
|
L-- UI layer
    L-- native chat/session editor surfaces, not the Backboard webview
```

## UI Source Anchors

| Area | File | Why it matters |
|---|---|---|
| Sessions layout | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts | Builds the grid containing sessions chat, auxiliary bar, and editor. |
| Auxiliary bar | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts | Implements the right pane composite. |
| Sessions CSS | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css | Controls density, right-panel animation, titlebars, and mobile overlay. |
| Editor controls | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts | Adds push/pull editor buttons that hide/show the auxiliary bar. |
| Browser container | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts | Registers Browser under ViewContainerLocation.AuxiliaryBar. |
| Browser chat integration | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts | Adds share, element, and screenshot-to-chat behavior. |
| Backboard panel | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts | Builds the webview UI, message loop, bridge calls, and state. |
| Copilot participants | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts | Registers native Copilot chat participants. |
| Copilot sessions | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts | Registers Copilot CLI and Claude session providers. |

## BB-DEEP-DIVE:START

The UI is split across three rendering strategies:

- Sessions shell UI is native workbench layout code under `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts`.
- Backboard UI is generated HTML, CSS, and JavaScript inside `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts`.
- Copilot UI is native VS Code chat/session UI registered from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts` and `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts`.

The visual rule to preserve is that the right auxiliary panel stays compact while the editor remains the primary work surface. Backboard can occupy the right panel as a custom webview, but Copilot appears through the normal chat/session stack rather than inside Backboard's DOM.

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "panelHtml|BackboardPanelProvider|createChatParticipant|registerChatSessionContentProvider|AUXILIARYBAR_PART" extensions/backboard extensions/copilot/src/extension src/vs/sessions -g '*.ts'
```

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| Evidence | Expected result |
|---|---|
| `src/vs/sessions/browser/workbench.ts` grid code | Shows sessions chat, auxiliary bar, and editor as separate leaf nodes. |
| `extensions/backboard/src/extension.ts` `panelHtml()` | Shows the custom Backboard composer, status, history, and auth overlay. |
| `extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts` | Shows native chat participants rather than webview markup. |
| `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts` | Shows session providers for Copilot CLI, Claude, and cloud sessions. |

## BB-VERIFICATION-MATRIX:END
