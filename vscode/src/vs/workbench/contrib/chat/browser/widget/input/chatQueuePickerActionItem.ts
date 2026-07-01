/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { ActionViewItem, BaseActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IActionViewItemService } from '../../../../../../platform/actions/browser/actionViewItemService.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';
import { MenuId, SubmenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatSubmitAction } from '../../actions/chatExecuteActions.js';
import { ChatQueueMessageAction } from '../../actions/chatQueueActions.js';

/**
 * Split-button action view item for the queue picker in the chat execute toolbar.
 * The primary button queues the current message.
 * The dropdown arrow opens a custom action widget with hover descriptions.
 *
 * Follows the same split-button pattern as {@link DropdownWithDefaultActionViewItem},
 * but uses {@link ActionWidgetDropdownActionViewItem} for the dropdown to show
 * an action widget with hover descriptions instead of a standard context menu.
 */
export class ChatQueuePickerActionItem extends BaseActionViewItem {

	private readonly _primaryActionAction: Action;
	private readonly _primaryAction: ActionViewItem;
	private readonly _dropdown: ActionWidgetDropdownActionViewItem;

	constructor(
		action: IAction,
		_options: IActionViewItemOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(undefined, action);

		// Primary action - queues the current message.
		this._primaryActionAction = this._register(new Action(
			'chat.queuePickerPrimary',
			localize('chat.queueMessage', "Add to Queue"),
			ThemeIcon.asClassName(Codicon.add),
			!!this.contextKeyService.getContextKeyValue(ChatContextKeys.inputHasText.key),
			() => this.commandService.executeCommand(ChatQueueMessageAction.ID)
		));
		this._primaryAction = this._register(new ActionViewItem(undefined, this._primaryActionAction, { icon: true, label: false }));

		this._register(this.contextKeyService.onDidChangeContext(e => {
			this._primaryActionAction.enabled = !!this.contextKeyService.getContextKeyValue(ChatContextKeys.inputHasText.key);
		}));

		// Dropdown - action widget with hover descriptions and chevron-down icon
		const dropdownAction = this._register(new Action('chat.queuePickerDropdown', localize('chat.queuePicker.moreActions', "More Actions...")));
		this._dropdown = this._register(new ChevronActionWidgetDropdown(
			dropdownAction,
			{
				actionProvider: { getActions: () => this._getDropdownActions() },
				showItemKeybindings: true,
			},
			actionWidgetService,
			this.keybindingService,
			this.contextKeyService,
			telemetryService,
		));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('monaco-dropdown-with-default');

		// Primary action button
		const primaryContainer = $('.action-container');
		this._primaryAction.render(append(container, primaryContainer));
		this._register(addDisposableListener(primaryContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.RightArrow)) {
				this._primaryAction.blur();
				this._dropdown.focus();
				event.stopPropagation();
			}
		}));

		// Dropdown arrow button
		const dropdownContainer = $('.dropdown-action-container');
		this._dropdown.render(append(container, dropdownContainer));
		this._register(addDisposableListener(dropdownContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.LeftArrow)) {
				this._dropdown.setFocusable(false);
				this._primaryAction.focus();
				event.stopPropagation();
			}
		}));
	}

	override focus(fromRight?: boolean): void {
		if (fromRight) {
			this._dropdown.focus();
		} else {
			this._primaryAction.focus();
		}
	}

	override blur(): void {
		this._primaryAction.blur();
		this._dropdown.blur();
	}

	override setFocusable(focusable: boolean): void {
		this._primaryAction.setFocusable(focusable);
		this._dropdown.setFocusable(focusable);
	}

	private _getDropdownActions(): IActionWidgetDropdownAction[] {
		// Resolve display keybindings against an overlay context that simulates the chat input
		// being focused with a request in progress. The injected `contextKeyService` may be the
		// chat widget's outer scope (which has `requestInProgress` but lacks `inChatInput`) or
		// even the global scope; either way, the queue keybinding's `when` clause would
		// not match and the resolver would fall back to the last-registered binding for each
		// command, producing labels that contradict actual behavior. Overlaying the scope keys
		// the bindings expect ensures we look up the binding that would actually fire.
		// Other context keys are read from the parent context, so scoped overrides like
		// editing a queued request are still respected.
		const lookupContext = this.contextKeyService.createOverlay([
			[ChatContextKeys.inputHasText.key, true],
			[ChatContextKeys.inChatInput.key, true],
			[ChatContextKeys.requestInProgress.key, true],
		]);
		const queueKeybinding = this.keybindingService.lookupKeybinding(ChatQueueMessageAction.ID, lookupContext, true);

		const queueAction: IActionWidgetDropdownAction = {
			id: ChatQueueMessageAction.ID,
			label: localize('chat.queueMessage', "Add to Queue"),
			tooltip: '',
			enabled: true,
			checked: true,
			icon: Codicon.add,
			class: undefined,
			keybinding: queueKeybinding,
			hover: {
				content: localize('chat.queueMessage.hover', "Queue this message to send after the current request completes. The current response will finish uninterrupted before the queued message is sent."),
			},
			run: () => {
				this.commandService.executeCommand(ChatQueueMessageAction.ID);
			}
		};

		const sendAction: IActionWidgetDropdownAction = {
			id: '_' + ChatSubmitAction.ID, // _ to avoid showing a keybinding which is not valid in this context
			label: localize('chat.sendImmediately', "Stop and Send"),
			tooltip: '',
			enabled: true,
			icon: Codicon.arrowRight,
			class: undefined,
			hover: {
				content: localize('chat.sendImmediately.hover', "Cancel the current request and send this message immediately."),
			},
			run: () => {
				this.commandService.executeCommand(ChatSubmitAction.ID);
			}
		};

		return [sendAction, queueAction];
	}
}

/**
 * {@link ActionWidgetDropdownActionViewItem} that renders a chevron-down icon
 * as its label, used as the dropdown arrow in the split button.
 */
class ChevronActionWidgetDropdown extends ActionWidgetDropdownActionViewItem {
	protected override renderLabel(element: HTMLElement): IDisposable | null {
		element.classList.add('codicon', 'codicon-chevron-down');
		return null;
	}
}


/**
 * Workbench contribution that registers a custom action view item for the
 * queue picker in the execute toolbar. This replaces the default split
 * button with a custom dropdown similar to the model switcher.
 */
export class ChatQueuePickerRendering extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.queuePickerRendering';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, (action, options, instantiationService) => {
			if (!(action instanceof SubmenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(ChatQueuePickerActionItem, action, options);
		}));
	}
}
