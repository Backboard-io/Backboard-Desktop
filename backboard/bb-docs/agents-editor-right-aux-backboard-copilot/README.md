# Agents Editor Right Aux Backboard Copilot

This folder is the focused implementation dossier for the Agents Window area where the editor, the right auxiliary panel, Backboard, and Copilot meet. It exists because the combined behavior spans sessions workbench layout code, browser-editor code, Backboard's webview extension, and Copilot's chat/session providers.

## Absolute Location

/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/agents-editor-right-aux-backboard-copilot

## What This Folder Covers

- Agents Window layout: how the sessions chat area, right auxiliary panel, and editor column are sized and shown.
- The editor relationship to the right auxiliary panel: push-right hides the auxiliary panel; pull-left restores it.
- Right auxiliary panel contents: Files, Browser, Backboard panel, and session-specific pane-composite behavior.
- Backboard implementation look: a custom webview view with its own HTML, CSS, composer, state, messages, OAuth, model/tool refresh, and bridge loop.
- Copilot implementation look: native VS Code chat participants and chat-session content providers for Copilot CLI, Claude, cloud sessions, tools, and subagents.

## High-Level Shape

```text
Agent Sessions Window
|
|-- left/center sessions chat bar
|   L-- sessions part and chat-session providers
|
|-- right work column
|   |-- right auxiliary panel
|   |   |-- Files container
|   |   |-- Browser container
|   |   L-- Backboard panel when workbench.view.extension.backboard is opened
|   |
|   L-- editor column
|       |-- normal editors
|       |-- BrowserEditorInput
|       L-- push/pull actions that hide or restore the right auxiliary panel
|
|-- Backboard implementation
|   |-- VS Code extension activation
|   |-- WebviewViewProvider for backboard.panel
|   |-- HTML/CSS/JS composer UI built inside panelHtml()
|   |-- BackboardBridge to local Rust bridge and hosted Backboard API
|   L-- webview message contract: send, cancel, settings, tools, history, state
|
L-- Copilot implementation
    |-- Chat participants registered through vscode.chat.createChatParticipant
    |-- chat-session content providers for Claude, Copilot CLI, and cloud agents
    |-- subagent/tool invocation formatting and trace linking
    L-- worktree/session metadata services for long-running agent sessions
```

## UI Shape

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

## Source Map

| Source path | Exists | Role |
|---|---:|---|
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts | exists | Owns the agent-session workbench grid: sessions chat bar, auxiliary bar, and editor column. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutPolicy.ts | exists | Provides viewport defaults for sessions part visibility and size. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts | exists | Implements the right auxiliary pane as a sessions-specific pane composite part. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/paneCompositePartService.ts | exists | Registers the auxiliary bar part implementation for sessions windows. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css | exists | Controls right panel density, titlebars, animation, and phone overlay behavior. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts | exists | Adds editor title actions that hide/show the auxiliary bar to push or pull the editor. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts | exists | Registers the Files container inside the right auxiliary bar. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts | exists | Registers the Browser container inside the auxiliary bar and titlebar screenshot action. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserPanel.ts | exists | Defines sessions browser view/container ids and browser view pane. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.ts | exists | Controls sessions browser view lifecycle. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserEditorInput.ts | exists | Defines browser editor input used beside the auxiliary bar. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts | exists | Implements browser editor widgets and action groups. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts | exists | Connects browser editor sharing, element/area screenshot, and chat attachment actions. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/package.json | exists | Declares Backboard commands, activation events, settings, and update commands. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts | exists | Implements the Backboard webview panel, bridge, OAuth, model settings, and turn loop. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts | exists | Registers Copilot chat participants and participant icons/intents. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/conversationFeature.ts | exists | Activates Copilot chat enablement and participant registration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts | exists | Registers Copilot CLI, Claude, and cloud chat-session providers. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts | exists | Provides Copilot CLI session item/content behavior and editor session commands. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/claudeChatSessionContentProvider.ts | exists | Provides Claude session content, creation, folder selection, and history. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatHistoryBuilder.ts | exists | Builds native VS Code chat history from Claude/session records. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/copilotcli/common/copilotCLITools.ts | exists | Formats Copilot CLI tool/subagent invocations into chat parts. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts | exists | Models and runs Copilot CLI sessions. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/tools/vscode-node/toolsService.ts | exists | Stores trace context for subagent/tool execution. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/exploreAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/planAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/askAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |

## Read These First

- ui/source-inventory.md for exact files and visible surfaces.
- ui/screen-map.md for what the area looks like on screen.
- endpoints/endpoint-registry.md for commands and message contracts.
- features/implementation-map.md for source ownership.
- features/backboard-copilot-implementation-look.md for the direct comparison.

## Quick Inspection Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "workbench.action.agentSessions.pushEditorRight|workbench.action.agentSessions.pullEditorLeft|workbench.action.sessions.addBrowserAreaScreenshotToChat|backboard.openRightPanel|backboard.panel|registerChatSessionContentProvider|createChatParticipant" src/vs/sessions src/vs/workbench/contrib/browserView extensions/backboard extensions/copilot/src/extension -g '*.ts' -g '*.json' -g '!**/node_modules/**'
```
