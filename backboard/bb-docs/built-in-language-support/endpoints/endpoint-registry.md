# Built In Language Support Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/built-in-language-support/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `editor.action.showReferences` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/dist/extension.js` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | onCommand:references-view.find, onCommand:editor.action.showReferences |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | 21 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | properties |
| `contributes.views` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | references-view |
| `contributes.viewsContainers` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | activitybar |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | editor/context, view/title, view/item/context, commandPalette |
| `contributes.keybindings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/references-view/package.json` | 4 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/bat/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/bat/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/clojure/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/clojure/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/coffeescript/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/coffeescript/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/cpp/package.json` | 3 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/cpp/package.json` | 5 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/csharp/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/csharp/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css-language-features/package.json` | onLanguage:css, onLanguage:less, onLanguage:scss |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css-language-features/package.json` | 3 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/css/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/dart/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/dart/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/diff/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/diff/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/docker/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/docker/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/dotenv/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/dotenv/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/fsharp/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/fsharp/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/go/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/go/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/groovy/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/groovy/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/handlebars/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/handlebars/package.json` | 1 entries |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/hlsl/package.json` | 1 entries |
| `contributes.grammars` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/hlsl/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/html-language-features/package.json` | onLanguage:html, onLanguage:handlebars |

## Endpoint Flow

```text
UI gesture or extension activation
    |
    v
Command/action/menu/view contribution
    |
    v
Service, controller, provider, or extension host boundary
    |
    v
State update, editor update, terminal/process work, webview message, or filesystem/network operation
    |
    v
User-visible result, cancellation, notification, marker, log, or disabled affordance
```

## Endpoint Code Evidence

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
      "activitybar": [
        {
          "id": "references-view",
          "icon": "$(references)",
          "title": "%container.title%"
        }
      ]
    },
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
        "path": "./snippets/batchfile.code-snippets"
      }
    ]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/microsoft/vscode.git"
  }
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
    ],
    "configurationDefaults": {
      "[clojure]": {
        "diffEditor.ignoreTrimWhitespace": false
      }
    }
  },
  "repository": {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/coffeescript/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/coffeescript/package.json
  },
  "scripts": {
    "update-grammar": "node ../node_modules/vscode-grammar-updater/bin atom/language-coffee-script grammars/coffeescript.cson ./syntaxes/coffeescript.tmLanguage.json"
  },
  "categories": ["Programming Languages"],
  "contributes": {
    "languages": [
      {
        "id": "coffeescript",
        "extensions": [
          ".coffee",
          ".cson",
          ".iced"
        ],
        "aliases": [
          "CoffeeScript",
          "coffeescript",
          "coffee"
        ],
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "coffeescript",
        "scopeName": "source.coffee",
        "path": "./syntaxes/coffeescript.tmLanguage.json"
      }
    ],
    "breakpoints": [
      {
        "language": "coffeescript"
      }
    ],
    "snippets": [
      {
        "language": "coffeescript",
        "path": "./snippets/coffeescript.code-snippets"
```

