# ASCII Architecture Atlas

## Whole Documentation Shape

```text
bb-docs
|
|-- README.md
|-- source-crosswalk.md
|-- validation.md
|-- deep-documentation-matrix.md
|-- ascii-architecture-atlas.md
|
L-- feature folders x 29
    |-- README.md
    |-- ui       x 4 markdown files including README
    |-- ux       x 4 markdown files including README
    |-- endpoints x 4 markdown files including README
    L-- features  x 4 markdown files including README
```

## Runtime Shape

```text
user gesture
  |
  +--> workbench shell
  |      |
  |      +--> command registry
  |      +--> menu registry
  |      +--> context keys
  |      +--> view/editor/webview/terminal/notebook surfaces
  |
  +--> extension host
  |      |
  |      +--> built-in extensions
  |      +--> Backboard extension
  |      L--> language, scm, debug, task, notebook, mcp providers
  |
  L--> platform/workbench services
         |
         +--> files, workspace, config, auth, secrets
         +--> chat, remote, terminal, telemetry
         L--> lifecycle, layout, storage, dialogs, notifications
```

## Feature Index

- `accessibility-localization-themes` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accessibility-localization-themes`
- `accounts-authentication-secrets` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accounts-authentication-secrets`
- `agent-sessions-window` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/agent-sessions-window`
- `agents-editor-right-aux-backboard-copilot` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/agents-editor-right-aux-backboard-copilot`
- `ai-chat-inline-assistance` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/ai-chat-inline-assistance`
- `backboard-agent-bridge` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-agent-bridge`
- `backboard-changes` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes`
- `built-in-language-support` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/built-in-language-support`
- `comments-review` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/comments-review`
- `debugging` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/debugging`
- `diff-merge-history` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/diff-merge-history`
- `editor-language-intelligence` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/editor-language-intelligence`
- `extension-authoring-api` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extension-authoring-api`
- `extensions-marketplace` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extensions-marketplace`
- `files-workspaces-explorer` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/files-workspaces-explorer`
- `markdown-preview-docs` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs`
- `mcp-tools-customizations` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/mcp-tools-customizations`
- `modern-ide-system-blueprint` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint`
- `notebooks-interactive` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/notebooks-interactive`
- `performance-telemetry-diagnostics` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/performance-telemetry-diagnostics`
- `problems-output-logs` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/problems-output-logs`
- `remote-tunnels-network` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/remote-tunnels-network`
- `search-navigation` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/search-navigation`
- `settings-keybindings-profiles-sync` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/settings-keybindings-profiles-sync`
- `source-control-git-github` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/source-control-git-github`
- `terminal-tasks` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/terminal-tasks`
- `testing` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/testing`
- `webviews-custom-editors-media` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/webviews-custom-editors-media`
- `welcome-onboarding-updates` -> `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/welcome-onboarding-updates`
