# Markdown Preview Docs Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/features/extension-points.md`

## Extension-Point Diagram

```text
package.json / contribution file
    |
    v
command, menu, view, provider, or service registration
    |
    v
activation and context-key gate
    |
    v
runtime implementation
    |
    v
visible feature behavior
```

## Declarative Extension Points

| Contribution type | Source file | Detail |
|---|---|---|
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | onLanguage:markdown, onLanguage:prompt, onLanguage:instructions, onLanguage:chatagent, onLanguage:skill, onCommand:markdown.api.render, onCommand:markdown.api.reloadPlugins, onWebviewPanel:markdown.preview |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | 16 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | 4 entries |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | webview/context, editor/title, modalEditor/editorTitle, explorer/context, editor/title/context, commandPalette |
| `contributes.keybindings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` | 2 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` |  |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` | 4 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json` | onWebviewPanel:vscode.mermaid-markdown-features.preview |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json` | 3 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json` | title, properties |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/package.json` | commandPalette, webview/context |

## Runtime Extension Points

- `ILanguageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts`
- `IClipboardService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownSettingRenderer.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownSettingRenderer.ts`
- `IContextMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownSettingRenderer.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownSettingRenderer.ts`
- `IPreferencesService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdownSettingRenderer.ts`
- `ILanguageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test/browser/markdownDocumentRenderer.test.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test/browser/markdownDocumentRenderer.test.ts`
- `IContextMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test/browser/markdownSettingRenderer.test.ts`
- `IPreferencesService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/test/browser/markdownSettingRenderer.test.ts`

## Command/Menu Extension Points

- No direct entries surfaced from the selected inventory scan.

## Extension Point Code Evidence

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
```

