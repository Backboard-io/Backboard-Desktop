# Performance Telemetry Diagnostics Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/performance-telemetry-diagnostics/features/extension-points.md`

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

- `IAiEditTelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts`
- `IRandomService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts`
- `IChatEntitlementService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts`
- `IEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts`
- `IWorkbenchConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `INativeEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `ILogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `INativeHostService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `IProgressService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `IFileService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `IEditorResolverService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `IAuxiliaryWindowService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `IEditorGroupsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts`
- `ILifecycleService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `ITelemetryService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IWorkspaceContextService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IEditorService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IKeybindingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IWorkbenchThemeService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IWorkbenchEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`

## Command/Menu Extension Points

- `workbench.action.showTelemetry` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts`
- `editor.aiStats.enabled` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/settingIds.ts`

## Extension Point Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/aiContributionFeature.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/aiContributionFeature.ts
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { AnnotatedDocument, IAnnotatedDocuments } from './helpers/annotatedDocuments.js';
import { createDocWithJustReason } from './helpers/documentWithAnnotatedEdits.js';
import { DocumentEditSourceTracker } from './telemetry/editTracker.js';

export type AiContributionLevel = 'chatAndAgent' | 'all';

interface TrackerEntry {
	readonly trackerStore: DisposableStore;
	readonly tracker: DocumentEditSourceTracker;
}

/**
 * Tracks AI-generated edits across open documents using the edit telemetry pipeline.
 */
export class AiContributionFeature extends Disposable {

	private readonly _trackers = new ResourceMap<TrackerEntry>();
	private readonly _documentsByUri = new ResourceMap<AnnotatedDocument>();

	constructor(
		annotatedDocuments: IAnnotatedDocuments,
	) {
		super();

		this._register(autorun(reader => {
			const docs = annotatedDocuments.documents.read(reader);
			const activeUris = new ResourceMap<boolean>();

			for (const doc of docs) {
				const uri = doc.document.uri;
				activeUris.set(uri, true);
				this._documentsByUri.set(uri, doc);

				if (!this._trackers.has(uri)) {
					this._trackers.set(uri, this._createTrackerEntry(doc));
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts
import { EDIT_TELEMETRY_SETTING_ID, AI_STATS_SETTING_ID } from './settingIds.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { EDIT_TELEMETRY_DETAILS_SETTING_ID, EDIT_TELEMETRY_SHOW_DECORATIONS, EDIT_TELEMETRY_SHOW_STATUS_BAR } from './settings.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAiEditTelemetryService } from './telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { AiEditTelemetryServiceImpl } from './telemetry/aiEditTelemetry/aiEditTelemetryServiceImpl.js';
import { IRandomService, RandomService } from './randomService.js';

registerWorkbenchContribution2('EditTelemetryContribution', EditTelemetryContribution, WorkbenchPhase.AfterRestored);

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'task',
	order: 100,
	title: localize('editTelemetry', "Edit Telemetry"),
	type: 'object',
	properties: {
		[EDIT_TELEMETRY_SETTING_ID]: {
			markdownDescription: localize('telemetry.editStats.enabled', "Controls whether to enable telemetry for edit statistics (only sends statistics if general telemetry is enabled)."),
			type: 'boolean',
			default: true,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[AI_STATS_SETTING_ID]: {
			markdownDescription: localize('editor.aiStats.enabled', "Controls whether to enable AI statistics in the editor. The gauge shows the average AI rate across 5-minute sessions, where each session's rate is calculated as AI-inserted characters divided by total inserted characters."),
			type: 'boolean',
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
			}
		},
		[EDIT_TELEMETRY_DETAILS_SETTING_ID]: {
			markdownDescription: localize('telemetry.editStats.detailed.enabled', "Controls whether to enable telemetry for detailed edit statistics (only sends statistics if general telemetry is enabled)."),
			type: 'boolean',
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { ITelemetryService, TelemetryLevel, telemetryLevelEnabled } from '../../../../platform/telemetry/common/telemetry.js';
import { AnnotatedDocuments } from './helpers/annotatedDocuments.js';
import { EditTrackingFeature } from './telemetry/editSourceTrackingFeature.js';
import { VSCodeWorkspace } from './helpers/vscodeObservableWorkspace.js';
import { AiStatsFeature } from './editStats/aiStatsFeature.js';
import { AI_STATS_SETTING_ID, EDIT_TELEMETRY_SETTING_ID } from './settingIds.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { AiContributionFeature } from './aiContributionFeature.js';

export class EditTelemetryContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService
	) {
		super();

		const workspace = derived(reader => reader.store.add(instantiationService.createInstance(VSCodeWorkspace)));
		const annotatedDocuments = derived(reader => reader.store.add(instantiationService.createInstance(AnnotatedDocuments, workspace.read(reader))));

		const editSourceTrackingEnabled = observableConfigValue(EDIT_TELEMETRY_SETTING_ID, true, configurationService);
		this._register(autorun(r => {
			const enabled = editSourceTrackingEnabled.read(r);
			if (!enabled || !telemetryLevelEnabled(telemetryService, TelemetryLevel.USAGE)) {
				return;
			}
			r.store.add(instantiationService.createInstance(EditTrackingFeature, workspace.read(r), annotatedDocuments.read(r)));
		}));

		const aiStatsEnabled = observableConfigValue(AI_STATS_SETTING_ID, true, configurationService);
		this._register(autorun(r => {
			const enabled = aiStatsEnabled.read(r);
			const aiDisabled = chatEntitlementService.sentimentObs.read(r).hidden;
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts
import { EventProfiling } from '../../../../base/common/event.js';
import { GCBasedDisposableTracker, setDisposableTracker } from '../../../../base/common/lifecycle.js';
import { env } from '../../../../base/common/process.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigExt, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService, Trace } from '../../../../platform/instantiation/common/instantiationService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IWorkbenchContributionsRegistry, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { InputLatencyContrib } from './inputLatencyContrib.js';
import { PerfviewContrib, PerfviewInput } from './perfviewEditor.js';

// -- startup performance view

registerWorkbenchContribution2(
	PerfviewContrib.ID,
	PerfviewContrib,
	{ lazy: true }
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PerfviewInput.Id,
	class implements IEditorSerializer {
		canSerialize(): boolean {
			return true;
		}
		serialize(): string {
			return '';
		}
		deserialize(instantiationService: IInstantiationService): PerfviewInput {
			return instantiationService.createInstance(PerfviewInput);
		}
	}
);
```

