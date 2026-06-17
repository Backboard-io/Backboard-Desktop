/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/filesView.css';
import * as dom from '../../../../base/browser/dom.js';
import * as path from '../../../../base/common/path.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IViewPaneLocationColors, IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { agentsPanelBackground } from '../../../common/theme.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

const $ = dom.$;

export const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';
export const SESSIONS_FILES_VIEW_ID = 'sessions.files.explorer';
export const SESSIONS_FILES_EMPTY_VIEW_ID = 'sessions.files.explorer.empty';

export class SessionsExplorerView extends ViewPane {
	private readonly _expandedResources = new Set<string>();
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => void this._renderFiles(), 100));
	private _body: HTMLElement | undefined;
	private _renderGeneration = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, _openerService, themeService, hoverService);

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => this._refreshScheduler.schedule()));
		this._register(this._fileService.onDidFilesChange(() => this._refreshScheduler.schedule()));
	}

	protected override getLocationBasedColors(): IViewPaneLocationColors {
		const colors = super.getLocationBasedColors();
		return {
			...colors,
			background: agentsPanelBackground,
			listOverrideStyles: {
				...colors.listOverrideStyles,
				listBackground: agentsPanelBackground,
			}
		};
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = dom.append(container, $('.sessions-files-view-body'));
		this._refreshScheduler.schedule(0);
	}

	private async _renderFiles(): Promise<void> {
		const body = this._body;
		if (!body) {
			return;
		}

		const generation = ++this._renderGeneration;
		dom.clearNode(body);

		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			this._renderEmpty(body);
			return;
		}

		for (const folder of folders) {
			this._expandedResources.add(folder.uri.toString());
			await this._renderResource(body, folder.uri, 0, true, generation);
			if (generation !== this._renderGeneration) {
				return;
			}
		}
	}

	private async _renderResource(container: HTMLElement, resource: URI, depth: number, isRoot = false, generation = this._renderGeneration): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this._fileService.resolve(resource);
		} catch {
			this._appendRow(container, resource, depth, false, false, isRoot);
			return;
		}

		if (generation !== this._renderGeneration) {
			return;
		}

		this._appendRow(container, stat.resource, depth, stat.isDirectory, this._expandedResources.has(stat.resource.toString()), isRoot);

		if (!stat.isDirectory || !this._expandedResources.has(stat.resource.toString())) {
			return;
		}

		const children = [...(stat.children ?? [])]
			.filter(child => !this._shouldHide(child.resource))
			.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || this._label(a.resource).localeCompare(this._label(b.resource)));

		for (const child of children) {
			await this._renderResource(container, child.resource, depth + 1, false, generation);
			if (generation !== this._renderGeneration) {
				return;
			}
		}
	}

	private _appendRow(container: HTMLElement, resource: URI, depth: number, isDirectory: boolean, expanded: boolean, isRoot: boolean): void {
		const row = dom.append(container, $('button.sessions-files-row')) as HTMLButtonElement;
		row.type = 'button';
		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.title = resource.fsPath || resource.toString();
		row.setAttribute('aria-label', this._label(resource));

		const twistie = dom.append(row, $('span.codicon.sessions-files-twistie'));
		if (isDirectory) {
			twistie.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		}

		const icon = dom.append(row, $('span.codicon.sessions-files-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(isDirectory ? Codicon.folder : Codicon.file));

		const label = dom.append(row, $('span.sessions-files-label'));
		label.textContent = isRoot ? this._rootLabel(resource) : this._label(resource);

		row.onclick = () => {
			if (isDirectory) {
				const key = resource.toString();
				if (this._expandedResources.has(key)) {
					this._expandedResources.delete(key);
				} else {
					this._expandedResources.add(key);
				}
				this._refreshScheduler.schedule(0);
				return;
			}
			void this._openerService.open(resource);
		};
	}

	private _renderEmpty(container: HTMLElement): void {
		const bodyContainer = dom.append(container, $('.files-empty-view-body'));
		const welcomeContainer = dom.append(bodyContainer, $('.files-empty-welcome'));

		const welcomeIcon = dom.append(welcomeContainer, $('.files-empty-welcome-icon'));
		welcomeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.files));

		const welcomeMessage = dom.append(welcomeContainer, $('.files-empty-welcome-message'));
		welcomeMessage.textContent = localize('filesView.noFiles', "Folders and files will appear here.");
	}

	private _label(resource: URI): string {
		return path.basename(resource.path) || resource.authority || resource.toString();
	}

	private _rootLabel(resource: URI): string {
		const folder = this._workspaceContextService.getWorkspace().folders.find(folder => folder.uri.toString() === resource.toString());
		return folder?.name || this._label(resource);
	}

	private _shouldHide(resource: URI): boolean {
		switch (this._label(resource)) {
			case '.git':
			case 'node_modules':
			case '.next':
			case 'out':
			case 'dist':
				return true;
			default:
				return false;
		}
	}
}

export class SessionsExplorerEmptyView extends ViewPane {
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
		@IHoverService hoverService: IHoverService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const bodyContainer = dom.append(container, $('.files-empty-view-body'));
		const welcomeContainer = dom.append(bodyContainer, $('.files-empty-welcome'));

		const welcomeIcon = dom.append(welcomeContainer, $('.files-empty-welcome-icon'));
		welcomeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.files));

		const welcomeMessage = dom.append(welcomeContainer, $('.files-empty-welcome-message'));
		welcomeMessage.textContent = localize('filesView.noFiles', "Folders and files will appear here.");
	}
}
