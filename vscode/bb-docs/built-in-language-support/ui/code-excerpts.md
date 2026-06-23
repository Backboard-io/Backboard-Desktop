# Built In Language Support UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/built-in-language-support/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

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
    "views": {
      "references-view": [
        {
          "id": "references-view.tree",
          "name": "%view.title%",
          "when": "reference-list.isActive"
        }
      ]
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
    "type": "git",
    "url": "https://github.com/microsoft/vscode.git"
  }
}
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
      }
    ],
    "configurationDefaults": {
      "[coffeescript]": {
        "diffEditor.ignoreTrimWhitespace": false,
        "editor.defaultColorDecorators": "never"
      }
    }
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/cpp/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/cpp/package.json
  },
  "scripts": {
    "update-grammar": "node ./build/update-grammars.js"
  },
  "categories": ["Programming Languages"],
  "contributes": {
    "languages": [
      {
        "id": "c",
        "extensions": [
          ".c",
          ".i"
        ],
        "aliases": [
          "C",
          "c"
        ],
        "configuration": "./language-configuration.json"
      },
      {
        "id": "cpp",
        "extensions": [
          ".cpp",
          ".cppm",
          ".cc",
          ".ccm",
          ".cxx",
          ".cxxm",
          ".c++",
          ".c++m",
          ".hpp",
          ".hh",
          ".hxx",
          ".h++",
          ".h",
          ".ii",
          ".ino",
          ".inl",
          ".ipp",
          ".ixx",
          ".tpp",
          ".txx",
          ".hpp.in",
          ".h.in"
        ],
        "aliases": [
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'extensions/bat' 'extensions/clojure' 'extensions/coffeescript' 'extensions/cpp' 'extensions/csharp' 'extensions/css' 'extensions/css-language-features' 'extensions/dart' 'extensions/diff' 'extensions/docker' 'extensions/dotenv' 'extensions/fsharp'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'extensions/bat' 'extensions/clojure' 'extensions/coffeescript' 'extensions/cpp' 'extensions/csharp' 'extensions/css' 'extensions/css-language-features' 'extensions/dart' 'extensions/diff' 'extensions/docker' 'extensions/dotenv' 'extensions/fsharp'
```

