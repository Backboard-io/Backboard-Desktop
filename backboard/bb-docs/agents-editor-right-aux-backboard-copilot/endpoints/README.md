# Agents Editor Right Aux Backboard Copilot Endpoints

Endpoint here means command ID, view ID, session provider ID, webview message type, service registration, or browser command.

## Command And Provider Map

| Endpoint | Kind | Behavior |
|---|---|---|
| backboard.openRightPanel | Backboard command | Opens workbench.view.extension.backboard, then focuses backboard.panel. |
| backboard.openPanel | Backboard command | Opens the same Backboard view. |
| backboard.newChat | Backboard command | Opens the panel and posts newChat to the webview. |
| backboard.showHistory | Backboard command | Opens the panel and posts showHistory to the webview. |
| backboard.refreshModels | Backboard command | Calls the Backboard bridge model refresh. |
| backboard.extension.signIn | Backboard command | Starts Backboard OAuth/SSO flow. |
| workbench.action.agentSessions.pushEditorRight | Sessions editor action | Hides Parts.AUXILIARYBAR_PART so the editor expands right. |
| workbench.action.agentSessions.pullEditorLeft | Sessions editor action | Shows Parts.AUXILIARYBAR_PART again. |
| workbench.action.sessions.addBrowserAreaScreenshotToChat | Sessions/browser action | Finds a browser editor, opens it if needed, then runs BrowserViewCommandId.AddAreaScreenshotToChat. |
| copilotcli | Copilot chat-session type | Registered through vscode.chat.registerChatSessionContentProvider. |
| ClaudeSessionUri.scheme | Claude session scheme | Registered through vscode.chat.registerChatSessionContentProvider. |

## Backboard Webview Message Contract

| Message | Direction | Meaning |
|---|---|---|
| send | webview -> extension | Submits text prompt with options and optional chat/workspace id. |
| sendVoice | webview -> extension | Submits prompt plus audio attachment when voice mode supports it. |
| cancel | webview -> extension | Cancels the active run token. |
| reviewChanges | webview -> extension | Opens SCM view. |
| signIn | webview -> extension | Starts Backboard OAuth/SSO and refreshes state. |
| refreshModels | webview -> extension | Refreshes model list through BackboardBridge. |
| refreshUsage | webview -> extension | Requests account/run usage snapshot. |
| ready | webview -> extension | Signals the panel script is ready to receive state. |
| syncPanelState | webview -> extension | Requests persisted panel state synchronization. |
| runStarted | extension -> webview | Marks active run and selected chat id. |
| delta | extension -> webview | Streams assistant text into the log. |
| status | extension -> webview | Updates status bar text. |
| runFinished | extension -> webview | Clears running state and completes the turn. |
| settings | extension -> webview | Sends public settings and workspace path. |
| models | extension -> webview | Sends model inventory. |
| tools | extension -> webview | Sends tool inventory. |
| panelStateSnapshot | extension -> webview | Sends persisted history/tabs/panel state. |

## BB-DEEP-DIVE:START

This area has no single HTTP API boundary. Its endpoints are mostly local VS Code command IDs, view IDs, provider IDs, and webview message names.

Concrete endpoint anchors:

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/package.json` declares `backboard.openRightPanel`, `backboard.openPanel`, `backboard.newChat`, `backboard.showHistory`, `backboard.refreshModels`, and `backboard.extension.signIn`.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` registers `backboard.panel` and routes Backboard webview messages.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts` registers `workbench.action.agentSessions.pushEditorRight` and `workbench.action.agentSessions.pullEditorLeft`.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` registers `workbench.action.sessions.addBrowserAreaScreenshotToChat`.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts` registers Copilot/Claude chat-session providers.

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "backboard\\.open|backboard\\.panel|registerCommand|registerWebviewViewProvider|registerChatSessionContentProvider|addBrowserAreaScreenshotToChat" extensions/backboard extensions/copilot/src/extension src/vs/sessions -g '*.ts' -g '*.json'
```

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| Endpoint family | Verification |
|---|---|
| Backboard commands | Confirm the command IDs exist in `extensions/backboard/package.json` and are registered in `extensions/backboard/src/extension.ts`. |
| Backboard webview messages | Confirm each message in the contract is handled or emitted by `BackboardPanelProvider`. |
| Sessions editor actions | Confirm push/pull actions call layout service visibility changes for `Parts.AUXILIARYBAR_PART`. |
| Copilot sessions | Confirm provider registration uses `vscode.chat.registerChatSessionContentProvider`. |

## BB-VERIFICATION-MATRIX:END
