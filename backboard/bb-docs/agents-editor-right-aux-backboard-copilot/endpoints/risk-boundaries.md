# Agents Editor Right Aux Backboard Copilot Risk Boundaries

## Boundary Diagram

```text
UI command or webview event
    |
    +--> sessions layout service
    |      L-- can hide/show/resize auxiliary panel and editor
    |
    +--> browser editor service
    |      L-- can activate browser editor and attach screenshot/element context
    |
    +--> Backboard extension
    |      L-- OAuth, bridge binary, hosted API, tool execution, file-backed panel state
    |
    L--> Copilot extension
           L-- chat participants, chat-session providers, tools, subagents, worktrees
```

## Concrete Risks

| Boundary | Risk | Review file |
|---|---|---|
| Layout split | Wrong saved size can crowd editor or auxiliary panel. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts |
| Push/pull action | Incorrect context can expose editor buttons outside sessions window. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts |
| Browser screenshot action | Action must not run when no browser editor/contextual browser view exists. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts |
| Backboard webview | Message types must be handled defensively and map to cancellation/state correctly. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts |
| Backboard bridge | Tool execution and continuation loops must stop cleanly on cancellation. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts |
| Copilot sessions | Session providers must register only the intended content providers and item providers. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts |
| Copilot subagents | Tool/subagent formatting must preserve parent/child invocation context. | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/copilotcli/common/copilotCLITools.ts |
