# Agents Editor Right Aux Backboard Copilot Features

## Feature Inventory

| Feature | Owner | Implementation |
|---|---|---|
| Agent sessions layout | Sessions workbench | Grid descriptor in src/vs/sessions/browser/workbench.ts. |
| Right auxiliary panel | Sessions auxiliary bar | AuxiliaryBarPart with sessions-specific keys, sizing, and title actions. |
| Editor expansion | Sessions editor contribution | Push/pull actions hide or restore Parts.AUXILIARYBAR_PART. |
| Browser detail panel | Sessions browser contribution | Browser view container in ViewContainerLocation.AuxiliaryBar. |
| Browser-to-chat context | Browser editor chat features | Share button, element selection, screenshot-to-chat commands. |
| Backboard right-panel UI | Backboard extension | BackboardPanelProvider and panelHtml() webview. |
| Backboard bridge loop | Backboard extension | BackboardBridge.send(), tool calls, continuation, model/tool refresh. |
| Copilot participants | Copilot extension | vscode.chat.createChatParticipant. |
| Copilot sessions | Copilot extension | Chat-session item/content/customization providers. |
| Copilot subagents/tools | Copilot extension | Tool invocation formatting and trace context. |

## Implementation Look Summary

Backboard looks like a self-contained web application embedded into a right-side VS Code view. Copilot looks like native VS Code chat/session infrastructure with participants, session providers, and tool/subagent plumbing. They meet at the product level because both serve agent workflows, but their rendering strategy is different.

## BB-DEEP-DIVE:START

The folder intentionally treats Agents Window, editor, right auxiliary panel, Backboard, and Copilot as one feature dossier because the product behavior is cross-cutting:

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts` owns the physical layout.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts` owns the right auxiliary panel part.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts` and `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` connect the browser editor to chat context.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` implements the custom Backboard panel and bridge.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts` and `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts` implement Copilot's native participant/session integration.

```text
Implementation ownership
|
|-- layout and shell: src/vs/sessions
|-- browser/editor context: src/vs/workbench/contrib/browserView
|-- Backboard custom panel: extensions/backboard
L-- Copilot native chat/session system: extensions/copilot
```

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| Feature claim | Verification target |
|---|---|
| Backboard is custom webview UI | `BackboardPanelProvider`, `resolveWebviewView`, and `panelHtml()` in `extensions/backboard/src/extension.ts`. |
| Copilot is native chat/session infrastructure | `vscode.chat.createChatParticipant` and `vscode.chat.registerChatSessionContentProvider` in `extensions/copilot`. |
| Right aux is part of sessions workbench layout | `Parts.AUXILIARYBAR_PART` leaf node and `AuxiliaryBarPart` implementation. |
| Editor push/pull changes the layout | `workbench.action.agentSessions.pushEditorRight` and `workbench.action.agentSessions.pullEditorLeft`. |

## BB-VERIFICATION-MATRIX:END
