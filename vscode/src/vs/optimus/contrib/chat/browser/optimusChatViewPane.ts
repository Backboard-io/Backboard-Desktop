/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { SIDE_BAR_FOREGROUND } from '../../../../workbench/common/theme.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IChatSessionsService, localChatSessionType, SessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { getChatSessionType } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { ISessionsService } from '../../../../sessions/services/sessions/browser/sessionsService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const OptimusChatViewId = 'optimus.workbench.view.chat';

/**
 * The Optimus window's right panel: hosts a full chat for whichever grid card
 * is currently active. This intentionally uses the regular editor/panel
 * ChatWidget host instead of the Sessions/NewChatWidget onboarding surface so
 * model selection, send enablement, tools, and composer controls match Editor.
 */
export class OptimusChatViewPane extends ViewPane {

	private chatWidget: ChatWidget | undefined;
	private lastBodyWidth = 0;
	private lastBodyHeight = 0;
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private currentResourceKey: string | undefined;

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
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	/**
	 * Diagnostic snapshot of the chat plumbing this pane depends on: which
	 * chat agents are registered (is there a default?), and which language
	 * models exist. Both empty is the signature of the window being treated
	 * as an editor window / the agent host root config not having arrived.
	 */
	private logChatPlumbing(context: string): void {
		try {
			const agents = this.chatAgentService.getAgents();
			const defaultAgent = this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat);
			const modelIds = this.languageModelsService.getLanguageModelIds();
			this.logService.info(`[OptimusDiag] ${context}: agents=${agents.length} [${agents.slice(0, 8).map(a => `${a.id}${a.isDefault ? '*' : ''}`).join(', ')}] defaultAgent=${defaultAgent?.id ?? 'NONE'} models=${modelIds.length} [${modelIds.slice(0, 8).join(', ')}]`);
		} catch (err) {
			this.logService.info(`[OptimusDiag] ${context}: failed to snapshot chat plumbing`, err);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('optimus-chat-view');

		const chatContainer = append(container, $('.optimus-chat-editor-host'));
		this.chatWidget = this._register(this.instantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: OptimusChatViewId },
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				clear: () => this.showBackboardNewChat(CancellationToken.None),
				rendererOptions: {
					renderTextEditsAsSummary: () => true,
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				dndContainer: container,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: editorBackground,
				overlayBackground: editorBackground,
				inputEditorBackground: editorBackground,
				resultEditorBackground: editorBackground,
			}
		));
		this.chatWidget.render(chatContainer);
		this.chatWidget.setVisible(this.isBodyVisible());

		this._register(autorun(reader => {
			const active = this.sessionsService.activeSession.read(reader);
			const chat = active?.activeChat.read(reader);
			if (chat) {
				this.loadChatResource(chat.resource).catch(err => this.logService.error('[OptimusChatViewPane] Failed to load active chat', err));
			} else {
				this.showBackboardNewChat(CancellationToken.None).catch(err => this.logService.error('[OptimusChatViewPane] Failed to show new chat', err));
			}
		}));

		this._register(this.onDidChangeBodyVisibility(visible => this.chatWidget?.setVisible(visible)));
		this.showBackboardNewChat(CancellationToken.None).catch(err => this.logService.error('[OptimusChatViewPane] Failed to initialize new chat', err));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyWidth = width;
		this.lastBodyHeight = height;
		this.layoutChatView();
	}

	private layoutChatView(): void {
		if (this.chatWidget && this.lastBodyWidth > 0 && this.lastBodyHeight > 0) {
			this.chatWidget.layout(this.lastBodyHeight, this.lastBodyWidth);
		}
	}

	override focus(): void {
		super.focus();
		this.chatWidget?.focusInput();
	}

	private async showBackboardNewChat(token: CancellationToken): Promise<void> {
		await this.loadChatResource(this.sessionsService.activeSession.get()?.activeChat.get().resource ?? URI.from({ scheme: SessionType.AgentHostBackboard, path: '/untitled' }), token);
	}

	private async loadChatResource(resource: URI, token: CancellationToken = CancellationToken.None): Promise<void> {
		if (this.currentResourceKey === resource.toString() && this.modelRef.value) {
			this.layoutChatView();
			this.chatWidget?.focusInput();
			return;
		}

		this.logService.info(`[OptimusDiag] pane loading ${resource.toString()}`);
		this.logChatPlumbing('pane pre-load');

		this.loadCts.value?.cancel();
		const cts = token === CancellationToken.None ? new CancellationTokenSource() : undefined;
		this.loadCts.value = cts;
		const effectiveToken = cts?.token ?? token;
		this.modelRef.value = undefined;

		try {
			await this.updateWidgetLockState(getChatSessionType(resource));
			const ref = await this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, effectiveToken, 'OptimusChatViewPane#loadChatResource');
			if (effectiveToken.isCancellationRequested) {
				this.logService.info(`[OptimusDiag] pane load CANCELLED for ${resource.toString()}`);
				ref?.dispose();
				return;
			}

			this.logService.info(`[OptimusDiag] pane load ${ref ? `OK requests=${ref.object.getRequests().length}` : 'returned NO MODEL'} for ${resource.toString()}`);
			this.logChatPlumbing('pane post-load');
			this.setModelRef(ref);
			this.currentResourceKey = resource.toString();
		} catch (error) {
			if (!effectiveToken.isCancellationRequested) {
				this.logService.error(`[OptimusDiag] pane load FAILED for ${resource.toString()}`, error);
				this.chatWidget?.setModel(undefined);
				this.currentResourceKey = undefined;
				throw error;
			}
		}
	}

	private async updateWidgetLockState(sessionType: string): Promise<void> {
		if (!this.chatWidget) {
			return;
		}

		if (sessionType === localChatSessionType) {
			this.chatWidget.unlockFromCodingAgent();
			return;
		}

		let canResolve = false;
		try {
			canResolve = await this.chatSessionsService.canResolveChatSession(sessionType);
		} catch (error) {
			this.logService.warn(`[OptimusChatViewPane] Failed to resolve chat session type '${sessionType}' for locking`, error);
		}

		if (!canResolve) {
			this.chatWidget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this.chatWidget.lockToCodingAgent(contribution.name, contribution.displayName, sessionType, contribution.agentHostProviderId);
		} else {
			this.chatWidget.unlockFromCodingAgent();
		}
	}

	private setModelRef(ref: IChatModelReference | undefined): void {
		const previous = this.modelRef.value;
		if (previous === ref) {
			return;
		}

		this.modelRef.value = ref;
		previous?.dispose();
		this.currentResourceKey = ref?.object.sessionResource.toString();
		this.chatWidget?.setModel(ref?.object);
		this.layoutChatView();
		this.chatWidget?.focusInput();
	}
}
