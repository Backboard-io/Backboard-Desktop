/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { $, append } from '../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { getChatSessionType } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { IChatSessionsService, localChatSessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { AbstractChatView, ChatViewKind, IChatViewOptions } from '../../../browser/parts/chatView.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { NewChatWidget } from './newChatWidget.js';
import { NewChatInSessionWidget } from './newChatInSessionWidget.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground, inactiveSessionViewBackground, inactiveSessionViewForeground } from '../../../common/theme.js';
import { isEqual } from '../../../../base/common/resources.js';

function formatAgentLabel(sessionType: string): string {
	return sessionType
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(part => part.toLowerCase() === 'codex' ? 'Codex' : part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function formatModelLabel(modelId: string): string {
	const slug = modelId.split('/').pop() ?? modelId;
	const claude = /^claude-(opus|sonnet|haiku)-(.+)$/i.exec(slug);
	if (claude) {
		return `Claude ${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1).toLowerCase()} ${claude[2].replace(/-/g, '.')}`;
	}
	const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(slug);
	if (gpt) {
		const suffix = gpt[2]
			? `-${gpt[2].split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-')}`
			: '';
		return `GPT-${gpt[1]}${suffix}`;
	}
	const deepSeek = /^deepseek-(.+)$/i.exec(slug);
	if (deepSeek) {
		return `DeepSeek ${deepSeek[1].split('-').map(part => /^v?\d/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}`;
	}
	return slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * A session view that hosts a {@link NewChatWidget} — the "new session" UI
 * shown before a session has been created. This is the default view that
 * the `SessionsPart` grid is seeded with.
 */
export class NewChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.newSession';

	override readonly kind: ChatViewKind;

	private readonly _widget: NewChatWidget | NewChatInSessionWidget;

	constructor(
		isNewChatInSession: boolean,
		options: IChatViewOptions,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.element.classList.add('chat-view-new');
		this.kind = isNewChatInSession ? 'newChatInSession' : 'newSession';
		this._widget = this._register(isNewChatInSession
			? instantiationService.createInstance(NewChatInSessionWidget, options)
			: instantiationService.createInstance(NewChatWidget, options));
		this._widget.render(this.element);
	}

	override toJSON(): object {
		return { type: NewChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(height, width);
	}

	override focus(): void {
		this._widget.focusInput();
	}

	override selectWorkspace(folderUri: URI, providerId?: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.selectWorkspace(folderUri, providerId);
		}
	}

	override prefillInput(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.prefillInput(text);
		}
	}

	override sendQuery(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.sendQuery(text);
		}
	}

	override attach(uris: URI[]): void {
		this._widget.attach(uris);
	}

	override setChat(chat: IChat, _historyKey?: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.setChat(chat);
		} else if (this._widget instanceof NewChatInSessionWidget) {
			this._widget.setChat(chat);
		}
	}
}

/**
 * A session view that hosts the standard chat {@link ChatWidget} — used to
 * render an active chat session inside the `SessionsPart` grid.
 */
export class ChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.session';

	override readonly kind: ChatViewKind = 'chat';

	private readonly _widget: ChatWidget;
	private readonly _identityElement: HTMLElement;
	private readonly _identityAgentElement: HTMLElement;
	private readonly _identityModelElement: HTMLElement;

	/** Reference to the loaded chat model; disposing releases the model. */
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());

	/** Cancels any in-flight model load when a new session is set or the view disposes. */
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());

	/** Tracks the currently loaded chat resource to avoid redundant reloads. */
	private _currentChatResource: URI | undefined;
	private _historyKey: string | undefined;

	/** Whether this view currently represents the active session. */
	private _isActive = true;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@ISessionContext private readonly sessionContext: ISessionContext,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		this.element.classList.add('chat-view-chat', 'backboard-clean-chat', 'backboard-composer');

		const scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		const scopedInstantiationService = this._register(instantiationService.createChild(
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
					renderTextEditsAsSummary: () => true,
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				dndContainer: this.element,
			},
			this._buildStyles(this._isActive)
		));
		this._widget.render(this.element);
		this._widget.setVisible(true);

		this._identityElement = $('.session-chat-identity');
		this._identityElement.setAttribute('role', 'status');
		this._identityElement.setAttribute('aria-live', 'polite');
		this._identityAgentElement = append(this._identityElement, $('span.session-chat-identity-agent'));
		append(this._identityElement, $('span.session-chat-identity-separator', undefined, '·'));
		this._identityModelElement = append(this._identityElement, $('span.session-chat-identity-model'));
		this._widget.inputPart.element.prepend(this._identityElement);

		this._register(autorun(reader => {
			const session = this.sessionContext.session.read(reader);
			if (!session) {
				this._identityElement.hidden = true;
				return;
			}

			const provider = this.sessionsProvidersService.getProvider(session.providerId);
			const sessionType = provider?.sessionTypes.find(type => type.id === session.sessionType);
			const agentLabel = sessionType?.label ?? formatAgentLabel(session.sessionType);

			const chatModelId = session.activeChat.read(reader).modelId.read(reader);
			const sessionModelId = session.modelId.read(reader);
			const selectedModel = this._widget.inputPart.selectedLanguageModel.read(reader);
			const modelId = chatModelId ?? sessionModelId ?? selectedModel?.identifier;
			const model = modelId
				? provider?.getModels(session.sessionId).find(candidate => candidate.identifier === modelId)
					?? (selectedModel?.identifier === modelId ? selectedModel : undefined)
				: selectedModel;
			const metadataName = model?.metadata.name;
			const metadataLooksLikeIdentifier = !!metadataName && (metadataName.includes('/') || (!metadataName.includes(' ') && metadataName === metadataName.toLowerCase() && /[-_]/.test(metadataName)));
			const modelLabel = metadataName && !metadataLooksLikeIdentifier
				? metadataName
				: modelId
					? formatModelLabel(modelId)
					: localize('sessionChatIdentity.autoModel', "Auto");

			this._identityAgentElement.textContent = agentLabel;
			this._identityModelElement.textContent = modelLabel;
			this._identityElement.title = localize('sessionChatIdentity.tooltip', "This chat uses {0} with {1}", agentLabel, modelLabel);
			this._identityElement.setAttribute('aria-label', this._identityElement.title);
			this._identityElement.hidden = false;
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING)) {
				this._applyHistoryKey();
			}
		}));
	}

	private _buildStyles(active: boolean) {
		return {
			listForeground: active ? activeSessionViewForeground : inactiveSessionViewForeground,
			listBackground: active ? activeSessionViewBackground : inactiveSessionViewBackground,
			overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
			inputEditorBackground: inactiveSessionViewBackground,
			resultEditorBackground: agentsPanelBackground,
		};
	}

	/** The underlying chat widget. */
	get widget(): ChatWidget {
		return this._widget;
	}

	override setChat(chat: IChat, historyKey?: string): void {
		const resource = chat.resource;
		this._historyKey = historyKey;
		this._applyHistoryKey();

		// Skip loading if we're already showing this chat
		if (isEqual(this._currentChatResource, resource)) {
			return;
		}

		this._currentChatResource = resource;

		// Cancel any in-flight load for the previous chat and start a fresh one.
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const token = cts.token;

		const loadPromise = this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'ChatView').then(ref => {
			if (token.isCancellationRequested || !ref) {
				ref?.dispose();
				return;
			}
			this._modelRef.value = ref;
			this._updateWidgetLockState(getChatSessionType(ref.object.sessionResource));
			this._widget.setModel(ref.object);
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[ChatView] Failed to load chat model for chat', err);
			}
			if (resource === this._currentChatResource) { // might have changed while we were waiting, only reset if it is still the same
				this._currentChatResource = undefined;
			}
		});

		// Surface progress on this leaf's own bar while the chat model loads,
		// matching how each editor group shows progress independently. The short
		// delay avoids flashing the bar for fast cached loads.
		this.showProgressWhile(loadPromise, 800);
	}

	private _applyHistoryKey(): void {
		const scopedHistory = this.configurationService.getValue<boolean>(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING) !== false;
		this._widget.inputPart.setHistoryKey(scopedHistory ? this._historyKey : undefined);
	}

	private _updateWidgetLockState(sessionType: string): void {
		if (sessionType === localChatSessionType) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this._widget.lockToCodingAgent(contribution.name, contribution.displayName, sessionType, contribution.agentHostProviderId);
		} else {
			this._widget.unlockFromCodingAgent();
		}
	}

	override toJSON(): object {
		return { type: ChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(height, width);
	}

	override focus(): void {
		this._widget.focusInput();
	}

	override attach(uris: URI[]): void {
		for (const uri of uris) {
			this._widget.attachmentModel.addFile(uri).catch(err => this.logService.error('[ChatView] Failed to attach file as context', err));
		}
	}

	override setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		this._widget.setStyles(this._buildStyles(active));
	}
}

/**
 * Default {@link IChatViewFactory} implementation. Lives in the contrib
 * layer where the concrete views are defined and is registered as an eager
 * singleton via the entry point.
 */
export class ChatViewFactory implements IChatViewFactory {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	createNewChatView(isNewChatInSession: boolean, options: IChatViewOptions, instantiationService?: IInstantiationService): AbstractChatView {
		return (instantiationService ?? this.instantiationService).createInstance(NewChatView, isNewChatInSession, options);
	}

	createChatView(instantiationService?: IInstantiationService): AbstractChatView {
		return (instantiationService ?? this.instantiationService).createInstance(ChatView);
	}
}
