# Backboard Changes Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `chat.plugins.browserCache.v1` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts` |
| `workbench.action.agenticSignOut` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.action.agenticSignIn` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.action.openSettings` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts` |
| `workbench.view.extension.copilot-chat` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chatDebug/browser/chatDebug.contribution.ts` |
| `workbench.sessions.panel.chatDebugContainer` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chatDebug/browser/chatDebug.contribution.ts` |
| `workbench.sessions.auxiliaryBar.filesContainer` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `sessions.files.action.syncChanges` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `sessions.files.action.collapseExplorerFolders` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts` |
| `chat.models.action.clearSearchResults` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatManagement.contribution.ts` |
| `workbench.action.openLanguageModelsJson` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatManagement.contribution.ts` |
| `workbench.action.chat.signInIndicator` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.triggerSetupForceSignIn` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.triggerSetupAnonymousWithoutDialog` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.triggerSetupFromAccounts` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.upgradePlan` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.manageAdditionalSpend` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `chat.internal.explain` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `chat.internal.fix` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `chat.internal.review` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` |
| `workbench.action.chat.toggle` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `chat.plugins.marketplaces.index.v1` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/agentPluginRepositoryService.ts` |
| `workbench.action.chat.openImageInCarousel` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/chatImageCarouselService.ts` |
| `workbench.action.toggleWindowAlwaysOnTop` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutActions.ts` |
| `backboard.installAvailableUpdate` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutActions.ts` |
| `workbench.action.agentSessions.openChangesView` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/changes/browser/changesViewActions.ts` |
| `workbench.action.chat.branchChatSession` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/branchChatSessionAction.ts` |
| `workbench.action.agentSessions.runScriptPrimary` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `workbench.action.agentSessions.configureDefaultRunAction` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `workbench.action.agentSessions.generateRunAction` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/chat/browser/runScriptAction.ts` |
| `workbench.action.closeSidebar` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarActions.ts` |
| `workbench.action.focusSideBar` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarActions.ts` |
| `workbench.action.chat.focusConfirmation` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatAccessibilityActions.ts` |
| `workbench.action.chat.toggleThinkingContentAccessibleView` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatAccessibilityActions.ts` |
| `workbench.action.openChat` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `workbench.action.chat.open` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `workbench.action.chat.triggerSetup` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `workbench.action.chat.triggerSetupSupportAnonymousAction` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `workbench.action.chat.generateAgentInstructions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| `workbench.action.chat.generateOnDemandInstructions` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| Declarative contributions | Source scan | No package-level contribution block surfaced from the selected inventory scan. |

## Endpoint Flow

```text
UI gesture or extension activation
    |
    v
Command/action/menu/view contribution
    |
    v
Service, controller, provider, or extension host boundary
    |
    v
State update, editor update, terminal/process work, webview message, or filesystem/network operation
    |
    v
User-visible result, cancellation, notification, marker, log, or disabled affordance
```

## Endpoint Code Evidence

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
			state,
		};
	}
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
		}
	}
}
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
	readonly fetchedAt: number;
}

type IStoredBrowserPluginCache = Record<string, IBrowserPluginCacheEntry>;
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
```

