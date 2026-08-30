/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { splitRecentLabel } from '../../../../base/common/labels.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IRecentlyOpened, isRecentFolder, isRecentWorkspace, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * Payload attached to each picker row. `checked` marks the current workspace
 * so the action list focuses it when the picker opens.
 */
interface IRecentPickerItem {
	readonly openable?: IWindowOpenable;
	readonly remoteAuthority?: string;
	readonly isCurrent?: boolean;
	readonly checked?: boolean;
	readonly run?: () => void;
}

/**
 * Status bar entry at the bottom left that shows the current workspace and
 * opens a picker of recently opened folders and workspaces for quick
 * switching. Uses the same action-widget list as the sessions workspace
 * picker so both switchers look and behave alike.
 */
class RecentWorkspacesStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.recentWorkspacesStatus';

	private static readonly STATUS_ENTRY_ID = 'status.recentWorkspaces';
	private static readonly MENU_COMMAND_ID = 'workbench.action.showRecentWorkspacesMenu';
	private static readonly MAX_MENU_ENTRIES = 10;
	private static readonly PICKER_MIN_WIDTH = 260;
	private static readonly PICKER_MAX_WIDTH = 420;

	/**
	 * Clicking the status entry while the picker is open first blurs (and
	 * thereby hides) the picker, then runs this command. Treat a click that
	 * lands right after the picker hid as "toggle closed" instead of
	 * immediately reopening it.
	 */
	private static readonly REOPEN_GUARD_MS = 250;

	private readonly entryAccessor = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	/**
	 * Recent local folders/workspace files known to no longer exist on disk,
	 * kept as URI strings. Checked asynchronously (at startup, when the
	 * recents change, and on each picker open) so the picker never lists a
	 * folder the user has deleted. Non-local schemes are never marked missing.
	 */
	private missingRecents = new Set<string>();

	private lastPickerHiddenAt = 0;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@ILabelService private readonly labelService: ILabelService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService
	) {
		super();

		this._register(CommandsRegistry.registerCommand(RecentWorkspacesStatusContribution.MENU_COMMAND_ID, () => this.onStatusEntryClicked()));

		this.updateStatusEntry();
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateStatusEntry()));
		this._register(this.contextService.onDidChangeWorkspaceName(() => this.updateStatusEntry()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.updateStatusEntry()));

		void this.refreshMissingRecents();
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this.refreshMissingRecents()));
	}

	private updateStatusEntry(): void {
		const workspaceLabel = this.contextService.getWorkbenchState() === WorkbenchState.EMPTY
			? localize('status.recentWorkspaces.empty', "Open Recent")
			: this.labelService.getWorkspaceLabel(this.contextService.getWorkspace());

		const entry: IStatusbarEntry = {
			name: localize('status.recentWorkspaces.name', "Current Workspace"),
			text: `$(folder-opened) ${workspaceLabel}`,
			ariaLabel: localize('status.recentWorkspaces.ariaLabel', "Current workspace: {0}, select to switch to a recently opened folder or workspace", workspaceLabel),
			tooltip: localize('status.recentWorkspaces.tooltip', "Switch to a Recently Opened Folder or Workspace"),
			command: RecentWorkspacesStatusContribution.MENU_COMMAND_ID
		};

		if (this.entryAccessor.value) {
			this.entryAccessor.value.update(entry);
		} else {
			this.entryAccessor.value = this.statusbarService.addEntry(entry, RecentWorkspacesStatusContribution.STATUS_ENTRY_ID, StatusbarAlignment.LEFT, 100);
		}
	}

	private onStatusEntryClicked(): void {
		if (this.actionWidgetService.isVisible) {
			this.actionWidgetService.hide();
			return;
		}
		if (Date.now() - this.lastPickerHiddenAt < RecentWorkspacesStatusContribution.REOPEN_GUARD_MS) {
			return; // this click just closed the picker via blur — don't reopen
		}
		void this.showRecentWorkspacesPicker();
	}

	private async showRecentWorkspacesPicker(): Promise<void> {
		const recentlyOpened = await this.workspacesService.getRecentlyOpened();
		void this.refreshMissingRecents(recentlyOpened); // re-validate in the background for the next open

		const items = this.buildPickerItems(recentlyOpened);
		const anchorElement = mainWindow.document.getElementById(RecentWorkspacesStatusContribution.STATUS_ENTRY_ID);

		const delegate: IActionListDelegate<IRecentPickerItem> = {
			onSelect: (item) => {
				this.actionWidgetService.hide(false);
				if (item.run) {
					item.run();
				} else if (item.isCurrent) {
					// already in this workspace — nothing to switch to
				} else if (item.openable) {
					this.hostService.openWindow([item.openable], {
						remoteAuthority: item.remoteAuthority || null // local window if remoteAuthority is not set or can not be deducted from the openable
					});
				}
			},
			onHide: () => {
				this.lastPickerHiddenAt = Date.now();

				// Restore focus to the status bar entry when the picker closes
				// without focus having moved elsewhere (e.g. via Escape), so
				// keyboard users are not dropped to the document body. Deferred
				// because at this point the picker DOM may still hold focus.
				disposableTimeout(() => {
					const active = getActiveElement();
					if (!active || active === active.ownerDocument.body) {
						anchorElement?.querySelector<HTMLElement>('a')?.focus();
					}
				}, 0, this._store);
			}
		};

		this.actionWidgetService.show<IRecentPickerItem>(
			'recentWorkspacesPicker',
			false,
			items,
			delegate,
			anchorElement ?? { x: 10, y: mainWindow.innerHeight - 10 },
			undefined,
			[],
			{
				getAriaLabel: (item) => {
					if (item.label && typeof item.description === 'string' && item.description) {
						return localize('status.recentWorkspaces.itemAriaLabel', "{0}, {1}", item.label, item.description);
					}
					return item.label ?? '';
				},
				getWidgetAriaLabel: () => localize('status.recentWorkspaces.pickerAriaLabel', "Recent Folders and Workspaces")
			},
			{
				inlineDescription: true,
				reserveSubmenuSpace: false,
				hideDefaultKeybindingTooltip: true,
				minWidth: RecentWorkspacesStatusContribution.PICKER_MIN_WIDTH,
				maxWidth: RecentWorkspacesStatusContribution.PICKER_MAX_WIDTH
			}
		);
	}

	private buildPickerItems(recentlyOpened: IRecentlyOpened): IActionListItem<IRecentPickerItem>[] {
		const items: IActionListItem<IRecentPickerItem>[] = [];

		for (const recent of recentlyOpened.workspaces) {
			if (items.length >= RecentWorkspacesStatusContribution.MAX_MENU_ENTRIES) {
				break;
			}

			let uri: URI;
			let openable: IWindowOpenable;
			let fullLabel: string;
			let isCurrent: boolean;
			let icon = Codicon.folder;
			if (isRecentFolder(recent)) {
				if (basename(recent.folderUri).startsWith('copilot-')) {
					continue; // skip agent-managed worktrees, same as the sessions workspace picker
				}
				uri = recent.folderUri;
				openable = { folderUri: recent.folderUri };
				fullLabel = recent.label || this.labelService.getWorkspaceLabel(recent.folderUri, { verbose: Verbosity.LONG });
				isCurrent = this.contextService.isCurrentWorkspace(recent.folderUri);
			} else if (isRecentWorkspace(recent)) {
				uri = recent.workspace.configPath;
				openable = { workspaceUri: recent.workspace.configPath };
				fullLabel = recent.label || this.labelService.getWorkspaceLabel(recent.workspace, { verbose: Verbosity.LONG });
				isCurrent = this.contextService.isCurrentWorkspace(recent.workspace);
				icon = Codicon.folderLibrary;
			} else {
				continue;
			}

			if (this.missingRecents.has(uri.toString())) {
				continue; // deleted from disk — don't offer to open it
			}

			const { name, parentPath } = splitRecentLabel(fullLabel);
			items.push({
				kind: ActionListItemKind.Action,
				label: name,
				description: parentPath || undefined,
				tooltip: fullLabel,
				group: { title: '', icon: isCurrent ? Codicon.check : icon },
				item: { openable, remoteAuthority: recent.remoteAuthority, isCurrent, checked: isCurrent || undefined },
				onRemove: () => this.workspacesService.removeRecentlyOpened([uri])
			});
		}

		if (items.length > 0) {
			items.push({ kind: ActionListItemKind.Separator, label: '' });
		}
		items.push({
			kind: ActionListItemKind.Action,
			label: localize('status.recentWorkspaces.openFolder', "Open Folder…"),
			group: { title: '', icon: Codicon.folderOpened },
			item: { run: () => this.fileDialogService.pickFolderAndOpen({ forceNewWindow: false }) }
		});
		items.push({
			kind: ActionListItemKind.Action,
			label: localize('status.recentWorkspaces.more', "More…"),
			group: { title: '', icon: Codicon.history },
			item: { run: () => this.commandService.executeCommand('workbench.action.openRecent') }
		});

		return items;
	}

	/**
	 * Re-check which recent local folders/workspace files still exist on disk
	 * and cache the missing set. Any error while checking is treated as
	 * "present" so a transient failure never hides an entry.
	 */
	private async refreshMissingRecents(recentlyOpened?: IRecentlyOpened): Promise<void> {
		recentlyOpened = recentlyOpened ?? await this.workspacesService.getRecentlyOpened();

		const next = new Set<string>();
		await Promise.all(recentlyOpened.workspaces.map(async recent => {
			const uri = isRecentFolder(recent) ? recent.folderUri : isRecentWorkspace(recent) ? recent.workspace.configPath : undefined;
			if (!uri || uri.scheme !== Schemas.file || !this.fileService.hasProvider(uri)) {
				return; // only local entries can be meaningfully checked
			}
			try {
				if (!await this.fileService.exists(uri)) {
					next.add(uri.toString());
				}
			} catch {
				// never hide an entry because of a stat failure
			}
		}));

		this.missingRecents = next;
	}
}

registerWorkbenchContribution2(RecentWorkspacesStatusContribution.ID, RecentWorkspacesStatusContribution, WorkbenchPhase.AfterRestored);
