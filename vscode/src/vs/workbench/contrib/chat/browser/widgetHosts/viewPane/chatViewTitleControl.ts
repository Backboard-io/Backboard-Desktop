/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatViewTitleControl.css';
import { addDisposableListener, EventType, h } from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { Gesture, EventType as TouchEventType } from '../../../../../../base/browser/touch.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { AgentSessionsPicker } from '../../agentSessions/agentSessionsPicker.js';
import { IAgentSession } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { openSession } from '../../agentSessions/agentSessionsOpener.js';

export interface IChatViewTitleDelegate {
	focusChat(): void;
}

export class ChatViewTitleControl extends Disposable {

	private static readonly DEFAULT_TITLE = localize('chat', "Backboard");
	private static readonly PICK_AGENT_SESSION_ACTION_ID = 'workbench.action.chat.pickAgentSession';

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private title: string | undefined = undefined;

	private titleContainer: HTMLElement | undefined;
	private titleLabel = this._register(new MutableDisposable<ChatViewTitleLabel>());

	private model: IChatModel | undefined;
	private modelDisposables = this._register(new MutableDisposable());

	private navigationToolbar?: MenuWorkbenchToolBar;
	private actionsToolbar?: MenuWorkbenchToolBar;
	private activeTabLabel: HTMLElement | undefined;
	private tabsContainer: HTMLElement | undefined;
	private tabDisposables = this._register(new DisposableStore());
	private readonly closedSessionTabs = new Set<string>();

	private lastKnownHeight = 0;

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: IChatViewTitleDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.render(this.container);
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.updateTabs(this.getResolvedTitle())));

		this.registerActions();
	}

	private registerActions(): void {
		const that = this;

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ChatViewTitleControl.PICK_AGENT_SESSION_ACTION_ID,
					title: localize('chat.pickAgentSession', "Pick Agent Session"),
					f1: false,
					menu: [{
						id: MenuId.ChatViewSessionTitleNavigationToolbar,
						group: 'navigation',
						order: 2
					}]
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const instantiationService = accessor.get(IInstantiationService);

				const agentSessionsPicker = instantiationService.createInstance(AgentSessionsPicker, that.titleLabel.value?.element, undefined);
				await agentSessionsPicker.pickAgentSession();
			}
		}));
	}

	private render(parent: HTMLElement): void {
		const elements = h('div.chat-view-title-container', [
			h('div.chat-view-title-inner', [
				h('div.chat-view-title-tabs@tabsContainer'),
				h('div.chat-view-title-navigation-toolbar@navigationToolbar'),
				h('div.chat-view-title-actions-toolbar@actionsToolbar'),
			]),
		]);
		this.tabsContainer = elements.tabsContainer;

		// Toolbar on the left
		this.navigationToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, elements.navigationToolbar, MenuId.ChatViewSessionTitleNavigationToolbar, {
			actionViewItemProvider: (action: IAction) => {
				if (action.id === ChatViewTitleControl.PICK_AGENT_SESSION_ACTION_ID) {
					this.titleLabel.value = new ChatViewTitleLabel(action);
					this.titleLabel.value.updateTitle(this.title ?? ChatViewTitleControl.DEFAULT_TITLE);

					return this.titleLabel.value;
				}

				return undefined;
			},
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			menuOptions: { shouldForwardArgs: true }
		}));

		// Actions toolbar on the right
		this.actionsToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, elements.actionsToolbar, MenuId.ChatViewSessionTitleToolbar, {
			menuOptions: { shouldForwardArgs: true },
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));

		// Title controls
		this.titleContainer = elements.root;
		this._register(Gesture.addTarget(this.titleContainer));
		for (const eventType of [TouchEventType.Tap, EventType.CLICK]) {
			this._register(addDisposableListener(this.titleContainer, eventType, () => {
				this.delegate.focusChat();
			}));
		}

		parent.appendChild(this.titleContainer);
		this.updateTitle(ChatViewTitleControl.DEFAULT_TITLE);
	}

	update(model: IChatModel | undefined): void {
		this.model = model;

		this.modelDisposables.value = model?.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				this.doUpdate();
			}
		});

		this.doUpdate();
	}

	private doUpdate(): void {
		const title = this.getResolvedTitle();

		this.updateTitle(title);

		const context = this.model && {
			$mid: MarshalledId.ChatViewContext,
			sessionResource: this.model.sessionResource
		} satisfies IChatViewTitleActionContext;

		if (this.navigationToolbar) {
			this.navigationToolbar.context = context;
		}

		if (this.actionsToolbar) {
			this.actionsToolbar.context = context;
		}
	}

	private getResolvedTitle(): string {
		const markdownTitle = new MarkdownString(this.model?.title ?? '');
		this.title = renderAsPlaintext(markdownTitle);
		return this.title.trim() || ChatViewTitleControl.DEFAULT_TITLE;
	}

	private updateTitle(title: string): void {
		if (!this.titleContainer) {
			return;
		}

		this.titleContainer.classList.toggle('visible', this.shouldRender());
		this.titleLabel.value?.updateTitle(title);
		if (this.activeTabLabel) {
			this.activeTabLabel.textContent = title;
		}
		this.updateTabs(title);

		const currentHeight = this.getHeight();
		if (currentHeight !== this.lastKnownHeight) {
			this.lastKnownHeight = currentHeight;

			this._onDidChangeHeight.fire();
		}
	}

	private shouldRender(): boolean {
		return true;
	}

	private updateTabs(currentTitle: string): void {
		if (!this.tabsContainer) {
			return;
		}

		this.tabDisposables.clear();
		this.tabsContainer.replaceChildren();

		const currentSessionResource = this.model?.sessionResource;
		this.addTab({
			label: currentTitle,
			active: true,
			isCurrent: true,
		});

		const sessions = this.agentSessionsService.model.sessions
			.filter(session => !session.isArchived())
			.filter(session => !currentSessionResource || !isEqual(session.resource, currentSessionResource))
			.filter(session => !this.closedSessionTabs.has(session.resource.toString()))
			.slice(0, 4);

		for (const session of sessions) {
			this.addTab({
				label: session.label,
				active: false,
				session,
			});
		}
	}

	private addTab(options: { label: string; active: boolean; isCurrent?: boolean; session?: IAgentSession }): void {
		if (!this.tabsContainer) {
			return;
		}

		const label = options.label.trim() || ChatViewTitleControl.DEFAULT_TITLE;
		let closeElement: HTMLElement | undefined;
		const tabElements = options.isCurrent
			? h('div.chat-view-title-tab', { role: 'button', tabIndex: 0, title: label }, [
				h('span.codicon.codicon-backboard-logo.chat-view-title-brand-icon'),
				h('span.chat-view-title-tab-label@label', [label]),
			])
			: h('div.chat-view-title-tab', { role: 'button', tabIndex: 0, title: label }, [
				h('span.chat-view-title-tab-label@label', [label]),
				h('span.codicon.codicon-close.chat-view-title-tab-close@close', { role: 'button', title: localize('chat.closeSessionTab', "Close Tab"), ariaLabel: localize('chat.closeSessionTab', "Close Tab") }),
			]);
		if (!options.isCurrent) {
			closeElement = tabElements.close;
		}
		const tab = tabElements.root;
		tab.classList.toggle('chat-view-title-tab-active', options.active);

		if (options.active) {
			this.activeTabLabel = tabElements.label;
		}

		this.tabsContainer.appendChild(tab);
		this.tabDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			if (options.session) {
				void this.instantiationService.invokeFunction(openSession, options.session);
			} else {
				this.delegate.focusChat();
			}
		}));

		if (options.session && closeElement) {
			this.tabDisposables.add(addDisposableListener(closeElement, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.closedSessionTabs.add(options.session!.resource.toString());
				this.updateTabs(this.getResolvedTitle());
			}));
		}
	}

	getHeight(): number {
		if (!this.titleContainer || this.titleContainer.style.display === 'none') {
			return 0;
		}

		return this.titleContainer.offsetHeight;
	}
}

class ChatViewTitleLabel extends ActionViewItem {

	private title: string | undefined;

	private titleLabel: HTMLSpanElement | undefined = undefined;

	constructor(action: IAction, options?: IActionViewItemOptions) {
		super(null, action, { ...options, icon: false, label: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('chat-view-title-action-item');
		this.label?.classList.add('chat-view-title-label-container');

		this.titleLabel = this.label?.appendChild(h('span.chat-view-title-label').root);

		this.updateLabel();
	}

	updateTitle(title: string): void {
		this.title = title;

		this.updateLabel();
	}

	protected override updateLabel(): void {
		if (!this.titleLabel) {
			return;
		}

		if (this.title) {
			this.titleLabel.textContent = this.title;
		} else {
			this.titleLabel.textContent = '';
		}
	}
}
