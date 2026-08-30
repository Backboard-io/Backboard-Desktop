# Editor Language Intelligence Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/editor-language-intelligence/features/extension-points.md`

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
| Declarative contributions | Source scan | No package-level contribution block surfaced from the selected inventory scan. |

## Runtime Extension Points

- `ISnippetsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/snippets/browser/snippets.service.contribution.ts`
- `ILanguageFeaturesService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts`
- `IKeybindingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts`
- `IEditorWorkerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/services/contribution.ts`
- `IMarkerDecorationsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/services/contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/widget/codeEditor/codeEditorContributions.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bracketPairColorizer2Telemetry/browser/bracketPairColorizer2Telemetry.contribution.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bracketPairColorizer2Telemetry/browser/bracketPairColorizer2Telemetry.contribution.ts`
- `IExtensionsWorkbenchService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/bracketPairColorizer2Telemetry/browser/bracketPairColorizer2Telemetry.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `ICodeEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/folding/browser/folding.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/folding/browser/folding.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `IStatusbarService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `ILanguageDetectionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `ILanguageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `IKeybindingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `INotificationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/languageDetection/browser/languageDetection.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/limitIndicator/browser/limitIndicator.contribution.ts`
- `ILanguageStatusService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/limitIndicator/browser/limitIndicator.contribution.ts`
- `ICodeEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `ITextMateTokenizationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/textMate/browser/textMateTokenizationFeature.contribution.ts`
- `ITextFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/textMate/browser/textMateTokenizationFeature.contribution.ts`

## Command/Menu Extension Points

- `editor.showCallHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `editor.showIncomingCalls` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `editor.showOutgoingCalls` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `editor.refocusCallHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `editor.closeCallHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.ts`
- `editor.showTypeHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `editor.showSupertypes` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `editor.showSubtypes` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `editor.refocusTypeHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `editor.closeTypeHierarchy` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.ts`
- `editor.experimental.preferTreeSitter` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/treeSitter/browser/treeSitterLibraryService.ts`
- `workbench.action.configurePreferredPasteAction` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/dropOrPasteInto/browser/commands.ts`
- `workbench.action.configurePreferredDropAction` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/dropOrPasteInto/browser/commands.ts`
- `editor.action.formatDocument.multiple` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/format/browser/formatActionsMultiple.ts`
- `editor.action.formatSelection.multiple` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/format/browser/formatActionsMultiple.ts`
- `editor.action.formatDocument.none` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/format/browser/formatActionsNone.ts`
- `editor.action.selectAll` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/editor/browser/editorExtensions.ts`

## Extension Point Code Evidence

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
			nls.localize('never', 'Never triggers Code Actions on save.'),
			nls.localize('explicitBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "explicit".'),
			nls.localize('neverBoolean', 'Triggers Code Actions only when explicitly saved. This value will be deprecated in favor of "never".')
		],
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

