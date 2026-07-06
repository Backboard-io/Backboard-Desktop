/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { AbstractChatView } from '../../../../sessions/browser/parts/chatView.js';
import { IChatViewFactory } from '../../../../sessions/services/chatView/browser/chatViewFactory.js';
import { ISessionsService } from '../../../../sessions/services/sessions/browser/sessionsService.js';

export const OptimusChatViewId = 'optimus.workbench.view.chat';

/**
 * The Optimus window's right panel: hosts a full chat for whichever grid card
 * is currently active, swapping the underlying chat model whenever the active
 * session (or its active chat) changes. Reuses the Simple window's ChatView
 * (via {@link IChatViewFactory}), which owns the ChatWidget hosting and
 * model-swap mechanics.
 */
export class OptimusChatViewPane extends ViewPane {

	private chatView: AbstractChatView | undefined;
	private emptyEl: HTMLElement | undefined;
	private lastBodyWidth = 0;
	private lastBodyHeight = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IChatViewFactory private readonly chatViewFactory: IChatViewFactory,
		@ISessionsService private readonly sessionsService: ISessionsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('optimus-chat-view');

		this.emptyEl = append(container, $('.optimus-chat-empty'));
		this.emptyEl.textContent = localize('optimus.chat.empty', "Select a card to chat with its agent.");

		this.chatView = this._register(this.chatViewFactory.createChatView());
		container.appendChild(this.chatView.element);

		this._register(autorun(reader => {
			const active = this.sessionsService.activeSession.read(reader);
			const chat = active?.activeChat.read(reader);
			const hasChat = !!active && !!chat;

			if (this.emptyEl) {
				this.emptyEl.style.display = hasChat ? 'none' : '';
			}
			if (this.chatView) {
				this.chatView.element.style.display = hasChat ? '' : 'none';
			}
			if (hasChat && this.chatView) {
				this.chatView.setChat(chat, active.sessionId);
				this.layoutChatView();
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyWidth = width;
		this.lastBodyHeight = height;
		this.layoutChatView();
	}

	private layoutChatView(): void {
		if (this.chatView && this.lastBodyWidth > 0 && this.lastBodyHeight > 0) {
			this.chatView.layout(this.lastBodyWidth, this.lastBodyHeight, 0, 0);
		}
	}

	override focus(): void {
		super.focus();
		this.chatView?.focus();
	}
}
