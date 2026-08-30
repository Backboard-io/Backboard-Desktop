# Remote Tunnels Network UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/remote-tunnels-network/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPlaywrightService = createDecorator<IPlaywrightService>('playwrightService');

export interface IInvokeFunctionResult {
	result?: unknown;
	error?: string;
	summary: string;
	/** When present the function did not complete within the timeout. Pass this ID to {@link IPlaywrightService.waitForDeferredResult} to keep waiting. */
	deferredResultId?: string;
}

/**
 * A service for using Playwright to connect to and automate the integrated browser.
 *
 * The service maintains a separate Playwright browser instance per session. Callers
 * must pass a {@link sessionId} to every method so operations are routed to the
 * correct instance. Page tracking is shared globally across all sessions.
 *
 * Pages must be explicitly tracked via {@link startTrackingPage} (or implicitly via
 * {@link openPage}) before they can be interacted with.
 */
export interface IPlaywrightService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the set of tracked pages changes.
	 * The event value is the full list of currently tracked view IDs.
	 */
	readonly onDidChangeTrackedPages: Event<readonly string[]>;

	/**
	 * Start tracking an existing browser view so that agent
	 * tools can interact with it.
	 * @param viewId The browser view identifier.
	 */
	startTrackingPage(viewId: string): Promise<void>;

	/**
	 * Stop tracking a browser view.
	 * @param viewId The browser view identifier.
	 */
	stopTrackingPage(viewId: string): Promise<void>;

	/**
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { browserZoomDefaultIndex, browserZoomFactors } from '../../../../platform/browserView/common/browserView.js';
import { zoomLevelToZoomFactor } from '../../../../platform/window/common/window.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const IBrowserZoomService = createDecorator<IBrowserZoomService>('browserZoomService');

/** Storage key for the per-host persistent zoom map. */
const BROWSER_ZOOM_PER_HOST_STORAGE_KEY = 'browserView.zoomPerHost';

/**
 * Special value for the default zoom level setting that instructs the browser view
 * to dynamically match the closest zoom level to the application's current UI zoom.
 */
export const MATCH_WINDOW_ZOOM_LABEL = 'Match Window';

export interface IBrowserZoomChangeEvent {
	/**
	 * The host (e.g. `"example.com"`) whose zoom changed, or `undefined`
	 * when the global default zoom level changed.
	 */
	readonly host: string | undefined;

	/**
	 * Whether the change came from an ephemeral session.
	 * - `true`  ? only ephemeral views need to react.
	 * - `false` ? all views (ephemeral and non-ephemeral) for the host may be affected.
	 */
	readonly isEphemeralChange: boolean;
}

/**
 * Manages two independent cascading zoom hierarchies for integrated browser views:
 *
 *  Normal views:    `persistent per-host override` ?? `configured default`
 *  Ephemeral views: `ephemeral per-host override`  ?? `configured default`
 *
 * Ephemeral views never see persistent overrides directly. Instead, when a persistent
 * value changes, it is copied into the ephemeral map so that ephemeral views
 * immediately reflect the new level. Conversely, ephemeral changes never affect
 * normal views.
 *
 * Per-host values that equal the current default are always removed (both persistent
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IBrowserViewWorkbenchService, IBrowserViewCDPService, IBrowserViewModel, IBrowserEditorViewState, IBrowserViewContextualFilter, IBrowserViewOpenHandler } from '../common/browserView.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { CDPEvent, CDPRequest, CDPResponse } from '../../../../platform/browserView/common/cdp/types.js';
import { ITunnelProxyInfo } from '../../../../platform/tunnel/common/tunnelProxy.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';

class WebBrowserViewWorkbenchService implements IBrowserViewWorkbenchService {
	declare readonly _serviceBrand: undefined;

	willUseRemoteProxy(): boolean {
		return false;
	}

	setRemoteProxyInfo(_info: ITunnelProxyInfo | undefined): void { }

	readonly onDidChangeBrowserViews = Event.None;
	readonly onDidChangeSharingAvailable = Event.None;
	readonly isSharingAvailable = false;

	private readonly _known = new Map<string, BrowserEditorInput>();

	getKnownBrowserViews(): Map<string, BrowserEditorInput> {
		return this._known;
	}

	registerContextualFilter(_filter: IBrowserViewContextualFilter): IDisposable {
		return Disposable.None;
	}

	getContextualBrowserViews(): Map<string, BrowserEditorInput> {
		return this._known;
	}

	registerOpenHandler(_handler: IBrowserViewOpenHandler): IDisposable {
		return Disposable.None;
	}

	getOrCreateLazy(_id: string, _state: IBrowserEditorViewState): BrowserEditorInput {
		throw new Error('Integrated Browser is not available in web.');
	}

	getBrowserViewModel(_id: string): IBrowserViewModel | undefined {
		return undefined;
	}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { BrowserEditor } from './browserEditor.js';
import { BrowserEditorInput, BrowserEditorSerializer } from '../common/browserEditorInput.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Schemas } from '../../../../base/common/network.js';
import { IBrowserViewCDPService, IBrowserViewWorkbenchService } from '../common/browserView.js';
import { BrowserViewWorkbenchService } from './browserViewWorkbenchService.js';
import { BrowserViewCDPService } from './browserViewCDPService.js';

// Register actions and browser features
import './features/webContentsViewRendererFeature.js';
import './features/browserNavigationFeatures.js';
import './features/browserWelcomeFeature.js';
import './features/browserFavoritesFeature.js';
import './features/browserHistoryFeature.js';
import './features/browserDataStorageFeatures.js';
import './features/browserDevToolsFeature.js';
import './features/browserEditorChatFeatures.js';
import './features/browserEditorErrorFeatures.js';
import './features/browserEditorZoomFeature.js';
import './features/browserEditorEmulationFeatures.js';
import './features/browserEditorFindFeature.js';
import './features/browserSearchFeatures.js';
import './features/browserTabManagementFeatures.js';
import './features/browserRemoteFeatures.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		BrowserEditor,
		BrowserEditorInput.EDITOR_ID,
		localize('browser.editorLabel', "Browser")
	),
	[
		new SyncDescriptor(BrowserEditorInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	BrowserEditorInput.ID,
	BrowserEditorSerializer
);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnection.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnection.contribution.ts
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { METERED_CONNECTION_SETTING_KEY, MeteredConnectionSettingValue } from '../../../../platform/meteredConnection/common/meteredConnection.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { MeteredConnectionStatusContribution } from './meteredConnectionStatus.js';

import '../../../../platform/meteredConnection/common/meteredConnection.config.contribution.js';

registerWorkbenchContribution2(MeteredConnectionStatusContribution.ID, MeteredConnectionStatusContribution, WorkbenchPhase.AfterRestored);

registerAction2(class ConfigureMeteredConnectionAction extends Action2 {

	static readonly ID = 'workbench.action.configureMeteredConnection';

	constructor() {
		super({
			id: ConfigureMeteredConnectionAction.ID,
			title: localize2('configureMeteredConnection', 'Configure Metered Connection'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);

		const currentValue = configurationService.getValue<MeteredConnectionSettingValue>(METERED_CONNECTION_SETTING_KEY);

		const picks: (IQuickPickItem & { value: MeteredConnectionSettingValue })[] = [
			{
				value: 'auto',
				label: localize('meteredConnection.auto', "Auto"),
				description: localize('meteredConnection.auto.description', "Detect metered connections automatically"),
				picked: currentValue === 'auto'
			},
			{
				value: 'on',
				label: localize('meteredConnection.on', "On"),
				description: localize('meteredConnection.on.description', "Always treat the connection as metered"),
				picked: currentValue === 'on'
			},
			{
				value: 'off',
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'src/vs/workbench/contrib/browserView' 'src/vs/workbench/contrib/externalUriOpener' 'src/vs/workbench/contrib/meteredConnection' 'src/vs/workbench/contrib/remote' 'src/vs/workbench/contrib/remoteCodingAgents' 'src/vs/workbench/contrib/remoteTunnel' 'src/vs/workbench/contrib/share' 'src/vs/workbench/contrib/url' 'src/vs/workbench/services/remote' 'src/vs/workbench/services/tunnel' 'src/vs/workbench/services/request' 'src/vs/workbench/services/browserView'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'src/vs/workbench/contrib/browserView' 'src/vs/workbench/contrib/externalUriOpener' 'src/vs/workbench/contrib/meteredConnection' 'src/vs/workbench/contrib/remote' 'src/vs/workbench/contrib/remoteCodingAgents' 'src/vs/workbench/contrib/remoteTunnel' 'src/vs/workbench/contrib/share' 'src/vs/workbench/contrib/url' 'src/vs/workbench/services/remote' 'src/vs/workbench/services/tunnel' 'src/vs/workbench/services/request' 'src/vs/workbench/services/browserView'
```

