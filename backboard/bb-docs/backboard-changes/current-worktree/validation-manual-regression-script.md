# Backboard Manual Regression Script

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes/current-worktree/validation-manual-regression-script.md`

## Regression Map

```text
1. Launch workbench with Backboard default chat agent.
2. Open Agents Window with browser editor and auxiliary bar visible.
3. Confirm sidebar activity navigation is a compact header.
4. Confirm Backboard composer omits usage button but preserves send/stop/voice/image/web.
5. Confirm browser screenshot-to-chat action appears in valid browser editor contexts.
6. Confirm browser toolbar does not show the removed chat sign-in placement.
7. Narrow the window and confirm title tabs, auxiliary bar, and sidebar header do not overlap.
```

## Source Verification Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
git diff --stat
git diff -- src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
git diff -- src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts
git diff -- extensions/backboard/src/extension.ts
git diff -- src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts
```

## UI Checks

| Area | Pass condition | Source file |
|---|---|---|
| Browser screenshot action | The titlebar/browser action can start area screenshot selection when browser editor context is valid. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts` |
| Composer actions | Usage button is absent from visible Backboard composer actions. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` |
| Chat input status | Usage metrics command is not contributed to MenuId.ChatInputStatus. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts` |
| Browser toolbar | Sign-in action is not contributed to MenuId.BrowserActionsToolbar by chat setup. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| Sidebar header | Activity navigation uses sidebar header area instead of title-row insertion. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts` |
| Agents Window density | Auxiliary bar can collapse narrower and title actions truncate cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css` |

