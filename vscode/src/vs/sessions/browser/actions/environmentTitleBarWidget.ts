/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/environmentTitleBarWidget.css';

import { $, addDisposableListener, append, clearNode, EventHelper, EventType, getWindow } from '../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { autorun, IReader, observableValue } from '../../../base/common/observable.js';
import { basename } from '../../../base/common/resources.js';
import { IAction } from '../../../base/common/actions.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { SessionConfigKey } from '../../../platform/agentHost/common/sessionConfigKeys.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IGitRepository, IGitService } from '../../../workbench/contrib/git/common/gitService.js';
import { ISCMRepository, ISCMService } from '../../../workbench/contrib/scm/common/scm.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../workbench/common/contextkeys.js';
import { Menus } from '../menus.js';
import { isAgentHostProvider } from '../../common/agentHostSessionsProvider.js';
import { IsNewChatSessionContext, IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../common/contextkeys.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISession, ISessionFolder, ISessionWorkspace } from '../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { RightWorkbenchCommandId } from '../../contrib/rightWorkbench/browser/rightWorkbench.js';

export class ShowEnvironmentPopupAction extends Action2 {
	static readonly ID = 'workbench.action.sessions.showEnvironmentPopup';

	constructor() {
		super({
			id: ShowEnvironmentPopupAction.ID,
			title: localize2('showEnvironmentPopup', "Show Environment"),
			icon: Codicon.settings,
			precondition: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext.negate()),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(RightWorkbenchCommandId.OpenReview);
	}
}

interface IEnvironmentRow {
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly value?: string;
	readonly muted?: boolean;
	readonly command?: string;
}

interface IResolvedGitInfo {
	readonly branchName?: string;
	readonly upstreamBranchName?: string;
	readonly outgoingChanges?: number;
	readonly incomingChanges?: number;
	readonly uncommittedChanges?: number;
	readonly hasGitHubRemote?: boolean;
}

export class EnvironmentTitleBarWidget extends BaseActionViewItem {

	private triggerButton: HTMLButtonElement | undefined;
	private popupStore = this._register(new DisposableStore());
	private readonly contentStore = this._register(new DisposableStore());
	private popupContainer: HTMLElement | undefined;
	/** Bumped once a repository finishes opening so the popup re-resolves the branch. */
	private readonly gitStatusTick = observableValue<number>('environmentGitStatusTick', 0);
	/** Working directory already handed to the git service to open. Reset on every popup open so each open re-checks. */
	private openedGitRepositoryKey: string | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IGitService private readonly gitService: IGitService,
		@ISCMService private readonly scmService: ISCMService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ILogService private readonly logService: ILogService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		clearNode(container);

		container.classList.add('sessions-environment-titlebar-widget');
		const triggerButton = append(container, $('button.sessions-environment-titlebar-widget-trigger')) as HTMLButtonElement;
		this.triggerButton = triggerButton;
		triggerButton.setAttribute('aria-label', localize('environmentPopupAriaLabel', "Show Environment"));
		triggerButton.setAttribute('aria-haspopup', 'dialog');
		triggerButton.setAttribute('aria-expanded', 'false');
		triggerButton.appendChild(renderIcon(Codicon.settings));

		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), triggerButton, localize('environmentPopupHover', "Show Environment")));
		this._register(addDisposableListener(triggerButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.togglePopup();
		}));
		this._register(addDisposableListener(triggerButton, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
				EventHelper.stop(event, true);
				this.togglePopup();
			}
		}));
	}

	private togglePopup(): void {
		if (!this.triggerButton) {
			return;
		}

		if (this.triggerButton.getAttribute('aria-expanded') === 'true') {
			this.contextViewService.hideContextView();
			return;
		}

		this.triggerButton.setAttribute('aria-expanded', 'true');
		this.contextViewService.showContextView({
			getAnchor: () => this.triggerButton!,
			render: container => this.renderPopup(container),
			onHide: () => {
				this.popupStore.clear();
				this.contentStore.clear();
				this.triggerButton?.setAttribute('aria-expanded', 'false');
			},
		});

		// Dismiss the popup when the user clicks anywhere outside of it. The
		// context view's built-in outside-click handling only fires for clicks
		// outside the whole workbench container, so it never closes for clicks
		// elsewhere in the window; register our own pointer listener instead.
		// Added after showContextView (whose synchronous render clears the popup
		// store) so the listener survives until the popup hides.
		this.popupStore.add(addDisposableListener(getWindow(this.triggerButton), EventType.MOUSE_DOWN, event => {
			const target = event.target as HTMLElement | null;
			if (target && (this.popupContainer?.contains(target) || this.triggerButton?.contains(target))) {
				return;
			}
			this.contextViewService.hideContextView();
		}, true));
	}

	private renderPopup(container: HTMLElement): DisposableStore {
		this.popupStore.clear();
		this.popupContainer = container;
		// Re-check the repository from scratch every time the popup opens.
		this.openedGitRepositoryKey = undefined;
		// Render inside an autorun so the popup stays live while open: the branch
		// updates as soon as the git repository finishes opening, the user checks
		// out a different branch, or the active session's workspace changes.
		this.popupStore.add(autorun(reader => this.renderPopupContent(reader)));
		return this.popupStore;
	}

	private renderPopupContent(reader: IReader): void {
		const container = this.popupContainer;
		if (!container) {
			return;
		}
		this.gitStatusTick.read(reader);
		this.contentStore.clear();
		clearNode(container);

		const popup = append(container, $('.sessions-environment-popup'));
		const header = append(popup, $('.sessions-environment-popup-header'));
		append(header, $('span.sessions-environment-popup-title', undefined, localize('environmentPopupTitle', "Environment")));
		append(header, $('button.sessions-environment-popup-add', { 'aria-label': localize('environmentPopupAdd', "Add") }, renderIcon(Codicon.add)));

		const activeSession = this.sessionsService.activeSession.read(reader);
		if (!activeSession) {
			this.renderRow(popup, {
				icon: Codicon.window,
				label: localize('environmentNoActiveSession', "No Active Session"),
				value: localize('environmentNoActiveSessionValue', "Start or select a session"),
				muted: true,
			});
			return;
		}

		const workspace = activeSession.workspace.read(reader);
		const folder = workspace?.folders[0];
		const gitRepository = folder?.gitRepository;
		const providerBranchName = this.getProviderBranchName(activeSession);
		const providerWorkingDirectory = this.getProviderWorkingDirectory(activeSession);
		const gitInfo = this.resolveGitInfo(reader, folder, providerWorkingDirectory);
		const branchName = gitInfo?.branchName ?? gitRepository?.branchName ?? providerBranchName;
		const upstreamBranchName = gitInfo?.upstreamBranchName ?? gitRepository?.upstreamBranchName;
		const changesSummary = activeSession.changesSummary?.read(reader);
		const changesValue = changesSummary
			? localize('environmentChangesSummary', "{0} files  +{1} -{2}", changesSummary.files, changesSummary.additions, changesSummary.deletions)
			: this.getGitChangesLabel(gitInfo) ?? localize('environmentNoChanges', "No changes");

		this.renderRow(popup, {
			icon: Codicon.diffMultiple,
			label: localize('environmentChanges', "Changes"),
			value: changesValue,
			command: RightWorkbenchCommandId.OpenReview,
		});
		this.renderRow(popup, {
			icon: Codicon.deviceDesktop,
			label: workspace?.group ?? localize('environmentLocal', "Local"),
			value: this.getWorkspaceLabel(workspace, folder),
		});
		this.renderRow(popup, {
			icon: Codicon.gitBranch,
			label: branchName ?? localize('environmentNoBranch', "No Branch"),
			value: upstreamBranchName,
			muted: !branchName,
		});
		this.renderRow(popup, {
			icon: Codicon.circleOutline,
			label: localize('environmentCommitOrPush', "Commit or Push"),
			value: this.getSyncLabel(gitInfo?.outgoingChanges ?? gitRepository?.outgoingChanges, gitInfo?.incomingChanges ?? gitRepository?.incomingChanges),
			command: RightWorkbenchCommandId.OpenReview,
		});
		this.renderRow(popup, {
			icon: Codicon.github,
			label: (gitInfo?.hasGitHubRemote ?? gitRepository?.hasGitHubRemote)
				? localize('environmentGitHubRemote', "GitHub Remote Connected")
				: localize('environmentGitHubRemoteMissing', "GitHub Remote Not Detected"),
			muted: !(gitInfo?.hasGitHubRemote ?? gitRepository?.hasGitHubRemote),
		});

		append(popup, $('.sessions-environment-popup-separator'));
		append(popup, $('span.sessions-environment-popup-section', undefined, localize('environmentSources', "Sources")));
		this.renderSourceRows(popup, workspace);
	}

	private getProviderBranchName(session: ISession): string | undefined {
		const provider = this.sessionsProvidersService.getProvider(session.providerId);
		if (!provider || !isAgentHostProvider(provider)) {
			return undefined;
		}

		const runningValue = provider.getSessionConfig(session.sessionId)?.values[SessionConfigKey.Branch];
		const createValue = provider.getCreateSessionConfig(session.sessionId)?.[SessionConfigKey.Branch];
		return this.asNonEmptyString(runningValue) ?? this.asNonEmptyString(createValue);
	}

	private getProviderWorkingDirectory(session: ISession): URI | undefined {
		const provider = this.sessionsProvidersService.getProvider(session.providerId);
		if (!provider || !isAgentHostProvider(provider)) {
			return undefined;
		}
		const workingDirectory = provider.getWorkingDirectory(session.sessionId);
		return workingDirectory ? URI.file(workingDirectory) : undefined;
	}

	private asNonEmptyString(value: unknown): string | undefined {
		if (typeof value !== 'string') {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed || undefined;
	}

	private renderRow(container: HTMLElement, row: IEnvironmentRow): void {
		const element = append(container, $('button.sessions-environment-popup-row')) as HTMLButtonElement;
		element.classList.toggle('muted', !!row.muted);
		element.disabled = !row.command;
		element.appendChild(renderIcon(row.icon));

		const label = append(element, $('span.sessions-environment-popup-row-label'));
		label.textContent = row.label;
		if (row.value) {
			const value = append(element, $('span.sessions-environment-popup-row-value'));
			value.textContent = row.value;
		}

		if (row.command) {
			this.contentStore.add(addDisposableListener(element, EventType.CLICK, () => {
				this.contextViewService.hideContextView();
				void this.commandService.executeCommand(row.command!);
			}));
		}
	}

	private renderSourceRows(container: HTMLElement, workspace: ISessionWorkspace | undefined): void {
		if (!workspace?.folders.length) {
			this.renderRow(container, {
				icon: Codicon.folder,
				label: localize('environmentNoSources', "No Sources"),
				muted: true,
			});
			return;
		}

		for (const folder of workspace.folders) {
			const row = append(container, $('.sessions-environment-popup-source'));
			row.appendChild(renderIcon(folder.gitRepository ? Codicon.repo : Codicon.folder));
			const label = append(row, $('span.sessions-environment-popup-source-label'));
			label.textContent = folder.gitRepository?.gitHubInfo.get()
				? `${folder.gitRepository.gitHubInfo.get()!.owner}/${folder.gitRepository.gitHubInfo.get()!.repo}`
				: folder.name || basename(folder.workingDirectory);
			const value = append(row, $('span.sessions-environment-popup-source-value'));
			value.textContent = folder.description ?? folder.workingDirectory.fsPath;
		}
	}

	private getWorkspaceLabel(workspace: ISessionWorkspace | undefined, folder: ISessionFolder | undefined): string | undefined {
		if (workspace?.label && folder?.name && workspace.label !== folder.name) {
			return `${workspace.label} / ${folder.name}`;
		}
		return folder?.name ?? workspace?.label;
	}

	private getSyncLabel(outgoingChanges: number | undefined, incomingChanges: number | undefined): string | undefined {
		if (!outgoingChanges && !incomingChanges) {
			return undefined;
		}
		return localize('environmentSyncSummary', "{0} outgoing, {1} incoming", outgoingChanges ?? 0, incomingChanges ?? 0);
	}

	private getGitChangesLabel(gitInfo: IResolvedGitInfo | undefined): string | undefined {
		if (gitInfo?.uncommittedChanges === undefined) {
			return undefined;
		}
		return gitInfo.uncommittedChanges
			? localize('environmentGitChangesSummary', "{0} changed files", gitInfo.uncommittedChanges)
			: localize('environmentNoChanges', "No changes");
	}

	private resolveGitInfo(reader: IReader, folder: ISessionFolder | undefined, providerWorkingDirectory: URI | undefined): IResolvedGitInfo | undefined {
		const key = this.getGitInfoKey(folder, providerWorkingDirectory);
		if (!key) {
			return undefined;
		}
		// Prefer the live git repository. Reading its state subscribes the popup so
		// the branch refreshes as soon as the repository loads or HEAD changes.
		const repository = this.findGitRepository(folder, providerWorkingDirectory);
		if (repository) {
			repository.state.read(reader);
			return this.toResolvedGitInfo(repository);
		}
		// Not open yet: fall back to the SCM provider (which may already know the
		// branch) and ask the git service to open the repository, re-rendering via
		// the tick once it resolves.
		this.ensureGitRepositoryOpened(key, providerWorkingDirectory ?? folder?.workingDirectory);
		return this.getCurrentScmInfo(reader, folder, providerWorkingDirectory);
	}

	private getCurrentScmInfo(reader: IReader, folder: ISessionFolder | undefined, providerWorkingDirectory: URI | undefined): IResolvedGitInfo | undefined {
		const repository = this.findScmRepository(folder, providerWorkingDirectory);
		if (!repository) {
			return undefined;
		}
		const historyProvider = repository.provider.historyProvider.read(reader);
		const branchName = historyProvider?.historyItemRef.read(reader)?.name ?? this.getScmStatusBarBranchName(reader, repository);
		const upstreamBranchName = historyProvider?.historyItemRemoteRef.read(reader)?.name;
		const uncommittedChanges = repository.provider.groups.reduce((count, group) => count + group.resources.length, 0);
		return {
			branchName,
			upstreamBranchName,
			uncommittedChanges,
		};
	}

	private getScmStatusBarBranchName(reader: IReader, repository: ISCMRepository): string | undefined {
		const commands = repository.provider.statusBarCommands.read(reader);
		const title = commands?.[0]?.title;
		if (typeof title !== 'string') {
			return undefined;
		}
		const branchName = title.replace(/\$\([^)]+\)\s*/g, '').trim();
		return branchName || undefined;
	}

	private ensureGitRepositoryOpened(key: string, workingDirectory: URI | undefined): void {
		if (!workingDirectory || this.openedGitRepositoryKey === key) {
			return;
		}
		this.openedGitRepositoryKey = key;
		this.gitService.openRepository(workingDirectory).then(() => {
			if (!this._store.isDisposed) {
				this.gitStatusTick.set(this.gitStatusTick.get() + 1, undefined);
			}
		}, error => this.logService.warn('[EnvironmentTitleBar] Failed to open git repository for branch status', error));
	}

	private findScmRepository(folder: ISessionFolder | undefined, providerWorkingDirectory: URI | undefined): ISCMRepository | undefined {
		const candidateDirectories = [providerWorkingDirectory, folder?.workingDirectory].filter((directory): directory is URI => !!directory);
		for (const directory of candidateDirectories) {
			const repository = this.scmService.getRepository(directory);
			if (repository) {
				return repository;
			}
		}
		for (const repository of this.scmService.repositories) {
			const rootUri = repository.provider.rootUri;
			if (!rootUri) {
				continue;
			}
			for (const directory of candidateDirectories) {
				if (
					this.uriIdentityService.extUri.isEqualOrParent(directory, rootUri) ||
					this.uriIdentityService.extUri.isEqualOrParent(rootUri, directory)
				) {
					return repository;
				}
			}
		}
		return undefined;
	}

	private findGitRepository(folder: ISessionFolder | undefined, providerWorkingDirectory: URI | undefined): IGitRepository | undefined {
		const candidateDirectories = [providerWorkingDirectory, folder?.workingDirectory].filter((directory): directory is URI => !!directory);
		for (const repository of this.gitService.repositories) {
			for (const directory of candidateDirectories) {
				if (
					this.uriIdentityService.extUri.isEqualOrParent(directory, repository.rootUri) ||
					this.uriIdentityService.extUri.isEqualOrParent(repository.rootUri, directory)
				) {
					return repository;
				}
			}
		}
		return undefined;
	}

	private toResolvedGitInfo(repository: IGitRepository): IResolvedGitInfo {
		const state = repository.state.get();
		const upstream = state.HEAD?.upstream;
		return {
			branchName: state.HEAD?.name,
			upstreamBranchName: upstream ? `${upstream.remote}/${upstream.name}` : undefined,
			outgoingChanges: state.HEAD?.ahead,
			incomingChanges: state.HEAD?.behind,
			uncommittedChanges: state.mergeChanges.length + state.indexChanges.length + state.workingTreeChanges.length + state.untrackedChanges.length,
			hasGitHubRemote: state.remotes.some(remote => /github\.com/i.test(remote.fetchUrl ?? remote.pushUrl ?? '')),
		};
	}

	private getGitInfoKey(folder: ISessionFolder | undefined, providerWorkingDirectory: URI | undefined): string | undefined {
		return (providerWorkingDirectory ?? folder?.workingDirectory)?.toString();
	}
}

export class EnvironmentTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.environmentTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// The Environment button sits inline with the terminal and right-panel
		// controls in the single floating session toolbar (top-right of the
		// session view), so the whole set stays on one row regardless of whether
		// the auxiliary bar is open or closed.
		const environmentMenuCommand = {
			id: ShowEnvironmentPopupAction.ID,
			title: localize2('showEnvironmentPopupMenu', "Environment"),
			icon: Codicon.settings,
		};
		this._register(MenuRegistry.appendMenuItem(Menus.SessionBarToolbar, {
			command: environmentMenuCommand,
			group: 'navigation',
			order: 8,
			// NB: no IsAuxiliaryWindowContext gate — the floating toolbar only
			// renders in the sessions window, and that key spuriously flips true
			// when the right panel/editor opens, which would hide this button.
			when: ContextKeyExpr.and(SessionsWelcomeVisibleContext.toNegated(), IsPhoneLayoutContext.negate()),
		}));
		// Mirror it in the title bar's right layout on the new-session screen so the
		// workspace controls (environment, terminal, right panel) sit in the top
		// title-bar row before a session is created too.
		this._register(MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
			command: environmentMenuCommand,
			group: 'navigation',
			order: 1,
			when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsNewChatSessionContext, IsPhoneLayoutContext.negate()),
		}));
		const registerEnvironmentWidget = (menuId: typeof Menus.SessionBarToolbar) => this._register(actionViewItemService.register(menuId, ShowEnvironmentPopupAction.ID, (action, options) => {
			return instantiationService.createInstance(EnvironmentTitleBarWidget, action, options);
		}, undefined));
		registerEnvironmentWidget(Menus.SessionBarToolbar);
		registerEnvironmentWidget(Menus.TitleBarRightLayout);
	}
}

registerAction2(ShowEnvironmentPopupAction);
