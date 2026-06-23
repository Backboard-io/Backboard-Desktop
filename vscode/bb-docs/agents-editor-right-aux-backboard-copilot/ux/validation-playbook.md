# Agents Editor Right Aux Backboard Copilot Validation Playbook

## Manual Checks

1. Open an agent/session window and verify the split: sessions chat area, right auxiliary panel, editor column.
2. Open Backboard with backboard.openRightPanel; verify the panel renders status, log/history area, composer, mode/model controls, web/image/voice/stop/send actions.
3. Use workbench.action.agentSessions.pushEditorRight; verify the auxiliary panel hides and the editor expands.
4. Use workbench.action.agentSessions.pullEditorLeft; verify the auxiliary panel returns and the editor contracts.
5. Open a Browser view in the auxiliary bar; verify Browser is registered under the auxiliary bar and not as a regular sidebar view.
6. Trigger workbench.action.sessions.addBrowserAreaScreenshotToChat with a browser editor open; verify it routes to the browser editor screenshot command.
7. Open a Copilot CLI or Claude chat session; verify the UI is native chat/session editor UI, not Backboard's webview composer.
8. Start a Backboard turn; verify run clock/status/delta/tool cards update and cancellation works.

## Source Checks

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "setPartHidden\(true, Parts\.AUXILIARYBAR_PART\)|setPartHidden\(false, Parts\.AUXILIARYBAR_PART\)|ViewContainerLocation\.AuxiliaryBar|BackboardPanelProvider|registerChatSessionContentProvider|createChatParticipant" src/vs/sessions src/vs/workbench/contrib/browserView extensions/backboard extensions/copilot/src/extension -g '*.ts' -g '!**/node_modules/**'
```
