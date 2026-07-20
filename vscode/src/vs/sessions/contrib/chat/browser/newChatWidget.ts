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
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derivedObservableWithCache, IObservable, observableSignalFromEvent, observableValue } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { IActiveSession, ISendRequestOptions, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
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

/**
 * Agent-host session types offered in the new-chat session-type (agent)
 * picker. Claude / Codex only surface when their gates are on (the
 * `preferAgentHost` preference for Claude, `chat.agentHost.codexAgent.enabled`
 * for Codex) — the picker intersects this allowlist with the session types the
 * providers actually advertise.
 */
const NEW_CHAT_ALLOWED_SESSION_TYPES = [
	AgentSessionProviders.AgentHostBackboard,
	AgentSessionProviders.AgentHostClaude,
	AgentSessionProviders.AgentHostCodex,
	AgentSessionProviders.AgentHostOpencode,
];

const NEW_CHAT_COMPOSER_LAYOUT_HEIGHT = 180;
const NEW_CHAT_COMPOSER_INPUT_MAX_HEIGHT = 260;
type FirstSendWorkspaceChoice = 'selectFolder' | 'createFolder' | undefined;

/**
 * 8-bit octopus mascot shown above the composer. The sprite is drawn from
 * character maps ('.' = transparent) so it is easy to tweak pixels or colors.
 */
const OCTOPUS_PALETTE: { [pixel: string]: string } = {
	B: '#3b82f6',	// body
	D: '#2257c4',	// dark shade (mouth, closed eyes)
	L: '#8ab8ff',	// highlight
	W: '#ffffff',	// eye
	P: '#0f172a',	// pupil
};

const OCTOPUS_HEAD = [
	'....BBBBBBBB....',
	'..BBLLBBBBBBBB..',
	'.BBLBBBBBBBBBBB.',
	'.BBWWWBBBBWWWBB.',
	'BBBWPWBBBBWPWBBB',
	'BBBWWWBBBBWWWBBB',
	'BBBBBBBDDBBBBBBB',
	'BBBBBBBBBBBBBBBB',
	'.BBBBBBBBBBBBBB.',
];

/** Row of {@link OCTOPUS_HEAD} where the eyes start; the blink overlay is anchored here. */
const OCTOPUS_EYE_ROW = 3;

/** Resting tentacle frame (rows continue below {@link OCTOPUS_HEAD}). */
const OCTOPUS_TENTACLES_A = [
	'.BB..BB..BB..BB.',
	'.BB..BB..BB..BB.',
	'BB..BB....BB..BB',
	'BB..BB....BB..BB',
];

/** Wiggle tentacle frame, alternated with frame A during the idle animation. */
const OCTOPUS_TENTACLES_B = [
	'.BB..BB..BB..BB.',
	'.BB..BB..BB..BB.',
	'..BB..BBBB..BB..',
	'..BB..BBBB..BB..',
];

/** Closed-eye overlay flashed briefly for the occasional blink. */
const OCTOPUS_EYELIDS = [
	'...BBB....BBB...',
	'...DDD....DDD...',
	'...BBB....BBB...',
];

/**
 * Empty columns reserved on each side of the head, and empty rows above it,
 * so the sleep Z's have room to drift up. The non-flip frames are drawn
 * shifted by these offsets.
 */
const OCTOPUS_CANVAS_PAD = 4;
const OCTOPUS_ROW_PAD = 7;

/**
 * Subtle flip-off: one middle tentacle rises modestly in front of the face
 * (dark shade so it silhouettes against the body, light tip) while the
 * others keep hanging. A second frame leans the tip for a tiny waggle. Drawn
 * shifted by the canvas padding so it lines up with the tentacles; no scale
 * lunge, no giant fist — a quick, understated flip. */
const OCTOPUS_FLIP_ROW = OCTOPUS_ROW_PAD + 2;
const OCTOPUS_FLIP = [
	'.......LL.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.BB..BB......BB.',
	'.BB..BB......BB.',
	'BB..BB........BB',
	'BB..BB........BB',
];

const OCTOPUS_FLIP_WAGGLE = [
	'......LL........',
	'......DD........',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.......DD.......',
	'.BB..BB......BB.',
	'.BB..BB......BB.',
	'BB..BB........BB',
	'BB..BB........BB',
];

/**
 * Soccer keep-ups: the outlined ball bounces on the left while the left
 * outer tentacle kicks (kick = ball low + leg swung up; up = ball high +
 * all tentacles hanging). Both frames include the full tentacle set, so
 * frame A is hidden while they show.
 */
const OCTOPUS_SOCCER_UP_ROW = 1;
const OCTOPUS_SOCCER_UP = [
	'.PPPP...................',
	'PDWWWP..................',
	'PWDDWP..................',
	'PWDDWP..................',
	'PWWWDP..................',
	'.PPPP...................',
	'........................',
	'........................',
	'........................',
	'........................',
	'........................',
	'........................',
	'........................',
	'........................',
	'........................',
	'.....BB..BB..BB..BB.....',
	'.....BB..BB..BB..BB.....',
	'....BB..BB....BB..BB....',
	'....BB..BB....BB..BB....',
];

const OCTOPUS_SOCCER_KICK_ROW = 7;
const OCTOPUS_SOCCER_KICK = [
	'.PPPP...................',
	'PWWWDP..................',
	'PWDDWP..................',
	'PWDDWP..................',
	'PDWWWP..................',
	'.PPPP...................',
	'..BB....................',
	'...BB...................',
	'....BB..................',
	'.........BB..BB..BB.....',
	'.........BB..BB..BB.....',
	'........BB....BB..BB....',
	'........BB....BB..BB....',
];

/**
 * Weight lifting: a barbell (dark bar and plates) pressed from chin level
 * (low) to overhead lockout (high, with the two side tentacles extended
 * above the head). The hanging tentacles stay in frame A throughout.
 */
const OCTOPUS_LIFT_LOW_ROW = 11;
const OCTOPUS_LIFT_LOW = [
	'.DD..................DD.',
	'.DDDDDDDDDDDDDDDDDDDDDD.',
	'.DD..................DD.',
];

const OCTOPUS_LIFT_HIGH_ROW = 1;
const OCTOPUS_LIFT_HIGH = [
	'.DD..................DD.',
	'.DDDDDDDDDDDDDDDDDDDDDD.',
	'.DD..................DD.',
	'......BB........BB......',
	'......BB........BB......',
	'......BB........BB......',
];

/**
 * Dozing off right before the flip-off, so it jolts awake for the fist.
 * The closed-eye lids stay on for the whole nap while a Z is born small
 * by the head (z1), drifts up-right growing (z2), and floats off the top
 * corner (z3) — the three stages cycle so Z's stream up continuously.
 */
const OCTOPUS_SLEEP_LIDS_ROW = 10;
const OCTOPUS_SLEEP_LIDS = [
	'.......BBB....BBB.......',
	'.......DDD....DDD.......',
	'.......BBB....BBB.......',
];

const OCTOPUS_SLEEP_Z1_ROW = 7;
const OCTOPUS_SLEEP_Z1 = [
	'..................PPP...',
	'...................P....',
	'..................PPP...',
];

const OCTOPUS_SLEEP_Z2_ROW = 4;
const OCTOPUS_SLEEP_Z2 = [
	'...................PPPP.',
	'.....................P..',
	'....................P...',
	'...................PPPP.',
];

const OCTOPUS_SLEEP_Z3_ROW = 0;
const OCTOPUS_SLEEP_Z3 = [
	'....................PPPP',
	'......................P.',
	'.....................P..',
	'....................PPPP',
];

/**
 * The most recently constructed composer, used only by the test-only
 * "Backboard: Reset Composer Workspace (Test)" command to reach the live
 * instance (the composer is a widget, not a service). Cleared on dispose.
 */
let activeComposerForTest: NewChatWidget | undefined;

export class NewChatWidget extends Disposable {

	private readonly _workspacePicker: WorkspacePicker;
	private readonly _sessionTypePicker: SessionTypePicker;
	private readonly _widget: ChatWidget;
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private _currentChatResource: URI | undefined;
	private _chatWidgetContent: HTMLElement | undefined;
	private _composerStackElement: HTMLElement | undefined;
	private _composerWorkspaceRowElement: HTMLElement | undefined;
	/** Set once the composer has seeded (or confirmed) a default workspace so it never re-seeds after an explicit clear. See {@link _ensureComposerHasWorkspace}. */
	private _defaultWorkspaceHandled = false;
	/**
	 * The user's `~/Desktop` folder (or `~` if Desktop does not exist),
	 * resolved only after the workspace picker's recents have loaded so it can
	 * never win a race against a real recent workspace. Last-resort seed for
	 * {@link _ensureComposerHasWorkspace} so the composer always lands on a
	 * real folder — never the bare "workspace" placeholder — and the model and
	 * Backboard-options pickers render even on a fresh profile with no history.
	 */
	private readonly _defaultFolderFallback = observableValue<URI | undefined>(this, undefined);
	private _middleTitle: HTMLElement | undefined;
	private _middleTitlePrefix: HTMLElement | undefined;
	private _middleTitleSuffix: HTMLElement | undefined;
	/** Slot inside the middle heading that hosts the workspace picker trigger. */
	private _middleTitlePickerSlot: HTMLElement | undefined;
	/** The " with " connector between the workspace and agent picker slots. */
	private _middleTitleConnector: HTMLElement | undefined;
	/** Slot inside the middle heading that hosts the session-type (agent) picker trigger. */
	private _middleTitleTypePickerSlot: HTMLElement | undefined;

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
		// Track the live instance for the test-only reset command.
		activeComposerForTest = this;
		this._register(toDisposable(() => {
			if (activeComposerForTest === this) {
				activeComposerForTest = undefined;
			}
		}));
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

		this._sessionTypePicker = this._register(this.instantiationService.createInstance(SessionTypePicker, this._session, () => this._workspacePicker.selectedFolderUri));
		this._sessionTypePicker.setAllowedSessionTypeIds(NEW_CHAT_ALLOWED_SESSION_TYPES);

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
			getActiveSessionProvider: () =>
				this._sessionTypePicker.getPickedChatSessionType(this._workspacePicker.selectedFolderUri)
				?? AgentSessionProviders.AgentHostBackboard,
			setActiveSessionProvider: provider => this._sessionTypePicker.selectSessionTypeById(provider, this._workspacePicker.selectedFolderUri),
			getAllowedSessionProviders: () => NEW_CHAT_ALLOWED_SESSION_TYPES,
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
		// The workspace picker trigger lives inside the middle heading (the
		// heading is the dropdown), so the composer workspace row is only needed
		// on web as a host for the no-agent-host empty state.
		const emptyStateContainer = isWeb ? this._renderComposerWorkspaceRow(composerStack) : undefined;
		this._widget.render(composerStack);
		this._mountComposerSessionTypePicker(composerStack);
		this._placeWorkspaceRowBelowInput(composerStack);
		// On web (vscode.dev / insiders.vscode.dev) the workspace picker is
		// scoped to the currently selected agent host. When no hosts are
		// known there is nothing for the user to pick, so swap the picker
		// out for the no-agent-host empty state. On Electron desktop the
		// regular picker is always functional (the local Copilot provider
		// is always available) so this branch is web-only.
		if (emptyStateContainer) {
			this._register(this._renderEmptyStateGate(emptyStateContainer, chatWidgetContent));
		} else {
			this._mountTitleWorkspacePicker();
		}

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

		this._ensureComposerHasWorkspace();

		chatWidgetContainer.classList.add('revealed');
	}

	/**
	 * The composer's model and Backboard-options controls bind to the active
	 * session, and a session requires a workspace. When the composer opens with
	 * no workspace restored or selected, those controls would otherwise render
	 * hidden or stuck "loading". Seed the most recent available workspace so the
	 * controls are functional immediately; the user can still switch workspaces
	 * from the picker.
	 *
	 * A usable default can appear asynchronously — recent-session workspaces
	 * resolve lazily, a serving provider can connect after construction, and VS
	 * Code recent folders load after construction — so this runs in an autorun
	 * that re-evaluates when any of those change. It seeds at most once, so it
	 * never fights the user explicitly clearing the workspace afterwards.
	 */
	private _ensureComposerHasWorkspace(): void {
		// Resolve the Desktop fallback only once the picker's recents have
		// loaded, so a real recent workspace always wins the seed below. Prefer
		// ~/Desktop; fall back to ~ only when Desktop does not exist.
		this._workspacePicker.whenInitialRecentsLoaded
			.then(() => this.pathService.userHome({ preferLocal: true }))
			.then(async home => {
				const desktop = URI.joinPath(home, 'Desktop');
				return (await this.fileService.exists(desktop)) ? desktop : home;
			})
			.then(folder => {
				if (!this._store.isDisposed) {
					this._defaultFolderFallback.set(folder, undefined);
				}
			}, () => { /* no home available — leave the composer unseeded */ });

		// Signals, not observableFromEvent(..., () => undefined): a constant
		// mapped value is deduplicated by the equality comparator, so such an
		// observable never fires again after the first read and the autorun
		// would never re-run when the home fallback resolves later.
		const pickerChanged = observableSignalFromEvent(this, this._workspacePicker.onDidChangeSelection);
		const sessionTypesChanged = observableSignalFromEvent(this, this.sessionsManagementService.onDidChangeSessionTypes);
		this._register(autorun(reader => {
			if (this._defaultWorkspaceHandled) {
				return;
			}
			// Subscribe to everything that can make (or already has made) a
			// workspace available so the autorun re-runs as they settle: the
			// picker's recents, a serving provider connecting, the active draft,
			// and the recent sessions' lazily-resolved workspaces. The decision
			// itself lives in {@link _seedDefaultWorkspaceIfNeeded} so the test
			// "reset" command can re-run it on demand.
			pickerChanged.read(reader);
			sessionTypesChanged.read(reader);
			this._session.read(reader);
			this.sessionsService.visibleSessions.read(reader);
			this._defaultFolderFallback.read(reader);
			const { recent, other } = this.sessionsService.getRecentlyOpenedSessions();
			for (const session of [...recent, ...other]) {
				session.workspace.read(reader);
			}
			this._seedDefaultWorkspaceIfNeeded();
		}));
	}

	/**
	 * Seeds the composer's workspace from the best available default when none
	 * is selected yet, so the model and Backboard-options pickers render. Order
	 * of preference: the most recent servable session's folder, then the
	 * workspace picker's recents, then the user's Desktop. No-op once a
	 * session/selection exists (marks {@link _defaultWorkspaceHandled} so it is
	 * never re-seeded from under an explicit user clear). Reads current values
	 * synchronously; the caller (the seeding autorun) owns the reactive reads.
	 */
	private _seedDefaultWorkspaceIfNeeded(): void {
		if (this._defaultWorkspaceHandled) {
			return;
		}
		if (this._session.get() || this._workspacePicker.selectedFolderUri) {
			this._defaultWorkspaceHandled = true;
			return;
		}

		const { recent, other } = this.sessionsService.getRecentlyOpenedSessions();
		const sessions = [...recent, ...other];
		const candidate = this._recentSessionFolder(sessions) ?? this._workspacePicker.getDefaultWorkspaceCandidate();
		if (candidate) {
			this._defaultWorkspaceHandled = true;
			this._workspacePicker.setSelectedWorkspace(candidate);
			return;
		}

		// Fresh profile with no recent sessions or folders anywhere: seed the
		// user's Desktop so the composer always lands on a real folder (never
		// the bare "workspace" placeholder) and its model and Backboard-options
		// controls still render. The draft is created without the upfront trust
		// prompt (nothing was user-initiated yet); {@link _sendFromSharedComposer}
		// requests folder trust before the first send instead.
		const fallback = this._defaultFolderFallback.get();
		if (fallback && this.sessionsManagementService.getSessionTypesForFolder(fallback).length > 0) {
			this._defaultWorkspaceHandled = true;
			this._workspacePicker.setSelectedWorkspace(fallback, { fireEvent: false });
			// Defer draft creation: creating a session activates it (mutating
			// observables the seeding autorun reads), which must not happen
			// mid-read.
			queueMicrotask(() => {
				if (!this._store.isDisposed && !this._session.get()) {
					this._createNewSession(fallback);
				}
			});
		}
	}

	/**
	 * Test affordance (Command Palette: "Backboard: Reset Composer Workspace
	 * (Test)"): drop the current workspace selection and draft, then re-run the
	 * default-workspace seeding so the no-workspace → seeded transition (and the
	 * model/options pickers appearing) can be exercised without relaunching
	 * against an empty profile.
	 */
	resetAndReseedWorkspaceForTest(): void {
		this._defaultWorkspaceHandled = false;
		this.sessionsService.unsetNewSession();
		this._workspacePicker.clearSelection();
		this._seedDefaultWorkspaceIfNeeded();
	}

	/**
	 * The workspace folder of the most recently opened session that can still
	 * be served by a registered provider, or `undefined` when there is none.
	 */
	private _recentSessionFolder(sessions: readonly ISession[]): URI | undefined {
		for (const session of sessions) {
			const root = session.workspace.get()?.folders[0]?.root;
			if (root && this.sessionsManagementService.getSessionTypesForFolder(root).length > 0) {
				return root;
			}
		}
		return undefined;
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
		this._composerWorkspaceRowElement = row;
		const pickerSlot = dom.append(row, dom.$('.new-session-workspace-picker-container'));
		return pickerSlot;
	}

	/**
	 * Move the workspace row so it sits directly beneath the input card (and
	 * above the category buttons) instead of on top of the composer. The input's
	 * category buttons live inside the chat widget's `.interactive-input-part`
	 * sibling area, so the row has to be relocated into that flex flow — right
	 * after the input part — for the "drawer sliding out from under the input"
	 * layout. No-op if either element is missing.
	 */
	private _placeWorkspaceRowBelowInput(composerStack: HTMLElement): void {
		const row = this._composerWorkspaceRowElement;
		const inputPart = composerStack.querySelector('.interactive-input-part');
		if (row && inputPart) {
			inputPart.insertAdjacentElement('afterend', row);
		}
	}

	private _renderMiddleSection(container: HTMLElement): void {
		const actions = dom.append(container, dom.$('.new-chat-middle-toolbar'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, actions, Menus.NewSessionToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			toolbarOptions: { primaryGroup: () => true },
		}));
		const middle = dom.append(container, dom.$('.new-chat-middle-section'));

		// The heading embeds the workspace picker trigger mid-sentence: "What
		// should we build in [workspace ▾]?". The prefix/suffix spans carry the
		// localized sentence around the picker slot; the picker itself renders
		// and maintains the workspace name.
		this._middleTitle = dom.append(middle, dom.$('h2.new-chat-middle-title'));
		this._middleTitlePrefix = dom.append(this._middleTitle, dom.$('span.new-chat-middle-title-text'));
		this._middleTitlePickerSlot = dom.append(this._middleTitle, dom.$('span.new-chat-middle-title-picker'));
		this._middleTitleConnector = dom.append(this._middleTitle, dom.$('span.new-chat-middle-title-text.session-workspace-picker-with-label'));
		this._middleTitleTypePickerSlot = dom.append(this._middleTitle, dom.$('span.new-chat-middle-title-picker.sessions-chat-session-type-picker'));
		this._middleTitleSuffix = dom.append(this._middleTitle, dom.$('span.new-chat-middle-title-text'));
		this._updateMiddleTitle();
		this._renderPixelOctopus(this._middleTitle);
	}

	/**
	 * Renders the 8-bit octopus mascot just left of the heading text
	 * (absolutely positioned, so it takes no layout row). Pixel rows are
	 * merged into horizontal run rects to keep the node count low and
	 * avoid hairline seams when the sprite scales.
	 */
	private _renderPixelOctopus(container: HTMLElement): void {
		const host = dom.append(container, dom.$('.new-chat-octopus'));
		host.setAttribute('aria-hidden', 'true');
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.classList.add('octo-sprite');
		const columns = OCTOPUS_HEAD[0].length + 2 * OCTOPUS_CANVAS_PAD;
		const rows = OCTOPUS_ROW_PAD + OCTOPUS_HEAD.length + OCTOPUS_TENTACLES_A.length;
		svg.setAttribute('viewBox', `0 0 ${columns} ${rows}`);
		svg.setAttribute('width', String(columns * 6));
		svg.setAttribute('height', String(rows * 6));
		const appendFrame = (className: string, frame: readonly string[], rowOffset: number, columnOffset: number) => {
			const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			group.classList.add(className);
			for (let y = 0; y < frame.length; y++) {
				const row = frame[y];
				for (let x = 0; x < row.length; x++) {
					const color = OCTOPUS_PALETTE[row[x]];
					if (!color) {
						continue;
					}
					let runEnd = x;
					while (runEnd + 1 < row.length && row[runEnd + 1] === row[x]) {
						runEnd++;
					}
					const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
					rect.setAttribute('x', String(x + columnOffset));
					rect.setAttribute('y', String(y + rowOffset));
					rect.setAttribute('width', String(runEnd - x + 1));
					rect.setAttribute('height', '1');
					rect.setAttribute('fill', color);
					group.appendChild(rect);
					x = runEnd;
				}
			}
			svg.appendChild(group);
		};
		appendFrame('octo-head', OCTOPUS_HEAD, OCTOPUS_ROW_PAD, OCTOPUS_CANVAS_PAD);
		appendFrame('octo-frame-a', OCTOPUS_TENTACLES_A, OCTOPUS_ROW_PAD + OCTOPUS_HEAD.length, OCTOPUS_CANVAS_PAD);
		appendFrame('octo-frame-b', OCTOPUS_TENTACLES_B, OCTOPUS_ROW_PAD + OCTOPUS_HEAD.length, OCTOPUS_CANVAS_PAD);
		appendFrame('octo-soccer-kick', OCTOPUS_SOCCER_KICK, OCTOPUS_SOCCER_KICK_ROW, 0);
		appendFrame('octo-soccer-up', OCTOPUS_SOCCER_UP, OCTOPUS_SOCCER_UP_ROW, 0);
		appendFrame('octo-lift-low', OCTOPUS_LIFT_LOW, OCTOPUS_LIFT_LOW_ROW, 0);
		appendFrame('octo-lift-high', OCTOPUS_LIFT_HIGH, OCTOPUS_LIFT_HIGH_ROW, 0);
		appendFrame('octo-sleep-lids', OCTOPUS_SLEEP_LIDS, OCTOPUS_SLEEP_LIDS_ROW, 0);
		appendFrame('octo-sleep-z1', OCTOPUS_SLEEP_Z1, OCTOPUS_SLEEP_Z1_ROW, 0);
		appendFrame('octo-sleep-z2', OCTOPUS_SLEEP_Z2, OCTOPUS_SLEEP_Z2_ROW, 0);
		appendFrame('octo-sleep-z3', OCTOPUS_SLEEP_Z3, OCTOPUS_SLEEP_Z3_ROW, 0);
		appendFrame('octo-flip', OCTOPUS_FLIP, OCTOPUS_FLIP_ROW, OCTOPUS_CANVAS_PAD);
		appendFrame('octo-flip-waggle', OCTOPUS_FLIP_WAGGLE, OCTOPUS_FLIP_ROW, OCTOPUS_CANVAS_PAD);
		appendFrame('octo-eyelids', OCTOPUS_EYELIDS, OCTOPUS_ROW_PAD + OCTOPUS_EYE_ROW, OCTOPUS_CANVAS_PAD);
		host.appendChild(svg);
	}

	/**
	 * Fills the heading's text around the embedded workspace picker. The
	 * localized template is split on its placeholder so translations can move
	 * the picker anywhere in the sentence.
	 */
	private _updateMiddleTitle(): void {
		if (!this._middleTitlePrefix || !this._middleTitleSuffix) {
			return;
		}
		// The sentence embeds the workspace picker: "... in [workspace]?". The
		// agent picker lives in the composer's toolbar row beside the model
		// picker, not in the heading.
		const workspaceMarker = '\u0000';
		const template = localize('newChatMiddleTitleInFolder', "What should we build in {0}?", workspaceMarker);
		const [prefix, suffix] = template.split(workspaceMarker);
		this._middleTitlePrefix.textContent = prefix;
		if (this._middleTitleConnector) {
			this._middleTitleConnector.textContent = '';
		}
		this._middleTitleSuffix.textContent = suffix ?? '';
	}

	/**
	 * Mounts the workspace picker trigger inside the middle heading so the
	 * heading itself is the workspace dropdown. The picker owns the trigger's
	 * label, click/keyboard handling, and dropdown anchoring, so it keeps
	 * working (and stays in sync with the selection) wherever it is mounted.
	 */
	private _mountTitleWorkspacePicker(): void {
		if (this._middleTitlePickerSlot) {
			this._workspacePicker.render(this._middleTitlePickerSlot);
		}
	}

	/**
	 * Mounts the session-type (agent host) picker inside the composer's bottom
	 * toolbar row, right after the input toolbar that hosts the model picker —
	 * the agent choice belongs with the other send-time options instead of the
	 * heading. Falls back to the heading slot if the embedded widget's toolbar
	 * row cannot be found.
	 */
	private _mountComposerSessionTypePicker(composerStack: HTMLElement): void {
		const inputToolbar = composerStack.querySelector('.chat-input-toolbars > .chat-input-toolbar');
		if (!inputToolbar) {
			if (this._middleTitleTypePickerSlot) {
				dom.clearNode(this._middleTitleTypePickerSlot);
				this._sessionTypePicker.render(this._middleTitleTypePickerSlot, { className: 'sessions-chat-session-type-picker' });
			}
			return;
		}
		const slot = dom.$('.new-chat-composer-type-picker');
		this._sessionTypePicker.render(slot, { className: 'sessions-chat-session-type-picker' });
		// Place the agent host between the model picker and the options gear in
		// the composer's primary toolbar. Switching hosts (or menu/context key
		// changes) rebuilds the entire chat input subtree, which silently drops
		// foreign children — so watch the stable composer root and re-resolve
		// the current toolbar on every mutation, re-inserting when detached.
		const placeSlot = () => {
			const actionsContainer = composerStack.querySelector('.chat-input-toolbars > .chat-input-toolbar .monaco-toolbar .actions-container');
			if (!actionsContainer) {
				return;
			}
			if (slot.parentElement === actionsContainer && slot.isConnected) {
				return;
			}
			const gearItem = actionsContainer.querySelector('.codicon-settings-gear')?.closest('.action-item');
			const pickerItems = actionsContainer.querySelectorAll('.chat-input-picker-item');
			const modelItem = pickerItems.length ? pickerItems[pickerItems.length - 1].closest('.action-item') : null;
			if (gearItem) {
				gearItem.insertAdjacentElement('beforebegin', slot);
			} else if (modelItem) {
				modelItem.insertAdjacentElement('afterend', slot);
			} else {
				actionsContainer.appendChild(slot);
			}
		};
		placeSlot();
		const observer = new MutationObserver(() => placeSlot());
		observer.observe(composerStack, { childList: true, subtree: true });
		this._register(toDisposable(() => observer.disconnect()));
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
			stateDisposables.value = undefined;
			this._mountTitleWorkspacePicker();
		};

		const showEmptyState = () => {
			chatWidgetContent.classList.add('no-agent-host');
			// The middle section (and the picker trigger inside its heading) is
			// hidden via the `no-agent-host` class; clear the slot so a stale
			// trigger is not left behind when the picker later remounts.
			if (this._middleTitlePickerSlot) {
				dom.clearNode(this._middleTitlePickerSlot);
			}
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
		// The seeded home-directory draft skips the trust prompt at creation
		// time (see {@link _ensureComposerHasWorkspace}); request it here, at
		// the first user-initiated send. No dialog is shown when the folder is
		// already trusted (the common, explicitly-picked case).
		if (!await this._ensureSessionWorkspaceTrust(session)) {
			this._widget.setInput(query);
			this._widget.focusInput();
			return true;
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

	/**
	 * Requests workspace trust for the session's folder when its workspace
	 * requires it. Resolves `true` without any UI when the folder is already
	 * trusted or trust is not required, so it is safe to gate every send.
	 */
	private async _ensureSessionWorkspaceTrust(session: IActiveSession): Promise<boolean> {
		const folderUri = session.workspace.get()?.folders[0]?.root;
		if (!folderUri) {
			return true;
		}
		const resolved = this.sessionsManagementService.resolveWorkspace(folderUri);
		if (!resolved?.workspace.requiresWorkspaceTrust) {
			return true;
		}
		return this._requestFolderTrust(folderUri);
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

/**
 * Test-only command: clears the composer's workspace + draft and re-runs the
 * default-workspace seeding, so the no-workspace → seeded transition (and the
 * model/Backboard-options pickers appearing) can be exercised in a running
 * instance without relaunching against an empty profile.
 */
registerAction2(class ResetComposerWorkspaceForTestAction extends Action2 {
	static readonly ID = 'backboard.newChat.resetComposerWorkspaceForTest';
	constructor() {
		super({
			id: ResetComposerWorkspaceForTestAction.ID,
			title: localize2('newChat.resetComposerWorkspaceForTest', "Reset Composer Workspace (Test)"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}
	override async run(_accessor: ServicesAccessor): Promise<void> {
		activeComposerForTest?.resetAndReseedWorkspaceForTest();
	}
});

// #endregion
