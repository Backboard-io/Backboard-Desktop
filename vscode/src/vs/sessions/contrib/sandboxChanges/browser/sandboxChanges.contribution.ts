/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { autorun } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISandboxWorkspaceChangesService } from '../common/sandboxChanges.js';

class SandboxWorkspaceChangesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessions.sandboxWorkspaceChanges';

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISandboxWorkspaceChangesService private readonly _sandboxWorkspaceChangesService: ISandboxWorkspaceChangesService,
	) {
		super();

		this._register(autorun(reader => {
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			const workspace = activeSession?.workspace.read(reader);
			if (activeSession && workspace?.folders.length) {
				void this._ensureBaseline(activeSession);
			}
		}));

		this._register(this._sessionsManagementService.onWillSendRequest(session => {
			void this._ensureBaseline(session);
		}));

		this._register(this._sessionsManagementService.onDidStartSession(session => {
			void this._ensureBaseline(session);
			this._sandboxWorkspaceChangesService.signalChanged();
		}));

		this._register(this._sessionsManagementService.onDidSendRequest(event => {
			void this._ensureBaseline(event.session);
			this._sandboxWorkspaceChangesService.signalChanged();
		}));

		this._register(this._sessionsManagementService.onDidChangeSessions(event => {
			for (const session of [...event.added, ...event.changed]) {
				void this._ensureBaseline(session);
			}
			this._sandboxWorkspaceChangesService.signalChanged();
		}));
	}

	private async _ensureBaseline(session: ISession): Promise<void> {
		try {
			await this._sandboxWorkspaceChangesService.ensureBaseline(session);
		} catch {
			// Baseline tracking is best-effort; the Changes tab still falls back to session-age file metadata.
		}
	}
}

registerWorkbenchContribution2(SandboxWorkspaceChangesContribution.ID, SandboxWorkspaceChangesContribution, WorkbenchPhase.AfterRestored);
