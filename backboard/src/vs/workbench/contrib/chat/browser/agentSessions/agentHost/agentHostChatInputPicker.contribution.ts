/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext, WorkspaceFolderCountContext } from '../../../../../common/contextkeys.js';
import { ChatContextKeys, ChatContextKeyExprs } from '../../../common/actions/chatContextKeys.js';

/**
 * Agent-host pickers live in `MenuId.ChatInput` so Backboard controls stay
 * inside the composer instead of occupying a secondary row below the input.
 *
 * Order layout in the primary toolbar:
 *   -1    AttachContextAction
 *   -0.9  OpenAgentHostModePickerAction
 *    3.2  OpenAgentHostAutoApprovePickerAction
 *    3.3  OpenAgentHostClaudeOptionsAction
 *    3.4  OpenAgentHostFolderPickerAction      (multi-root only)
 *  100    OpenModelPickerAction
 */

export class OpenAgentHostFolderPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostFolderPicker';
	constructor() {
		super({
			id: OpenAgentHostFolderPickerAction.ID,
			title: localize2('agentHost.folderPicker', "Folder"),
			f1: false,
			// The working directory is an argument to session creation and is
			// fixed once the session has started (its first request), so the
			// chip stays visible afterwards but is disabled.
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.chatSessionIsEmpty),
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 3.4,
				// Only relevant when there is more than one root folder to choose
				// from and we are in a regular editor window (the agent sessions
				// window has its own workspace picker). Ordered last in the chip
				// row to match the extension-host Copilot CLI layout.
				when: ContextKeyExpr.and(
					ChatContextKeyExprs.isAgentHostSession,
					WorkspaceFolderCountContext.greater(1),
					IsSessionsWindowContext.negate(),
				),
			}],
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

/**
 * Visible for locked agent-host sessions anywhere, and for ALL chats in the
 * sessions (Simple) window — there every session is an agent-host session,
 * including the not-yet-started composer where the lock key isn't set yet.
 */
const agentHostPickerVisibility = ContextKeyExpr.or(
	ChatContextKeyExprs.isAgentHostSession,
	IsSessionsWindowContext,
);

export class OpenAgentHostModePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostModePicker';
	constructor() {
		super({
			id: OpenAgentHostModePickerAction.ID,
			title: localize2('agentHost.modePicker', "Access"),
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: -0.9,
				when: agentHostPickerVisibility,
			}],
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

export class OpenAgentHostAutoApprovePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostAutoApprovePicker';
	constructor() {
		super({
			id: OpenAgentHostAutoApprovePickerAction.ID,
			title: localize2('agentHost.autoApprovePicker', "Auto-Approve"),
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 3.2,
				when: agentHostPickerVisibility,
			}],
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

/** Claude permission-mode picker opened through the consolidated options gear. */
export class OpenAgentHostPermissionModePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostPermissionModePicker';
	constructor() {
		super({
			id: OpenAgentHostPermissionModePickerAction.ID,
			title: localize2('agentHost.permissionModePicker', "Approvals"),
			f1: false,
			precondition: ChatContextKeys.enabled,
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

/** Claude fast-mode picker opened through the consolidated options gear. */
export class OpenAgentHostFastModePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostFastModePicker';
	constructor() {
		super({
			id: OpenAgentHostFastModePickerAction.ID,
			title: localize2('agentHost.fastModePicker', "Fast Mode"),
			f1: false,
			precondition: ChatContextKeys.enabled,
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

/** Consolidates Claude's Approvals and Fast Mode controls into one menu. */
export class OpenAgentHostClaudeOptionsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openAgentHostClaudeOptions';
	constructor() {
		super({
			id: OpenAgentHostClaudeOptionsAction.ID,
			title: localize2('agentHost.claudeOptions', "Agent Options"),
			tooltip: localize('agentHost.claudeOptionsTooltip', "Open agent session options"),
			icon: Codicon.settingsGear,
			f1: false,
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 3.3,
				when: ChatContextKeys.chatSessionIsExternalAgent,
			}],
		});
	}
	override async run(): Promise<void> { /* the action view item handles interaction */ }
}

registerAction2(OpenAgentHostModePickerAction);
registerAction2(OpenAgentHostAutoApprovePickerAction);
registerAction2(OpenAgentHostPermissionModePickerAction);
registerAction2(OpenAgentHostFastModePickerAction);
registerAction2(OpenAgentHostClaudeOptionsAction);
registerAction2(OpenAgentHostFolderPickerAction);
