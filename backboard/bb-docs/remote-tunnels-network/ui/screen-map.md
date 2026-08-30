# Remote Tunnels Network Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/remote-tunnels-network/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Remote Tunnels Network        | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `remote-tunnels-network`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/meteredConnection/browser/meteredConnection.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/browser/remote.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/browser/remoteStartEntry.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remote/electron-browser/remote.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteCodingAgents/browser/remoteCodingAgents.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/share/browser/share.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/url/browser/url.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/electron-main/browserViewGroupMainService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/electron-main/browserViewMainService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/node/browserViewGroupRemoteService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/node/playwrightService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/remote/browser/remoteAuthorityResolverService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts` |

## UI Code Anchors

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
```

