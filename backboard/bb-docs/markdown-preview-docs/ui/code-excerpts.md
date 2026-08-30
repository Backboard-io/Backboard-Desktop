# Markdown Preview Docs UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

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
          "meta.embedded.block.css": "css",
          "meta.embedded.block.ini": "ini",
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
          "text/x-coffee",
          "text/x-cpp",
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
          "text.html.markdown"
        ],
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
        {
          "command": "_mermaid-markdown.copySource",
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'src/vs/workbench/contrib/markdown' 'extensions/markdown-basics' 'extensions/markdown-language-features' 'extensions/markdown-math' 'extensions/mermaid-markdown-features'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'src/vs/workbench/contrib/markdown' 'extensions/markdown-basics' 'extensions/markdown-language-features' 'extensions/markdown-math' 'extensions/mermaid-markdown-features'
```

