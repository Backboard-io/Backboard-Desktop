# Terminal Tasks Ownership And Files

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/terminal-tasks/features/ownership-and-files.md`

## Owner-Style Source Buckets

```text
terminal-tasks
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
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/common/capabilities/partialCommandDetectionCapability.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/browser/task.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminal.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminal.web.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalMainContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/electron-browser/terminal.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/electron-browser/terminalNativeContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/test/electron-browser/externalTerminal.contribution.test.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/accessibility/browser/terminal.accessibility.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/autoReplies/browser/terminal.autoReplies.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chat/browser/terminal.chat.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/terminal.chatAgentTools.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/developer/browser/terminal.developer.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/environmentChanges/browser/terminal.environmentChanges.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/find/browser/terminal.find.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/history/browser/terminal.history.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/inlineHint/browser/terminal.initialHint.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/links/browser/terminal.links.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/notification/browser/terminal.notification.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickAccess/browser/terminal.quickAccess.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickFix/browser/terminal.quickFix.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/resizeDimensionsOverlay/browser/terminal.resizeDimensionsOverlay.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/sendSignal/browser/terminal.sendSignal.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/stickyScroll/browser/terminal.stickyScroll.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/stickyScroll/browser/terminalStickyScrollContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/suggest/browser/terminal.suggest.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/telemetry/browser/terminal.telemetry.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/typeAhead/browser/terminal.typeAhead.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/voice/browser/terminal.voice.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/wslRecommendation/browser/terminal.wslRecommendation.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/zoom/browser/terminal.zoom.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/electron-browser/externalTerminalService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/browser/abstractTaskService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/browser/taskService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/electron-browser/taskService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/agentHostTerminalService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalConfigurationService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalEditingService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalEditorService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalGroupService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalInstanceService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalProfileResolverService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalProfileService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/electron-browser/terminalProfileResolverService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/terminalConfigurationService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/terminalInstanceService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/terminalProfileService.integrationTest.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/terminalService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chat/browser/terminalChatService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkProviderService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickFix/browser/terminalQuickFixService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chat/test/browser/terminalChatService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/browser/terminalSandboxService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/suggest/test/browser/terminalCompletionService.escaping.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/suggest/test/browser/terminalCompletionService.test.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/ahpTerminalCommandSource.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/chatTerminalCommandMirror.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser/terminalCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/ahpTerminalCommandSource.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/chatTerminalCommandMirror.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/terminalActions.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chat/browser/terminalChatActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/treeSitterCommandParser.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickFix/browser/terminalQuickFixBuiltinActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/voice/browser/terminalVoiceActions.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/capabilities/commandDetectionCapability.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test/browser/capabilities/partialCommandDetectionCapability.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/commandParsers/commandFileWriteParser.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/getTerminalLastCommandTool.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/terminalCommandArtifactCollector.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/terminalCommandParser.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/browser/commandLineAutoApproveAnalyzer.test.ts` | Command/action layer: exposes invokable behavior and menu integration. |

## First-Level Source Children

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/images
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/package.nls.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/grunt/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/images
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/package.nls.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/gulp/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/images
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/package.nls.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/jake/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/.vscodeignore
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/esbuild.browser.mts
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/images
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/package.nls.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/src
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/tsconfig.browser.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/npm/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest

```text
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/.vscodeignore
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/cgmanifest.json
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/dist
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/esbuild.mts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/fixtures
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/media
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/node_modules
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/out
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/package-lock.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/package.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/package.nls.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/scripts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/src
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/testWorkspace
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/ThirdPartyNotices.txt
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/tsconfig.json
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/terminal-suggest/tsconfig.tsbuildinfo
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/electron-browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/electron-main
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/node
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/externalTerminal/test
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/electron-main
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/node
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/terminal/test
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/electron-browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/node
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/externalTerminal/test
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/electron-browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tasks/test
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/browser
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/common
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/electron-browser
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/terminal.all.ts
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/terminalContribChatExports.ts
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/terminalContribExports.ts
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminal/test
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/accessibility
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/autoReplies
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chat
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/chatAgentTools
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/clipboard
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/commandGuide
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/developer
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/environmentChanges
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/find
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/history
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/inlineHint
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/links
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/notification
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickAccess
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/quickFix
[file] /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/README.md
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/resizeDimensionsOverlay
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/terminalContrib/sendSequence
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/terminal

```text
[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/terminal/common
```

## File Review Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'src/vs/workbench/contrib/externalTerminal' 'src/vs/workbench/contrib/tasks' 'src/vs/workbench/contrib/terminal' 'src/vs/workbench/contrib/terminalContrib' 'src/vs/workbench/services/terminal' 'src/vs/platform/terminal' 'src/vs/platform/externalTerminal' 'extensions/npm' -maxdepth 3 -type f | sort | sed -n '1,160p'
```

