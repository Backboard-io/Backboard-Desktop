# Source Control Git Github Validation Playbook

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/source-control-git-github/ux/validation-playbook.md`

## Manual Validation Flow

```text
+-------------------+
| Start clean build |
+---------+---------+
          |
          v
+-------------------+
| Open feature path |
+---------+---------+
          |
          v
+-------------------+
| Invoke endpoint   |
+---------+---------+
          |
          v
+-------------------+
| Verify UI state   |
+---------+---------+
          |
          v
+-------------------+
| Exercise recovery |
+-------------------+
```

## Validation Steps

1. Open the product with a clean profile so stale storage does not hide contribution or activation issues.
2. Use the commands below to inspect source registrations before relying on UI behavior.
3. Trigger the primary command, view, editor, or extension flow for `source-control-git-github`.
4. Narrow the window and check that labels, icons, tabs, lists, and editor chrome do not overlap.
5. Toggle high contrast or keyboard-only interaction if this feature has a visible surface.
6. Exercise cancellation, disabled context, empty state, and error state using the state matrix.
7. Re-run the docs validation commands to ensure this documentation still maps to real source paths.

## Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
find 'bb-docs/source-control-git-github' -maxdepth 3 -type f | sort
rg -n "registerAction2|CommandsRegistry|MenuRegistry|createDecorator|class |interface |package.json|contributes" 'extensions/git' 'extensions/git-base' 'extensions/github' 'extensions/github-authentication' 'src/vs/workbench/contrib/git' 'src/vs/workbench/contrib/scm'
rg -n "source-control-git-github|Source Control Git Github" bb-docs/source-control-git-github
```

## Evidence Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.service.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/git.contributions.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/quickDiff.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/gitService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scmViewService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/common/experimentationService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/common/gitService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/quickDiffService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/common/scmService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/package.json` | Extension manifest: activation, contributions, command IDs, menus, and declarative surfaces. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/actionButton.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/commands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git/src/postCommitCommands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github/src/commands.ts` | Command/action layer: exposes invokable behavior and menu integration. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/authServer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/buffer.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/crypto.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/github-authentication/src/browser/fetch.ts` | Implementation file participating in the feature surface or supporting source area. |

## Review Code Snippets

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.service.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scm/browser/scm.service.contribution.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISCMService, ISCMViewService } from '../common/scm.js';
import { SCMService } from '../common/scmService.js';
import { SCMViewService } from './scmViewService.js';

registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);
registerSingleton(ISCMViewService, SCMViewService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/git.contributions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/git/browser/git.contributions.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IGitService } from '../common/gitService.js';
import { GitService } from './gitService.js';

registerSingleton(IGitService, GitService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/git-base/package.json
    "vscode": "0.10.x"
  },
  "categories": [
    "Other"
  ],
  "activationEvents": [
    "*"
  ],
  "main": "./out/extension.js",
  "browser": "./dist/browser/extension.js",
  "icon": "resources/icons/git.png",
  "scripts": {
    "compile": "gulp compile-extension:git-base",
    "watch": "gulp watch-extension:git-base",
    "update-grammar": "node ./build/update-grammars.js"
  },
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "contributes": {
    "commands": [
      {
        "command": "git-base.api.getRemoteSources",
        "title": "%command.api.getRemoteSources%",
        "category": "Git Base API"
      }
    ],
    "menus": {
      "commandPalette": [
```

