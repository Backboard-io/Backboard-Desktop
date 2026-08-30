# Markdown Preview Docs Implementation Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/features/implementation-map.md`

## Architecture Map

```text
Markdown Preview Docs
|
|-- Contribution layer
|   |-- package.json, *.contribution.ts, workbench registration
|   L-- command/menu/view/context declarations
|
|-- Runtime layer
|   |-- services, controllers, providers, registries
|   L-- events, state, disposables, async operations
|
|-- Presentation layer
|   |-- browser/view/widget/editor/webview files
|   L-- css, icons, labels, focus, overflow, empty states
|
L-- Validation layer
    |-- tests when present
    L-- manual checks in ux/validation-playbook.md
```

## Source Inventory

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/cgmanifest.json`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/language-configuration.json` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/CONTRIBUTING.md`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/dist` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/cgmanifest.json`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/dist` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features` | directory | `[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/.vscodeignore`<br>`[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/cgmanifest.json`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/chat-webview-out` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test` |

## Implementation Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commandManager.ts` | Command/action layer: exposes invokable behavior and menu integration. |
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

## Implementation Code Anchors

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
        "path": "./syntaxes/markdown.tmLanguage.json",
        "embeddedLanguages": {
          "meta.embedded.block.html": "html",
          "source.js": "javascript",
          "source.css": "css",
          "meta.embedded.block.frontmatter": "yaml",
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
          "text/x-abap",
          "text/x-apex",
          "text/x-azcli",
          "text/x-bat",
          "text/x-cameligo",
          "text/x-clojure",
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json
      "supported": true
    }
  },
  "main": "./out/extension",
  "browser": "./dist/browser/extension",
  "activationEvents": [],
  "contributes": {
    "languages": [
      {
        "id": "markdown-math",
        "aliases": []
      }
    ],
    "grammars": [
      {
        "language": "markdown-math",
        "scopeName": "text.html.markdown.math",
        "path": "./syntaxes/md-math.tmLanguage.json"
      },
      {
        "scopeName": "markdown.math.block",
        "path": "./syntaxes/md-math-block.tmLanguage.json",
        "injectTo": [
          "text.html.markdown"
        ],
        "embeddedLanguages": {
          "meta.embedded.math.markdown": "latex"
        }
      },
      {
        "scopeName": "markdown.math.inline",
        "path": "./syntaxes/md-math-inline.tmLanguage.json",
        "injectTo": [
          "text.html.markdown"
        ],
        "embeddedLanguages": {
          "meta.embedded.math.markdown": "latex",
          "punctuation.definition.math.end.markdown": "latex"
        }
      },
      {
        "scopeName": "markdown.math.codeblock",
        "path": "./syntaxes/md-math-fence.tmLanguage.json",
        "injectTo": [
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json
      "supported": true
    }
  },
  "main": "./out/extension",
  "browser": "./dist/browser/extension",
  "activationEvents": [
    "onWebviewPanel:vscode.mermaid-markdown-features.preview"
  ],
  "contributes": {
    "commands": [
      {
        "command": "_mermaid-markdown.resetPanZoom",
        "title": "%command.resetPanZoom.title%"
      },
      {
        "command": "_mermaid-markdown.openInEditor",
        "title": "%command.openInEditor.title%"
      },
      {
        "command": "_mermaid-markdown.copySource",
        "title": "%command.copySource.title%"
      }
    ],
    "menus": {
      "commandPalette": [
        {
          "command": "_mermaid-markdown.resetPanZoom",
          "when": "false"
        },
        {
          "command": "_mermaid-markdown.openInEditor",
          "when": "false"
        },
        {
          "command": "_mermaid-markdown.copySource",
          "when": "false"
        }
      ],
      "webview/context": [
        {
          "command": "_mermaid-markdown.openInEditor",
          "when": "webviewId == 'vscode.mermaid-markdown-features.chatOutputItem' || (webviewSection == 'mermaid' && (webviewId == 'markdown.preview' || webviewId == 'vscode.markdown.preview.editor' || webviewId == 'notebook.output'))",
          "group": "navigation@1"
        },
```

