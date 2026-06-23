# Built In Language Support Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/built-in-language-support/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Built In Language Support     | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `built-in-language-support`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css-language-features/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/html-language-features/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/html/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/scss/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css-language-features/server/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/html-language-features/server/package.json` - Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/ipynb/src/ipynbMain.browser.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/extension.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/highlights.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/navigation.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/references-view.d.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/tree.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/src/utils.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/typescript-language-features/src/extension.browser.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/typescript-language-features/src/remoteRepositories.browser.ts` - Implementation file participating in the feature surface or supporting source area.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/html-language-features/client/src/languageParticipants.ts` - Implementation file participating in the feature surface or supporting source area.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/bat/package.json` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/clojure/package.json` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/coffeescript/package.json` |

## UI Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json
    "url": "https://github.com/Microsoft/vscode-references-view"
  },
  "bugs": {
    "url": "https://github.com/Microsoft/vscode-references-view/issues"
  },
  "activationEvents": [
    "onCommand:references-view.find",
    "onCommand:editor.action.showReferences"
  ],
  "main": "./out/extension",
  "browser": "./dist/browser/extension",
  "contributes": {
    "configuration": {
      "properties": {
        "references.preferredLocation": {
          "description": "%config.references.preferredLocation%",
          "type": "string",
          "default": "peek",
          "enum": [
            "peek",
            "view"
          ],
          "enumDescriptions": [
            "%config.references.preferredLocation.peek%",
            "%config.references.preferredLocation.view%"
          ]
        }
      }
    },
    "viewsContainers": {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/bat/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/bat/package.json
  },
  "scripts": {
    "update-grammar": "node ../node_modules/vscode-grammar-updater/bin mmims/language-batchfile grammars/batchfile.cson ./syntaxes/batchfile.tmLanguage.json"
  },
  "categories": ["Programming Languages"],
  "contributes": {
    "languages": [
      {
        "id": "bat",
        "extensions": [
          ".bat",
          ".cmd"
        ],
        "aliases": [
          "Batch",
          "bat"
        ],
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "bat",
        "scopeName": "source.batchfile",
        "path": "./syntaxes/batchfile.tmLanguage.json"
      }
    ],
    "snippets": [
      {
        "language": "bat",
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/clojure/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/clojure/package.json
  },
  "scripts": {
    "update-grammar": "node ../node_modules/vscode-grammar-updater/bin atom/language-clojure grammars/clojure.cson ./syntaxes/clojure.tmLanguage.json"
  },
  "categories": ["Programming Languages"],
  "contributes": {
    "languages": [
      {
        "id": "clojure",
        "aliases": [
          "Clojure",
          "clojure"
        ],
        "extensions": [
          ".clj",
          ".cljs",
          ".cljc",
          ".cljx",
          ".clojure",
          ".edn"
        ],
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "clojure",
        "scopeName": "source.clojure",
        "path": "./syntaxes/clojure.tmLanguage.json"
      }
```

