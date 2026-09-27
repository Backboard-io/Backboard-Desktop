/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../../workbench/contrib/chat/browser/widget/media/chatPanelCursorLook.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAgentCliSetupService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentCliSetup.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND } from '../../../../workbench/common/theme.js';
import { IWorkspacePickerDelegate, IWorkspacePickerItem } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IAgentHostNewSessionFolderService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostNewSessionFolderService.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { AgentSessionsHistoryModal } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsHistoryModal.js';
import { createBackboardSessionTypePickerDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/backboardSessionTypePickerDelegate.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { getChatSessionType, isUntitledChatSession } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { WorkspacePicker } from '../../../../sessions/contrib/chat/browser/sessionWorkspacePicker.js';
import { Event } from '../../../../base/common/event.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatAgentService } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IChatSessionsService, localChatSessionType, SessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISessionsService } from '../../../../sessions/services/sessions/browser/sessionsService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { localize } from '../../../../nls.js';
import { CanGoBackFromSubagentContext } from '../../../../sessions/common/contextkeys.js';
import { ChatResourceNavigationHistory } from '../../../../sessions/browser/parts/chatResourceNavigationHistory.js';
import { chatResourceNavigationRegistry, IChatResourceNavigationContext, IChatResourceNavigationParticipant } from '../../../../sessions/services/chatView/browser/chatResourceNavigationRegistry.js';

export const OptimusChatViewId = 'optimus.workbench.view.chat';

/**
 * The Optimus window's right panel: hosts a full chat for whichever grid card
 * is currently active. This intentionally uses the regular editor/panel
 * ChatWidget host instead of the Sessions/NewChatWidget onboarding surface so
 * model selection, send enablement, tools, and composer controls match Editor.
 */
export class OptimusChatViewPane extends ViewPane implements IChatResourceNavigationParticipant {

	private chatWidget: ChatWidget | undefined;
	private readonly historyModal = this._register(new MutableDisposable<AgentSessionsHistoryModal>());
	private chatNavigationElement: HTMLElement | undefined;
	private chatNavigationTitle: HTMLElement | undefined;
	private chatNavigationMeta: HTMLElement | undefined;
	private lastBodyWidth = 0;
	private lastBodyHeight = 0;
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly modelChangeListener = this._register(new MutableDisposable());
	private currentResourceKey: string | undefined;
	private resetComposerAfterSubmittedAgent = false;
	private readonly chatResourceHistory = new ChatResourceNavigationHistory();
	private readonly chatResourceContexts = new Map<string, IChatResourceNavigationContext>();
	private readonly canGoBackFromSubagentKey: IContextKey<boolean>;

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
		@IAgentHostNewSessionFolderService private readonly newSessionFolderService: IAgentHostNewSessionFolderService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentCliSetupService private readonly agentCliSetupService: IAgentCliSetupService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.canGoBackFromSubagentKey = CanGoBackFromSubagentContext.bindTo(contextKeyService);
		this.canGoBackFromSubagentKey.set(false);
		this._register(chatResourceNavigationRegistry.registerParticipant(this));
		this._register(toDisposable(() => {
			if (this.chatResourceHistory.canGoBack) {
				this.canGoBackFromSubagentKey.set(false);
			}
		}));
	}

	/**
	 * Folder chip in the composer: shows the folder the loaded chat operates
	 * on and, while composing a NEW chat, lets the user pick the folder the
	 * task will run in (bound to the untitled session so materialization
	 * lands there). The chip only renders in empty-workspace windows, so
	 * this is inherently Optimus-only.
	 */
	private workspacePicker: WorkspacePicker | undefined;

	private createWorkspacePickerDelegate(): IWorkspacePickerDelegate {
		const picker = assertReturnsDefined(this.workspacePicker);
		return {
			getWorkspaces: () => {
				const selected = this.getSelectedWorkspaceItem();
				return selected ? [selected] : [];
			},
			getSelectedWorkspace: () => this.getSelectedWorkspaceItem(),
			setSelectedWorkspace: workspace => {
				if (workspace) {
					picker.setSelectedWorkspace(workspace.uri);
				} else {
					picker.clearSelection();
				}
			},
			onDidChangeSelectedWorkspace: Event.map(picker.onDidSelectWorkspace, () => this.getSelectedWorkspaceItem()),
			onDidChangeWorkspaces: picker.onDidChangeSelection,
			openFolderCommand: 'workbench.action.files.openFolder',
		};
	}

	private getSelectedWorkspaceItem(): IWorkspacePickerItem | undefined {
		const selected = this.workspacePicker?.selectedResolved;
		const folder = selected?.workspace.folders[0];
		if (!selected || !folder) {
			return undefined;
		}
		return { uri: folder.root, label: selected.workspace.label, isFolder: true };
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
			const optimusCtx = this.contextKeyService.getContextKeyValue('isOptimusWindow');
			const workbenchState = this.workspaceContextService.getWorkbenchState();
			this.logService.info(`[OptimusDiag] ${context}: agents=${agents.length} defaultAgent=${defaultAgent?.id ?? 'NONE'} models=${modelIds.length} isOptimusWindowCtx=${optimusCtx} workbenchState=${workbenchState} pickerSelected=${this.workspacePicker?.selectedFolderUri?.toString() ?? 'none'}`);
		} catch (err) {
			this.logService.info(`[OptimusDiag] ${context}: failed to snapshot chat plumbing`, err);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Keep the Editor host hierarchy so its full panel styles apply, including
		// the recent-chat welcome surface and bottom-anchored composer.
		container.classList.add('optimus-chat-view', 'chat-viewpane');
		// Panel tokens key on this part class rather than a :has() on the part.
		const targetWindow = getWindow(container);
		targetWindow.requestAnimationFrame(() => container.closest('.part.auxiliarybar')?.classList.add('part-has-optimus-chat-view'));
		this._register(toDisposable(() => container.closest('.part.auxiliarybar')?.classList.remove('part-has-optimus-chat-view')));

		const header = append(container, $('.optimus-chat-folder-header'));
		this.folderRow = append(header, $('.optimus-chat-header-folder.new-session-workspace-picker-container'));
		const openHistory = () => {
			const modal = this.instantiationService.createInstance(AgentSessionsHistoryModal);
			this.historyModal.value = modal;
			modal.show({ excludeSubscriptionSessions: true, chatContainer: this.chatWidget?.domNode, openSession: resource => this.loadRootChatResource(resource) });
		};

		this.chatNavigationElement = append(container, $('.optimus-chat-navigation'));
		this.chatNavigationElement.hidden = true;
		this.chatNavigationElement.setAttribute('role', 'navigation');
		const backButton = append(this.chatNavigationElement, $('button.optimus-chat-back')) as HTMLButtonElement;
		backButton.type = 'button';
		backButton.ariaLabel = localize('optimus.backToMainThreadAriaLabel', 'Back to main thread');
		backButton.append(
			$('span.codicon.codicon-arrow-left', { 'aria-hidden': 'true' }),
			$('span.optimus-chat-back-label', undefined, localize('optimus.mainThread', 'Main thread')),
		);
		append(this.chatNavigationElement, $('span.optimus-chat-navigation-separator', { 'aria-hidden': 'true' }, '/'));
		const identity = append(this.chatNavigationElement, $('.optimus-chat-navigation-identity'));
		this.chatNavigationTitle = append(identity, $('.optimus-chat-navigation-title'));
		this.chatNavigationMeta = append(identity, $('.optimus-chat-navigation-meta'));
		this._register(addDisposableListener(backButton, EventType.CLICK, () => {
			void this.navigateToMainThread();
		}));

		this.workspacePicker = this._register(this.instantiationService.createInstance(WorkspacePicker));
		this.workspacePicker.setLocalOnly(true);
		this._register(this.workspacePicker.onDidSelectWorkspace(folderUri => {
			// Folder choice applies to the task being composed: bind it to the
			// untitled session so it materializes in that folder on first send.
			if (folderUri && this.currentResourceKey) {
				const resource = URI.parse(this.currentResourceKey);
				if (isUntitledChatSession(resource)) {
					this.newSessionFolderService.setFolder(resource, folderUri);
				}
			}
			this.chatWidget?.focusInput();
		}));

		const chatContainer = append(container, $('.optimus-chat-editor-host.backboard-chat-controls.backboard-clean-chat.backboard-composer'));
		this.chatWidget = this._register(this.instantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: OptimusChatViewId },
			{
				useBackboardPanelEmptyHome: true,
				panelEmptyHomeNavigation: { openSession: resource => this.loadRootChatResource(resource), openHistory },
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
				// Same pair as the Editor's chat view pane: `isSessionsWindow`
				// plus a delegate with `setActiveSessionProvider` is what swaps
				// the plain model picker for the Simple window's combined
				// provider+model chip. The mode picker it hides is the same trade
				// Simple makes — the chip's provider rail replaces it.
				isSessionsWindow: true,
				sessionTypePickerDelegate: createBackboardSessionTypePickerDelegate(
					() => this.chatWidget?.viewModel?.model.sessionResource,
					this.commandService,
					this.chatSessionsService,
					this.agentCliSetupService,
					() => (this.chatWidget?.viewModel?.model.getRequests().length ?? 0) === 0),
				supportsChangingModes: false,
				inputEditorMinLines: 2,
				workspacePickerDelegate: this.createWorkspacePickerDelegate(),
				dndContainer: container,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: SIDE_BAR_BACKGROUND,
				overlayBackground: SIDE_BAR_BACKGROUND,
				inputEditorBackground: SIDE_BAR_BACKGROUND,
				resultEditorBackground: SIDE_BAR_BACKGROUND,
			}
		));
		this.chatWidget.render(chatContainer);
		this.chatWidget.setVisible(this.isBodyVisible());

		this.workspacePicker.render(this.folderRow);

		// The folder locks in the moment the first message is committed. Remember
		// that this submission came from the launch composer before hiding the
		// chip: once the backend accepts it, Advanced resets this panel to a fresh
		// composer while the resulting task continues in its tile instead of
		// becoming a transcript here. (The first send converts the untitled chat
		// into a real session on a different model, so model-side checks can lag.)
		this._register(this.chatWidget.onDidAcceptInput(() => {
			if (this.folderRowVisible) {
				this.resetComposerAfterSubmittedAgent = true;
				this.folderRowVisible = false;
				if (this.folderRow) {
					this.folderRow.inert = true;
				}
				this.layoutChatView();
			}
		}));
		this._register(this.chatWidget.onDidSubmitAgent(() => {
			if (!this.resetComposerAfterSubmittedAgent) {
				return;
			}
			this.resetComposerAfterSubmittedAgent = false;
			this.showNewChat().then(() => {
				// Session materialization can apply the shared session layout while the
				// fresh model is loading. Reassert the Advanced launcher's open panel
				// only after that transition settles.
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			}).catch(err => this.logService.error('[OptimusChatViewPane] Failed to reset launch composer after submit', err));
		}));

		this._register(autorun(reader => {
			const active = this.sessionsService.activeSession.read(reader);
			const chat = active?.activeChat.read(reader);
			if (chat) {
				this.loadRootChatResource(chat.resource).catch(err => this.logService.error('[OptimusChatViewPane] Failed to load active chat', err));
			} else {
				this.showBackboardNewChat(CancellationToken.None).catch(err => this.logService.error('[OptimusChatViewPane] Failed to show new chat', err));
			}
		}));

		this._register(this.onDidChangeBodyVisibility(visible => this.chatWidget?.setVisible(visible)));
		// No explicit initial load: the active-session autorun above runs
		// immediately and either loads the active chat or shows the new-chat
		// composer. A second call here raced it, cancelling the first load
		// and leaving the widget without a model (sends then hang silently).
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyWidth = width;
		this.lastBodyHeight = height;
		this.layoutChatView();
	}

	private folderRow: HTMLElement | undefined;
	private folderRowVisible = false;

	private updateFolderRowVisibility(resource: URI | undefined): void {
		// Folder choice only makes sense before the chat has started: once a
		// request exists, the session's working directory is fixed. Converted
		// sessions keep their untitled resource, so the untitled check alone
		// is not sufficient.
		const model = this.modelRef.value?.object;
		const visible = !!resource && isUntitledChatSession(resource) && !(model && this.currentResourceKey === resource.toString() && model.hasRequests);
		if (visible === this.folderRowVisible) {
			return;
		}
		this.folderRowVisible = visible;
		if (this.folderRow) {
			this.folderRow.inert = !visible;
		}
		this.layoutChatView();
	}

	private layoutChatView(): void {
		if (this.chatWidget && this.lastBodyWidth > 0 && this.lastBodyHeight > 0) {
			const titleHeight = 34;
			const navigationHeight = this.chatResourceHistory.canGoBack ? 44 : 0;
			this.chatWidget.layout(Math.max(0, this.lastBodyHeight - titleHeight - navigationHeight), this.lastBodyWidth);
		}
	}

	override focus(): void {
		super.focus();
		this.chatWidget?.focusInput();
	}

	/**
	 * The blank chat currently offered by the composer. Untitled chats MUST
	 * use the `/untitled-<uuid>` path convention: that is what the chat
	 * session service's provider-free blank-session branch and the send-time
	 * conversion into a real backboard session key on. A bare `/untitled`
	 * path matches neither and hangs forever trying to load a nonexistent
	 * host session.
	 */
	private untitledResource: URI | undefined;

	private getOrCreateUntitledResource(): URI {
		// Reuse the current untitled chat while it is still what the panel is
		// showing (autorun re-entries, repeated New Task presses); mint a new
		// one after it was consumed by a send or replaced by a real session.
		if (!this.untitledResource || (this.currentResourceKey && this.currentResourceKey !== this.untitledResource.toString())) {
			this.untitledResource = URI.from({ scheme: SessionType.AgentHostBackboard, path: `/untitled-${generateUuid()}` });
		}
		return this.untitledResource;
	}

	/**
	 * Explicitly show a FRESH blank chat. The New Task action calls this
	 * directly: it cannot rely on clearing the active session alone, because
	 * when no session is active (e.g. right after closing chats) clearing it
	 * again changes nothing and the panel would stay on whatever it shows.
	 */
	async showNewChat(): Promise<void> {
		this.untitledResource = undefined; // mint a fresh blank chat
		await this.showBackboardNewChat(CancellationToken.None, true);
	}

	private async showBackboardNewChat(token: CancellationToken, forceNew = false): Promise<void> {
		const resource = (!forceNew ? this.sessionsService.activeSession.get()?.activeChat.get().resource : undefined) ?? this.getOrCreateUntitledResource();

		// The untitled chat's provisional backend needs a working directory —
		// loading can hang indefinitely without one. Seed it BEFORE the load
		// (the composer's folder chip drives it afterwards): the user's picker
		// selection, else the last active session's folder.
		if (isUntitledChatSession(resource) && !this.newSessionFolderService.getFolder(resource)) {
			const folder = this.workspacePicker?.selectedFolderUri
				?? this.sessionsService.activeSession.get()?.workspace.get()?.folders[0]?.workingDirectory;
			if (folder) {
				this.newSessionFolderService.setFolder(resource, folder);
				this.workspacePicker?.setSelectedWorkspace(folder);
			}
		}

		await this.loadRootChatResource(resource, token);
	}

	private async loadRootChatResource(resource: URI, token: CancellationToken = CancellationToken.None): Promise<void> {
		await this.loadChatResource(resource, token);
		if (!token.isCancellationRequested && this.currentResourceKey === resource.toString()) {
			this.resetChatResourceNavigation();
		}
	}

	canHandleChatResource(parentSessionResource: URI): boolean {
		const currentResource = this.currentResourceKey ? URI.parse(this.currentResourceKey) : undefined;
		return !!currentResource && (
			isEqual(currentResource, parentSessionResource)
			|| (!!this.chatResourceHistory.root && isEqual(this.chatResourceHistory.root, parentSessionResource))
		);
	}

	async openChatResource(parentSessionResource: URI, chatResource: URI, context?: IChatResourceNavigationContext): Promise<boolean> {
		if (!this.canHandleChatResource(parentSessionResource) || !this.currentResourceKey) {
			return false;
		}

		const previousResource = URI.parse(this.currentResourceKey);
		await this.loadChatResource(chatResource);
		if (this.currentResourceKey !== chatResource.toString()) {
			return false;
		}

		this.chatResourceHistory.recordOpen(previousResource, chatResource);
		if (context) {
			this.chatResourceContexts.set(chatResource.toString(), context);
		}
		this.updateChatResourceNavigation();
		this.chatWidget?.focusInput();
		return true;
	}

	async navigateBack(parentSessionResource: URI): Promise<boolean> {
		const previousResource = this.chatResourceHistory.previous;
		if (!previousResource || !this.canHandleChatResource(parentSessionResource)) {
			return false;
		}

		await this.loadChatResource(previousResource);
		if (this.currentResourceKey !== previousResource.toString()) {
			return false;
		}

		this.chatResourceHistory.commitBack();
		this.updateChatResourceNavigation();
		return true;
	}

	private async navigateToMainThread(): Promise<void> {
		const rootResource = this.chatResourceHistory.root;
		if (!rootResource) {
			return;
		}

		await this.loadChatResource(rootResource);
		if (this.currentResourceKey === rootResource.toString()) {
			this.resetChatResourceNavigation();
			this.chatWidget?.focusInput();
		}
	}

	private resetChatResourceNavigation(): void {
		this.chatResourceHistory.reset();
		this.chatResourceContexts.clear();
		this.updateChatResourceNavigation();
	}

	private updateChatResourceNavigation(): void {
		const canGoBack = this.chatResourceHistory.canGoBack;
		if (this.chatNavigationElement) {
			this.chatNavigationElement.hidden = !canGoBack;
		}
		this.canGoBackFromSubagentKey.set(canGoBack);
		if (canGoBack && this.currentResourceKey && this.chatNavigationElement && this.chatNavigationTitle && this.chatNavigationMeta) {
			const context = this.chatResourceContexts.get(this.currentResourceKey);
			const title = context?.title.trim() || localize('optimus.subagentChat', 'Subagent chat');
			const meta = [context?.agentName?.trim(), context?.status?.trim()].filter((value): value is string => !!value).join(' · ');
			this.chatNavigationTitle.textContent = title;
			this.chatNavigationTitle.title = title;
			this.chatNavigationMeta.textContent = meta || localize('optimus.subagent', 'Subagent');
			this.chatNavigationElement.ariaLabel = localize('optimus.openSubagentContext', 'Main thread, subagent: {0}', title);
		}
		this.layoutChatView();
	}

	private async loadChatResource(resource: URI, token: CancellationToken = CancellationToken.None): Promise<void> {
		if (this.currentResourceKey === resource.toString() && this.modelRef.value) {
			this.layoutChatView();
			this.chatWidget?.focusInput();
			return;
		}

		this.logService.info(`[OptimusDiag] pane loading ${resource.toString()}`);
		this.logChatPlumbing('pane pre-load');
		this.updateFolderRowVisibility(resource);

		this.loadCts.value?.cancel();
		const cts = token === CancellationToken.None ? new CancellationTokenSource() : undefined;
		this.loadCts.value = cts;
		const effectiveToken = cts?.token ?? token;
		this.modelRef.value = undefined;

		try {
			await this.updateWidgetLockState(getChatSessionType(resource));
			this.logService.info(`[OptimusDiag] pane lock state resolved for ${resource.toString()}, acquiring session`);
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

		// Re-evaluate the folder chip when the chat gains its first request
		// (folder choice is fixed from that point on).
		this.modelChangeListener.value = ref ? ref.object.onDidChange(() => this.updateFolderRowVisibility(ref.object.sessionResource)) : undefined;
		this.updateFolderRowVisibility(ref?.object.sessionResource);
		this.chatWidget?.setModel(ref?.object);

		// Reflect the loaded chat's folder in the composer's folder chip; for
		// untitled chats the chip keeps the user's (or last) selection, which
		// becomes the new task's folder.
		const resource = ref?.object.sessionResource;
		if (resource && !isUntitledChatSession(resource)) {
			const folder = this.sessionsService.activeSession.get()?.workspace.get()?.folders[0]?.workingDirectory;
			if (folder) {
				this.workspacePicker?.setSelectedWorkspace(folder);
			}
		}

		this.layoutChatView();
		this.chatWidget?.focusInput();
	}
}
