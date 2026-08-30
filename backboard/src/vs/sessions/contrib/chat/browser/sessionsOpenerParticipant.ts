/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { parseSubagentSessionUri } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IAgentSession } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { ISessionOpenerParticipant, ISessionOpenOptions, sessionOpenerRegistry } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsOpener.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

/**
 * Routes session open requests in the Agents window through the
 * {@link ISessionsManagementService} so that the active session/chat state is
 * properly updated. Without this, the default opener tries to load the chat
 * directly into the `ChatViewId` view, which is hidden behind a `when` clause
 * tied to the new-chat context keys and may simply do nothing.
 */
class SessionsOpenerParticipant implements ISessionOpenerParticipant {

	async handleOpenSession(accessor: ServicesAccessor, session: IAgentSession, openOptions?: ISessionOpenOptions): Promise<boolean> {
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsService = accessor.get(ISessionsService);
		const target = sessionsManagementService.getSession(session.resource);
		if (!target) {
			return false;
		}

		await sessionsService.openSession(session.resource, { preserveFocus: openOptions?.editorOptions?.preserveFocus });
		return true;
	}

	async handleOpenChatResource(accessor: ServicesAccessor, parentSessionResource: URI, chatResource: URI, openOptions?: ISessionOpenOptions): Promise<boolean> {
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsPartService = accessor.get(ISessionsPartService);
		let ownerResource = parentSessionResource;
		let parsedParent: ReturnType<typeof parseSubagentSessionUri>;
		while ((parsedParent = parseSubagentSessionUri(ownerResource))) {
			ownerResource = parsedParent.parentSession;
		}
		// In the Sessions window, the chat model URI can differ from the outer
		// session item URI (for example agent-host chat vs local-agent-host
		// session resources). Resolve both forms before looking up the grid leaf.
		const target = sessionsManagementService.getSession(parentSessionResource)
			?? sessionsManagementService.getSession(ownerResource)
			?? sessionsManagementService.getSessionForChatResource(ownerResource)?.session;
		const sessionView = target ? sessionsPartService.getSessionView(target.sessionId) : undefined;
		if (!sessionView?.openChatResource(chatResource)) {
			return false;
		}
		if (!openOptions?.editorOptions?.preserveFocus) {
			sessionView.focus();
		}
		return true;
	}
}

export class SessionsOpenerParticipantContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.sessionOpenerParticipant';

	constructor() {
		super();
		this._register(sessionOpenerRegistry.registerParticipant(new SessionsOpenerParticipant()));
	}
}
