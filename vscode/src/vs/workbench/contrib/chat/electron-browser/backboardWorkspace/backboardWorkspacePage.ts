/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/backboardWorkspace.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventHelper, EventType, reset } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { fromNow } from '../../../../../base/common/date.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { editorBackground, editorForeground, inputBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../common/theme.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHostNewSessionFolderService } from '../../browser/agentSessions/agentHost/agentHostNewSessionFolderService.js';
import { AgentSessionStatus, getAgentChangesSummary, IAgentSession } from '../../browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../browser/agentSessions/agentSessionsService.js';
import { ChatWidget } from '../../browser/widget/chatWidget.js';
import { IChatModelReference, IChatService } from '../../common/chatService/chatService.js';
import { IChatSessionFileChange, IChatSessionFileChange2, IChatSessionsService, localChatSessionType, SessionType } from '../../common/chatSessionsService.js';
import { ChatAgentLocation, ChatModeKind, getDefaultNewChatSessionResource } from '../../common/constants.js';
import type { IChatModel } from '../../common/model/chatModel.js';
import { getChatSessionType } from '../../common/model/chatUri.js';
import { BACKBOARD_WORKSPACE_SURFACE_ID } from './backboardWorkspaceConstants.js';

export class BackboardWorkspacePage extends Disposable {

	static readonly ID = BACKBOARD_WORKSPACE_SURFACE_ID;

	private container: HTMLElement | undefined;
	private pageElement: HTMLElement | undefined;
	private cardsContainer: HTMLElement | undefined;
	private countElement: HTMLElement | undefined;
	private detailElement: HTMLElement | undefined;
	private detailTitleElement: HTMLElement | undefined;
	private detailSubtitleElement: HTMLElement | undefined;
	private detailNewButton: HTMLButtonElement | undefined;
	private chatContainer: HTMLElement | undefined;
	private chatWidget: ChatWidget | undefined;
	private workspaceSwitcherButton: HTMLButtonElement | undefined;
	private workspaceSwitcherLabel: HTMLElement | undefined;
	private selectedWorkspaceFilter: string | undefined;
	private dimension = new Dimension(0, 0);
	private selectedSessionResource: URI | undefined;
	private targetWorkspaceUri: URI | undefined;
	private defaultWorkspacePromise: Promise<URI> | undefined;

	private readonly cardDisposables = this._register(new DisposableStore());
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly loadSessionCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly outputPreviewByResource = new Map<string, string>();
	private readonly outputPreviewLoads = new Set<string>();
	private readonly outputPreviewStores = new Map<string, DisposableStore>();
	private readonly modelByResource = new Map<string, IChatModel>();
	private readonly modelIdByResource = new Map<string, string>();
	private readonly cardReplyDraftByResource = new Map<string, string>();
	private readonly deletedSessionResources = new Set<string>();
	private readonly outputPreviewRenderScheduler = this._register(new RunOnceScheduler(() => this.renderSessions(), 100));

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IAgentHostNewSessionFolderService private readonly newSessionFolderService: IAgentHostNewSessionFolderService,
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();

		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.renderSessions()));
		this._register({
			dispose: () => {
				for (const store of this.outputPreviewStores.values()) {
					store.dispose();
				}
				this.outputPreviewStores.clear();
				this.modelByResource.clear();
				this.modelIdByResource.clear();
				this.cardReplyDraftByResource.clear();
			}
		});
	}

	create(parent: HTMLElement): void {
		this.container = append(parent, $('.backboard-workspace-editor'));
		this.container.tabIndex = 0;

		const page = append(this.container, $('.backboard-workspace-page'));
		this.pageElement = page;
		const main = append(page, $('.backboard-workspace-main'));

		const toolbar = append(main, $('.backboard-workspace-toolbar'));
		const heading = append(toolbar, $('.backboard-workspace-heading'));

		// Workspace switcher button
		this.workspaceSwitcherButton = append(heading, $('button.backboard-workspace-switcher'));
		this.workspaceSwitcherButton.type = 'button';
		const switcherIcon = append(this.workspaceSwitcherButton, $('span.codicon.codicon-folder'));
		switcherIcon.setAttribute('aria-hidden', 'true');
		this.workspaceSwitcherLabel = append(this.workspaceSwitcherButton, $('span'));
		this.workspaceSwitcherLabel.textContent = localize('backboardWorkspaceAllWorkspaces', "All Workspaces");
		this.workspaceSwitcherButton.title = localize('backboardWorkspaceSwitcherTitle', "Switch workspace");
		this.workspaceSwitcherButton.setAttribute('aria-label', this.workspaceSwitcherButton.title);
		this.cardDisposables.add(addDisposableListener(this.workspaceSwitcherButton, EventType.CLICK, (e) => {
			EventHelper.stop(e);
			this.showWorkspaceSwitcherMenu(this.workspaceSwitcherButton!);
		}));

		const titleRow = append(heading, $('.backboard-workspace-title-row'));
		append(titleRow, $('h1')).textContent = localize('backboardWorkspaceTitle', "Agent Workspace");
		this.countElement = append(titleRow, $('.backboard-workspace-count'));

		const actions = append(toolbar, $('.backboard-workspace-actions'));
		this.createToolbarButton(actions, 'codicon-refresh', localize('backboardWorkspaceRefresh', "Refresh"), () => {
			void this.agentSessionsService.model.resolve(undefined);
		});
		this.createToolbarButton(actions, 'codicon-add', localize('backboardWorkspaceNewAgent', "New Agent"), () => {
			void this.openNewAgentSession();
		});

		this.cardsContainer = append(main, $('.backboard-workspace-cards'));

		const detail = append(page, $('.backboard-workspace-detail'));
		this.detailElement = detail;
		const detailHeader = append(detail, $('.backboard-workspace-detail-header'));
		const detailTitleRow = append(detailHeader, $('.backboard-workspace-detail-title-row'));
		const detailIcon = append(detailTitleRow, $('.backboard-workspace-detail-icon.codicon.codicon-backboard-logo'));
		detailIcon.setAttribute('aria-hidden', 'true');
		this.detailTitleElement = append(detailTitleRow, $('h2'));
		this.detailSubtitleElement = append(detailHeader, $('.backboard-workspace-detail-subtitle'));

		// "New" button in detail header — always spawns a fresh chat
		this.detailNewButton = append(detailHeader, $('button.backboard-workspace-detail-new-button')) as HTMLButtonElement;
		this.detailNewButton.type = 'button';
		const newIcon = append(this.detailNewButton, $('span.codicon.codicon-add'));
		newIcon.setAttribute('aria-hidden', 'true');
		append(this.detailNewButton, $('span')).textContent = localize('backboardWorkspaceDetailNew', "New");
		this.detailNewButton.title = localize('backboardWorkspaceDetailNewTitle', "Start a new agent chat");
		this.detailNewButton.setAttribute('aria-label', this.detailNewButton.title);
		this.cardDisposables.add(addDisposableListener(this.detailNewButton, EventType.CLICK, () => {
			void this.openNewAgentSession();
		}));

		this.chatContainer = append(detail, $('.backboard-workspace-detail-chat'));

		this.createChatWidget(detail);
		void this.ensureWorkspaceUri().then(() => {
			this.renderSessions();
			// Auto-open a new agent session so the detail/chat panel is
			// immediately visible and functional instead of hidden behind
			// the "no-detail" state.
			if (!this.modelRef.value) {
				void this.openNewAgentSession();
			}
		}, error => {
			this.logService.error('[BackboardWorkspacePage] Failed to initialize default workspace folder', error);
		});
		this.renderSessions();
		this.updateDetailHeader(undefined);
		this.updateWorkspaceDetailState();
	}

	focus(): void {
		this.container?.focus({ preventScroll: true });
	}

	revealTop(): void {
		if (this.container) {
			this.container.scrollTop = 0;
		}
		if (this.pageElement) {
			this.pageElement.scrollTop = 0;
		}
		if (this.cardsContainer) {
			this.cardsContainer.scrollTop = 0;
		}
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.container?.style.setProperty('width', `${dimension.width}px`);
		this.container?.style.setProperty('height', `${dimension.height}px`);
		this.layoutChatWidget();
	}

	private createChatWidget(detailElement: HTMLElement): void {
		if (!this.chatContainer) {
			return;
		}

		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.chatContainer));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService],
		)));

		this.chatWidget = this._register(scopedInstantiationService.createInstance(
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
				dndContainer: detailElement,
			},
			{
				listForeground: editorForeground,
				listBackground: editorBackground,
				overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
				inputEditorBackground: inputBackground,
				resultEditorBackground: editorBackground,
			},
		));
		this.chatWidget.render(this.chatContainer);
		this.chatWidget.setVisible(true);

		this._register(this.chatWidget.onDidChangeViewModel(event => {
			if (event.currentSessionResource && this.isBackboardSessionType(getChatSessionType(event.currentSessionResource)) && !isEqual(this.selectedSessionResource, event.currentSessionResource)) {
				this.selectedSessionResource = event.currentSessionResource;
				this.renderSessions();
			}
		}));
	}

	private createToolbarButton(parent: HTMLElement, iconClass: string, label: string, handler: () => void): HTMLButtonElement {
		const button = append(parent, $('button.backboard-workspace-icon-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		const icon = append(button, $(`span.codicon.${iconClass}`));
		icon.setAttribute('aria-hidden', 'true');
		this._register(addDisposableListener(button, EventType.CLICK, handler));
		return button;
	}

	private renderSessions(): void {
		if (!this.cardsContainer) {
			return;
		}

		const previousScrollTop = this.cardsContainer.scrollTop;
		this.cardDisposables.clear();
		clearNode(this.cardsContainer);

		const sessions = this.getBackboardSessions();
		this.disposeStaleOutputPreviews(sessions);
		if (this.countElement) {
			this.countElement.textContent = sessions.length === 1
				? localize('backboardWorkspaceOneAgent', "1 agent")
				: localize('backboardWorkspaceManyAgents', "{0} agents", sessions.length);
		}

		if (this.selectedSessionResource && !sessions.some(session => isEqual(session.resource, this.selectedSessionResource))) {
			this.selectedSessionResource = undefined;
		}

		if (!sessions.length) {
			this.renderEmptyState(this.cardsContainer);
			return;
		}

		for (const session of sessions) {
			this.renderSessionCard(this.cardsContainer, session);
		}

		this.cardsContainer.scrollTop = previousScrollTop;
	}

	private renderEmptyState(parent: HTMLElement): void {
		const empty = append(parent, $('.backboard-workspace-empty'));
		const mark = append(empty, $('.codicon.codicon-backboard-logo'));
		mark.setAttribute('aria-hidden', 'true');
		append(empty, $('h2')).textContent = localize('backboardWorkspaceEmptyTitle', "No agent sessions yet");
		append(empty, $('p')).textContent = localize('backboardWorkspaceEmptyDescription', "Start a Backboard agent and it will show up here.");
		const button = append(empty, $('button.backboard-workspace-primary-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('backboardWorkspaceEmptyNewAgent', "New Agent");
		this.cardDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
			void this.openNewAgentSession();
		}));
	}

	private renderSessionCard(parent: HTMLElement, session: IAgentSession): void {
		const selected = this.selectedSessionResource ? isEqual(session.resource, this.selectedSessionResource) : false;
		const card = append(parent, $('.backboard-workspace-card')) as HTMLDivElement;
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.classList.toggle('selected', selected);
		card.classList.toggle('running', session.status === AgentSessionStatus.InProgress);
		card.setAttribute('aria-pressed', String(selected));
		this.queueSessionOutputPreview(session);

		// Header: status dot + name + status pill
		const header = append(card, $('.backboard-workspace-card-header'));
		const title = append(header, $('.backboard-workspace-card-title'));
		append(title, $(`span.backboard-workspace-status-dot.${this.getStatusClass(session.status)}`));
		append(title, $('span.backboard-workspace-card-name')).textContent = session.label;

		const headerActions = append(header, $('.backboard-workspace-card-actions'));
		append(headerActions, $(`span.backboard-workspace-status-pill.${this.getStatusClass(session.status)}`)).textContent = this.getStatusLabel(session.status);
		const overflow = append(headerActions, $('button.backboard-workspace-card-menu')) as HTMLButtonElement;
		overflow.type = 'button';
		overflow.title = localize('backboardWorkspaceDeleteAgent', "Delete Agent");
		overflow.setAttribute('aria-label', localize('backboardWorkspaceDeleteAgent', "Delete Agent"));
		append(overflow, $('span.codicon.codicon-close')).setAttribute('aria-hidden', 'true');
		this.cardDisposables.add(addDisposableListener(overflow, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void this.deleteSession(session);
		}));

		// Body: description + output preview + activity
		const content = append(card, $('.backboard-workspace-card-content'));
		const outputPreview = this.getCachedOutputPreview(session);
		const description = this.getCardDescription(session);
		if (description) {
			append(content, $('.backboard-workspace-card-description')).textContent = description;
		}

		if (selected) {
			this.renderSelectedCardChat(content, session, outputPreview);
		} else if (outputPreview) {
			const output = append(content, $('.backboard-workspace-card-output'));
			output.textContent = outputPreview;
		}

		const activity = append(content, $('.backboard-workspace-card-activity'));
		this.renderActivityRows(activity, session);

		const files = this.getChangedFileLabels(session);
		if (files.length) {
			const fileRow = append(content, $('.backboard-workspace-card-files'));
			for (const file of files.slice(0, 3)) {
				append(fileRow, $('span')).textContent = file;
			}
			if (files.length > 3) {
				append(fileRow, $('span')).textContent = localize('backboardWorkspaceMoreFiles', "+{0}", files.length - 3);
			}
		}

		this.cardDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
			void this.openExistingSession(session);
		}));
		this.cardDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				EventHelper.stop(event, true);
				void this.openExistingSession(session);
			}
		}));
	}

	private renderSelectedCardChat(parent: HTMLElement, session: IAgentSession, fallbackPreview: string | undefined): void {
		const chat = append(parent, $('.backboard-workspace-card-chat'));
		const transcript = append(chat, $('.backboard-workspace-card-transcript'));
		const model = this.modelByResource.get(session.resource.toString());
		const messages = model ? this.getCompactTranscript(model) : [];

		if (messages.length) {
			for (const message of messages) {
				const row = append(transcript, $(`div.backboard-workspace-card-message.${message.kind}`));
				append(row, $('.backboard-workspace-card-message-label')).textContent = message.label;
				append(row, $('.backboard-workspace-card-message-text')).textContent = message.text;
			}
		} else if (fallbackPreview) {
			const row = append(transcript, $('.backboard-workspace-card-message.agent'));
			append(row, $('.backboard-workspace-card-message-label')).textContent = session.providerLabel;
			append(row, $('.backboard-workspace-card-message-text')).textContent = fallbackPreview;
		} else {
			const empty = append(transcript, $('.backboard-workspace-card-chat-empty'));
			empty.textContent = localize('backboardWorkspaceCardChatEmpty', "No messages loaded yet.");
		}

		const composer = append(chat, $('.backboard-workspace-card-composer'));
		const input = append(composer, $('textarea.backboard-workspace-card-input')) as HTMLTextAreaElement;
		const key = session.resource.toString();
		input.rows = 2;
		input.value = this.cardReplyDraftByResource.get(key) ?? '';
		input.placeholder = localize('backboardWorkspaceCardReplyPlaceholder', "Reply to this agent...");
		input.setAttribute('aria-label', localize('backboardWorkspaceCardReplyAria', "Reply to this agent"));

		const send = append(composer, $('button.backboard-workspace-card-send')) as HTMLButtonElement;
		send.type = 'button';
		send.title = localize('backboardWorkspaceCardSend', "Send");
		send.setAttribute('aria-label', localize('backboardWorkspaceCardSend', "Send"));
		append(send, $('.codicon.codicon-arrow-up')).setAttribute('aria-hidden', 'true');

		const updateSendState = () => {
			send.disabled = !input.value.trim();
		};
		updateSendState();

		const submit = () => {
			void this.submitCardReply(session, input);
		};

		this.cardDisposables.add(addDisposableListener(input, EventType.MOUSE_DOWN, event => event.stopPropagation()));
		this.cardDisposables.add(addDisposableListener(input, EventType.CLICK, event => event.stopPropagation()));
		this.cardDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
			const value = input.value;
			if (value) {
				this.cardReplyDraftByResource.set(key, value);
			} else {
				this.cardReplyDraftByResource.delete(key);
			}
			updateSendState();
		}));
		this.cardDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' && !event.shiftKey) {
				EventHelper.stop(event, true);
				submit();
			}
		}));
		this.cardDisposables.add(addDisposableListener(send, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			submit();
		}));
	}

	private getCompactTranscript(model: IChatModel): { kind: 'user' | 'agent'; label: string; text: string }[] {
		const messages: { kind: 'user' | 'agent'; label: string; text: string }[] = [];
		for (const request of model.getRequests().slice(-2)) {
			const requestText = this.normalizeOutputPreview(request.message.text);
			if (requestText) {
				messages.push({ kind: 'user', label: localize('backboardWorkspaceCardUserLabel', "You"), text: requestText });
			}

			const responseText = this.normalizeOutputPreview(request.response?.response.getFinalResponse())
				?? this.normalizeOutputPreview(request.response?.response.getMarkdown());
			if (responseText) {
				messages.push({ kind: 'agent', label: localize('backboardWorkspaceCardAgentLabel', "Backboard"), text: responseText });
			}
		}
		return messages.slice(-4);
	}

	private async submitCardReply(session: IAgentSession, input: HTMLTextAreaElement): Promise<void> {
		const value = input.value.trim();
		if (!value || !this.chatWidget) {
			return;
		}

		if (!this.selectedSessionResource || !isEqual(this.selectedSessionResource, session.resource) || !this.modelRef.value) {
			await this.openExistingSession(session);
		}

		await this.chatWidget.acceptInput(value, { preserveFocus: true, storeToHistory: true });
		this.cardReplyDraftByResource.delete(session.resource.toString());
		input.value = '';
		this.renderSessions();
	}

	private async deleteSession(session: IAgentSession): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			message: localize('backboardWorkspaceDeleteAgentConfirm', "Are you sure you want to delete this agent?"),
			detail: localize('backboardWorkspaceDeleteAgentDetail', "This action cannot be undone."),
			primaryButton: localize('backboardWorkspaceDeleteAgentButton', "Delete")
		});

		if (!confirmed.confirmed) {
			return;
		}

		try {
			await this.resolveSessionItem(session, CancellationToken.None);
			await this.chatSessionsService.deleteChatSessionItem(session.resource, CancellationToken.None);
			this.deletedSessionResources.add(session.resource.toString());
			session.setArchived(true);
			this.disposeSessionOutputPreview(session.resource.toString());
			if (this.selectedSessionResource && isEqual(this.selectedSessionResource, session.resource)) {
				this.selectedSessionResource = undefined;
				this.modelRef.clear();
				this.chatWidget?.setModel(undefined);
				this.updateDetailHeader(undefined);
				this.updateWorkspaceDetailState();
			}
			this.renderSessions();
			void this.agentSessionsService.model.resolve(session.providerType);
		} catch (error) {
			this.dialogService.error(localize('backboardWorkspaceDeleteAgentError', "Failed to delete agent: {0}", toErrorMessage(error)));
		}
	}

	private renderActivityRows(parent: HTMLElement, session: IAgentSession): void {
		const summary = getAgentChangesSummary(session.changes);
		const updatedAt = this.getSessionActivityTime(session);

		this.renderActivityRow(parent, this.getActivityIcon(session, summary), updatedAt ? fromNow(updatedAt, true) : '', this.getActivityText(session, summary));

		if (summary) {
			this.renderActivityRow(
				parent,
				'codicon-diff',
				'',
				summary.files === 1
					? localize('backboardWorkspaceOneFileChanged', "1 file changed")
					: localize('backboardWorkspaceFilesChanged', "{0} files changed", summary.files),
			);
		}
	}

	private renderActivityRow(parent: HTMLElement, iconClass: string, timestamp: string, label: string): void {
		const row = append(parent, $('.backboard-workspace-activity-row'));
		append(row, $(`span.codicon.${iconClass}`)).setAttribute('aria-hidden', 'true');
		if (timestamp) {
			append(row, $('span.backboard-workspace-activity-time')).textContent = timestamp;
		}
		append(row, $('span.backboard-workspace-activity-label')).textContent = label;
	}

	private async openNewAgentSession(): Promise<void> {
		if (!await this.prepareWorkspaceForSession(undefined)) {
			return;
		}

		this.selectedSessionResource = undefined;
		this.renderSessions();
		await this.loadSession(undefined);
	}

	private async openExistingSession(session: IAgentSession): Promise<void> {
		this.selectedSessionResource = session.resource;
		this.renderSessions();
		await this.loadSession(session);
	}

	private updateWorkspaceDetailState(): void {
		const hasDetail = !!this.modelRef.value;
		this.pageElement?.classList.toggle('no-detail', !hasDetail);
		this.detailElement?.classList.toggle('hidden', !hasDetail);
		if (!hasDetail) {
			this.selectedSessionResource = undefined;
			this.modelRef.clear();
			this.chatWidget?.setModel(undefined);
		}
		this.chatContainer?.classList.toggle('hidden', !hasDetail);
		this.layoutChatWidget();
	}

	private getSessionWorkspaceUri(session: IAgentSession | undefined): URI | undefined {
		if (!session) {
			return undefined;
		}

		const workingDirectoryPath = this.getMetadataString(session, 'workingDirectoryPath');
		return workingDirectoryPath ? URI.file(workingDirectoryPath) : this.newSessionFolderService.getFolder(session.resource);
	}

	private async ensureWorkspaceUri(): Promise<URI> {
		if (this.targetWorkspaceUri) {
			return this.targetWorkspaceUri;
		}

		if (!this.defaultWorkspacePromise) {
			this.defaultWorkspacePromise = (async () => {
				const folder = URI.joinPath(await this.pathService.userHome({ preferLocal: true }), '.backboard_ide', 'workspace');
				await this.fileService.createFolder(folder);
				return folder;
			})();
		}

		this.targetWorkspaceUri = await this.defaultWorkspacePromise;
		return this.targetWorkspaceUri;
	}

	private async prepareWorkspaceForSession(session: IAgentSession | undefined, sessionResource?: URI): Promise<boolean> {
		try {
			const workspaceUri = this.getSessionWorkspaceUri(session) ?? await this.ensureWorkspaceUri();
			if (sessionResource) {
				this.newSessionFolderService.setFolder(sessionResource, workspaceUri);
			}
			return true;
		} catch (error) {
			this.logService.error('[BackboardWorkspacePage] Failed to prepare workspace folder', error);
			this.notificationService.error(localize('backboardWorkspacePrepareFolderError', "Unable to prepare the Backboard workspace folder: {0}", toErrorMessage(error)));
			return false;
		}
	}

	private async loadSession(session: IAgentSession | undefined): Promise<void> {
		if (!this.chatWidget) {
			return;
		}

		this.updateDetailHeader(session);
		this.loadSessionCts.value?.cancel();
		const cts = new CancellationTokenSource();
		this.loadSessionCts.value = cts;

		try {
			if (session) {
				await this.resolveSessionItem(session, cts.token);
			}

			const ref = session
				? await this.chatService.acquireOrLoadSession(session.resource, ChatAgentLocation.Chat, cts.token, 'BackboardWorkspacePage#loadSession')
				: await this.acquireNewBackboardSession(cts.token);

			if (cts.token.isCancellationRequested || !ref) {
				ref?.dispose();
				return;
			}

			if (!await this.prepareWorkspaceForSession(session, ref.object.sessionResource)) {
				ref.dispose();
				return;
			}

			this.modelRef.value = ref;
			this.modelByResource.set(ref.object.sessionResource.toString(), ref.object);
			await this.updateWidgetLockState(getChatSessionType(ref.object.sessionResource));
			if (cts.token.isCancellationRequested) {
				if (this.modelRef.value === ref) {
					this.modelRef.clear();
				} else {
					ref.dispose();
				}
				return;
			}
			this.chatWidget.setModel(ref.object);
			session?.setRead(true);
			this.updateWorkspaceDetailState();
			this.layoutChatWidget();
		} catch (error) {
			if (!cts.token.isCancellationRequested) {
				this.logService.error('[BackboardWorkspacePage] Failed to load workspace chat session', error);
				this.notificationService.error(localize('backboardWorkspaceLoadError', "Unable to open agent session: {0}", toErrorMessage(error)));
			}
		}
	}

	private acquireNewBackboardSession(token: CancellationToken): Promise<IChatModelReference | undefined> | IChatModelReference {
		const resource = getDefaultNewChatSessionResource(this.configurationService, this.chatSessionsService);
		if (getChatSessionType(resource) === localChatSessionType) {
			return this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { canUseTools: true, debugOwner: 'BackboardWorkspacePage#acquireNewBackboardSession' });
		}

		return this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'BackboardWorkspacePage#acquireNewBackboardSession');
	}

	private async resolveSessionItem(session: IAgentSession, token: CancellationToken): Promise<void> {
		await this.chatSessionsService.activateChatSessionItemProvider(session.providerType);
		await this.chatSessionsService.resolveChatSessionItem(session.providerType, session.resource, token);
	}

	private updateDetailHeader(session: IAgentSession | undefined): void {
		if (!this.detailTitleElement || !this.detailSubtitleElement) {
			return;
		}

		reset(this.detailTitleElement, session?.label ?? localize('backboardWorkspaceNewAgentTitle', "New Agent"));
		reset(this.detailSubtitleElement, session
			? localize('backboardWorkspaceOpenSessionSubtitle', "Chat and review this agent session.")
			: localize('backboardWorkspaceNewAgentSubtitle', "Start a task from the workspace detail panel."));
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
			this.logService.warn(`[BackboardWorkspacePage] Failed to resolve chat session type '${sessionType}' for locking`, error);
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

	private layoutChatWidget(): void {
		if (!this.chatWidget || !this.chatContainer) {
			return;
		}

		const bounds = this.chatContainer.getBoundingClientRect();
		const width = Math.max(0, Math.floor(bounds.width || this.dimension.width));
		const height = Math.max(0, Math.floor(bounds.height || this.dimension.height));
		this.chatWidget.layout(height, width);
	}

	private getBackboardSessions(): IAgentSession[] {
		return this.agentSessionsService.model.sessions
			.filter(session => !session.isArchived() && !this.deletedSessionResources.has(session.resource.toString()) && this.isBackboardSession(session))
			.filter(session => !this.selectedWorkspaceFilter || this.getSessionWorkspaceUri(session)?.toString() === this.selectedWorkspaceFilter)
			.sort((a, b) => this.getSessionActivityTime(b) - this.getSessionActivityTime(a));
	}

	private getAvailableWorkspaces(): { uri: URI; label: string; count: number }[] {
		const map = new Map<string, { uri: URI; label: string; count: number }>();
		for (const session of this.agentSessionsService.model.sessions) {
			if (session.isArchived() || !this.isBackboardSession(session)) {
				continue;
			}
			const uri = this.getSessionWorkspaceUri(session);
			if (!uri) {
				continue;
			}
			const key = uri.toString();
			const existing = map.get(key);
			if (existing) {
				existing.count++;
			} else {
				map.set(key, { uri, label: basename(uri) ?? uri.fsPath, count: 1 });
			}
		}
		return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
	}

	private showWorkspaceSwitcherMenu(anchor: HTMLElement): void {
		// Remove any existing menu
		const existing = this.container?.ownerDocument.querySelector('.monaco-workspace-switcher-menu');
		existing?.remove();

		const doc = this.container?.ownerDocument;
		if (!doc) {
			return;
		}

		const menu = append(doc.body, $('.monaco-workspace-switcher-menu'));
		const disposables = new DisposableStore();

		// "All Workspaces" option
		const allItem = append(menu, $('.monaco-workspace-switcher-menu-item'));
		allItem.classList.toggle('active', !this.selectedWorkspaceFilter);
		append(allItem, $('span.codicon.codicon-layout')).setAttribute('aria-hidden', 'true');
		append(allItem, $('span.switcher-item-label')).textContent = localize('backboardWorkspaceAllWorkspaces', "All Workspaces");
		const allCount = append(allItem, $('span.switcher-item-count'));
		const totalSessions = this.agentSessionsService.model.sessions.filter(s => !s.isArchived() && this.isBackboardSession(s)).length;
		allCount.textContent = String(totalSessions);
		disposables.add(addDisposableListener(allItem, EventType.CLICK, () => {
			this.selectedWorkspaceFilter = undefined;
			this.workspaceSwitcherLabel!.textContent = localize('backboardWorkspaceAllWorkspaces', "All Workspaces");
			this.renderSessions();
			menu.remove();
			disposables.dispose();
		}));

		const workspaces = this.getAvailableWorkspaces();
		if (workspaces.length > 0) {
			append(menu, $('.monaco-workspace-switcher-menu-separator'));
			for (const ws of workspaces) {
				const item = append(menu, $('.monaco-workspace-switcher-menu-item'));
				item.classList.toggle('active', this.selectedWorkspaceFilter === ws.uri.toString());
				append(item, $('span.codicon.codicon-folder')).setAttribute('aria-hidden', 'true');
				append(item, $('span.switcher-item-label')).textContent = ws.label;
				append(item, $('span.switcher-item-count')).textContent = String(ws.count);
				disposables.add(addDisposableListener(item, EventType.CLICK, () => {
					this.selectedWorkspaceFilter = ws.uri.toString();
					this.workspaceSwitcherLabel!.textContent = ws.label;
					this.renderSessions();
					menu.remove();
					disposables.dispose();
				}));
			}
		}

		// Position the menu below the anchor
		const rect = anchor.getBoundingClientRect();
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;

		// Dismiss on outside click
		disposables.add(addDisposableListener(doc, EventType.CLICK, (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && e.target !== anchor) {
				menu.remove();
				disposables.dispose();
			}
		}, true));
	}

	private getSessionActivityTime(session: IAgentSession): number {
		return session.status === AgentSessionStatus.InProgress
			? session.timing.lastRequestStarted ?? session.timing.created
			: session.timing.lastRequestEnded ?? session.timing.created;
	}

	private isBackboardSession(session: IAgentSession): boolean {
		return this.isBackboardSessionType(session.providerType)
			|| this.chatSessionsService.getChatSessionContribution(session.providerType)?.agentHostProviderId === 'backboard';
	}

	private isBackboardSessionType(sessionType: string): boolean {
		return sessionType === SessionType.AgentHostBackboard || sessionType.endsWith('-backboard');
	}

	private getChangedFileLabels(session: IAgentSession): string[] {
		if (!(session.changes instanceof Array)) {
			return [];
		}

		return session.changes.map(change => basename(this.getChangeUri(change)));
	}

	private getChangeUri(change: IChatSessionFileChange | IChatSessionFileChange2): URI {
		return 'uri' in change ? change.uri : change.modifiedUri;
	}

	private asPlainText(value: string | IMarkdownString | undefined): string | undefined {
		if (!value) {
			return undefined;
		}

		return typeof value === 'string' ? value : value.value;
	}

	private getMetadataString(session: IAgentSession, key: string): string | undefined {
		const value = session.metadata?.[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}

		return undefined;
	}

	private getCachedOutputPreview(session: IAgentSession): string | undefined {
		return this.outputPreviewByResource.get(session.resource.toString());
	}

	private queueSessionOutputPreview(session: IAgentSession): void {
		const key = session.resource.toString();
		if (this.outputPreviewLoads.has(key) || this.outputPreviewStores.has(key)) {
			return;
		}

		this.outputPreviewLoads.add(key);
		void this.resolveSessionItem(session, CancellationToken.None).then(() => {
			return this.chatService.acquireOrLoadSession(session.resource, ChatAgentLocation.Chat, CancellationToken.None, 'BackboardWorkspacePage#queueSessionOutputPreview');
		}).then(ref => {
			this.outputPreviewLoads.delete(key);
			if (!ref) {
				return;
			}

			const store = new DisposableStore();
			store.add(ref);
			store.add(ref.object.onDidChange(() => {
				this.updateOutputPreview(key, ref.object);
			}));
			this.outputPreviewStores.set(key, store);
			this.modelByResource.set(key, ref.object);
			this.updateOutputPreview(key, ref.object);
		}, error => {
			this.outputPreviewLoads.delete(key);
			this.logService.warn('[BackboardWorkspacePage] Failed to load session output preview', error);
		});
	}

	private updateOutputPreview(key: string, model: IChatModel): void {
		const preview = this.extractOutputPreview(model);
		const previous = this.outputPreviewByResource.get(key);
		const modelId = this.extractModelId(model);
		const previousModelId = this.modelIdByResource.get(key);
		if (modelId) {
			this.modelIdByResource.set(key, modelId);
		} else {
			this.modelIdByResource.delete(key);
		}

		if (preview === previous && modelId === previousModelId) {
			return;
		}

		if (preview) {
			this.outputPreviewByResource.set(key, preview);
		} else {
			this.outputPreviewByResource.delete(key);
		}
		this.outputPreviewRenderScheduler.schedule();
	}

	private getCardDescription(session: IAgentSession): string {
		return this.asPlainText(session.description)
			?? localize('backboardWorkspaceDefaultDescription', "Agent session ready to review");
	}

	private extractModelId(model: IChatModel): string | undefined {
		const requests = model.getRequests();
		for (let i = requests.length - 1; i >= 0; i--) {
			const modelId = requests[i].modelId;
			if (modelId) {
				return modelId;
			}
		}

		return model.inputModel.state.get()?.selectedModel?.identifier;
	}

	private extractOutputPreview(model: IChatModel): string | undefined {
		const requests = model.getRequests();
		for (let i = requests.length - 1; i >= 0; i--) {
			const response = requests[i].response;
			if (!response) {
				continue;
			}

			const finalResponse = this.normalizeOutputPreview(response.response.getFinalResponse())
				?? this.normalizeOutputPreview(response.response.getMarkdown());
			if (finalResponse) {
				const stepCount = this.getResponseStepCount(response.response.value);
				if (stepCount > 0) {
					const stepLabel = response.isComplete
						? stepCount === 1
							? localize('backboardWorkspaceFinishedOneStep', "Finished with 1 step")
							: localize('backboardWorkspaceFinishedManySteps', "Finished with {0} steps", stepCount)
						: stepCount === 1
							? localize('backboardWorkspaceWorkingOneStep', "Working through 1 step")
							: localize('backboardWorkspaceWorkingManySteps', "Working through {0} steps", stepCount);
					return `${stepLabel}. ${finalResponse}`;
				}
				return finalResponse;
			}
		}

		return undefined;
	}

	private getResponseStepCount(parts: readonly { kind: string }[]): number {
		let count = 0;
		for (const part of parts) {
			if (
				part.kind === 'toolInvocation'
				|| part.kind === 'toolInvocationSerialized'
				|| part.kind === 'textEditGroup'
				|| part.kind === 'workspaceEdit'
				|| part.kind === 'externalEdit'
			) {
				count++;
			}
		}
		return count;
	}

	private normalizeOutputPreview(value: string | undefined): string | undefined {
		const normalized = value
			?.replace(/```[\s\S]*?```/g, '')
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
			.replace(/\s+/g, ' ')
			.trim();

		if (!normalized) {
			return undefined;
		}

		return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
	}

	private disposeStaleOutputPreviews(sessions: readonly IAgentSession[]): void {
		const activeKeys = new Set(sessions.map(session => session.resource.toString()));
		for (const [key] of this.outputPreviewStores) {
			if (!activeKeys.has(key)) {
				this.disposeSessionOutputPreview(key);
			}
		}
	}

	private disposeSessionOutputPreview(key: string): void {
		this.outputPreviewStores.get(key)?.dispose();
		this.outputPreviewStores.delete(key);
		this.outputPreviewByResource.delete(key);
		this.modelByResource.delete(key);
		this.modelIdByResource.delete(key);
		this.cardReplyDraftByResource.delete(key);
		this.outputPreviewLoads.delete(key);
	}

	private getStatusClass(status: AgentSessionStatus): string {
		switch (status) {
			case AgentSessionStatus.Completed:
				return 'done';
			case AgentSessionStatus.Failed:
				return 'failed';
			case AgentSessionStatus.NeedsInput:
				return 'needs-input';
			case AgentSessionStatus.InProgress:
			default:
				return 'live';
		}
	}

	private getStatusLabel(status: AgentSessionStatus): string {
		switch (status) {
			case AgentSessionStatus.Completed:
				return localize('backboardWorkspaceDone', "Done");
			case AgentSessionStatus.Failed:
				return localize('backboardWorkspaceFailed', "Failed");
			case AgentSessionStatus.NeedsInput:
				return localize('backboardWorkspaceNeedsInput', "Needs input");
			case AgentSessionStatus.InProgress:
			default:
				return localize('backboardWorkspaceLive', "Live");
		}
	}

	private getActivityIcon(session: IAgentSession, summary: ReturnType<typeof getAgentChangesSummary>): string {
		switch (session.status) {
			case AgentSessionStatus.InProgress:
				return 'codicon-sync';
			case AgentSessionStatus.NeedsInput:
				return 'codicon-comment-discussion';
			case AgentSessionStatus.Failed:
				return 'codicon-error';
			case AgentSessionStatus.Completed:
			default:
				return summary && summary.files > 0 ? 'codicon-edit' : 'codicon-check';
		}
	}

	private getActivityText(session: IAgentSession, summary: ReturnType<typeof getAgentChangesSummary>): string {
		const liveActivity = this.asPlainText(session.description);
		switch (session.status) {
			case AgentSessionStatus.Completed:
				if (summary && summary.files > 0) {
					return localize('backboardWorkspaceEditingComplete', "Editing complete");
				}
				return localize('backboardWorkspaceRunCompleted', "Run completed");
			case AgentSessionStatus.Failed:
				return localize('backboardWorkspaceRunFailed', "Run failed");
			case AgentSessionStatus.NeedsInput:
				return liveActivity ?? localize('backboardWorkspaceNeedsInputActivity', "Waiting for input");
			case AgentSessionStatus.InProgress:
			default:
				if (summary && summary.files > 0) {
					return liveActivity ?? localize('backboardWorkspaceEditingFiles', "Editing files");
				}
				return liveActivity ?? localize('backboardWorkspaceRunActive', "Run in progress");
		}
	}
}
