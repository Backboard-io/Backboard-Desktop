/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
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
import { IWorkspacePickerDelegate, IWorkspacePickerItem } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IAgentHostNewSessionFolderService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostNewSessionFolderService.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
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
	private readonly modelChangeListener = this._register(new MutableDisposable());
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
		@IAgentHostNewSessionFolderService private readonly newSessionFolderService: IAgentHostNewSessionFolderService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
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

		container.classList.add('optimus-chat-view');

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
				workspacePickerDelegate: this.createWorkspacePickerDelegate(),
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

		// Visible folder chip under the composer: shows/picks the folder the
		// composed task runs in. (The composer toolbar's own workspace-picker
		// slot is a hidden dropdown anchor by design, so the chip is rendered
		// here as its own row, like the Simple window's new-chat surface.)
		this.folderRow = append(container, $('.optimus-chat-folder-row'));
		this.workspacePicker.render(this.folderRow);
		// Folder choice only applies to NEW chats — an existing session's
		// working directory is fixed at creation. Hidden until the untitled
		// composer is showing (see updateFolderRowVisibility).
		this.folderRow.style.display = 'none';

		// The folder locks in the moment the first message is committed —
		// hide the chip at send time. (The model-side hasRequests check can
		// lag: the first send converts the untitled chat into a real session
		// on a different model, so our model's change event never fires.)
		this._register(this.chatWidget.onDidAcceptInput(() => {
			if (this.folderRowVisible) {
				this.folderRowVisible = false;
				if (this.folderRow) {
					this.folderRow.style.display = 'none';
				}
				this.layoutChatView();
			}
		}));

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

	/** Height of the folder row under the composer (see optimusGridPart.css). */
	private static readonly FOLDER_ROW_HEIGHT = 30;

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
			this.folderRow.style.display = visible ? '' : 'none';
		}
		this.layoutChatView();
	}

	private layoutChatView(): void {
		if (this.chatWidget && this.lastBodyWidth > 0 && this.lastBodyHeight > 0) {
			const rowHeight = this.folderRowVisible ? OptimusChatViewPane.FOLDER_ROW_HEIGHT : 0;
			this.chatWidget.layout(this.lastBodyHeight - rowHeight, this.lastBodyWidth);
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
		await this.showBackboardNewChat(CancellationToken.None);
	}

	private async showBackboardNewChat(token: CancellationToken): Promise<void> {
		const resource = this.sessionsService.activeSession.get()?.activeChat.get().resource ?? this.getOrCreateUntitledResource();

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

		await this.loadChatResource(resource, token);
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
