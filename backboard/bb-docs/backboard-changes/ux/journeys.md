# Backboard Changes UX Journeys

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes/ux/journeys.md`

## Primary Journey

```text
User intent
   |
   v
Find entry point for backboard-changes
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
| Discover | User opens command palette, menu, view, editor, or extension surface. | Contribution and context keys decide visibility. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/agentFeedback/browser/nullAgentFeedbackService.contribution.ts` |
| Invoke | User selects the command or starts the flow. | Command/action delegates to a service, controller, provider, or extension activation. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts` |
| Work | Feature reads state, writes state, starts a task, or renders content. | Events and services keep the UI synchronized. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts` |
| Recover | User hits an error, cancellation, offline state, unavailable context, or disabled workspace. | Notification, inline message, log, disabled state, or fallback flow communicates recovery. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserZoomService.ts` |

## UX Detail Notes

- Keep text action labels tied to the exact command or menu label in source.
- Verify focus order when the feature owns toolbar, tree, editor, webview, terminal, notebook, or quick access UI.
- Verify cancellation and retry affordances where source shows async work, token usage, network calls, process execution, or extension activation.
- Verify reduced-width and high-contrast behavior where CSS or workbench layout files are part of the source inventory.

## Code Anchor For Journey Review

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

