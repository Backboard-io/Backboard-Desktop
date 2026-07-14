/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { IChatService, IChatToolInvocation } from '../common/chatService/chatService.js';
import { extractLocalhostUrl, extractLocalhostUrls, getWebPreviewOriginKey, isLocalWebPreviewUrl, OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID } from '../common/chatWebPreview.js';
import { IChatModel, IChatRequestModel } from '../common/model/chatModel.js';
import { IArtifactSourceGroup, IChatArtifactsService } from '../common/tools/chatArtifactsService.js';
import { isToolResultInputOutputDetails } from '../common/tools/languageModelToolsService.js';
import { IChatWidgetService } from './chat.js';

/**
 * Tool names that plausibly opened or previewed a web page. URLs found in
 * these tools' inputs are navigation targets and can be carded without a
 * liveness probe. URLs in any other tool (shell commands, generic MCP tools —
 * the only path available to providers without client tools, e.g. Backboard)
 * must pass a probe first so incidental mentions (`grep localhost`, config
 * dumps) never produce a card.
 */
const BROWSER_TOOL_NAME_RE = /browser|preview|navigate|playwright/i;

/** Per chat session bookkeeping for preview detection. */
class SessionPreviewState implements IDisposable {
	/** Origin keys that already have a preview card in this session. */
	readonly seenOrigins = new Set<string>();
	/** Origin keys with a liveness probe currently in flight. */
	readonly probingOrigins = new Set<string>();
	/** Tool call ids whose completed input has already been scanned. */
	readonly processedToolCallIds = new Set<string>();
	/** Request ids that already auto-opened the browser panel once. */
	readonly autoOpenedRequestIds = new Set<string>();
	readonly store = new DisposableStore();

	dispose(): void {
		this.store.dispose();
	}
}

/**
 * Watches live chat sessions for local web apps the agent started or opened —
 * session-owned browser views, `devServer` artifacts, and localhost URLs in
 * browser-ish tool invocations — and appends a `webPreview` card to the
 * transcript (once per URL origin per session). In the sessions window, the
 * first preview of a turn also reveals the app in the right-panel Browser tab.
 */
export class ChatWebPreviewTracker extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatWebPreviewTracker';

	/** Browser view ids that already produced (or were rejected for) a card. */
	private readonly _processedViewIds = new Set<string>();

	private readonly _sessions = this._register(new DisposableMap<string, SessionPreviewState>());

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatArtifactsService private readonly chatArtifactsService: IChatArtifactsService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatService.onDidCreateModel(model => this._attachToModel(model)));
		for (const model of this.chatService.chatModels.get()) {
			this._attachToModel(model);
		}

		this._register(this.browserViewService.onDidChangeBrowserViews(() => this._checkBrowserViews()));
	}

	private _attachToModel(model: IChatModel): void {
		const key = model.sessionResource.toString();
		if (this._sessions.has(key)) {
			return;
		}

		const state = new SessionPreviewState();
		this._sessions.set(key, state);

		// Restored sessions: origins that already have a card in the
		// transcript must not produce a second one.
		for (const request of model.getRequests()) {
			for (const part of request.response?.response.value ?? []) {
				if (part.kind === 'webPreview') {
					const origin = getWebPreviewOriginKey(part.url);
					if (origin) {
						state.seenOrigins.add(origin);
					}
				}
			}
		}

		// Pre-existing devServer artifacts (persisted across reloads) are
		// stale by definition — treat them as seen so only artifacts declared
		// from now on produce cards.
		const artifacts = this.chatArtifactsService.getArtifacts(model.sessionResource);
		for (const url of this._devServerUrls(artifacts.artifactGroups.get())) {
			const origin = getWebPreviewOriginKey(url);
			if (origin) {
				state.seenOrigins.add(origin);
			}
		}

		state.store.add(autorun(reader => {
			const groups = artifacts.artifactGroups.read(reader);
			// Not read through the reader on purpose: a turn starting must not
			// re-evaluate (and card) artifacts left over from earlier turns.
			if (!model.requestInProgress.get()) {
				return;
			}
			const request = model.getRequests().at(-1);
			if (!request) {
				return;
			}
			for (const url of this._devServerUrls(groups)) {
				// Agent-declared dev servers are trusted — no probe needed (and
				// the server may still be binding when the artifact lands).
				void this._handleCandidate(model, state, request, url, { trusted: true, autoOpen: true });
			}
		}));

		// Follow the streaming response to scan completed browser-ish tool
		// invocations for localhost URLs. `liveRequestId` marks the request as
		// having streamed live in this window — replayed provider history also
		// fires addRequest/completedRequest, but its responses arrive already
		// complete and must not be swept (stale content, unwanted auto-open).
		const responseSubscription = state.store.add(new MutableDisposable());
		let liveRequestId: string | undefined;
		const attachToLastRequest = () => {
			const request = model.getRequests().at(-1);
			if (!request?.response || request.response.isComplete) {
				return;
			}
			liveRequestId = request.id;
			responseSubscription.value = request.response.onDidChange(() => this._scanToolInvocations(model, state, request));
			this._scanToolInvocations(model, state, request);
		};
		state.store.add(model.onDidChange(e => {
			if (e.kind === 'addRequest' || e.kind === 'addResponse') {
				attachToLastRequest();
			} else if (e.kind === 'completedRequest') {
				responseSubscription.clear();
				if (e.request.id !== liveRequestId) {
					return; // replayed history — never live in this window
				}
				liveRequestId = undefined;
				// Last-resort sweep: the agent may only have mentioned the URL
				// in its reply text (no preview tool, no artifact). Probe-gated,
				// so prose mentions of dead servers never card.
				this._scanToolInvocations(model, state, e.request);
				this._scanCompletedResponseText(model, state, e.request);
			}
		}));
		attachToLastRequest();

		state.store.add(model.onDidDispose(() => this._sessions.deleteAndDispose(key)));
	}

	private _devServerUrls(groups: readonly IArtifactSourceGroup[]): string[] {
		const urls: string[] = [];
		for (const group of groups) {
			for (const artifact of group.artifacts) {
				if (artifact.type === 'devServer' && artifact.uri) {
					const url = extractLocalhostUrl(artifact.uri);
					if (url) {
						urls.push(url);
					}
				}
			}
		}
		return urls;
	}

	/**
	 * Cards browser views the agent opened for a session (e.g. via the
	 * `open_browser_page` tool). These views are already routed into the
	 * Browser panel by the sessions layer, so they never auto-open here.
	 */
	private _checkBrowserViews(): void {
		for (const [id, input] of this.browserViewService.getKnownBrowserViews()) {
			if (this._processedViewIds.has(id)) {
				continue;
			}
			// `owner.sessionId` is the chat session resource URI string.
			const sessionId = input.model?.owner.sessionId;
			if (!sessionId || !input.url || !isLocalWebPreviewUrl(input.url)) {
				continue; // may become eligible later (model resolve, navigation)
			}
			const state = this._sessions.get(sessionId);
			const model = this.chatService.getSession(URI.parse(sessionId));
			const request = model?.getRequests().at(-1);
			if (!state || !model || !request) {
				continue; // the chat model may attach later — retry then
			}
			// Latch only once a definitive decision is possible. Views surface
			// during agent turns; one first becoming eligible between turns is
			// user navigation and is not carded.
			this._processedViewIds.add(id);
			if (model.requestInProgress.get()) {
				void this._handleCandidate(model, state, request, input.url, { browserViewId: id, trusted: true, autoOpen: false });
			}
		}
	}

	private async _handleCandidate(model: IChatModel, state: SessionPreviewState, request: IChatRequestModel, url: string, opts: { browserViewId?: string; trusted: boolean; autoOpen: boolean }): Promise<void> {
		const origin = getWebPreviewOriginKey(url);
		if (!origin) {
			return;
		}

		if (state.seenOrigins.has(origin)) {
			// The card already exists and mirrors the live app. A trusted
			// re-trigger (server restart, repeat run, restored session) must
			// still reveal the panel or the feature feels broken.
			if (opts.trusted && opts.autoOpen) {
				await this._maybeAutoOpen(model, state, request, url, origin);
			}
			return;
		}
		// Untrusted mentions (shell output, generic tool results) must resolve
		// to a live server before they produce a card. A failed probe is not
		// remembered — the server may come up later in the turn and re-trigger.
		// The in-flight-probe gate applies to untrusted candidates only: a
		// trusted trigger arriving mid-probe must card immediately (the probe's
		// post-await seenOrigins re-check prevents the duplicate).
		if (!opts.trusted) {
			if (state.probingOrigins.has(origin)) {
				return;
			}
			state.probingOrigins.add(origin);
			try {
				if (!(await this._probeAlive(url, 2))) {
					return;
				}
			} finally {
				state.probingOrigins.delete(origin);
			}
			if (state.seenOrigins.has(origin)) {
				return; // carded by a trusted trigger while probing
			}
		}

		if (request.response && !request.response.isComplete) {
			state.seenOrigins.add(origin);
			this.chatService.appendProgress(request, { kind: 'webPreview', url, browserViewId: opts.browserViewId });
		} else if (request.response && request === model.getRequests().at(-1)) {
			// The turn completed while the candidate was being detected (e.g.
			// the preview tool was the turn's last action, or the probe
			// out-lived the stream). Still append to that response — dropping
			// the card here is what makes the feature feel flaky.
			state.seenOrigins.add(origin);
			request.response.updateContent({ kind: 'webPreview', url, browserViewId: opts.browserViewId });
		} else {
			return;
		}

		if (opts.autoOpen) {
			await this._maybeAutoOpen(model, state, request, url, origin);
		}
	}

	/**
	 * A URL is alive when anything answers on it. `no-cors` keeps dev servers
	 * without CORS headers probeable; connection-refused rejects. Retries are
	 * spaced out to cover a server that is still binding its port.
	 */
	private async _probeAlive(url: string, attempts = 1): Promise<boolean> {
		for (let i = 0; i < attempts; i++) {
			if (i > 0) {
				await timeout(2000);
			}
			try {
				await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) });
				return true;
			} catch {
				// not listening (yet)
			}
		}
		return false;
	}

	/**
	 * Scans every completed tool invocation for localhost URLs — the only
	 * signal available for providers without client tools (e.g. the Backboard
	 * agent, whose dev servers start via plain shell tools). Browser-ish tools
	 * are trusted; everything else is probe-gated.
	 */
	private _scanToolInvocations(model: IChatModel, state: SessionPreviewState, request: IChatRequestModel): void {
		for (const part of request.response?.response.value ?? []) {
			if (part.kind !== 'toolInvocation' || state.processedToolCallIds.has(part.toolCallId)) {
				continue;
			}
			const invocationState = part.state.get();
			if (invocationState.type !== IChatToolInvocation.StateKind.Completed && invocationState.type !== IChatToolInvocation.StateKind.Cancelled) {
				continue; // still running — revisit on the next change
			}
			state.processedToolCallIds.add(part.toolCallId);
			if (invocationState.type === IChatToolInvocation.StateKind.Cancelled) {
				continue;
			}

			const inputTexts: string[] = [];
			const outputTexts: string[] = [];
			const details = IChatToolInvocation.resultDetails(part);
			if (isToolResultInputOutputDetails(details)) {
				inputTexts.push(details.input);
				for (const output of details.output) {
					if (output.type === 'embed' && output.isText !== false) {
						outputTexts.push(output.value);
					}
				}
			}
			const toolSpecificData = part.toolSpecificData;
			if (toolSpecificData?.kind === 'terminal') {
				if ('commandLine' in toolSpecificData) {
					inputTexts.push(toolSpecificData.commandLine.original);
					if (toolSpecificData.terminalCommandOutput?.text) {
						outputTexts.push(toolSpecificData.terminalCommandOutput.text);
					}
				} else {
					inputTexts.push(toolSpecificData.command);
				}
			}

			// Trust applies to what the tool was ASKED to open (its input) —
			// URLs merely appearing in outputs (page content, logs) are always
			// probe-gated, even for browser tools.
			const trustedTool = BROWSER_TOOL_NAME_RE.test(part.toolId);
			const inputUrls = extractLocalhostUrls(inputTexts.join('\n'));
			const inputOrigins = new Set(inputUrls.map(url => getWebPreviewOriginKey(url)));
			for (const url of inputUrls) {
				void this._handleCandidate(model, state, request, url, { trusted: trustedTool, autoOpen: true });
			}
			for (const url of extractLocalhostUrls(outputTexts.join('\n'))) {
				if (inputOrigins.has(getWebPreviewOriginKey(url))) {
					continue;
				}
				void this._handleCandidate(model, state, request, url, { trusted: false, autoOpen: true });
			}
		}
	}

	private _scanCompletedResponseText(model: IChatModel, state: SessionPreviewState, request: IChatRequestModel): void {
		const markdown = request.response?.response.getMarkdown();
		if (!markdown) {
			return;
		}
		for (const url of extractLocalhostUrls(markdown)) {
			void this._handleCandidate(model, state, request, url, { trusted: false, autoOpen: true });
		}
	}

	private async _maybeAutoOpen(model: IChatModel, state: SessionPreviewState, request: IChatRequestModel, url: string, origin: string): Promise<void> {
		if (!this.environmentService.isSessionsWindow || state.autoOpenedRequestIds.has(request.id)) {
			return;
		}

		// Only the session the user is currently looking at may take over the
		// Browser panel.
		const widget = this.chatWidgetService.getWidgetBySessionResource(model.sessionResource);
		if (!widget || (this.chatWidgetService.lastFocusedWidget && this.chatWidgetService.lastFocusedWidget !== widget)) {
			return;
		}

		// Latch before any await so concurrent candidates in the same turn
		// cannot double-open.
		state.autoOpenedRequestIds.add(request.id);

		// Reveal an existing live view of this origin rather than navigating a
		// fresh one over it.
		let browserViewId: string | undefined;
		const contextual = this.browserViewService.getContextualBrowserViews({ activeSessionId: model.sessionResource.toString() });
		for (const input of contextual.values()) {
			if (input.url && getWebPreviewOriginKey(input.url) === origin) {
				browserViewId = input.id;
				break;
			}
		}

		if (!browserViewId) {
			// Give a just-started server a moment to bind so the panel does
			// not open onto a connection error; open regardless afterwards.
			await this._probeAlive(url, 3);
			// The probe can take seconds — the user may have switched sessions
			// or the session may be gone. Re-validate before taking the panel.
			if (this._store.isDisposed || !this.chatWidgetService.getWidgetBySessionResource(model.sessionResource)) {
				return;
			}
		}

		try {
			await this.commandService.executeCommand(OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID, browserViewId ? { browserViewId } : { url });
		} catch (err) {
			this.logService.debug('[ChatWebPreviewTracker] Failed to auto-open browser panel', err);
		}
	}
}
