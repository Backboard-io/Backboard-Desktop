# Debugging Ownership And Files

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/debugging/features/ownership-and-files.md`

## Owner-Style Source Buckets

```text
debugging
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
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.service.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debug.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/extensionHostDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/electron-browser/extensionHostDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugActionViewItems.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugEditorActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/callStackEditorContribution.css` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/debug.contribution.css` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/nullDebugService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/debugViewModel.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common/disassemblyViewInput.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/baseDebugView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointsView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/breakpointWidget.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/callStackWidget.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugAdapterManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugANSIHandling.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugChatIntegration.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugColors.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugConfigurationManager.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugConsoleQuickAccess.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugExpressionRenderer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugHover.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugIcons.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugMemory.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugProgress.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugQuickAccess.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugSession.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugSessionPicker.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugSettingMigration.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugStatus.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugTaskRunner.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugTitle.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugToolBar.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/debugViewlet.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/disassemblyView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/exceptionWidget.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/linkDetector.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/loadedScriptsView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/rawDebugSession.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/repl.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/replAccessibilityHelp.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/replAccessibleView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/replFilter.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/replViewer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/runAndDebugAccessibilityHelp.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/statusbarColorProvider.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/variablesView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/watchExpressionsView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/welcomeView.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/baseDebugView.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/breakpoints.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/callStack.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugANSIHandling.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugConfigurationManager.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugHover.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugMemory.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugSession.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugSource.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugUtils.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/debugViewModel.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/linkDetector.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/mockDebugModel.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/rawDebugSession.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/repl.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/variablesView.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/watch.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test/browser/watchExpressionView.test.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/breakpointWidget.css` | Presentation layer: controls layout, density, colors, states, and overflow. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/callStackWidget.css` | Presentation layer: controls layout, density, colors, states, and overflow. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/debugHover.css` | Presentation layer: controls layout, density, colors, states, and overflow. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser/media/debugToolBar.css` | Presentation layer: controls layout, density, colors, states, and overflow. |

## First-Level Source Children

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/package.nls.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-auto-launch/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/package.nls.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/debug-server-ready/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/electron-browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/node
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/debug/test
```

## File Review Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'src/vs/workbench/contrib/debug' 'extensions/debug-auto-launch' 'extensions/debug-server-ready' -maxdepth 3 -type f | sort | sed -n '1,160p'
```

