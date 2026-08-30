# Extension Authoring Api Ownership And Files

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extension-authoring-api/features/ownership-and-files.md`

## Owner-Style Source Buckets

```text
extension-authoring-api
|
|-- workbench contrib code: src/vs/workbench/contrib/...
|-- workbench services:     src/vs/workbench/services/...
|-- platform services:      src/vs/platform/...
|-- built-in extensions:    extensions/...
L-- Backboard/session code: extensions/backboard and src/vs/sessions when listed
```

## Full File Table

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/tags.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/browser/workspaceTagsService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/commands.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/extensionEditingBrowserMain.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/src/extension.browser.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/browser.cdp.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/browser.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/browser.tools.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTags.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/tsconfig.browser.json` | Structured registry/configuration file consumed by the workbench or extension host. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/tsconfig.browser.json` | Structured registry/configuration file consumed by the workbench or extension host. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/common/javaWorkspaceTags.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/common/workspaceTags.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/constants.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/extensionEditingMain.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/extensionEngineValidation.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/extensionLinter.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/jsonReconstruct.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/packageDocumentHelper.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src/packageDocumentL10nSupport.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/extension.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/memfs.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/utils.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testWorkspace/10linefile.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testWorkspace/30linefile.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testWorkspace/myFile.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/src/colorizer.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/src/colorizerTestMain.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/src/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/src/colorizer.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/src/colorizerTestMain.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/src/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/src/download.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/src/extension.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/chat.runInTerminal.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/chat.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/configuration.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/debug.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/documentPaste.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/editor.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/env.power.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/env.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/extensions.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/interactiveWindow.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/ipynb.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/languagedetection.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/languages.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/lm.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/module.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/notebook.api.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/notebook.document.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/notebook.editor.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/notebook.kernel.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/proxy.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/quickInput.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/readonlyFileSystem.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/rpc.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/state.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/terminal.shellIntegration.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/terminal.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/tree.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/types.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/window.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/workspace.event.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/workspace.fs.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/workspace.tasks.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/workspace.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/singlefolder-tests/workspace.watcher.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/workspace-tests/index.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src/workspace-tests/workspace.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-checker.ts` | Implementation file participating in the feature surface or supporting source area. |

## First-Level Source Children

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/esbuild.browser.mts
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/images
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.nls.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/tsconfig.browser.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/src
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testWorkspace
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testworkspace.code-workspace
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/testWorkspace2
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/package.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/src
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/package.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/producticons
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/src
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/test
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/.vscodeignore
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/esbuild.browser.mts
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/scripts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/tsconfig.browser.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/test
```

## File Review Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'src/vs/workbench/contrib/commands' 'src/vs/workbench/contrib/tags' 'extensions/extension-editing' 'extensions/vscode-api-tests' 'extensions/vscode-test-resolver' 'extensions/vscode-colorize-tests' 'extensions/vscode-colorize-perf-tests' -maxdepth 3 -type f | sort | sed -n '1,160p'
```

