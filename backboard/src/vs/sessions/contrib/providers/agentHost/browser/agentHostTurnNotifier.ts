/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunDelta } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { isAgentHostProvider, type IAgentHostSessionsProvider } from '../../../../common/agentHostSessionsProvider.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';

const NOTIFICATIONS_CONFIG_KEY = 'notifications';

/**
 * Shows an OS notification when an agent-host session's turn finishes
 * (`InProgress` → `Completed`/`Error`) and the session's `notifications`
 * config toggle is on. Fires only while the window is unfocused — the point
 * is to call the user back when they stepped away; clicking the toast focuses
 * the window and opens the session. Approval prompts are already covered by
 * the chat layer's `ChatWindowNotifier`; this contribution only handles turn
 * completion.
 */
export class AgentHostTurnNotifierContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.agentHostTurnNotifier';

	/** One watcher bundle per agent-host provider, keyed by provider id. */
	private readonly _providerWatchers = this._register(new DisposableMap<string>());
	/** In-flight toast per session, keyed by session id. */
	private readonly _activeToasts = this._register(new DisposableMap<string>());

	constructor(
		@ISessionsProvidersService private readonly _providersService: ISessionsProvidersService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IHostService private readonly _hostService: IHostService,
	) {
		super();

		for (const provider of this._providersService.getProviders()) {
			this._watchProvider(provider);
		}
		this._register(this._providersService.onDidChangeProviders(e => {
			for (const provider of e.added) {
				this._watchProvider(provider);
			}
			for (const provider of e.removed) {
				this._providerWatchers.deleteAndDispose(provider.id);
			}
		}));
	}

	private _watchProvider(provider: ISessionsProvider): void {
		if (!isAgentHostProvider(provider)) {
			return;
		}

		const store = new DisposableStore();
		const sessionWatchers = store.add(new DisposableMap<string>());
		for (const session of provider.getSessions()) {
			sessionWatchers.set(session.sessionId, this._watchSession(provider, session));
		}
		store.add(provider.onDidChangeSessions(e => {
			for (const session of e.added) {
				if (!sessionWatchers.has(session.sessionId)) {
					sessionWatchers.set(session.sessionId, this._watchSession(provider, session));
				}
			}
			for (const session of e.removed) {
				sessionWatchers.deleteAndDispose(session.sessionId);
				this._activeToasts.deleteAndDispose(session.sessionId);
			}
		}));
		this._providerWatchers.set(provider.id, store);
	}

	private _watchSession(provider: IAgentHostSessionsProvider, session: ISession) {
		return autorunDelta(session.status, ({ lastValue, newValue }) => {
			if (newValue === SessionStatus.InProgress) {
				// A new turn started: retract any toast left over from the last one.
				this._activeToasts.deleteAndDispose(session.sessionId);
				return;
			}
			// Only a completed or failed turn notifies — and only on a real
			// transition out of a running turn, so session hydration on window
			// reload (which starts straight at Completed) stays silent.
			if (lastValue !== SessionStatus.InProgress) {
				return;
			}
			if (newValue === SessionStatus.Completed || newValue === SessionStatus.Error) {
				this._notifyIfConfigured(provider, session, newValue);
			}
		});
	}

	private async _notifyIfConfigured(provider: IAgentHostSessionsProvider, session: ISession, status: SessionStatus): Promise<void> {
		const value = provider.getSessionConfig(session.sessionId)?.values?.[NOTIFICATIONS_CONFIG_KEY];
		if (value !== true && value !== 'true') {
			return;
		}

		// Only call the user back when they are away; a focused window means
		// they watched the turn finish.
		if (this._hostService.hasFocus) {
			return;
		}

		this._activeToasts.deleteAndDispose(session.sessionId);
		const cts = new CancellationTokenSource();
		this._activeToasts.set(session.sessionId, toDisposable(() => cts.dispose(true)));

		try {
			await this._hostService.focus(mainWindow, { mode: FocusMode.Notify });

			const title = session.title.get() || localize('agentHostTurnNotifier.untitled', "Untitled Session");
			const body = status === SessionStatus.Error
				? localize('agentHostTurnNotifier.failed', "Backboard hit an error this turn.")
				: localize('agentHostTurnNotifier.completed', "Backboard finished this turn.");
			const result = await this._hostService.showToast({
				title: title.replace(/`/g, '\''),
				body,
				actions: [localize('agentHostTurnNotifier.open', "Open Session")],
			}, cts.token);

			if (result.clicked || typeof result.actionIndex === 'number') {
				await this._hostService.focus(mainWindow, { mode: FocusMode.Force });
				await this._sessionsService.openSession(session.resource);
			}
		} finally {
			this._activeToasts.deleteAndDispose(session.sessionId);
		}
	}
}

registerWorkbenchContribution2(AgentHostTurnNotifierContribution.ID, AgentHostTurnNotifierContribution, WorkbenchPhase.AfterRestored);
