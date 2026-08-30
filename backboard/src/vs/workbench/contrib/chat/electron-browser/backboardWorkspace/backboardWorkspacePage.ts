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

type BackboardWorkspaceViewStateId = 'activeAgents' | 'mixedStatus' | 'completed' | 'chatClosed' | 'chatOpen' | 'chatRunning' | 'chatReview';
type BackboardWorkspaceTone = 'live' | 'queued' | 'done' | 'warning' | 'failed';

interface IBackboardWorkspacePlaceholderActivity {
	readonly icon: string;
	readonly text: string;
	readonly tone: BackboardWorkspaceTone;
}

interface IBackboardWorkspacePlaceholderAgent {
	readonly title: string;
	readonly status: string;
	readonly tone: BackboardWorkspaceTone;
	readonly command: string;
	readonly description: string;
	readonly activities: readonly IBackboardWorkspacePlaceholderActivity[];
	readonly files: readonly string[];
	readonly model: string;
}

interface IBackboardWorkspaceViewState {
	readonly id: BackboardWorkspaceViewStateId;
	readonly count: string;
	readonly agents: readonly IBackboardWorkspacePlaceholderAgent[];
}

const basePlaceholderAgents: readonly IBackboardWorkspacePlaceholderAgent[] = [
	{
		title: 'refactor-api',
		status: 'LIVE',
		tone: 'live',
		command: '$ build',
		description: 'Refactor the legacy API layer from callback-heavy request handlers into typed async/await flows',
		activities: [
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'write_file src/api/client.ts', tone: 'live' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'write_file src/api/client.ts', tone: 'live' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'converting fetch wrapper to async/await while preserving...', tone: 'queued' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'write_file src/api/client.ts', tone: 'live' },
			{ icon: 'codicon-check', text: 'auth.ts imports normalized and ApiError interface reused', tone: 'done' },
		],
		files: ['api.ts', 'auth.ts', 'helpers.ts'],
		model: 'Haiku 4.5',
	},
	{
		title: 'generate-tests',
		status: 'LIVE',
		tone: 'live',
		command: '$ test',
		description: 'Generate coverage for API transforms and edge-case error handling',
		activities: [
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'scan test fixtures', tone: 'live' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'write_file test/api/client.test.ts', tone: 'live' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'checking async error propagation...', tone: 'queued' },
			{ icon: 'codicon-check', text: 'request factory coverage added', tone: 'done' },
		],
		files: ['api.test.ts', 'client.test.ts', 'helpers.ts'],
		model: 'Haiku 4.5',
	},
	{
		title: 'lint-fix',
		status: 'LIVE',
		tone: 'live',
		command: '$ lint',
		description: 'Normalize imports, formatting, and unreachable branches after the refactor',
		activities: [
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'write_file src/api/client.ts', tone: 'live' },
			{ icon: 'codicon-loading codicon-modifier-spin', text: 'fixing eslint no-floating-promises...', tone: 'queued' },
			{ icon: 'codicon-check', text: 'unused request helpers removed', tone: 'done' },
		],
		files: ['api.ts', 'auth.ts', 'helpers.ts'],
		model: 'Haiku 4.5',
	},
];

const WORKSPACE_VIEW_STATES: Record<BackboardWorkspaceViewStateId, IBackboardWorkspaceViewState> = {
	activeAgents: { id: 'activeAgents', count: '3 agents', agents: basePlaceholderAgents },
	mixedStatus: {
		id: 'mixedStatus',
		count: '3 agents',
		agents: [
			basePlaceholderAgents[0],
			{ ...basePlaceholderAgents[1], status: 'QUEUED', tone: 'queued' },
			{ ...basePlaceholderAgents[2], status: 'REVIEW', tone: 'warning' },
		],
	},
	completed: {
		id: 'completed',
		count: '3 completed',
		agents: basePlaceholderAgents.map(agent => ({ ...agent, status: 'DONE', tone: 'done' })),
	},
	chatClosed: { id: 'chatClosed', count: '2 agents', agents: basePlaceholderAgents.slice(0, 2) },
	chatOpen: { id: 'chatOpen', count: '2 agents', agents: basePlaceholderAgents.slice(0, 2) },
	chatRunning: { id: 'chatRunning', count: '2 agents', agents: basePlaceholderAgents.slice(0, 2) },
	chatReview: { id: 'chatReview', count: '2 agents', agents: basePlaceholderAgents.slice(0, 2).map(agent => ({ ...agent, status: 'REVIEW', tone: 'warning' })) },
};

export class BackboardWorkspacePage extends Disposable {

	static readonly ID = BACKBOARD_WORKSPACE_SURFACE_ID;

	private container: HTMLElement | undefined;
	private pageElement: HTMLElement | undefined;
	private cardsContainer: HTMLElement | undefined;
	private countElement: HTMLElement | undefined;
	private detailElement: HTMLElement | undefined;
	private detailTitleElement: HTMLElement | undefined;
	private detailNewButton: HTMLButtonElement | undefined;
	private chatContainer: HTMLElement | undefined;
	private chatWidget: ChatWidget | undefined;
	private workspaceSwitcherButton: HTMLButtonElement | undefined;
	private workspaceSwitcherLabel: HTMLElement | undefined;
	private selectedWorkspaceFilter: string | undefined;
	private detailCollapsed = false;
	private detailToggleButton: HTMLButtonElement | undefined;
	private detailExpandButton: HTMLButtonElement | undefined;
	private detailWidth = 420;
	private readonly minDetailWidth = 320;
	private readonly maxDetailWidth = 720;
	private readonly minMainWidth = 420;
	private dimension = new Dimension(0, 0);
	private selectedSessionResource: URI | undefined;
	private targetWorkspaceUri: URI | undefined;
	private defaultWorkspacePromise: Promise<URI> | undefined;
	private viewState: BackboardWorkspaceViewStateId = 'activeAgents';

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

		// Workspace row below the native titlebar.
		const header = append(this.container, $('.backboard-workspace-header'));
		const headerLeft = append(header, $('.backboard-workspace-header-left'));

		// Workspace switcher button
		this.workspaceSwitcherButton = append(headerLeft, $('button.backboard-workspace-switcher'));
		this.workspaceSwitcherButton.type = 'button';
		const switcherIcon = append(this.workspaceSwitcherButton, $('span.codicon.codicon-folder'));
		switcherIcon.setAttribute('aria-hidden', 'true');
		this.workspaceSwitcherLabel = append(this.workspaceSwitcherButton, $('span'));
		this.workspaceSwitcherLabel.textContent = localize('backboardWorkspaceAllWorkspaces', "All Workspaces");
		this.workspaceSwitcherButton.title = localize('backboardWorkspaceSwitcherTitle', "Switch workspace");
		this.workspaceSwitcherButton.setAttribute('aria-label', this.workspaceSwitcherButton.title);
		this._register(addDisposableListener(this.workspaceSwitcherButton, EventType.CLICK, (e) => {
			EventHelper.stop(e);
			this.showWorkspaceSwitcherMenu(this.workspaceSwitcherButton!);
		}));

		const titleRow = append(header, $('.backboard-workspace-title-row'));
		append(titleRow, $('h1')).textContent = localize('backboardWorkspaceTitle', "Advanced");
		this.countElement = append(titleRow, $('.backboard-workspace-count'));

		// Header right: global workspace actions
		const headerRight = append(header, $('.backboard-workspace-header-right'));

		// Refresh button
		this.createToolbarButton(headerRight, 'codicon-refresh', localize('backboardWorkspaceRefresh', "Refresh"), () => {
			void this.agentSessionsService.model.resolve(undefined);
		});

		// "New" button — spawns a fresh chat
		this.detailNewButton = append(headerRight, $('button.backboard-workspace-detail-new-button')) as HTMLButtonElement;
		this.detailNewButton.type = 'button';
		const newIcon = append(this.detailNewButton, $('span.codicon.codicon-add'));
		newIcon.setAttribute('aria-hidden', 'true');
		append(this.detailNewButton, $('span')).textContent = localize('backboardWorkspaceDetailNew', "New");
		this.detailNewButton.title = localize('backboardWorkspaceDetailNewTitle', "Start a new agent chat");
		this.detailNewButton.setAttribute('aria-label', this.detailNewButton.title);
		this._register(addDisposableListener(this.detailNewButton, EventType.CLICK, () => {
			void this.openNewAgentSession();
		}));

		// Floating "expand panel" button — visible only when detail is collapsed
		this.detailExpandButton = append(headerRight, $('button.backboard-workspace-detail-expand')) as HTMLButtonElement;
		this.detailExpandButton.type = 'button';
		const expandIcon = append(this.detailExpandButton, $('span.codicon.codicon-chevron-left'));
		expandIcon.setAttribute('aria-hidden', 'true');
		this.detailExpandButton.title = localize('backboardWorkspaceExpandPanel', "Open chat panel");
		this.detailExpandButton.setAttribute('aria-label', this.detailExpandButton.title);
		this.detailExpandButton.hidden = true;
		this._register(addDisposableListener(this.detailExpandButton, EventType.CLICK, () => {
			this.detailCollapsed = false;
			this.syncToggleIcon();
			this.updateWorkspaceDetailState();
		}));

		// Page body below the header
		const page = append(this.container, $('.backboard-workspace-page'));
		this.pageElement = page;
		const main = append(page, $('.backboard-workspace-main'));
		this.cardsContainer = append(main, $('.backboard-workspace-cards'));

		// Draggable sash between main and detail
		const sash = append(page, $('div.backboard-workspace-sash'));
		sash.setAttribute('role', 'separator');
		sash.setAttribute('aria-orientation', 'vertical');
		sash.setAttribute('aria-label', localize('backboardWorkspaceResizePanel', "Resize chat panel"));
		sash.tabIndex = 0;
		sash.setAttribute('aria-valuemin', String(this.minDetailWidth));
		sash.setAttribute('aria-valuemax', String(this.maxDetailWidth));
		sash.setAttribute('aria-valuenow', String(this.detailWidth));
		this._register(addDisposableListener(sash, EventType.POINTER_DOWN, (event: PointerEvent) => {
			event.preventDefault();
			sash.setPointerCapture(event.pointerId);
			sash.classList.add('dragging');
			page.classList.add('resizing-detail');
			const startX = event.clientX;
			const startWidth = this.detailWidth;
			const doc = this.container?.ownerDocument;
			const onMove = (e: PointerEvent) => {
				const delta = startX - e.clientX;
				const next = this.clampDetailWidth(startWidth + delta);
				this.detailWidth = next;
				sash.setAttribute('aria-valuenow', String(this.detailWidth));
				this.applyDetailWidth();
			};
			const onUp = (e: PointerEvent) => {
				if (sash.hasPointerCapture(e.pointerId)) {
					sash.releasePointerCapture(e.pointerId);
				}
				sash.classList.remove('dragging');
				page.classList.remove('resizing-detail');
				doc?.removeEventListener('pointermove', onMove);
				doc?.removeEventListener('pointerup', onUp);
				doc?.removeEventListener('pointercancel', onUp);
			};
			doc?.addEventListener('pointermove', onMove);
			doc?.addEventListener('pointerup', onUp);
			doc?.addEventListener('pointercancel', onUp);
		}));
		this._register(addDisposableListener(sash, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			let delta = 0;
			if (event.key === 'ArrowLeft') {
				delta = 24;
			} else if (event.key === 'ArrowRight') {
				delta = -24;
			} else if (event.key === 'Home') {
				this.detailWidth = this.minDetailWidth;
			} else if (event.key === 'End') {
				this.detailWidth = this.clampDetailWidth(this.maxDetailWidth);
			} else {
				return;
			}

			EventHelper.stop(event, true);
			if (delta) {
				this.detailWidth = this.clampDetailWidth(this.detailWidth + delta);
			}
			sash.setAttribute('aria-valuenow', String(this.detailWidth));
			this.applyDetailWidth();
		}));

		const detail = append(page, $('.backboard-workspace-detail'));
		this.detailElement = detail;

		const detailHeader = append(detail, $('.backboard-workspace-detail-header'));
		this.detailTitleElement = append(detailHeader, $('h2.backboard-workspace-detail-title'));

		this.detailToggleButton = append(detailHeader, $('button.backboard-workspace-detail-toggle')) as HTMLButtonElement;
		this.detailToggleButton.type = 'button';
		const toggleIcon = append(this.detailToggleButton, $('span.codicon.codicon-chevron-right'));
		toggleIcon.setAttribute('aria-hidden', 'true');
		this.detailToggleButton.title = localize('backboardWorkspaceCollapsePanel', "Collapse panel");
		this.detailToggleButton.setAttribute('aria-label', this.detailToggleButton.title);
		this._register(addDisposableListener(this.detailToggleButton, EventType.CLICK, () => {
			this.toggleDetailCollapsed();
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
		this.applyDetailWidth();
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
				renderInputToolbarBelowInput: false,
				supportsFileReferences: true,
				rendererOptions: {
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				isSessionsWindow: true,
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
			const state = WORKSPACE_VIEW_STATES[this.viewState];
			if (this.countElement) {
				this.countElement.textContent = state.count;
			}
			for (const agent of state.agents) {
				this.renderPlaceholderAgentCard(this.cardsContainer, agent);
			}
			return;
		}

		for (const session of sessions) {
			this.renderSessionCard(this.cardsContainer, session);
		}

		// Fill remaining grid space with shadow tiles so the dashboard
		// never looks empty — clicking a shadow creates a new agent.
		const columns = 3;
		const remainder = sessions.length % columns;
		const fillCount = remainder === 0 ? 0 : columns - remainder;
		for (let i = 0; i < Math.min(fillCount, columns); i++) {
			this.renderShadowTile(this.cardsContainer);
		}

		this.cardsContainer.scrollTop = previousScrollTop;
	}

	private renderPlaceholderAgentCard(parent: HTMLElement, agent: IBackboardWorkspacePlaceholderAgent): void {
		const card = append(parent, $('article.backboard-workspace-card.backboard-workspace-placeholder-card')) as HTMLDivElement;
		card.dataset.tone = agent.tone;
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.setAttribute('aria-label', localize('backboardWorkspacePlaceholderAgentLabel', "Start from agent card {0}", agent.title));

		const header = append(card, $('.backboard-workspace-card-header'));
		const title = append(header, $('.backboard-workspace-card-title'));
		append(title, $(`span.backboard-workspace-status-dot.${agent.tone}`));
		append(title, $('span.backboard-workspace-card-name')).textContent = agent.title;
		const headerActions = append(header, $('.backboard-workspace-card-actions'));
		append(headerActions, $(`span.backboard-workspace-status-pill.${agent.tone}`)).textContent = agent.status;
		const overflow = append(headerActions, $('button.backboard-workspace-card-menu')) as HTMLButtonElement;
		overflow.type = 'button';
		overflow.title = localize('backboardWorkspaceAgentActions', "Agent actions");
		overflow.setAttribute('aria-label', overflow.title);
		append(overflow, $('span.codicon.codicon-kebab-vertical')).setAttribute('aria-hidden', 'true');

		const command = append(card, $('.backboard-workspace-command-row'));
		append(command, $('span.backboard-workspace-command-label')).textContent = agent.command;
		append(command, $('span.backboard-workspace-command-description')).textContent = agent.description;

		const activity = append(card, $('.backboard-workspace-card-activity'));
		for (const item of agent.activities) {
			const row = append(activity, $('.backboard-workspace-activity-row'));
			row.dataset.tone = item.tone;
			const icon = append(row, $('span.codicon'));
			for (const className of item.icon.split(' ')) {
				icon.classList.add(className);
			}
			icon.setAttribute('aria-hidden', 'true');
			append(row, $('span.backboard-workspace-activity-label')).textContent = item.text;
		}

		const files = append(card, $('.backboard-workspace-card-files'));
		for (const file of agent.files) {
			const chip = append(files, $('span.backboard-workspace-file-chip'));
			append(chip, $('span.backboard-workspace-file-dot')).setAttribute('aria-hidden', 'true');
			append(chip, $('span')).textContent = file;
		}

		const footer = append(card, $('.backboard-workspace-card-footer'));
		const stop = append(footer, $('button.backboard-workspace-card-footer-action')) as HTMLButtonElement;
		stop.type = 'button';
		stop.title = localize('backboardWorkspaceStopAgent', "Stop agent");
		stop.setAttribute('aria-label', stop.title);
		append(stop, $('span.codicon.codicon-debug-stop')).setAttribute('aria-hidden', 'true');
		append(footer, $('.backboard-workspace-card-footer-spacer'));
		append(footer, $('span.backboard-workspace-card-model-pill')).textContent = agent.model;
		append(footer, $('span.codicon.codicon-link-external')).setAttribute('aria-hidden', 'true');

		this.cardDisposables.add(addDisposableListener(card, EventType.CLICK, event => {
			if ((event.target as HTMLElement).closest('button')) {
				return;
			}
			void this.openNewAgentSession();
		}));
		this.cardDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				EventHelper.stop(event, true);
				void this.openNewAgentSession();
			}
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

		// Band 1: Header — status dot + title + status badge + delete
		const header = append(card, $('.backboard-workspace-card-header'));
		const title = append(header, $('.backboard-workspace-card-title'));
		append(title, $(`span.backboard-workspace-status-dot.${this.getStatusClass(session.status)}`));
		append(title, $('span.backboard-workspace-card-name')).textContent = session.label;
		const headerActions = append(header, $('.backboard-workspace-card-actions'));
		append(headerActions, $(`span.backboard-workspace-status-pill.${this.getStatusClass(session.status)}`)).textContent = this.getStatusLabel(session.status);
		const overflow = append(headerActions, $('button.backboard-workspace-card-menu')) as HTMLButtonElement;
		overflow.type = 'button';
		overflow.title = localize('backboardWorkspaceDeleteAgent', "Delete");
		overflow.setAttribute('aria-label', localize('backboardWorkspaceDeleteAgent', "Delete"));
		append(overflow, $('span.codicon.codicon-close')).setAttribute('aria-hidden', 'true');
		this.cardDisposables.add(addDisposableListener(overflow, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void this.deleteSession(session);
		}));

		// Band 2: Activity body — output preview + activity rows
		const body = append(card, $('.backboard-workspace-card-body'));
		const outputPreview = this.getCachedOutputPreview(session);
		if (outputPreview) {
			append(body, $('.backboard-workspace-card-output')).textContent = outputPreview;
		}
		const activity = append(body, $('.backboard-workspace-card-activity'));
		this.renderActivityRows(activity, session);

		// Band 3: File chips
		const files = this.getChangedFileLabels(session);
		if (files.length) {
			const fileStrip = append(card, $('.backboard-workspace-card-files'));
			for (const file of files.slice(0, 3)) {
				append(fileStrip, $('span.backboard-workspace-file-chip')).textContent = file;
			}
			if (files.length > 3) {
				append(fileStrip, $('span.backboard-workspace-file-chip.more')).textContent = localize('backboardWorkspaceMoreFiles', "+{0}", files.length - 3);
			}
		}

		// Band 4: Footer — provider label
		const footer = append(card, $('.backboard-workspace-card-footer'));
		const pill = append(footer, $('span.backboard-workspace-card-model-pill'));
		append(pill, $('span.codicon.codicon-sparkle')).setAttribute('aria-hidden', 'true');
		append(pill, $('span')).textContent = session.providerLabel || 'Backboard';

		// Click opens the run in the right drawer
		this.cardDisposables.add(addDisposableListener(card, EventType.CLICK, event => {
			if ((event.target as HTMLElement).closest('.backboard-workspace-card-menu')) {
				return;
			}
			void this.openExistingSession(session);
		}));
		this.cardDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				EventHelper.stop(event, true);
				void this.openExistingSession(session);
			}
		}));
	}

	private renderShadowTile(parent: HTMLElement): void {
		const tile = append(parent, $('.backboard-workspace-shadow-tile'));
		tile.tabIndex = 0;
		tile.setAttribute('role', 'button');
		tile.title = localize('backboardWorkspaceCreateAgent', "Create agent");
		tile.setAttribute('aria-label', tile.title);
		const preview = append(tile, $('.backboard-workspace-shadow-preview'));
		append(preview, $('span.codicon.codicon-add')).setAttribute('aria-hidden', 'true');
		append(preview, $('span')).textContent = localize('backboardWorkspaceCreateAgent', "Create agent");
		this.cardDisposables.add(addDisposableListener(tile, EventType.CLICK, () => {
			void this.openNewAgentSession();
		}));
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

	private applyDetailWidth(): void {
		this.detailWidth = this.clampDetailWidth(this.detailWidth);
		if (this.pageElement) {
			this.pageElement.style.setProperty('--detail-width', `${this.detailWidth}px`);
		}
		this.layoutChatWidget();
	}

	private clampDetailWidth(width: number): number {
		const pageWidth = this.pageElement?.clientWidth ?? this.dimension.width;
		const availableMax = pageWidth > 0 ? Math.max(this.minDetailWidth, pageWidth - this.minMainWidth) : this.maxDetailWidth;
		return Math.round(Math.max(this.minDetailWidth, Math.min(this.maxDetailWidth, availableMax, width)));
	}

	private updateWorkspaceDetailState(): void {
		const hasDetail = !!this.modelRef.value;
		const visible = hasDetail && !this.detailCollapsed;
		this.pageElement?.classList.toggle('no-detail', !visible);
		this.detailElement?.classList.toggle('hidden', !visible);
		this.detailElement?.classList.toggle('collapsed', this.detailCollapsed);
		if (!hasDetail) {
			this.selectedSessionResource = undefined;
			this.modelRef.clear();
			this.chatWidget?.setModel(undefined);
		}
		this.chatContainer?.classList.toggle('hidden', !visible);
		this.layoutChatWidget();
	}

	private toggleDetailCollapsed(): void {
		this.detailCollapsed = !this.detailCollapsed;
		this.syncToggleIcon();
		this.updateWorkspaceDetailState();
	}

	private syncToggleIcon(): void {
		const icon = this.detailToggleButton?.querySelector('.codicon');
		if (icon) {
			icon.classList.toggle('codicon-chevron-right', this.detailCollapsed);
			icon.classList.toggle('codicon-chevron-left', !this.detailCollapsed);
		}
		if (this.detailToggleButton) {
			this.detailToggleButton.title = this.detailCollapsed
				? localize('backboardWorkspaceExpandPanel', "Expand panel")
				: localize('backboardWorkspaceCollapsePanel', "Collapse panel");
			this.detailToggleButton.setAttribute('aria-label', this.detailToggleButton.title);
		}
		if (this.detailExpandButton) {
			this.detailExpandButton.hidden = !this.detailCollapsed;
		}
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
		if (!this.detailTitleElement) {
			return;
		}

		reset(this.detailTitleElement, session?.label ?? localize('backboardWorkspaceNewAgentTitle', "New Agent"));
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

		const menuHost = this.container ?? doc.body;
		const menu = append(menuHost, $('.monaco-workspace-switcher-menu'));
		menu.setAttribute('role', 'listbox');
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
		const menuWidth = Math.max(260, rect.width);
		const left = Math.min(rect.left, Math.max(8, doc.defaultView?.innerWidth ?? rect.left) - menuWidth - 8);
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${Math.max(8, left)}px`;
		menu.style.minWidth = `${menuWidth}px`;

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
