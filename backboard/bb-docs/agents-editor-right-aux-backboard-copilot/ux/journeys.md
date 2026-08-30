# Agents Editor Right Aux Backboard Copilot UX Journeys

## Journey 1: Use Backboard In The Right Panel

```text
Open Backboard
    |
    v
Command backboard.openRightPanel / backboard.openPanel
    |
    v
workbench.view.extension.backboard opens the Backboard view container
    |
    v
backboard.panel webview resolves and renders panelHtml()
    |
    v
User chooses model/mode/options and sends a prompt
    |
    v
BackboardBridge sends turn, streams deltas, executes tools, updates history
```

## Journey 2: Use Editor With Right Auxiliary Panel

```text
Open session
    |
    v
Sessions workbench creates right section
    |
    +--> auxiliary bar visible
    L--> editor visible
          |
          +--> Push Editor Right hides auxiliary bar
          L--> Pull Editor Left restores auxiliary bar
```

## Journey 3: Use Browser Screenshot In Chat

```text
Browser view exists
    |
    v
Titlebar action Add Area Screenshot to Chat
    |
    v
Session action ensures BrowserEditorInput is active
    |
    v
BrowserViewCommandId.AddAreaScreenshotToChat
    |
    v
Browser editor selection attaches screenshot context to chat
```

## Journey 4: Use Copilot Agent Sessions

```text
Copilot activates chat/session contribution
    |
    v
Registers chat participants and session content providers
    |
    v
User opens Copilot CLI, Claude, or cloud session
    |
    v
Provider builds native chat history/session item UI
    |
    v
Tools, subagents, worktrees, and model providers run behind native VS Code chat APIs
```
