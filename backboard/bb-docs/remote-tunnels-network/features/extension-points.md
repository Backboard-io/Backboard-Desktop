# Remote Tunnels Network Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/remote-tunnels-network/features/extension-points.md`

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

- `IPlaywrightService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts`
- `IBrowserZoomService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts`
- `IBrowserViewWorkbenchService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts`
- `IBrowserViewCDPService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts`
- `IEditorResolverService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts`
- `IBrowserViewCDPService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts`
- `IBrowserViewWorkbenchService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnection.contribution.ts`
- `IQuickInputService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnection.contribution.ts`
- `IRemoteAgentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `ILifecycleService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `ILabelService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IExtensionService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `INativeWorkbenchEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IRemoteAuthorityResolverService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IWorkspaceContextService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `INativeHostService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IStorageService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IRemoteExplorerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `IRemoteCodingAgentsService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteCodingAgents/browser/remoteCodingAgents.contribution.ts`
- `IClipboardService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts`
- `IDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts`
- `INativeEnvironmentService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts`

## Command/Menu Extension Points

- `workbench.remote.action.closeUnusedPorts` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts`
- `workbench.action.url.openUrl` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/url/browser/url.contribution.ts`
- `workbench.action.triggerReconnect` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/common/remote.contribution.ts`
- `workbench.action.pauseSocketWriting` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/common/remote.contribution.ts`
- `workbench.action.configureMeteredConnection` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnectionStatus.ts`
- `workbench.banner.remote.unsupportedConnection.dismissed` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/browser/remoteConnectionHealth.ts`
- `workbench.banner.remote.arm32Deprecation.dismissed` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/browser/remoteConnectionHealth.ts`
- `workbench.view.remote` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/browser/remoteExplorer.ts`
- `workbench.action.manageTrustedDomain` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/url/browser/trustedDomains.ts`
- `browser.favorites.delete` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserFavoritesFeature.ts`
- `browser.toggleFavorite` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserFavoritesFeature.ts`
- `browser.history.delete` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserHistoryFeature.ts`
- `browser.configureSearchEngine` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserNavigationFeatures.ts`
- `workbench.browser.linkOpenedHintDismissed` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts`

## Extension Point Code Evidence

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
```

