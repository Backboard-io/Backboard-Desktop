# Markdown Preview Docs Endpoint Risk Boundaries

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/endpoints/risk-boundaries.md`

## Boundary Diagram

```text
trusted UI state
    |
    v
command/action/menu endpoint
    |
    v
service/controller/provider boundary
    |
    +--> workspace trust / profile / remote authority / extension host
    +--> filesystem / terminal / process / network / webview / authentication when present
    +--> notification / marker / log / telemetry when present
    |
    v
visible result
```

## Risk Table

| Boundary | Failure mode | Review action | Source anchor |
|---|---|---|---|
| Command visibility | Command appears in the wrong context or remains hidden when valid. | Inspect when clauses, context keys, and menu groups. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` |
| Service call | Service dependency is unavailable, delayed, or disposed. | Inspect constructor injection, lifecycle, and Disposable handling. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json` |
| Async boundary | Cancellation, error, or concurrent invocation leaves UI in stale state. | Inspect CancellationToken, promises, event listeners, and finally blocks. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` |
| External boundary | Filesystem, network, extension host, browser view, terminal, or secret store returns failure. | Inspect validation, message routing, and recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` |

## Boundary Code Evidence

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
```

