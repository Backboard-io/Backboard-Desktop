# Deep Documentation Matrix

This matrix counts the concrete source and documentation surface for every feature folder.

| Feature | Source paths | Candidate files | Detail files |
|---|---:|---:|---:|
| [accessibility-localization-themes](accessibility-localization-themes/README.md) | 18 | 103 | 17 |
| [accounts-authentication-secrets](accounts-authentication-secrets/README.md) | 9 | 109 | 17 |
| [agent-sessions-window](agent-sessions-window/README.md) | 4 | 845 | 17 |
| [agents-editor-right-aux-backboard-copilot](agents-editor-right-aux-backboard-copilot/README.md) | 27 | 27 | 19 |
| [ai-chat-inline-assistance](ai-chat-inline-assistance/README.md) | 12 | 617 | 17 |
| [backboard-agent-bridge](backboard-agent-bridge/README.md) | 2 | 283 | 17 |
| [backboard-changes](backboard-changes/README.md) | 5 | 887 | 21 |
| [built-in-language-support](built-in-language-support/README.md) | 54 | 677 | 17 |
| [comments-review](comments-review/README.md) | 1 | 36 | 17 |
| [debugging](debugging/README.md) | 3 | 122 | 17 |
| [diff-merge-history](diff-merge-history/README.md) | 8 | 109 | 17 |
| [editor-language-intelligence](editor-language-intelligence/README.md) | 22 | 419 | 17 |
| [extension-authoring-api](extension-authoring-api/README.md) | 7 | 352 | 17 |
| [extensions-marketplace](extensions-marketplace/README.md) | 6 | 183 | 17 |
| [files-workspaces-explorer](files-workspaces-explorer/README.md) | 12 | 206 | 17 |
| [markdown-preview-docs](markdown-preview-docs/README.md) | 5 | 191 | 17 |
| [mcp-tools-customizations](mcp-tools-customizations/README.md) | 5 | 410 | 17 |
| [modern-ide-system-blueprint](modern-ide-system-blueprint/README.md) | 15 | 31 | 31 |
| [notebooks-interactive](notebooks-interactive/README.md) | 3 | 278 | 17 |
| [performance-telemetry-diagnostics](performance-telemetry-diagnostics/README.md) | 5 | 55 | 17 |
| [problems-output-logs](problems-output-logs/README.md) | 3 | 34 | 17 |
| [remote-tunnels-network](remote-tunnels-network/README.md) | 16 | 165 | 17 |
| [search-navigation](search-navigation/README.md) | 3 | 72 | 17 |
| [settings-keybindings-profiles-sync](settings-keybindings-profiles-sync/README.md) | 13 | 253 | 17 |
| [source-control-git-github](source-control-git-github/README.md) | 6 | 209 | 17 |
| [terminal-tasks](terminal-tasks/README.md) | 12 | 663 | 17 |
| [testing](testing/README.md) | 1 | 74 | 17 |
| [webviews-custom-editors-media](webviews-custom-editors-media/README.md) | 8 | 116 | 17 |
| [welcome-onboarding-updates](welcome-onboarding-updates/README.md) | 12 | 142 | 17 |

## Repository Root

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode`

## Validation Command

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find bb-docs -type f -name '*.md' | sort | wc -l
find bb-docs -mindepth 2 -maxdepth 2 -type d | sort | wc -l
```
