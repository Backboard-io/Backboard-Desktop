# Performance Telemetry Diagnostics Implementation Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/performance-telemetry-diagnostics/features/implementation-map.md`

## Architecture Map

```text
Performance Telemetry Diagnostics
|
|-- Contribution layer
|   |-- package.json, *.contribution.ts, workbench registration
|   L-- command/menu/view/context declarations
|
|-- Runtime layer
|   |-- services, controllers, providers, registries
|   L-- events, state, disposables, async operations
|
|-- Presentation layer
|   |-- browser/view/widget/editor/webview files
|   L-- css, icons, labels, focus, overflow, empty states
|
L-- Validation layer
    |-- tests when present
    L-- manual checks in ux/validation-playbook.md
```

## Source Inventory

| Source path | Kind | Evidence |
|---|---:|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/electron-browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/common`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/test` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser`<br>`[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/electron-browser` |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry` | directory | `[dir]  /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser` |

## Implementation Files

| File | Why it matters |
|---|---|
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/aiContributionFeature.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editTelemetryContribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.web.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/electron-browser/performance.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/policyExport/electron-browser/policyExport.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorer.web.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/electron-browser/processExplorer.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/telemetry/browser/telemetry.contribution.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/test/browser/aiContributionFeature.test.ts` | Workbench contribution entry point: registers actions, views, services, or lifecycle hooks. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/randomService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryServiceImpl.ts` | Service boundary: owns state, dependency injection, events, or cross-feature contracts. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/settingIds.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/settings.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/inputLatencyContrib.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/perfviewEditor.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/startupTimings.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/electron-browser/rendererAutoProfiler.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/electron-browser/startupProfiler.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/electron-browser/startupTimings.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorerControl.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorerEditor.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/browser/processExplorerEditorInput.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/electron-browser/processExplorerControl.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/processExplorer/electron-browser/processExplorerEditor.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editStats/aiStatsChart.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editStats/aiStatsFeature.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/editStats/aiStatsStatusBar.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/helpers/annotatedDocuments.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/helpers/documentWithAnnotatedEdits.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/helpers/observableWorkspace.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/helpers/utils.ts` | Implementation file participating in the feature surface or supporting source area. |
| `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/editTelemetry/browser/helpers/vscodeObservableWorkspace.ts` | Implementation file participating in the feature surface or supporting source area. |

## Implementation Code Anchors

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
				}
			}

			for (const [uri, entry] of this._trackers) {
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
			default: false,
			tags: ['experimental'],
			experiment: {
				mode: 'auto'
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
			if (!enabled || aiDisabled) {
				return;
			}
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


registerAction2(class extends Action2 {
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.web.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/performance/browser/performance.web.contribution.ts
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { BrowserResourcePerformanceMarks, BrowserStartupTimings } from './startupTimings.js';

// -- startup timings

Registry.as<IWorkbenchContributionsRegistry>(Extensions.Workbench).registerWorkbenchContribution(
	BrowserResourcePerformanceMarks,
	LifecyclePhase.Eventually
);

Registry.as<IWorkbenchContributionsRegistry>(Extensions.Workbench).registerWorkbenchContribution(
	BrowserStartupTimings,
	LifecyclePhase.Eventually
);
```

