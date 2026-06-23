# Agents Editor Right Aux Backboard Copilot Commands Settings Services

## Backboard Settings

Backboard declares settings for credentials, environment, API URL, OAuth redirect URI, model/provider defaults, mode, reasoning intensity, web search, image generation, MCP toggles, voice mode, bridge path, workspace root, and update manifests.

### Package contribution excerpt

```json
  ],
  "activationEvents": [
    "onStartupFinished",
    "onCommand:backboard.extension.signIn",
    "onCommand:backboard.setApiKey",
    "onCommand:backboard.copyOAuthRedirectUri",
    "onCommand:backboard.completeOAuthCallback",
    "onCommand:backboard.refreshModels",
    "onCommand:backboard.openRightPanel",
    "onCommand:backboard.openPanel",
    "onCommand:backboard.newChat",
    "onCommand:backboard.showHistory",
    "onUri"
  ],
  "extensionKind": [
    "workspace",
    "ui"
  ],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited"
    }
  },
  "contributes": {
    "commands": [
      {
        "command": "backboard.setApiKey",
        "title": "Backboard: Set API Key"
      },
      {
        "command": "backboard.extension.signIn",
        "title": "Backboard: Sign In"
      },
      {
        "command": "backboard.copyOAuthRedirectUri",
        "title": "Backboard: Copy OAuth Redirect URI"
      },
      {
        "command": "backboard.completeOAuthCallback",
        "title": "Backboard: Complete OAuth Callback"
      },
      {
        "command": "backboard.refreshModels",
        "title": "Backboard: Refresh Models"
      },
      {
        "command": "backboard.openRightPanel",
        "title": "Backboard: Open Right Panel"
      },
      {
        "command": "backboard.openPanel",
        "title": "Backboard: Open Panel"
      },
      {
        "command": "backboard.newChat",
        "title": "Backboard: New Chat"
      },
      {
        "command": "backboard.showHistory",
        "title": "Backboard: Show History"
      },
      {
        "command": "backboard.checkForUpdates",
        "title": "Backboard: Check for Updates"
      },
      {
        "command": "backboard.installAvailableUpdate",
        "title": "Backboard: Install Update",
        "icon": "$(cloud-download)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "backboard.installAvailableUpdate",
          "when": "view == backboard.panel && backboard.updateAvailable",
          "group": "navigation@1"
        }
      ],
      "commandPalette": [
        {
          "command": "backboard.installAvailableUpdate",
          "when": "backboard.updateAvailable"
        }
      ]
    },
    "configuration": [
      {
        "title": "Backboard",
        "properties": {
          "backboard.apiKey": {
            "type": "string",
            "default": "",
```

## Services And Registrations

| Service/registration | Source | Purpose |
|---|---|---|
| IAgentWorkbenchLayoutService | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts | Sessions-specific layout control including editor maximize and auto-visibility suppression. |
| AuxiliaryBarPart | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts | Right auxiliary pane composite. |
| IEditorService | Sessions/browser actions | Opens or activates browser editor before screenshot-to-chat. |
| IBrowserViewWorkbenchService | Browser/session actions | Locates contextual browser views. |
| BackboardBridge | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts | Sends prompts, tools, models, and state between extension and Backboard bridge. |
| vscode.chat.createChatParticipant | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts | Registers Copilot native chat participants. |
| vscode.chat.registerChatSessionContentProvider | /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts | Registers Copilot CLI and Claude session content providers. |
