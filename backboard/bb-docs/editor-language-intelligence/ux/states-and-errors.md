# Editor Language Intelligence States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/editor-language-intelligence/ux/states-and-errors.md`

## State Machine

```text
[inactive]
    | contribution registered or extension activated
    v
[available]
    | command/menu/view invoked
    v
[working]
    | success        | cancel        | failure
    v              v               v
[ready]       [cancelled]      [error-recovery]
    |              |               |
    +--------------+---------------+--> [available]
```

## State And Failure Matrix

| Condition | User-facing requirement | Source evidence |
|---|---|---|
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/snippets/browser/snippets.service.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActions.contribution.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/services/contribution.ts` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/widget/codeEditor/codeEditorContributions.ts` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/bracketPairColorizer2Telemetry' 'src/vs/workbench/contrib/callHierarchy' 'src/vs/workbench/contrib/codeActions' 'src/vs/workbench/contrib/codeEditor' 'src/vs/workbench/contrib/dropOrPasteInto' 'src/vs/workbench/contrib/emmet' 'src/vs/workbench/contrib/folding' 'src/vs/workbench/contrib/format' 'src/vs/workbench/contrib/inlayHints' 'src/vs/workbench/contrib/languageDetection' 'src/vs/workbench/contrib/languageStatus' 'src/vs/workbench/contrib/limitIndicator'
```

## State Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/snippets/browser/snippets.service.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/snippets/browser/snippets.service.contribution.ts
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISnippetsService } from './snippets.js';
import { SnippetsService } from './snippetsService.js';

registerSingleton(ISnippetsService, SnippetsService, InstantiationType.Delayed);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActions.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActions.contribution.ts
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CodeActionsContribution, editorConfiguration, notebookEditorConfiguration } from './codeActionsContribution.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration)
	.registerConfiguration(editorConfiguration);

Registry.as<IConfigurationRegistry>(Extensions.Configuration)
	.registerConfiguration(notebookEditorConfiguration);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(CodeActionsContribution, LifecyclePhase.Eventually);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts
import { Emitter, Event } from '../../../../base/common/event.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { editorConfigurationBaseNode } from '../../../../editor/common/config/editorConfigurationSchema.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { codeActionCommandId, refactorCommandId, sourceActionCommandId } from '../../../../editor/contrib/codeAction/browser/codeAction.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import * as nls from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

const createCodeActionsAutoSave = (description: string): IJSONSchema => {
	return {
		type: 'string',
		enum: ['always', 'explicit', 'never', true, false],
		enumDescriptions: [
			nls.localize('alwaysSave', 'Triggers Code Actions on explicit saves and auto saves triggered by window or focus changes.'),
			nls.localize('explicitSave', 'Triggers Code Actions only when explicitly saved'),
			nls.localize('neverSave', 'Never triggers Code Actions on save'),
			nls.localize('explicitSaveBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "explicit".'),
			nls.localize('neverSaveBoolean', 'Never triggers Code Actions on save. This value will be deprecated in favor of "never".')
		],
		default: 'explicit',
		description: description
	};
};

const createNotebookCodeActionsAutoSave = (description: string): IJSONSchema => {
	return {
		type: ['string', 'boolean'],
		enum: ['explicit', 'never', true, false],
		enumDescriptions: [
			nls.localize('explicit', 'Triggers Code Actions only when explicitly saved.'),
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/services/contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/services/contribution.ts
import { registerSingleton, InstantiationType } from '../../../platform/instantiation/common/extensions.js';
import { IEditorWorkerService } from '../../common/services/editorWorker.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../editorExtensions.js';
import { EditorWorkerService } from './editorWorkerService.js';
import { MarkerDecorationsContribution } from './markerDecorations.js';

/* registers link detection and word based suggestions for any document */
registerSingleton(IEditorWorkerService, EditorWorkerService, InstantiationType.Eager);

// eager because it instantiates IMarkerDecorationsService which is responsible for rendering squiggles
registerEditorContribution(MarkerDecorationsContribution.ID, MarkerDecorationsContribution, EditorContributionInstantiation.Eager);
```

