/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { AbstractChatView, ChatViewKind, IChatViewOptions } from '../../../../sessions/browser/parts/chatView.js';
import { IChatViewFactory } from '../../../../sessions/services/chatView/browser/chatViewFactory.js';
import { ISessionContext, SessionContext } from '../../../../sessions/services/sessions/browser/sessionContext.js';
import { ISessionsService } from '../../../../sessions/services/sessions/browser/sessionsService.js';
import { SessionStatus } from '../../../../sessions/services/sessions/common/session.js';

export const OptimusChatViewId = 'optimus.workbench.view.chat';

/**
 * The Optimus window's right panel: hosts the chat for whichever grid card is
 * currently active.
 *
 * It mounts the *same* chat surfaces the Simple window mounts — the Sessions
 * chat views obtained from {@link IChatViewFactory} (`NewChatView` for a fresh
 * composer, `ChatView` for a live transcript) — so the composer controls, the
 * combined provider+model picker, send enablement and the streaming path are
 * identical in both modes. It previously built its own `ChatWidget` with
 * editor-style options, which drifted into a second, differently behaving chat
 * UI; the view-kind switching below mirrors `SessionView.openSession`.
 *
 * The session chrome `SessionView` renders around the chat (title, tabs,
 * per-session toolbar) stays out of here: in Optimus that information lives on
 * the grid cards, and the panel is narrow.
 */
export class OptimusChatViewPane extends ViewPane {

	/**
	 * Options handed to each new-chat view. `renderSessionTypePickerInControls`
	 * is an A/B treatment that `SessionsPart` resolves for the Simple window;
	 * the right panel keeps the default placement (picker next to the workspace
	 * picker) rather than duplicating the experiment plumbing.
	 */
	private readonly chatViewOptions: IChatViewOptions = {
		renderSessionTypePickerInControls: observableValue<boolean>('optimusRenderSessionTypePickerInControls', false)
	};

	private readonly currentView = this._register(new MutableDisposable<AbstractChatView>());
	private contentContainer: HTMLElement | undefined;
	private viewInstantiationService: IInstantiationService | undefined;
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
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IChatViewFactory private readonly chatViewFactory: IChatViewFactory,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('optimus-chat-view');
		this.contentContainer = append(container, $('.optimus-chat-view-content'));

		// Scoped like `SessionView`: toolbars and contributed action view items
		// hosted by the chat views resolve the session they act on through
		// `ISessionContext`. The panel always shows the window's active session,
		// so it publishes exactly that.
		this.viewInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, this.scopedContextKeyService],
			[ISessionContext, new SessionContext(this.sessionsService.activeSession)],
		)));

		// Mirrors `SessionView.openSession`: the active session's state picks
		// the view kind, so the panel shows whatever the Simple window would.
		this._register(autorun(reader => {
			const session = this.sessionsService.activeSession.read(reader);

			let desiredKind: ChatViewKind;
			if (session === undefined || session.isCreated.read(reader) === false) {
				desiredKind = 'newSession';
			} else if (session.activeChat.read(reader).status.read(reader) === SessionStatus.Untitled) {
				desiredKind = 'newChatInSession';
			} else {
				desiredKind = 'chat';
			}

			let view = this.currentView.value;
			if (!view || view.kind !== desiredKind) {
				view = desiredKind === 'chat'
					? this.chatViewFactory.createChatView(this.viewInstantiationService)
					: this.chatViewFactory.createNewChatView(desiredKind === 'newChatInSession', this.chatViewOptions, this.viewInstantiationService);
				this.contentContainer?.replaceChildren(view.element);
				this.currentView.value = view;
				// The panel hosts a single chat, which is the one the user is
				// working in — never the dimmed inactive styling.
				view.setActive(true);
			}

			if (session) {
				view.setChat(session.activeChat.read(reader), session.sessionId);
			}

			this.layoutChatView();
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyWidth = width;
		this.lastBodyHeight = height;
		this.layoutChatView();
	}

	private layoutChatView(): void {
		if (this.lastBodyWidth > 0 && this.lastBodyHeight > 0) {
			this.currentView.value?.layout(this.lastBodyWidth, this.lastBodyHeight, 0, 0);
		}
	}

	override focus(): void {
		super.focus();
		this.currentView.value?.focus();
	}

	/**
	 * Explicitly show a FRESH composer. The New Task action calls this directly:
	 * it cannot rely on clearing the active session alone, because when no
	 * session is active (e.g. right after closing every chat) clearing it again
	 * changes nothing and the panel would stay on whatever it shows.
	 *
	 * `forceNew` discards any pending draft and deactivates the session, which
	 * drives the autorun above back to the new-chat composer. The composer then
	 * owns session creation and first-send materialization exactly as it does in
	 * the Simple window — there is no second, panel-local untitled chat to keep
	 * in sync, so a task can no longer end up split across two sessions.
	 */
	async showNewChat(): Promise<void> {
		this.sessionsService.openNewSession({ forceNew: true });
		this.currentView.value?.focus();
	}
}
