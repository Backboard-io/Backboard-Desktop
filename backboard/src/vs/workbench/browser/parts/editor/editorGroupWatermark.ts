/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, h } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';

export class EditorGroupWatermark extends Disposable {

	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';

	private readonly welcome: HTMLElement;
	private readonly shortcuts: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());

	private enabled = false;
	private workbenchState: WorkbenchState;

	constructor(
		container: HTMLElement,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark-toolbar-container@toolbarContainer'),
			h('.editor-group-watermark', [
				h('.watermark-container', [
					// The Backboard welcome lives in its own container: `.shortcuts` is
					// hidden once the group is short (see `max-height-478px` in
					// editorgroupview.css), which would make the welcome vanish as soon
					// as the panel is dragged up.
					h('.backboard-welcome@welcome'),
					h('.shortcuts@shortcuts'),
				])
			])
		]);

		append(container, elements.root);
		this.welcome = elements.welcome;
		this.shortcuts = elements.shortcuts;
		this.toolbarContainer = elements.toolbarContainer;

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.toolbarContainer, MenuId.EditorGroupWatermarkToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			highlightToggledItems: true,
			menuOptions: { shouldForwardArgs: true }
		}));

		this.registerListeners();

		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY) &&
				this.enabled !== this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY)
			) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this.render();
			}
		}));
	}

	private render(): void {
		this.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);

		clearNode(this.welcome);
		clearNode(this.shortcuts);
		this.transientDisposables.clear();

		this.renderBackboardEmptyState();

		if (!this.enabled) {
			return;
		}
	}

	private renderBackboardEmptyState(): void {
		const createLogo = () => $('.backboard-welcome-logo', { 'aria-hidden': 'true' },
			$('img', {
				src: FileAccess.asBrowserUri('vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg').toString(true),
				alt: '',
				decoding: 'async',
			}),
		);

		const createActionRow = (icon: ThemeIcon, label: string, command: string) => {
			const keybinding = this.keybindingService.lookupKeybinding(command)?.getLabel();
			const row = $('button.backboard-welcome-action', { type: 'button' },
				$('span.backboard-welcome-action-icon.codicon' + ThemeIcon.asCSSSelector(icon), { 'aria-hidden': 'true' }),
				$('span.backboard-welcome-action-label', {}, label),
				$('span.backboard-welcome-action-keybinding', {}, keybinding ?? ''),
			) as HTMLButtonElement;
			this.transientDisposables.add(addDisposableListener(row, 'click', () => {
				this.commandService.executeCommand(command).catch(onUnexpectedError);
			}));
			return row;
		};

		const createSection = (label: string, ...actions: HTMLElement[]) => $('.backboard-welcome-section', {},
			$('.backboard-welcome-section-heading', {},
				$('span', {}, label),
				$('.backboard-welcome-section-rule'),
			),
			$('.backboard-welcome-action-list', {}, ...actions),
		);

		const welcome = $('.backboard-welcome-page', {},
			$('.backboard-welcome-shell', {},
				$('.backboard-welcome-header', {},
					createLogo(),
					$('.backboard-welcome-header-copy', {},
						$('h1.backboard-welcome-title', {}, localize('backboardWelcome.title', "Welcome to Backboard Studio")),
						$('p.backboard-welcome-subtitle', {}, localize('backboardWelcome.subtitle', "The editor for what's next")),
					),
				),

				createSection(
					localize('backboardWelcome.getStarted', "GET STARTED"),
					createActionRow(Codicon.add, localize('backboardWelcome.newFile', "New File"), 'workbench.action.files.newUntitledFile'),
					createActionRow(Codicon.folderOpened, localize('backboardWelcome.openProject', "Open Project"), 'workbench.action.files.openFolder'),
					createActionRow(Codicon.cloudDownload, localize('backboardWelcome.cloneRepository', "Clone Repository"), 'git.clone'),
				),

				createSection(
					localize('backboardWelcome.configure', "CONFIGURE"),
					createActionRow(Codicon.settingsGear, localize('backboardWelcome.openSettings', "Open Settings"), 'workbench.action.openSettings'),
					createActionRow(Codicon.keyboard, localize('backboardWelcome.customizeKeymaps', "Customize Keymaps"), 'workbench.action.openGlobalKeybindings'),
					createActionRow(Codicon.extensions, localize('backboardWelcome.exploreExtensions', "Explore Extensions"), 'workbench.view.extensions'),
				),
			),
		);

		append(this.welcome, welcome);
	}
}
