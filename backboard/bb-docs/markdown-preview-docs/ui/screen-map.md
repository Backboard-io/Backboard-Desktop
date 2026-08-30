# Markdown Preview Docs Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/markdown-preview-docs/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Markdown Preview Docs         | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `markdown-preview-docs`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/activeLineMarker.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/csp.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/diffScrollSync.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/events.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/index.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/loading.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/messaging.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/pre.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/scroll-sync.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/settings.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/preview-src/strings.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/extension.browser.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/types/previewMessaging.d.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/mermaid-markdown-features/src/webviewManager.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/refreshPreview.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/reopenAsPreview.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/src/commands/showPreview.ts` - Implementation file participating in the feature surface or supporting source area.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-basics/package.json` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-language-features/package.json` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/markdown-math/package.json` |

## UI Code Anchors

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
```

