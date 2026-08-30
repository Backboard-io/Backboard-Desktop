# Extension Authoring Api UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/extension-authoring-api/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

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
												type: 'string',
											},
											{
												type: 'object',
												required: ['command'],
												properties: {
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
        ],
        "url": "vscode://schemas/icon-theme"
      },
      {
        "fileMatch": "*product-icon-theme.json",
        "url": "vscode://schemas/product-icon-theme"
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

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/tags/electron-browser/workspaceTagsService.ts
import { IFileService, IFileStatResult, IFileStat } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState, IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ITextFileService, ITextFileContent } from '../../../services/textfile/common/textfiles.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceTagsService, Tags } from '../common/workspaceTags.js';
import { getHashedRemotesFromConfig } from './workspaceTags.js';
import { splitLines } from '../../../../base/common/strings.js';
import { MavenArtifactIdRegex, MavenDependenciesRegex, MavenDependencyRegex, GradleDependencyCompactRegex, GradleDependencyLooseRegex, MavenGroupIdRegex, JavaLibrariesToLookFor } from '../common/javaWorkspaceTags.js';
import { hashAsync } from '../../../../base/common/hash.js';

const MetaModulesToLookFor = [
	// Azure packages
	'@azure',
	'@azure/ai',
	'@azure/core',
	'@azure/cosmos',
	'@azure/event',
	'@azure/identity',
	'@azure/keyvault',
	'@azure/search',
	'@azure/storage'
];

const ModulesToLookFor = [
	// Platform-related type definition packages
	'@types/vscode',
	'@vscode/dts',
	'@types/node',
	'@types/bun',
	'bun-types',
	'@types/web',
	// Packages that suggest a JS-based backend server
	'express',
	'sails',
	'koa',
	'hapi',
	'socket.io',
	'restify',
	'next',
	'nuxt',
	'@nestjs/core',
	'strapi',
	'gatsby',
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'src/vs/workbench/contrib/commands' 'src/vs/workbench/contrib/tags' 'extensions/extension-editing' 'extensions/vscode-api-tests' 'extensions/vscode-test-resolver' 'extensions/vscode-colorize-tests' 'extensions/vscode-colorize-perf-tests'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'src/vs/workbench/contrib/commands' 'src/vs/workbench/contrib/tags' 'extensions/extension-editing' 'extensions/vscode-api-tests' 'extensions/vscode-test-resolver' 'extensions/vscode-colorize-tests' 'extensions/vscode-colorize-perf-tests'
```

