# Source Crosswalk

This file maps source directories and built-in extensions to the `bb-docs` feature folders. It is meant to make the documentation coverage auditable.

## Workbench Contrib Directories

| Feature folder | Primary `src/vs/workbench/contrib` directories |
|---|---|
| `accessibility-localization-themes` | `accessibility`, `accessibilitySignals`, `localization`, `sash`, `scrollLocking`, `styleOverrides`, `themes` |
| `accounts-authentication-secrets` | `authentication`, `encryption` |
| `ai-chat-inline-assistance` | `agentsVoice`, `chat`, `inlineChat`, `inlineCompletions`, `speech` |
| `agents-editor-right-aux-backboard-copilot` | `browserView`, `chat` |
| `backboard-agent-bridge` | `optimus` |
| `comments-review` | `comments` |
| `debugging` | `debug` |
| `diff-merge-history` | `bulkEdit`, `editSessions`, `localHistory`, `mergeEditor`, `multiDiffEditor`, `timeline` |
| `editor-language-intelligence` | `bracketPairColorizer2Telemetry`, `callHierarchy`, `codeActions`, `codeEditor`, `dropOrPasteInto`, `emmet`, `folding`, `format`, `inlayHints`, `languageDetection`, `languageStatus`, `limitIndicator`, `outline`, `snippets`, `typeHierarchy` |
| `extension-authoring-api` | `commands`, `tags` |
| `extensions-marketplace` | `extensions` |
| `files-workspaces-explorer` | `files`, `list`, `opener`, `workspace`, `workspaces` |
| `markdown-preview-docs` | `markdown` |
| `mcp-tools-customizations` | `mcp` |
| `notebooks-interactive` | `interactive`, `notebook`, `replNotebook` |
| `performance-telemetry-diagnostics` | `editTelemetry`, `performance`, `policyExport`, `processExplorer`, `telemetry` |
| `problems-output-logs` | `logs`, `markers`, `output` |
| `remote-tunnels-network` | `browserView`, `externalUriOpener`, `meteredConnection`, `remote`, `remoteCodingAgents`, `remoteTunnel`, `share`, `url` |
| `search-navigation` | `quickaccess`, `search`, `searchEditor` |
| `settings-keybindings-profiles-sync` | `keybindings`, `keybindingsExport`, `preferences`, `userDataProfile`, `userDataSync` |
| `source-control-git-github` | `git`, `scm` |
| `terminal-tasks` | `externalTerminal`, `tasks`, `terminal`, `terminalContrib` |
| `testing` | `testing` |
| `webviews-custom-editors-media` | `customEditor`, `imageCarousel`, `webview`, `webviewPanel`, `webviewView` |
| `welcome-onboarding-updates` | `emergencyAlert`, `issue`, `relauncher`, `splash`, `surveys`, `update`, `welcomeAgentSessions`, `welcomeBanner`, `welcomeGettingStarted`, `welcomeOnboarding`, `welcomeViews`, `welcomeWalkthrough` |

## Workbench Services And Platform Areas

| Feature folder | Supporting service/platform areas |
|---|---|
| `accounts-authentication-secrets` | `src/vs/workbench/services/accounts`, `authentication`, `secrets`; `src/vs/platform/secrets`, `encryption` |
| `ai-chat-inline-assistance` | `src/vs/workbench/services/chat`, `inlineCompletions`, `aiEmbeddingVector`, `aiRelatedInformation`, `aiSettingsSearch`; `src/vs/platform/agentPlugins` |
| `agent-sessions-window` | `src/vs/sessions/**`; `src/vs/workbench/services/agentHost`; `src/vs/platform/agentHost` |
| `agents-editor-right-aux-backboard-copilot` | `src/vs/sessions/**`; `src/vs/workbench/contrib/browserView`; `src/vs/workbench/contrib/chat`; `src/vs/workbench/services/browserView`, `chat` |
| `editor-language-intelligence` | `src/vs/editor/**`; `src/vs/workbench/services/language`, `languageDetection`, `languageStatus`, `suggest`, `textMate`, `treeSitter` |
| `extensions-marketplace` | `src/vs/workbench/services/extensionManagement`, `extensionRecommendations`, `extensions`; `src/vs/platform/extensionManagement`, `extensions` |
| `files-workspaces-explorer` | `src/vs/workbench/services/files`, `textfile`, `workingCopy`, `workspaces`; `src/vs/platform/files`, `workspace`, `workspaces` |
| `mcp-tools-customizations` | `src/vs/workbench/services/mcp`; `src/vs/platform/mcp`; `src/vs/workbench/contrib/chat/browser/aiCustomization` |
| `remote-tunnels-network` | `src/vs/workbench/services/remote`, `tunnel`, `request`, `browserView`; `src/vs/platform/remote`, `tunnel`, `request`, `browserView` |
| `settings-keybindings-profiles-sync` | `src/vs/workbench/services/preferences`, `configuration`, `keybinding`, `userDataProfile`, `userDataSync`; `src/vs/platform/configuration`, `keybinding`, `userDataSync` |
| `terminal-tasks` | `src/vs/workbench/services/terminal`; `src/vs/platform/terminal`, `externalTerminal` |

## Built-in Extension Groups

| Feature folder | Extension folders |
|---|---|
| `backboard-agent-bridge` | `extensions/backboard` |
| `backboard-changes` | Current uncommitted changes and recent commits touching `extensions/backboard`, `src/vs/sessions`, `src/vs/workbench/browser/parts/sidebar`, `src/vs/workbench/contrib/browserView`, and `src/vs/workbench/contrib/chat` |
| `agents-editor-right-aux-backboard-copilot` | `extensions/backboard`, `extensions/copilot` |
| `ai-chat-inline-assistance`, `agent-sessions-window`, `mcp-tools-customizations` | `extensions/copilot` |
| `source-control-git-github` | `extensions/git`, `extensions/git-base`, `extensions/github`, `extensions/github-authentication` |
| `accounts-authentication-secrets` | `extensions/microsoft-authentication`, `extensions/github-authentication` |
| `terminal-tasks` | `extensions/npm`, `extensions/grunt`, `extensions/gulp`, `extensions/jake`, `extensions/terminal-suggest` |
| `markdown-preview-docs` | `extensions/markdown-basics`, `extensions/markdown-language-features`, `extensions/markdown-math`, `extensions/mermaid-markdown-features` |
| `webviews-custom-editors-media` | `extensions/media-preview`, `extensions/simple-browser`, `extensions/notebook-renderers` |
| `debugging` | `extensions/debug-auto-launch`, `extensions/debug-server-ready` |
| `diff-merge-history` | `extensions/merge-conflict`, `extensions/search-result` |
| `extension-authoring-api` | `extensions/extension-editing`, `extensions/vscode-api-tests`, `extensions/vscode-test-resolver`, `extensions/vscode-colorize-tests`, `extensions/vscode-colorize-perf-tests` |
| `built-in-language-support` | `bat`, `clojure`, `coffeescript`, `cpp`, `csharp`, `css`, `css-language-features`, `dart`, `diff`, `docker`, `dotenv`, `fsharp`, `go`, `groovy`, `handlebars`, `hlsl`, `html`, `html-language-features`, `ini`, `ipynb`, `java`, `javascript`, `json`, `json-language-features`, `julia`, `latex`, `less`, `log`, `lua`, `make`, `objective-c`, `perl`, `php`, `php-language-features`, `powershell`, `prompt-basics`, `pug`, `python`, `r`, `razor`, `references-view`, `restructuredtext`, `ruby`, `rust`, `scss`, `shaderlab`, `shellscript`, `sql`, `swift`, `typescript-basics`, `typescript-language-features`, `vb`, `xml`, `yaml` |
| `accessibility-localization-themes` | `theme-abyss`, `theme-defaults`, `theme-kimbie-dark`, `theme-monokai`, `theme-monokai-dimmed`, `theme-quietlight`, `theme-red`, `theme-seti`, `theme-solarized-dark`, `theme-solarized-light`, `theme-tomorrow-night-blue` |
