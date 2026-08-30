# Markdown Preview Docs UI Source Inventory

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/ui/source-inventory.md`

## Source-To-UI Map

```text
markdown-preview-docs
|
|-- docs
|   |-- ui
|   |-- ux
|   |-- endpoints
|   L-- features
|
L-- source inventory
   |-- extensions/markdown-basics
   |-- extensions/markdown-language-features
   |-- extensions/markdown-math
   |-- extensions/mermaid-markdown-features
   L-- src/vs/workbench/contrib/markdown
```

## Full Source Paths

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/cgmanifest.json`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/language-configuration.json` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/CONTRIBUTING.md`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/dist` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/cgmanifest.json`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/dist` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/cgmanifest.json`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/chat-webview-out` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test` |

## UI-Relevant Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/activeLineMarker.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/csp.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/diffScrollSync.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/events.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/loading.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/messaging.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/pre.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/scroll-sync.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/settings.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/strings.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/extension.browser.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/types/previewMessaging.d.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/src/webviewManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/refreshPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/reopenAsPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/showPreview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/showPreviewSecuritySelector.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/documentRenderer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/lineDiff.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/markdownEditorProvider.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/preview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/previewConfig.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/previewManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/renderedDiffWarning.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/scrolling.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/security.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/preview/topmostLineMonitor.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/chat/index-editor.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/chat/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/chat/mermaidWebview.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/chat/vscodeApi.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/markdown/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/notebook/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/config.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/css.d.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/diagramManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/disposable.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/iconPackConfig.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/preview-src/shared/vsCodeTheme.ts` | Implementation file participating in the feature surface or supporting source area. |

## Concrete Source Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts
import '../common/markdownColors.js';
import './media/markdown.css';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json
    "vscode": "^1.20.0"
  },
  "categories": [
    "Programming Languages"
  ],
  "contributes": {
    "languages": [
      {
        "id": "markdown",
        "aliases": [
          "Markdown",
          "markdown"
        ],
        "extensions": [
          ".md",
          ".mkd",
          ".mkdn",
          ".mdwn",
          ".mdown",
          ".markdown",
          ".markdn",
          ".mdtxt",
          ".mdtext",
          ".litcoffee",
          ".ron",
          ".ronn",
          ".workbook"
        ],
        "filenamePatterns": [
          "**/.cursor/**/*.mdc"
        ],
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "markdown",
        "scopeName": "text.html.markdown",
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json
  "main": "./out/extension",
  "browser": "./dist/browser/extension",
  "categories": [
    "Programming Languages"
  ],
  "activationEvents": [
    "onLanguage:markdown",
    "onLanguage:prompt",
    "onLanguage:instructions",
    "onLanguage:chatagent",
    "onLanguage:skill",
    "onCommand:markdown.api.render",
    "onCommand:markdown.api.reloadPlugins",
    "onWebviewPanel:markdown.preview"
  ],
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "%workspaceTrust%",
      "restrictedConfigurations": [
        "markdown.styles"
      ]
    }
  },
  "contributes": {
    "notebookRenderer": [
      {
        "id": "vscode.markdown-it-renderer",
        "displayName": "Markdown it renderer",
        "entrypoint": "./notebook-out/index.js",
        "mimeTypes": [
          "text/markdown",
          "text/latex",
          "text/x-css",
          "text/x-html",
          "text/x-json",
          "text/x-typescript",
```

## Repository Inspection Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "class .*View|registerAction2|MenuId\.|toolbar|title|pane|widget|view|css|render|layout" 'src/vs/workbench/contrib/markdown' 'extensions/markdown-basics' 'extensions/markdown-language-features' 'extensions/markdown-math' 'extensions/mermaid-markdown-features'
find 'bb-docs/markdown-preview-docs/ui' -maxdepth 1 -type f | sort
```

