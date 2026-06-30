/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWidget.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derivedObservableWithCache, IObservable } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { localize } from '../../../../nls.js';
import { IActiveSession, ISendRequestOptions, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISession, ISessionWorkspace } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { WorkspacePicker } from './sessionWorkspacePicker.js';
import { WebWorkspacePicker } from './webWorkspacePicker.js';
import { IPreferredSessionType, SessionTypePicker } from './sessionTypePicker.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { NoAgentHostEmptyState } from './noAgentHostEmptyState.js';
import { IAgentHostFilterService } from '../../../services/agentHostFilter/common/agentHostFilter.js';
import { IChatViewOptions } from '../../../browser/parts/chatView.js';
import { ISessionTypePickerDelegate, IWorkspacePickerDelegate, IWorkspacePickerItem as IChatWorkspacePickerItem } from '../../../../workbench/contrib/chat/browser/chat.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground } from '../../../common/theme.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Menus } from '../../../browser/menus.js';

// #region --- New Chat Widget ---

const NEW_CHAT_COMPOSER_LAYOUT_HEIGHT = 180;
const NEW_CHAT_COMPOSER_INPUT_MAX_HEIGHT = 260;
type FirstSendWorkspaceChoice = 'selectFolder' | 'createFolder' | undefined;

export class NewChatWidget extends Disposable {

	private readonly _workspacePicker: WorkspacePicker;
	private readonly _sessionTypePicker: SessionTypePicker;
	private readonly _widget: ChatWidget;
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private _currentChatResource: URI | undefined;
	private _chatWidgetContent: HTMLElement | undefined;
	private _composerStackElement: HTMLElement | undefined;
	private _gitStatusElement: HTMLElement | undefined;

	/** Recreates the draft once a better/late-registering provider can serve the folder (see {@link _createNewSession}). */
	private readonly _pendingPreferredUpgrade = new MutableDisposable<IDisposable>();

	/**
	 * The currently mounted no-agent-host empty state, if any. Set by
	 * {@link _renderEmptyStateGate} while the empty state replaces the
	 * workspace picker; consulted by {@link focusInput} to route focus to
	 * the visible heading instead of the (hidden) chat input.
	 */
	private _activeEmptyState: NoAgentHostEmptyState | undefined;

	private readonly _session: IObservable<IActiveSession | undefined>;

	constructor(
		_options: IChatViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@IAgentHostFilterService private readonly agentHostFilterService: IAgentHostFilterService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IChatService private readonly chatService: IChatService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		// On web (vscode.dev / insiders.vscode.dev), use {@link WebWorkspacePicker}
		// which scopes recents to the active host and renders as a bottom
		// sheet on phone-layout viewports. On Electron desktop, the regular
		// {@link WorkspacePicker} is fine — phones never run there.
		const PickerCtor = isWeb ? WebWorkspacePicker : WorkspacePicker;
		this._workspacePicker = this._register(this.instantiationService.createInstance(PickerCtor));
		this._workspacePicker.setLocalOnly(true);
		this._register(this._pendingPreferredUpgrade);

		// TODO: @sandy081 The session/chat should be passed down. There should not be sessionsService.activeSession read in the widget.
		this._session = derivedObservableWithCache<IActiveSession | undefined>(this, (reader, prev) => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			if (activeSession && activeSession.isCreated.read(reader)) {
				return prev;
			}
			return activeSession;
		});

		this._sessionTypePicker = this._register(this.instantiationService.createInstance(SessionTypePicker, this._session));
		this._sessionTypePicker.setAllowedSessionTypeIds([AgentSessionProviders.AgentHostBackboard]);

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
				supportsChangingModes: false,
				isSessionsWindow: true,
				inputEditorMinLines: 2,
				workspacePickerDelegate: this._createWorkspacePickerDelegate(),
				sessionTypePickerDelegate: this._createSessionTypePickerDelegate(),
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

		this._register(this._workspacePicker.onDidSelectWorkspace(async folderUri => {
			await this._onWorkspaceSelected(folderUri);
			this._widget.focusInput();
		}));
		this._register(this._sessionTypePicker.onDidSelectSessionType(async () => {
			await this._onWorkspaceSelected(this._workspacePicker.selectedFolderUri);
			this._widget.focusInput();
		}));
	}

	private _createWorkspacePickerDelegate(): IWorkspacePickerDelegate {
		return {
			getWorkspaces: () => this._getChatWorkspacePickerItems(),
			getSelectedWorkspace: () => this._getSelectedChatWorkspacePickerItem(),
			setSelectedWorkspace: workspace => {
				if (workspace) {
					this._workspacePicker.setSelectedWorkspace(workspace.uri);
				} else {
					this._workspacePicker.clearSelection();
				}
			},
			onDidChangeSelectedWorkspace: Event.map(this._workspacePicker.onDidSelectWorkspace, () => this._getSelectedChatWorkspacePickerItem()),
			onDidChangeWorkspaces: this._workspacePicker.onDidChangeSelection,
			openFolderCommand: 'workbench.action.files.openFolder',
		};
	}

	private _createSessionTypePickerDelegate(): ISessionTypePickerDelegate {
		return {
			getActiveSessionProvider: () => AgentSessionProviders.AgentHostBackboard,
			setActiveSessionProvider: () => undefined,
			getAllowedSessionProviders: () => [AgentSessionProviders.AgentHostBackboard],
		};
	}

	private _getSelectedChatWorkspacePickerItem(): IChatWorkspacePickerItem | undefined {
		const selected = this._workspacePicker.selectedResolved;
		const folder = selected?.workspace.folders[0];
		if (!selected || !folder) {
			return undefined;
		}
		return {
			uri: folder.root,
			label: selected.workspace.label,
			isFolder: true,
		};
	}

	private _getChatWorkspacePickerItems(): IChatWorkspacePickerItem[] {
		const selected = this._getSelectedChatWorkspacePickerItem();
		return selected ? [selected] : [];
	}

	// --- Rendering ---

	render(parent: HTMLElement): void {
		const element = dom.append(parent, dom.$('.sessions-chat-widget'));
		const chatWidgetContainer = dom.append(element, dom.$('.new-chat-widget-container'));
		const chatWidgetContent = dom.append(chatWidgetContainer, dom.$('.new-chat-widget-content'));
		this._chatWidgetContent = chatWidgetContent;

		this._renderMiddleSection(chatWidgetContent);
		const composerStack = dom.append(chatWidgetContent, dom.$('.new-chat-composer-stack'));
		this._composerStackElement = composerStack;
		const workspacePickerContainer = this._renderComposerWorkspaceRow(composerStack);
		this._widget.render(composerStack);
		this._renderComposerSuggestions(composerStack);
		// On web (vscode.dev / insiders.vscode.dev) the workspace picker is
		// scoped to the currently selected agent host. When no hosts are
		// known there is nothing for the user to pick, so swap the picker
		// out for the no-agent-host empty state. On Electron desktop the
		// regular picker is always functional (the local Copilot provider
		// is always available) so this branch is web-only.
		this._register(isWeb
			? this._renderEmptyStateGate(workspacePickerContainer, chatWidgetContent)
			: this._renderWorkspacePicker(workspacePickerContainer));

		this._widget.setVisible(true);
		this._widget.setInputPartMaxHeightOverride(NEW_CHAT_COMPOSER_INPUT_MAX_HEIGHT);
		this._makeComposerEasyToFocus();
		this.layout(NEW_CHAT_COMPOSER_LAYOUT_HEIGHT, chatWidgetContent.clientWidth);

		// Create initial session for any workspace already selected at construct time.
		// If the selection arrives later (provider registers asynchronously), the
		// picker fires onDidSelectWorkspace and our listener handles it.
		// Skip if an active session already exists (restored by openNewSession
		// from a new-session draft when navigating back from another session).
		const restoredFolderUri = this._workspacePicker.selectedFolderUri;
		if (!this._syncWorkspacePickerFromActiveSession() && restoredFolderUri) {
			this._createNewSession(restoredFolderUri);
		}

		chatWidgetContainer.classList.add('revealed');
	}

	private _makeComposerEasyToFocus(): void {
		const inputContainer = this._widget.inputPart.inputContainerElement;
		if (!inputContainer) {
			return;
		}

		const focusInput = () => {
			this._widget.focusInput();
			this._widget.input.inputEditor.focus();
		};
		this._register(dom.addDisposableListener(inputContainer, dom.EventType.POINTER_DOWN, focusInput));
		this._register(dom.addDisposableListener(inputContainer, dom.EventType.CLICK, focusInput));
	}

	private _renderComposerWorkspaceRow(container: HTMLElement): HTMLElement {
		const row = dom.append(container, dom.$('.new-chat-composer-workspace-row'));
		const pickerSlot = dom.append(row, dom.$('.new-session-workspace-picker-container'));
		this._gitStatusElement = dom.append(row, dom.$('.new-chat-git-status'));
		this._register(this._renderGitStatus());
		return pickerSlot;
	}

	private _renderGitStatus(): IDisposable {
		const store = new DisposableStore();
		store.add(autorun(reader => this._updateGitStatus(this._session.read(reader)?.workspace.read(reader) ?? this._workspacePicker.selectedResolved?.workspace)));
		store.add(this._workspacePicker.onDidSelectWorkspace(() => {
			this._updateGitStatus(this._session.get()?.workspace.get() ?? this._workspacePicker.selectedResolved?.workspace);
		}));
		return store;
	}

	private _updateGitStatus(workspace: ISessionWorkspace | undefined): void {
		const element = this._gitStatusElement;
		if (!element) {
			return;
		}

		const folder = workspace?.folders[0];
		const gitRepository = folder?.gitRepository;
		const repoName = gitRepository?.uri ? basename(gitRepository.uri) : (folder?.name ?? workspace?.label);
		const branchName = gitRepository?.branchName?.trim();
		const displayBranchName = branchName || localize('newChatGitStatus.defaultBranch', "main");

		dom.clearNode(element);
		element.classList.toggle('empty', !repoName);
		if (!repoName) {
			return;
		}

		const branchChip = dom.append(element, dom.$('span.new-chat-git-status-item.branch'));
		dom.append(branchChip, renderIcon(Codicon.gitBranch));
		const branchLabel = dom.append(branchChip, dom.$('span.sessions-chat-dropdown-label'));
		branchLabel.textContent = displayBranchName;
		branchChip.classList.remove('pending');

		const title = localize('newChatGitStatus.titleWithBranch', "Repository: {0}, Branch: {1}", repoName, displayBranchName);
		element.title = title;
		element.setAttribute('aria-label', title);
	}

	private _renderMiddleSection(container: HTMLElement): void {
		const actions = dom.append(container, dom.$('.new-chat-middle-toolbar'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, actions, Menus.NewSessionToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			toolbarOptions: { primaryGroup: () => true },
		}));
		const middle = dom.append(container, dom.$('.new-chat-middle-section'));

		const title = dom.append(middle, dom.$('h2.new-chat-middle-title'));
		title.textContent = localize('newChatMiddleTitle', "What should Backboard do?");

		const description = dom.append(middle, dom.$('.new-chat-middle-description'));
		const descriptionLineOne = dom.append(description, dom.$('p'));
		descriptionLineOne.textContent = localize('newChatMiddleDescriptionOne', "Ask for a code change, file edit, bug fix, or UI update.");
		const descriptionLineTwo = dom.append(description, dom.$('p'));
		descriptionLineTwo.textContent = localize('newChatMiddleDescriptionTwo', "Pick a workspace, then describe the next step.");

	}

	private _renderComposerSuggestions(container: HTMLElement): void {
		const suggestionsContainer = dom.append(container, dom.$('.new-chat-middle-suggestions'));
		const suggestions = [
			localize('newChatSuggestionLandingPage', "Build a feature"),
			localize('newChatSuggestionPricingSection', "Fix a bug"),
			localize('newChatSuggestionSettingsScreen', "Polish this UI"),
		];
		for (const suggestion of suggestions) {
			const button = dom.append(suggestionsContainer, dom.$('button.new-chat-middle-suggestion')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = suggestion;
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this._widget.setInput(suggestion);
				this._widget.focusInput();
			}));
		}
	}

	/**
	 * If a new-session draft was restored by {@link openNewSession}, sync
	 * the workspace picker to match the session's workspace. The picker may
	 * have restored a workspace from a different provider (e.g. remote vs
	 * local), so overwrite it with the session's actual workspace without
	 * firing the event (which would trigger {@link _onWorkspaceSelected} and
	 * create a new session).
	 *
	 * @returns `true` if an active session was found and the picker was synced.
	 */
	private _syncWorkspacePickerFromActiveSession(): boolean {
		const activeSession = this._session.get();
		if (!activeSession) {
			return false;
		}

		const sessionWorkspace = activeSession.workspace.get();
		const folderUri = sessionWorkspace?.folders[0]?.root;
		if (folderUri) {
			this._workspacePicker.setSelectedWorkspace(folderUri, { fireEvent: false });
		}

		return true;
	}

	private _isPreferredServable(folderUri: URI, pick: IPreferredSessionType): boolean {
		return this.sessionsManagementService.getSessionTypesForFolder(folderUri).some(t =>
			(pick.providerId === undefined || t.providerId === pick.providerId)
			&& t.sessionType.id === pick.sessionTypeId);
	}

	private _createNewSession(folderUri: URI): void {
		this._pendingPreferredUpgrade.clear();
		const userPick = this._sessionTypePicker.getUserPickedSessionType();
		const created = this._createSessionNow(folderUri, userPick);
		// Keep the draft in sync with late-registering providers. Agent hosts
		// connect lazily, so there is no timeout — the listener lives until the
		// draft is sent or replaced. We watch when:
		//  - no provider can serve the folder yet (!created),
		//  - the user's explicit pick isn't servable yet (created with a
		//    fallback, upgrade once its provider connects), or
		//  - there is no explicit pick, so the draft tracks the preferred
		//    (first) type, which can change as the folder's session-type list
		//    grows.
		if (!created || !userPick || !this._isPreferredServable(folderUri, userPick)) {
			this._scheduleRecreateOnProviderChange(folderUri, userPick, created);
		}
	}

	private _createSessionNow(folderUri: URI, userPick: IPreferredSessionType | undefined): ISession | undefined {
		// Prefer the user's explicit pick when its provider can serve the
		// folder; otherwise fall back to the preferred (first) session type.
		const effectivePick = userPick && this._isPreferredServable(folderUri, userPick)
			? userPick
			: this._sessionTypePicker.getPreferredSessionType(folderUri);
		if (!effectivePick) {
			this.logService.info(`[Sessions] Backboard session type is not available yet for ${folderUri.toString()}; waiting for provider registration.`);
			return undefined;
		}
		try {
			return this.sessionsService.openNewSession({
				folderUri,
				providerId: effectivePick.providerId,
				sessionTypeId: effectivePick.sessionTypeId,
			});
		} catch (e) {
			this.logService.error('Failed to create new session:', e);
			return undefined;
		}
	}

	private _scheduleRecreateOnProviderChange(folderUri: URI, userPick: IPreferredSessionType | undefined, created: ISession | undefined): void {
		const store = new DisposableStore();
		store.add(this.sessionsManagementService.onDidChangeSessionTypes(() => {
			if (created) {
				const active = this._session.get();
				if (active?.sessionId !== created.sessionId || active.isCreated.get()) {
					return; // the draft was sent or is no longer the active session
				}
				if (userPick) {
					if (!this._isPreferredServable(folderUri, userPick)) {
						return; // the preferred provider still cannot serve the folder
					}
				} else {
					// No explicit pick: keep the draft on the preferred (first)
					// type. Recreate only when that preferred actually changed.
					const preferred = this._sessionTypePicker.getPreferredSessionType(folderUri);
					if (!preferred || (preferred.providerId === active.providerId && preferred.sessionTypeId === active.sessionType)) {
						return;
					}
				}
			}
			this._createNewSession(folderUri);
		}));
		this._pendingPreferredUpgrade.value = store;
	}

	private _renderWorkspacePicker(container: HTMLElement): IDisposable {
		const pickersRow = dom.append(container, dom.$('.session-workspace-picker'));
		const pickersLabel = dom.append(pickersRow, dom.$('.session-workspace-picker-label'));
		pickersLabel.textContent = this._workspacePicker.selectedFolderUri
			? localize('newSessionIn', "New session in")
			: localize('newSessionChooseWorkspace', "Start by picking a");

		this._workspacePicker.render(pickersRow);

		return this._workspacePicker.onDidSelectWorkspace(() => {
			const folderUri = this._workspacePicker.selectedFolderUri;
			pickersLabel.textContent = folderUri
				? localize('newSessionIn', "New session in")
				: localize('newSessionChooseWorkspace', "Start by picking a");
		});
	}

	private _renderEmptyState(container: HTMLElement): IDisposable {
		const emptyState = this.instantiationService.createInstance(NoAgentHostEmptyState);
		emptyState.render(container);
		this._activeEmptyState = emptyState;
		return {
			dispose: () => {
				if (this._activeEmptyState === emptyState) {
					this._activeEmptyState = undefined;
				}
				emptyState.dispose();
			},
		};
	}

	/**
	 * Web-only: hosts the workspace picker, but swaps it out for the
	 * no-agent-host empty state once we are *sure* there are no hosts —
	 * i.e. after a discovery cycle has completed. Rendering the empty
	 * state before discovery has run would briefly flash it at users who
	 * actually have hosts that just haven't been discovered yet (e.g.
	 * cached tunnels resolved on startup). Until then we keep the regular
	 * workspace picker, which has its own loading affordance.
	 */
	private _renderEmptyStateGate(container: HTMLElement, chatWidgetContent: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const pickerSlot = dom.append(container, dom.$('.session-workspace-picker-slot'));
		const stateDisposables = store.add(new MutableDisposable());

		const showPicker = () => {
			chatWidgetContent.classList.remove('no-agent-host');
			dom.clearNode(pickerSlot);
			stateDisposables.value = this._renderWorkspacePicker(pickerSlot);
		};

		const showEmptyState = () => {
			chatWidgetContent.classList.add('no-agent-host');
			dom.clearNode(pickerSlot);
			stateDisposables.value = this._renderEmptyState(pickerSlot);
		};

		const filter = this.agentHostFilterService;
		let hasCompletedDiscovery = filter.hosts.length > 0;

		// If no discovery cycle is in flight or has completed yet, kick one
		// off so the empty state can resolve in a bounded time. The
		// `tunnelAgentHost.contribution` already triggers a startup
		// rediscover, but in the (rare) case the view mounts before the
		// contribution gets a chance, this prevents the user from being
		// stuck on a picker that never gets populated.
		if (!hasCompletedDiscovery && !filter.isDiscovering) {
			filter.rediscover();
		}

		const update = () => {
			if (hasCompletedDiscovery && !filter.isDiscovering && filter.hosts.length === 0) {
				showEmptyState();
			} else {
				showPicker();
			}
		};

		update();

		// `onDidChange` fires when the host list changes — entering or
		// leaving the empty state if the last host disconnects or the
		// first host appears.
		store.add(filter.onDidChange(() => {
			if (filter.hosts.length > 0) {
				hasCompletedDiscovery = true;
			}
			update();
		}));
		// `onDidChangeDiscovering` fires on discovery start *and* end; we
		// treat any transition out of discovering as having completed at
		// least one cycle.
		store.add(filter.onDidChangeDiscovering(() => {
			if (!filter.isDiscovering) {
				hasCompletedDiscovery = true;
			}
			update();
		}));

		return store;
	}

	// --- Send ---

	private async _send(options: ISendRequestOptions): Promise<boolean> {
		const session = this._session.get();
		if (!session) {
			this._workspacePicker.showPicker();
			return false;
		}

		// Capture the composer's workspace selection before the send: a
		// background send consumes the in-flight new session and resets the
		// new-session view, so we re-seed a fresh pending session afterwards
		// (see below) to keep the composer's pickers functional.
		const reseedFolderUri = options.background ? this._workspacePicker.selectedFolderUri : undefined;

		try {
			await this.sessionsManagementService.sendNewChatRequest(session, options);
		} catch (e) {
			this.logService.error('Failed to send request:', e);
			return false;
		}

		// A background send graduated the composer's in-flight session and
		// returned the view to a fresh (but session-less) new-session composer.
		// The send now commits in the background, so reseed a replacement draft
		// immediately — providers are multi-new-session aware, so the graduating
		// session and this new draft coexist. This restores the
		// session-type/model pickers for the next message.
		if (options.background && reseedFolderUri) {
			this._createNewSession(reseedFolderUri);
		}
		return true;
	}

	private async _sendFromSharedComposer(query: string): Promise<boolean> {
		const input = this._widget.inputPart;
		let session = this._session.get();
		if (!session) {
			const folderUri = this._workspacePicker.selectedFolderUri;
			if (folderUri) {
				await this._onWorkspaceSelected(folderUri);
				session = this._session.get();
			}
			if (!session) {
				const selectedFolder = await this._promptForFirstSendWorkspace();
				if (!selectedFolder || !await this._selectWorkspaceForFirstSend(selectedFolder)) {
					this._widget.setInput(query);
					this._widget.focusInput();
					return true;
				}
				session = this._session.get();
				if (!session) {
					this._widget.setInput(query);
					this._widget.focusInput();
					await this.dialogService.error(
						localize('newChatWorkspaceUnavailable', "Backboard could not start a session in that directory."),
						localize('newChatWorkspaceUnavailableDetail', "Choose a different directory and try again.")
					);
					return true;
				}
			}
		}
		const provider = this.sessionsProvidersService.getProvider(session.providerId);
		if (input.currentLanguageModel) {
			provider?.setModel(session.sessionId, input.currentLanguageModel);
		}
		const modeKind = input.currentModeKind;
		const sendOptions: ISendRequestOptions = {
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
		};
		await input.acceptInput(true, true);
		const sent = await this._send(sendOptions);
		if (!sent) {
			this._widget.setInput(query);
		}
		return true;
	}

	private async _promptForFirstSendWorkspace(): Promise<URI | undefined> {
		const choice = await this._showFirstSendWorkspaceModal();
		switch (choice) {
			case 'selectFolder':
				return this._pickWorkspaceFolderForFirstSend();
			case 'createFolder':
				return this._createDesktopWorkspaceFolder();
			default:
				return undefined;
		}
	}

	private _showFirstSendWorkspaceModal(): Promise<FirstSendWorkspaceChoice> {
		const host = this._chatWidgetContent;
		if (!host) {
			return Promise.resolve(undefined);
		}

		return new Promise(resolve => {
			const store = new DisposableStore();
			const overlay = dom.append(host, dom.$('.new-chat-folder-modal-overlay'));
			const modal = dom.append(overlay, dom.$('.new-chat-folder-modal'));
			modal.tabIndex = -1;
			modal.setAttribute('role', 'dialog');
			modal.setAttribute('aria-modal', 'true');

			const closeButton = dom.append(modal, dom.$('button.new-chat-folder-modal-close')) as HTMLButtonElement;
			closeButton.type = 'button';
			closeButton.setAttribute('aria-label', localize('newChatFolderModalClose', "Close"));
			closeButton.appendChild(renderIcon(Codicon.close));

			const title = dom.append(modal, dom.$('h2.new-chat-folder-modal-title'));
			title.textContent = localize('newChatSelectDirectoryTitle', "Where should Backboard work?");

			const message = dom.append(modal, dom.$('p.new-chat-folder-modal-message'));
			message.textContent = localize('newChatSelectDirectoryMessage', "Backboard needs a place on your computer to store the files it creates and edits for this project.");

			const detail = dom.append(modal, dom.$('p.new-chat-folder-modal-detail'));
			detail.textContent = localize('newChatSelectDirectoryDetail', "Don't have one? We can create one for you!");

			const actions = dom.append(modal, dom.$('.new-chat-folder-modal-actions'));
			const selectButton = dom.append(actions, dom.$('button.new-chat-folder-modal-button.secondary')) as HTMLButtonElement;
			selectButton.type = 'button';
			selectButton.textContent = localize('newChatSelectDirectoryButton', "Select a folder");

			let createButton: HTMLButtonElement | undefined;
			if (!isWeb) {
				createButton = dom.append(actions, dom.$('button.new-chat-folder-modal-button.primary')) as HTMLButtonElement;
				createButton.type = 'button';
				createButton.textContent = localize('newChatWorkInDesktopButton', "Create a folder");
			}

			let settled = false;
			const finish = (choice: FirstSendWorkspaceChoice) => {
				if (settled) {
					return;
				}
				settled = true;
				store.dispose();
				overlay.remove();
				resolve(choice);
			};

			store.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => finish(undefined)));
			store.add(dom.addDisposableListener(selectButton, dom.EventType.CLICK, () => finish('selectFolder')));
			if (createButton) {
				store.add(dom.addDisposableListener(createButton, dom.EventType.CLICK, () => finish('createFolder')));
			}
			store.add(dom.addDisposableListener(overlay.ownerDocument, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					finish(undefined);
				}
			}));

			setTimeout(() => (createButton ?? selectButton).focus(), 0);
		});
	}

	private async _pickWorkspaceFolderForFirstSend(): Promise<URI | undefined> {
		const result = await this.fileDialogService.showOpenDialog({
			title: localize('newChatSelectDirectoryDialogTitle', "Choose a Folder for Backboard"),
			openLabel: localize('newChatSelectDirectoryOpenLabel', "Choose Folder"),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		return result?.[0];
	}

	private async _createDesktopWorkspaceFolder(): Promise<URI | undefined> {
		const folderName = await this._promptForDesktopWorkspaceFolderName();
		if (!folderName) {
			return undefined;
		}

		try {
			const home = await this.pathService.userHome({ preferLocal: true });
			const desktop = URI.joinPath(home, 'Desktop');
			const folderUri = await this._getAvailableDesktopWorkspaceFolder(desktop, folderName);
			await this.fileService.createFolder(folderUri);
			return folderUri;
		} catch (error) {
			this.logService.error('[NewChatWidget] Failed to create Desktop workspace folder', error);
			await this.dialogService.error(
				localize('newChatCreateDesktopWorkspaceFailed', "Backboard could not create a new folder on Desktop."),
				localize('newChatCreateDesktopWorkspaceFailedDetail', "Choose a folder instead and try again.")
			);
			return undefined;
		}
	}

	private async _promptForDesktopWorkspaceFolderName(): Promise<string | undefined> {
		return this._showFolderNameModal();
	}

	private _showFolderNameModal(): Promise<string | undefined> {
		const host = this._chatWidgetContent;
		if (!host) {
			return Promise.resolve(undefined);
		}

		return new Promise(resolve => {
			const store = new DisposableStore();
			const overlay = dom.append(host, dom.$('.new-chat-folder-modal-overlay'));
			const modal = dom.append(overlay, dom.$('.new-chat-folder-modal'));
			modal.tabIndex = -1;
			modal.setAttribute('role', 'dialog');
			modal.setAttribute('aria-modal', 'true');

			const closeButton = dom.append(modal, dom.$('button.new-chat-folder-modal-close')) as HTMLButtonElement;
			closeButton.type = 'button';
			closeButton.setAttribute('aria-label', localize('newChatFolderModalClose', "Close"));
			closeButton.appendChild(renderIcon(Codicon.close));

			const title = dom.append(modal, dom.$('h2.new-chat-folder-modal-title'));
			title.textContent = localize('newChatCreateFolderTitle', "Name this project folder");

			const message = dom.append(modal, dom.$('p.new-chat-folder-modal-message'));
			message.textContent = localize('newChatCreateFolderMessage', "Backboard will create this folder on your Desktop.");

			const field = dom.append(modal, dom.$('.new-chat-folder-modal-field'));
			const label = dom.append(field, dom.$('label.new-chat-folder-modal-label')) as HTMLLabelElement;
			const inputId = `new-chat-folder-name-${Date.now()}`;
			label.htmlFor = inputId;
			label.textContent = localize('newChatCreateFolderLabel', "Folder name");
			const input = dom.append(field, dom.$('input.new-chat-folder-modal-input')) as HTMLInputElement;
			input.id = inputId;
			input.type = 'text';
			input.autocomplete = 'off';
			input.spellcheck = false;
			input.placeholder = localize('newChatCreateFolderPlaceholder', "My project");
			const error = dom.append(field, dom.$('.new-chat-folder-modal-error'));
			error.setAttribute('aria-live', 'polite');

			const actions = dom.append(modal, dom.$('.new-chat-folder-modal-actions'));
			const createButton = dom.append(actions, dom.$('button.new-chat-folder-modal-button.primary')) as HTMLButtonElement;
			createButton.type = 'button';
			createButton.textContent = localize('newChatCreateFolderButton', "Create folder");

			let settled = false;
			const finish = (folderName: string | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				store.dispose();
				overlay.remove();
				resolve(folderName);
			};
			const submit = () => {
				const folderName = this._sanitizeDesktopWorkspaceFolderName(input.value);
				if (!folderName) {
					error.textContent = localize('newChatCreateFolderInvalidName', "Enter a folder name.");
					input.focus();
					return;
				}
				finish(folderName);
			};

			store.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => finish(undefined)));
			store.add(dom.addDisposableListener(createButton, dom.EventType.CLICK, submit));
			store.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					event.stopPropagation();
					submit();
				}
			}));
			store.add(dom.addDisposableListener(overlay.ownerDocument, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					finish(undefined);
				}
			}));
			store.add(dom.addDisposableListener(input, 'input', () => {
				if (error.textContent) {
					error.textContent = '';
				}
			}));

			setTimeout(() => input.focus(), 0);
		});
	}

	private async _getAvailableDesktopWorkspaceFolder(desktop: URI, baseName: string): Promise<URI> {
		for (let index = 1; index <= 100; index++) {
			const name = index === 1 ? baseName : `${baseName} ${index}`;
			const candidate = URI.joinPath(desktop, name);
			if (!await this.fileService.exists(candidate)) {
				return candidate;
			}
		}
		return URI.joinPath(desktop, `${baseName} ${Date.now()}`);
	}

	private _sanitizeDesktopWorkspaceFolderName(name: string): string {
		return name
			.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[. ]+$/g, '');
	}

	private async _selectWorkspaceForFirstSend(folderUri: URI): Promise<boolean> {
		this._workspacePicker.setSelectedWorkspace(folderUri, { fireEvent: false });
		await this._onWorkspaceSelected(folderUri);
		return !!this._session.get();
	}

	private async _requestFolderTrust(folderUri: URI): Promise<boolean> {
		const trusted = await this.workspaceTrustRequestService.requestResourcesTrust({
			uri: folderUri,
			message: localize('trustFolderMessage', "An agent session will be able to read files, run commands, and make changes in this folder."),
		});
		if (!trusted) {
			this._workspacePicker.removeFromRecents(folderUri);
		}
		return !!trusted;
	}

	saveState(): void {
	}

	layout(_height: number, _width: number): void {
		const width = this._composerStackElement?.clientWidth || this._chatWidgetContent?.clientWidth || _width;
		this._widget.layout(NEW_CHAT_COMPOSER_LAYOUT_HEIGHT, width);
	}

	focusInput(): void {
		// While the empty state is mounted, the chat input is hidden via
		// CSS (`.no-agent-host` on `.new-chat-widget-content`) so focusing
		// it would just send focus to <body>. Land on the empty state's
		// heading instead so the user has a visible focus target.
		if (this._activeEmptyState) {
			this._activeEmptyState.focus();
			return;
		}
		this._widget.focusInput();
		this._widget.input.inputEditor.focus();
	}

	/**
	 * Handles a workspace selection from the workspace picker.
	 * Requests folder trust if needed and creates a new session.
	 */
	private async _onWorkspaceSelected(folderUri: URI | undefined): Promise<void> {
		// Cancel any in-flight upgrade for a previous selection.
		this._pendingPreferredUpgrade.clear();

		if (!folderUri) {
			this.sessionsService.unsetNewSession();
			return;
		}

		const resolved = this.sessionsManagementService.resolveWorkspace(folderUri);
		if (resolved?.workspace.requiresWorkspaceTrust) {
			if (!await this._requestFolderTrust(folderUri)) {
				return;
			}
		}

		if (!this._store.isDisposed) {
			this._createNewSession(folderUri);
		}
	}

	prefillInput(text: string): void {
		this._widget.setInput(text);
	}

	setHostVisible(_visible: boolean): void {
	}

	sendQuery(text: string): void {
		this._widget.acceptInput(text).catch(err => this.logService.error('[NewChatWidget] Failed to send query', err));
	}

	attach(uris: URI[]): void {
		for (const uri of uris) {
			this._widget.attachmentModel.addFile(uri).catch(err => this.logService.error('[NewChatWidget] Failed to attach file as context', err));
		}
	}

	selectWorkspace(folderUri: URI, providerId?: string): void {
		this._workspacePicker.setSelectedWorkspace(folderUri, { providerId });
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
		this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'NewChatWidget').then(ref => {
			if (token.isCancellationRequested || !ref) {
				ref?.dispose();
				return;
			}
			this._modelRef.value = ref;
			this._widget.setModel(ref.object);
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[NewChatWidget] Failed to load chat model', err);
			}
		});
	}
}

// #endregion
