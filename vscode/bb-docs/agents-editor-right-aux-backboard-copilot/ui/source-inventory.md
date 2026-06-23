# Agents Editor Right Aux Backboard Copilot UI Source Inventory

## Full Source Table

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

## UI Ownership Notes

- The sessions workbench owns the split layout and decides when the auxiliary panel and editor are both visible.
- The auxiliary bar part owns pane-composite title/actions behavior inside the right panel.
- Backboard owns its own internal UI because it is a VS Code webview view. The source is a long panelHtml() string and local script inside extensions/backboard/src/extension.ts.
- Copilot owns native chat/session surfaces. Its source registers participants and content providers; it does not render the Backboard composer.

## Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "ViewContainerLocation\.AuxiliaryBar|Parts\.AUXILIARYBAR_PART|panelHtml|BackboardPanelProvider|createChatParticipant|registerChatSessionContentProvider" src/vs/sessions src/vs/workbench/contrib/browserView extensions/backboard extensions/copilot/src/extension -g '*.ts' -g '!**/node_modules/**'
```
