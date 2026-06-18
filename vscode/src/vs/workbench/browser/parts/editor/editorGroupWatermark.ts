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

	private readonly shortcuts: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());

	private enabled = false;
	private workbenchState: WorkbenchState;

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark-toolbar-container@toolbarContainer'),
			h('.editor-group-watermark', [
				h('.watermark-container', [
					h('.shortcuts@shortcuts'),
				])
			])
		]);

		append(container, elements.root);
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

		clearNode(this.shortcuts);
		this.transientDisposables.clear();

		if (!this.enabled) {
			return;
		}

		this.renderBackboardWelcome();
	}

	private renderBackboardWelcome(): void {
		const runCommand = (command: string, ...args: unknown[]) => {
			Promise.resolve(this.commandService.executeCommand(command, ...args)).catch(onUnexpectedError);
		};

		const createActionRow = (icon: ThemeIcon, label: string, command: string, ...args: unknown[]) => {
			const keybinding = this.keybindingService.lookupKeybinding(command)?.getLabel();
			const row = $('button.backboard-welcome-action', { type: 'button' },
				$('span.backboard-welcome-action-icon.codicon' + ThemeIcon.asCSSSelector(icon), { 'aria-hidden': 'true' }),
				$('span.backboard-welcome-action-label', {}, label),
				keybinding ? $('span.backboard-welcome-action-keybinding', {}, keybinding) : $('span.backboard-welcome-action-keybinding', {}),
			) as HTMLButtonElement;
			this.transientDisposables.add(addDisposableListener(row, 'click', () => runCommand(command, ...args)));
			return row;
		};

		const createSection = (label: string, ...actions: HTMLElement[]) => $('.backboard-welcome-section', {},
			$('.backboard-welcome-section-heading', {},
				$('span', {}, label),
				$('.backboard-welcome-section-rule'),
			),
			$('.backboard-welcome-action-list', {}, ...actions),
		);

		const returnToOnboarding = $('button.backboard-welcome-footer-link', { type: 'button' }, localize('backboardWelcome.returnToOnboarding', "Return to Onboarding")) as HTMLButtonElement;
		this.transientDisposables.add(addDisposableListener(returnToOnboarding, 'click', () => runCommand('workbench.action.welcomeOnboarding2026')));

		append(this.shortcuts, $('.backboard-welcome-page', {},
			$('.backboard-welcome-shell', {},
				$('.backboard-welcome-header', {},
					$('.backboard-welcome-logo', { 'aria-hidden': 'true' },
						$<HTMLImageElement>('img', {
							src: FileAccess.asBrowserUri('vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg').toString(true),
							alt: '',
							decoding: 'async',
						}),
					),
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

				returnToOnboarding,
			),
		));
	}
}
