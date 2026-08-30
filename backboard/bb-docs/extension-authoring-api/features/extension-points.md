# Extension Authoring Api Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extension-authoring-api/features/extension-points.md`

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
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json` | onLanguage:json, onLanguage:markdown |
| `contributes.languages` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json` | 1 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` |  |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` | type, title, properties |
| `contributes.views` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` | remote |
| `contributes.debuggers` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` | 1 entries |
| `contributes.notebooks` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-api-tests/package.json` | 3 entries |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/package.json` | onLanguage:json |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-tests/package.json` | onLanguage:json |
| `activationEvents` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json` | onResolveRemoteAuthority:test, onCommand:vscode-testresolver.newWindow, onCommand:vscode-testresolver.currentWindow, onCommand:vscode-testresolver.newWindowWithError, onCommand:vscode-testresolver.showLog, onCommand:vscode-testresolver.openTunnel, onCommand:vscode-testresolver.startRemoteServer, onCommand:vscode-testresolver.toggleConnectionPause |
| `contributes.commands` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json` | 9 entries |
| `contributes.configuration` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json` | properties |
| `contributes.menus` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-test-resolver/package.json` | commandPalette, statusBar/remoteIndicator |

## Runtime Extension Points

- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts`
- `ILogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts`
- `INotificationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts`
- `IWorkspaceTagsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/browser/workspaceTagsService.ts`
- `IFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts`
- `IWorkspaceContextService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts`
- `IWorkbenchEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts`
- `ITextFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts`
- `IWorkspaceTagsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts`
- `IMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IContextMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IKeybindingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `ILabelService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `ILogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `INotificationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IOpenerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IProgressService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IThemeService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IViewDescriptorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IActivityService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IHoverService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `ITreeViewsDnDService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IAccessibleViewInformationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-treeView.ts`
- `IFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTags.ts`

## Command/Menu Extension Points

- No direct entries surfaced from the selected inventory scan.

## Extension Point Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/commands/common/commands.contribution.ts
import { safeStringify } from '../../../../base/common/objects.js';
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

type RunnableCommand = string | { command: string; args: any[] };

type CommandArgs = {
	commands: RunnableCommand[];
};

/** Runs several commands passed to it as an argument */
class RunCommands extends Action2 {

	constructor() {
		super({
			id: 'runCommands',
			title: nls.localize2('runCommands', "Run Commands"),
			f1: false,
			metadata: {
				description: nls.localize('runCommands.description', "Run several commands"),
				args: [
					{
						name: 'args',
						schema: {
							type: 'object',
							required: ['commands'],
							properties: {
								commands: {
									type: 'array',
									description: nls.localize('runCommands.commands', "Commands to run"),
									items: {
										anyOf: [
											{
												$ref: 'vscode://schemas/keybindings#/definitions/commandNames'
											},
											{
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/tags.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/tags.contribution.ts
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { WorkspaceTags } from './workspaceTags.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

// Register Workspace Tags Contribution
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(WorkspaceTags, LifecyclePhase.Eventually);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/extension-editing/package.json
  "license": "MIT",
  "engines": {
    "vscode": "^1.4.0"
  },
  "icon": "images/icon.png",
  "activationEvents": [
    "onLanguage:json",
    "onLanguage:markdown"
  ],
  "main": "./out/extensionEditingMain",
  "browser": "./dist/browser/extensionEditingBrowserMain",
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": {
      "supported": true
    }
  },
  "scripts": {
    "compile": "gulp compile-extension:extension-editing",
    "watch": "gulp watch-extension:extension-editing"
  },
  "dependencies": {
    "jsonc-parser": "^3.2.0",
    "markdown-it": "^14.2.0",
    "parse5": "^3.0.2"
  },
  "contributes": {
    "jsonValidation": [
      {
        "fileMatch": "package.json",
        "url": "vscode://schemas/vscode-extensions"
      },
      {
        "fileMatch": "*language-configuration.json",
        "url": "vscode://schemas/language-configuration"
      },
      {
        "fileMatch": [
          "*icon-theme.json",
          "!*product-icon-theme.json"
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/browser/workspaceTagsService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/browser/workspaceTagsService.ts
import { WorkbenchState, IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceTagsService, Tags } from '../common/workspaceTags.js';

export class NoOpWorkspaceTagsService implements IWorkspaceTagsService {

	declare readonly _serviceBrand: undefined;

	getTags(): Promise<Tags> {
		return Promise.resolve({});
	}

	async getTelemetryWorkspaceId(workspace: IWorkspace, state: WorkbenchState): Promise<string | undefined> {
		return undefined;
	}

	getHashedRemotesFromUri(workspaceUri: URI, stripEndingDotGit?: boolean): Promise<string[]> {
		return Promise.resolve([]);
	}
}

registerSingleton(IWorkspaceTagsService, NoOpWorkspaceTagsService, InstantiationType.Delayed);
```

