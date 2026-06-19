/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWidget.css';
import './media/newChatInSession.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { derived, IObservable } from '../../../../base/common/observable.js';
import { Gesture, EventType as TouchEventType } from '../../../../base/browser/touch.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISendRequestOptions } from '../../../services/sessions/common/sessionsProvider.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IChatViewOptions } from '../../../browser/parts/chatView.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground } from '../../../common/theme.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { isEqual } from '../../../../base/common/resources.js';

// #region --- New Chat In Session Widget ---

const STORAGE_KEY_SUB_SESSION_TIP_DISMISSED = 'sessions.subSessionTipDismissed';

/**
 * A widget for composing a secondary chat within an existing session.
 * Reuses {@link NewChatInputWidget} but without workspace/session type pickers,
 * since the session already exists.
 */
export class NewChatInSessionWidget extends Disposable {

	private readonly _widget: ChatWidget;
	private readonly _tipDisposable = this._register(new MutableDisposable());
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _session: IObservable<IActiveSession | undefined>;
	private _currentChatResource: URI | undefined;
	private _chatWidgetContent: HTMLElement | undefined;

	constructor(
		_options: IChatViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IStorageService private readonly storageService: IStorageService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();

		this._session = derived(reader => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			return activeSession;
		});

		const scopedContextKeyService = this._register(contextKeyService.createScoped(document.createElement('div')));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, scopedContextKeyService])
		));
		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			undefined,
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				rendererOptions: {
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				isSessionsWindow: true,
				submitHandler: async query => this._sendFromSharedComposer(query),
			},
			{
				listForeground: activeSessionViewForeground,
				listBackground: activeSessionViewBackground,
				overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
				inputEditorBackground: activeSessionViewBackground,
				resultEditorBackground: agentsPanelBackground,
			}
		));
	}

	// --- Rendering ---

	render(parent: HTMLElement): void {
		const element = dom.append(parent, dom.$('.sessions-chat-widget.new-chat-in-session'));
		const chatWidgetContainer = dom.append(element, dom.$('.new-chat-widget-container'));
		const chatWidgetContent = dom.append(chatWidgetContainer, dom.$('.new-chat-widget-content'));
		this._chatWidgetContent = chatWidgetContent;

		this._renderSubSessionTip(chatWidgetContent);
		this._widget.render(chatWidgetContent);
		this._widget.setVisible(true);
		this._widget.setInputPlaceholder(localize('newChatInSessionPlaceholder', 'Ask a follow-up question or start a new topic within this session...'));

		chatWidgetContainer.classList.add('revealed');
	}

	private _renderSubSessionTip(container: HTMLElement): void {
		if (this.storageService.getBoolean(STORAGE_KEY_SUB_SESSION_TIP_DISMISSED, StorageScope.PROFILE, false)) {
			return;
		}

		const tipContainer = dom.append(container, dom.$('.sub-session-tip-container'));
		const tipWidget = dom.append(tipContainer, dom.$('.sub-session-tip-widget'));
		tipWidget.setAttribute('role', 'status');
		tipWidget.setAttribute('aria-label', localize('subSessionTip.ariaLabel', "Sub-session tip"));

		// Tip icon
		const iconEl = dom.append(tipWidget, renderIcon(Codicon.lightbulb));
		iconEl.classList.add('sub-session-tip-icon');

		// Tip text
		const textEl = dom.append(tipWidget, dom.$('span.sub-session-tip-text'));
		textEl.textContent = localize(
			'subSessionTip.message',
			"This is a sub-session, a new chat in the same workspace. Use it to ask questions, run tasks, or explore ideas with fresh context."
		);

		// Dismiss button
		const dismissBtn = dom.append(tipWidget, dom.$('button.sub-session-tip-dismiss')) as HTMLButtonElement;
		dismissBtn.type = 'button';
		dismissBtn.setAttribute('aria-label', localize('subSessionTip.dismiss', "Dismiss tip"));
		dom.append(dismissBtn, renderIcon(Codicon.close));

		const dismiss = () => {
			this.storageService.store(STORAGE_KEY_SUB_SESSION_TIP_DISMISSED, true, StorageScope.PROFILE, StorageTarget.USER);
			tipContainer.remove();
			this._tipDisposable.clear();
		};

		const handleDismiss = (e: Event) => {
			dom.EventHelper.stop(e, true);
			dismiss();
		};

		const store = new DisposableStore();
		store.add(Gesture.addTarget(dismissBtn));
		store.add(dom.addDisposableListener(dismissBtn, dom.EventType.CLICK, handleDismiss));
		store.add(dom.addDisposableListener(dismissBtn, TouchEventType.Tap, handleDismiss));
		this._tipDisposable.value = store;
	}

	// --- Send ---

	private async _send(options: ISendRequestOptions): Promise<boolean> {
		const activeSession = this._session.get();
		if (!activeSession) {
			return false;
		}
		const activeChat = activeSession.activeChat.get();
		try {
			await this.sessionsManagementService.sendRequest(activeSession, activeChat, options);
		} catch (e) {
			this.logService.error('Failed to send secondary chat request:', e);
			return false;
		}
		return true;
	}

	private async _sendFromSharedComposer(query: string): Promise<boolean> {
		const input = this._widget.inputPart;
		const activeSession = this._session.get();
		if (!activeSession) {
			return true;
		}
		const provider = this.sessionsProvidersService.getProvider(activeSession.providerId);
		if (input.currentLanguageModel) {
			provider?.setModel(activeSession.sessionId, input.currentLanguageModel);
		}
		const modeKind = input.currentModeKind;
		const sent = await this._send({
			query,
			attachedContext: input.getAttachedAndImplicitContext().asArray(),
			userSelectedModelId: input.currentLanguageModel,
			userSelectedModelConfiguration: input.currentLanguageModel ? input.getModelConfiguration(input.currentLanguageModel) : undefined,
			modeInfo: input.currentModeInfo,
			instructionContext: {
				modeKind,
				enabledTools: modeKind === ChatModeKind.Agent ? input.selectedToolsModel.userSelectedTools.get() : undefined,
				enabledSubAgents: modeKind === ChatModeKind.Agent ? input.currentModeObs.get().agents?.get() : undefined,
			},
		});
		if (sent) {
			input.acceptInput(true);
		}
		return true;
	}

	setChat(chat: IChat): void {
		const resource = chat.resource;
		if (isEqual(this._currentChatResource, resource)) {
			return;
		}
		this._currentChatResource = resource;
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const token = cts.token;
		this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'NewChatInSessionWidget').then(ref => {
			if (token.isCancellationRequested || !ref) {
				ref?.dispose();
				return;
			}
			this._modelRef.value = ref;
			this._widget.setModel(ref.object);
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[NewChatInSessionWidget] Failed to load chat model', err);
			}
		});
	}

	layout(height: number, width: number): void {
		this._widget.layout(this._chatWidgetContent?.clientHeight || height, this._chatWidgetContent?.clientWidth || width);
	}

	focusInput(): void {
		this._widget.focusInput();
	}

	attach(uris: URI[]): void {
		for (const uri of uris) {
			this._widget.attachmentModel.addFile(uri).catch(err => this.logService.error('[NewChatInSessionWidget] Failed to attach file as context', err));
		}
	}
}

// #endregion
