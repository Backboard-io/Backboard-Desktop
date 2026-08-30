# Backboard Changes Endpoint Risk Boundaries

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes/endpoints/risk-boundaries.md`

## Boundary Diagram

```text
trusted UI state
    |
    v
command/action/menu endpoint
    |
    v
service/controller/provider boundary
    |
    +--> workspace trust / profile / remote authority / extension host
    +--> filesystem / terminal / process / network / webview / authentication when present
    +--> notification / marker / log / telemetry when present
    |
    v
visible result
```

## Risk Table

| Boundary | Failure mode | Review action | Source anchor |
|---|---|---|---|
| Command visibility | Command appears in the wrong context or remains hidden when valid. | Inspect when clauses, context keys, and menu groups. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts` |
| Service call | Service dependency is unavailable, delayed, or disposed. | Inspect constructor injection, lifecycle, and Disposable handling. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts` |
| Async boundary | Cancellation, error, or concurrent invocation leaves UI in stale state. | Inspect CancellationToken, promises, event listeners, and finally blocks. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts` |
| External boundary | Filesystem, network, extension host, browser view, terminal, or secret store returns failure. | Inspect validation, message routing, and recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts` |

## Boundary Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AgentFeedbackKind, AgentFeedbackState, IAgentFeedback, IAgentFeedbackAddedEvent, IAgentFeedbackChangeEvent, IAgentFeedbackConvertedEvent, IAgentFeedbackNavigationBearing, IAgentFeedbackReplyAddedEvent, IAgentFeedbackService, IAgentFeedbackSubmittedEvent, INavigableSessionComment } from './agentFeedbackService.js';
import { IAgentFeedbackContext } from './agentFeedbackEditorUtils.js';
import { ICodeReviewSuggestion } from '../../codeReview/browser/codeReviewService.js';

/**
 * No-op implementation of {@link IAgentFeedbackService} used on web,
 * where the full agent feedback UI (editor overlay, hover, attachments)
 * is not wired up. The changes view model still depends on the service
 * being registered, so we expose a service that reports no feedback.
 */
class NullAgentFeedbackService extends Disposable implements IAgentFeedbackService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeFeedback = this._register(new Emitter<IAgentFeedbackChangeEvent>()).event;
	readonly onDidChangeNavigation = this._register(new Emitter<URI>()).event;
	readonly onDidAddFeedback = this._register(new Emitter<IAgentFeedbackAddedEvent>()).event;
	readonly onDidConvertFeedback = this._register(new Emitter<IAgentFeedbackConvertedEvent>()).event;
	readonly onDidAddReply = this._register(new Emitter<IAgentFeedbackReplyAddedEvent>()).event;
	readonly onDidSubmitFeedback = this._register(new Emitter<IAgentFeedbackSubmittedEvent>()).event;

	addFeedback(sessionResource: URI, resourceUri: URI, range: IRange, text: string, _suggestion?: ICodeReviewSuggestion, _context?: IAgentFeedbackContext, _sourcePRReviewCommentId?: string, _kind?: AgentFeedbackKind, state: AgentFeedbackState = AgentFeedbackState.Accepted): IAgentFeedback {
		return {
			id: '',
			text,
			resourceUri,
			range,
			sessionResource,
			kind: AgentFeedbackKind.UserReview,
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { registerEditorContribution, EditorContributionInstantiation } from '../../../../../editor/browser/editorExtensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { PROMPT_LANGUAGE_ID } from '../../common/promptSyntax/promptTypes.js';
import { PromptCodingAgentActionOverlayWidget } from './promptCodingAgentActionOverlay.js';

export class PromptCodingAgentActionContribution extends Disposable {
	static readonly ID = 'promptCodingAgentActionContribution';

	private readonly _overlayWidgets = this._register(new DisposableMap<ICodeEditor, PromptCodingAgentActionOverlayWidget>());

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		this._register(this._editor.onDidChangeModel(() => {
			this._updateOverlayWidget();
		}));

		this._updateOverlayWidget();
	}
	private _updateOverlayWidget(): void {
		const model = this._editor.getModel();

		// Remove existing overlay if present
		this._overlayWidgets.deleteAndDispose(this._editor);

		// Add overlay if this is a prompt file
		if (model && model.getLanguageId() === PROMPT_LANGUAGE_ID) {
			const widget = this._instantiationService.createInstance(PromptCodingAgentActionOverlayWidget, this._editor);
			this._overlayWidgets.set(this._editor, widget);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { getComparisonKey } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IPluginGitService } from '../common/plugins/pluginGitService.js';
import {
	GitHubAuthRequiredError,
	GitHubRateLimitError,
	IGitHubRepoRef,
	fetchAndExtractGitHubRepo,
	parseGitHubCloneUrl,
	resolveGitHubRefToSha,
} from './githubRepoFetcher.js';

/** Storage key for the per-target metadata index used by this service. */
const BROWSER_CACHE_STORAGE_KEY = 'chat.plugins.browserCache.v1';

/**
 * Per-target metadata persisted via {@link IStorageService}. Keyed by the
 * `targetDir.toString()` of the cloned repository so we can answer
 * `revParse('HEAD')` and detect "is the cached snapshot still current?" on
 * `pull()` without an extra GitHub round-trip.
 */
interface IBrowserPluginCacheEntry {
	readonly owner: string;
	readonly repo: string;
	readonly ref?: string;
	readonly sha: string;
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

