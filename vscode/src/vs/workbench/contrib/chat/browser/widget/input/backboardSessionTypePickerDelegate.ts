/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { getChatSessionType } from '../../../common/model/chatUri.js';
import { AgentSessionProviders, AgentSessionTarget } from '../../agentSessions/agentSessions.js';
import { ISessionTypePickerDelegate } from '../../chat.js';

/**
 * Session providers the Simple window's new-chat composer offers, in its order.
 * Mirrors `NEW_CHAT_ALLOWED_SESSION_TYPES` in
 * `vs/sessions/contrib/chat/browser/newChatWidget.ts` — kept as a copy rather
 * than an import because that module is in the `vs/sessions` layer, which
 * `vs/workbench` may not import from.
 */
const STATIC_SESSION_PROVIDERS: readonly AgentSessionTarget[] = [
	AgentSessionProviders.AgentHostBackboard,
	AgentSessionProviders.AgentHostClaude,
	AgentSessionProviders.AgentHostCodex,
	AgentSessionProviders.AgentHostOpencode,
];

/** Prefix identifying an agent-host session type. */
const AGENT_HOST_SESSION_TYPE_PREFIX = 'agent-host-';

/**
 * Builds the session-type picker delegate that turns the composer's model
 * picker into the Simple window's combined provider+model chip.
 *
 * `ChatInputPart` renders `CombinedModelProviderPickerActionItem` only when the
 * widget sets `isSessionsWindow` *and* its `sessionTypePickerDelegate` supplies
 * `setActiveSessionProvider`; otherwise it falls back to the plain
 * `ModelPickerActionItem`. Hosts outside `vs/sessions` cannot reuse that
 * window's `SessionTypePicker`, so this provides the same three capabilities
 * from workbench-layer services alone:
 *
 * - the active provider is read off the chat's own session resource, which is
 *   what `ChatInputPart.getCurrentSessionType` already falls back to;
 * - selecting a provider runs `openNewChatSessionInPlace.<type>`, the command
 *   the shared session picker executes when no setter is supplied (see
 *   `sessionTargetPickerActionItem`), registered per contributed type;
 * - the provider rail lists the Simple window's providers plus any
 *   dynamically-registered agent-host types, so BYOS ("bring your own server")
 *   providers such as remote agent hosts appear too. For the combined chip the
 *   allowlist *is* the rail — it is not a filter over a wider enumeration the
 *   way it is in `sessionTargetPickerActionItem` — so anything omitted here is
 *   unreachable.
 *
 * @param getSessionResource Lazily resolves the hosted chat's session resource.
 *   Called after construction, so it may return `undefined` early on.
 */
export function createBackboardSessionTypePickerDelegate(
	getSessionResource: () => URI | undefined,
	commandService: ICommandService,
	chatSessionsService: IChatSessionsService,
): ISessionTypePickerDelegate {
	return {
		getActiveSessionProvider: () => {
			const resource = getSessionResource();
			return resource ? getChatSessionType(resource) : undefined;
		},

		setActiveSessionProvider: provider => {
			commandService
				.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.${provider}`)
				.then(undefined, () => { /* provider not registered; the rail keeps its current selection */ });
		},

		getAllowedSessionProviders: () => {
			const providers: AgentSessionTarget[] = [...STATIC_SESSION_PROVIDERS];
			for (const contribution of chatSessionsService.getAllChatSessionContributions()) {
				if (contribution.type.startsWith(AGENT_HOST_SESSION_TYPE_PREFIX) && !providers.includes(contribution.type)) {
					providers.push(contribution.type);
				}
			}
			return providers;
		},
	};
}
