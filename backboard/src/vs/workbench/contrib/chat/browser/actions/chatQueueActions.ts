/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatRequestQueueKind, IChatService } from '../../common/chatService/chatService.js';
import { ChatConfiguration } from '../../common/constants.js';
import { isRequestVM } from '../../common/model/chatViewModel.js';
import { IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

const editingQueue = ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Queue);
const editingSteer = ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Steer);
const editingQueueOrSteer = ContextKeyExpr.or(editingQueue, editingSteer)!;

const queuingActionsPresent = ContextKeyExpr.and(
	ContextKeyExpr.or(ChatContextKeys.requestInProgress, editingQueueOrSteer),
	ChatContextKeys.editingRequestType.notEqualsTo(ChatContextKeys.EditingRequestType.Sent),
);

export interface IChatRemovePendingRequestContext {
	sessionResource: URI;
	pendingRequestId: string;
}

function isRemovePendingRequestContext(context: unknown): context is IChatRemovePendingRequestContext {
	return !!context &&
		typeof context === 'object' &&
		'sessionResource' in context &&
		'pendingRequestId' in context &&
		URI.isUri((context as IChatRemovePendingRequestContext).sessionResource) &&
		typeof (context as IChatRemovePendingRequestContext).pendingRequestId === 'string';
}

export class ChatQueueMessageAction extends Action2 {
	static readonly ID = 'workbench.action.chat.queueMessage';

	constructor() {
		super({
			id: ChatQueueMessageAction.ID,
			title: localize2('chat.queueMessage', "Send"),
			tooltip: localize('chat.queueMessage.tooltip', "Send after the current response finishes"),
			icon: Codicon.arrowUp,
			f1: false,
			category: CHAT_CATEGORY,

			precondition: ChatContextKeys.inputHasSendableContent,
			keybinding: [{
				when: ContextKeyExpr.and(
					ChatContextKeys.inChatInput,
					queuingActionsPresent,
				),
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib + 1
			}],
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (!widget?.viewModel) {
			return;
		}

		// If no request is in progress, send as a normal message instead of queuing
		if (!widget.viewModel.model.requestInProgress.get()) {
			widget.acceptInput();
			return;
		}

		widget.acceptInput(undefined, { queue: ChatRequestQueueKind.Queued });
	}
}

export class ChatSteerWithMessageAction extends Action2 {
	static readonly ID = 'workbench.action.chat.steerWithMessage';

	constructor() {
		super({
			id: ChatSteerWithMessageAction.ID,
			title: localize2('chat.steerWithMessage', "Add to Queue"),
			tooltip: localize('chat.steerWithMessage.tooltip', "Queue this message to send after the current request completes"),
			icon: Codicon.add,
			f1: false,
			category: CHAT_CATEGORY,
			precondition: ChatContextKeys.inputHasText,
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (!widget?.viewModel) {
			return;
		}

		const inputValue = widget.getInput();
		if (!inputValue.trim()) {
			return;
		}

		// If no request is in progress, send as a normal message instead of queuing.
		if (!widget.viewModel.model.requestInProgress.get()) {
			widget.acceptInput();
			return;
		}

		widget.acceptInput(undefined, { queue: ChatRequestQueueKind.Queued });
	}
}

export class ChatRemovePendingRequestAction extends Action2 {
	static readonly ID = 'workbench.action.chat.removePendingRequest';

	constructor() {
		super({
			id: ChatRemovePendingRequestAction.ID,
			title: localize2('chat.removePendingRequest', "Remove from Queue"),
			icon: Codicon.trash,
			f1: false,
			category: CHAT_CATEGORY,
			menu: [{
				id: MenuId.ChatMessageTitle,
				group: 'navigation',
				order: 4,
				when: ContextKeyExpr.and(
					ChatContextKeys.isRequest,
					ChatContextKeys.isPendingRequest
				)
			}]
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const chatService = accessor.get(IChatService);
		const [context] = args;

		// Support both toolbar context (IChatRequestViewModel) and command context (IChatRemovePendingRequestContext)
		if (isRequestVM(context) && context.pendingKind) {
			chatService.removePendingRequest(context.sessionResource, context.id);
			return;
		}

		if (isRemovePendingRequestContext(context)) {
			chatService.removePendingRequest(context.sessionResource, context.pendingRequestId);
			return;
		}
	}
}

export class ChatEditPendingRequestAction extends Action2 {
	static readonly ID = 'workbench.action.chat.editPendingRequest';

	constructor() {
		super({
			id: ChatEditPendingRequestAction.ID,
			title: localize2('chat.editPendingRequest', "Edit"),
			icon: Codicon.edit,
			f1: false,
			category: CHAT_CATEGORY,
			menu: [{
				id: MenuId.ChatMessageTitle,
				group: 'secondary',
				order: 2,
				when: ContextKeyExpr.and(
					ChatContextKeys.isRequest,
					ChatContextKeys.isPendingRequest,
					ContextKeyExpr.notEquals(`config.${ChatConfiguration.EditRequests}`, 'hover'),
					ContextKeyExpr.notEquals(`config.${ChatConfiguration.EditRequests}`, 'input')
				)
			}]
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const [context] = args;

		if (!isRequestVM(context) || !context.pendingKind) {
			return;
		}

		const widget = widgetService.getWidgetBySessionResource(context.sessionResource);
		widget?.startEditing(context.id);
	}
}

export class ChatRemoveAllPendingRequestsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.removeAllPendingRequests';

	constructor() {
		super({
			id: ChatRemoveAllPendingRequestsAction.ID,
			title: localize2('chat.removeAllPendingRequests', "Remove All Queued"),
			icon: Codicon.clearAll,
			f1: false,
			category: CHAT_CATEGORY,
			menu: [{
				id: MenuId.ChatContext,
				group: 'navigation',
				order: 3,
				when: ChatContextKeys.hasPendingRequests,
			}],
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const chatService = accessor.get(IChatService);
		const widgetService = accessor.get(IChatWidgetService);
		const [context] = args;

		const widget = (isRequestVM(context) && widgetService.getWidgetBySessionResource(context.sessionResource)) || widgetService.lastFocusedWidget;
		const model = widget?.viewModel?.model;
		if (!model) {
			return;
		}

		for (const pendingRequest of [...model.getPendingRequests()]) {
			chatService.removePendingRequest(model.sessionResource, pendingRequest.request.id);
		}
	}
}

export function registerChatQueueActions(): void {
	registerAction2(ChatQueueMessageAction);
	registerAction2(ChatSteerWithMessageAction);
	registerAction2(ChatRemovePendingRequestAction);
	registerAction2(ChatEditPendingRequestAction);
	registerAction2(ChatRemoveAllPendingRequestsAction);

	// While a response is active, keep the same send-arrow affordance. Sending is
	// non-destructive: ChatWidget.acceptInput automatically queues the message and
	// lets the current response finish.
	MenuRegistry.appendMenuItem(MenuId.ChatExecute, {
		command: {
			id: ChatQueueMessageAction.ID,
			title: localize2('chat.queueMessage', "Send"),
			icon: Codicon.arrowUp,
		},
		when: ContextKeyExpr.and(
			queuingActionsPresent,
			ChatContextKeys.inputHasSendableContent,
		),
		group: 'navigation',
		order: 4,
	});
}
