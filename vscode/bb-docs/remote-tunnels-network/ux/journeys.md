# Remote Tunnels Network UX Journeys

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/remote-tunnels-network/ux/journeys.md`

## Primary Journey

```text
User intent
   |
   v
Find entry point for remote-tunnels-network
   |
   v
Command/menu/view/editor contribution activates
   |
   v
Workbench service or extension code updates state
   |
   v
UI renders state, result, failure, or recovery action
   |
   v
User continues, cancels, retries, or switches context
```

## Journey Table

| Phase | User action | System behavior | Code path to inspect |
|---|---|---|---|
| Discover | User opens command palette, menu, view, editor, or extension surface. | Contribution and context keys decide visibility. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/platform/browserView/common/playwrightService.ts` |
| Invoke | User selects the command or starts the flow. | Command/action delegates to a service, controller, provider, or extension activation. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts` |
| Work | Feature reads state, writes state, starts a task, or renders content. | Events and services keep the UI synchronized. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/browser/browserView.contribution.ts` |
| Recover | User hits an error, cancellation, offline state, unavailable context, or disabled workspace. | Notification, inline message, log, disabled state, or fallback flow communicates recovery. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts` |

## UX Detail Notes

- Keep text action labels tied to the exact command or menu label in source.
- Verify focus order when the feature owns toolbar, tree, editor, webview, terminal, notebook, or quick access UI.
- Verify cancellation and retry affordances where source shows async work, token usage, network calls, process execution, or extension activation.
- Verify reduced-width and high-contrast behavior where CSS or workbench layout files are part of the source inventory.

## Code Anchor For Journey Review

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
```

