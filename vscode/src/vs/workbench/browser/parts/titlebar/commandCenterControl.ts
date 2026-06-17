/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventType, addDisposableListener, isActiveDocument, reset } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, SubmenuAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { createActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId, MenuRegistry, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { WindowTitle } from './windowTitle.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

const AGENT_SESSIONS_WELCOME_INPUT_TYPE_ID = 'workbench.editors.agentSessionsWelcomeInput';
const OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID = 'workbench.action.openWorkspaceInAgentsWindow';
const CLOSE_WORKSPACE_PAGE_COMMAND_ID = 'workbench.action.closeWorkspacePage';

type TitlebarPage = 'sandbox' | 'editor';

export class CommandCenterControl {

	private readonly _disposables = new DisposableStore();

	private readonly _onDidChangeVisibility = this._disposables.add(new Emitter<void>());
	readonly onDidChangeVisibility: Event<void> = this._onDidChangeVisibility.event;

	readonly element: HTMLElement = document.createElement('div');

	constructor(
		windowTitle: WindowTitle,
		hoverDelegate: IHoverDelegate,
		@IInstantiationService instantiationService: IInstantiationService,
		@IQuickInputService quickInputService: IQuickInputService,
	) {
		this.element.classList.add('command-center');

		const titleToolbar = instantiationService.createInstance(MenuWorkbenchToolBar, this.element, MenuId.CommandCenter, {
			contextMenu: MenuId.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: {
				primaryGroup: () => true,
			},
			telemetrySource: 'commandCenter',
			actionViewItemProvider: (action, options) => {
				if (action instanceof SubmenuItemAction && action.item.submenu === MenuId.CommandCenterCenter) {
					return instantiationService.createInstance(CommandCenterCenterViewItem, action, windowTitle, { ...options, hoverDelegate });
				} else {
					return createActionViewItem(instantiationService, action, { ...options, hoverDelegate });
				}
			}
		});

		let quickInputVisible = false;
		this._disposables.add(Event.filter(quickInputService.onShow, () => isActiveDocument(this.element), this._disposables)(() => {
			quickInputVisible = true;
			this._setVisibility(quickInputService.alignment.get() !== 'top');
		}));
		this._disposables.add(quickInputService.onHide(() => {
			quickInputVisible = false;
			this._setVisibility(true);
		}));
		this._disposables.add(autorun(reader => {
			const alignment = quickInputService.alignment.read(reader);
			if (quickInputVisible) {
				this._setVisibility(alignment !== 'top');
			}
		}));
		this._disposables.add(titleToolbar);
	}

	private _setVisibility(show: boolean): void {
		this.element.classList.toggle('hide', !show);
		this._onDidChangeVisibility.fire();
	}

	dispose(): void {
		this._disposables.dispose();
	}
}


class CommandCenterCenterViewItem extends BaseActionViewItem {

	private static readonly _quickOpenCommandId = 'workbench.action.quickOpenWithModes';

	private readonly _hoverDelegate: IHoverDelegate;

	constructor(
		private readonly _submenu: SubmenuItemAction,
		private readonly _windowTitle: WindowTitle,
		options: IBaseActionViewItemOptions,
		@IHoverService private readonly _hoverService: IHoverService,
		@IKeybindingService private _keybindingService: IKeybindingService,
		@IInstantiationService private _instaService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(undefined, _submenu.actions.find(action => action.id === 'workbench.action.quickOpenWithModes') ?? _submenu.actions[0], options);
		this._hoverDelegate = options.hoverDelegate ?? getDefaultHoverDelegate('mouse');
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('command-center-center');
		container.classList.add('ide-page-switch-container');
		container.classList.toggle('multiple', (this._submenu.actions.length > 1));

		const hover = this._store.add(this._hoverService.setupManagedHover(this._hoverDelegate, container, this.getTooltip()));

		// update label & tooltip when window title changes
		this._store.add(this._windowTitle.onDidChange(() => {
			hover.update(this.getTooltip());
		}));

		const groups: (readonly IAction[])[] = [];
		for (const action of this._submenu.actions) {
			if (action instanceof SubmenuAction) {
				groups.push(action.actions);
			} else {
				groups.push([action]);
			}
		}


		for (let i = 0; i < groups.length; i++) {
			const group = groups[i];

			// nested toolbar
			const toolbar = this._instaService.createInstance(WorkbenchToolBar, container, {
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				telemetrySource: 'commandCenterCenter',
				actionViewItemProvider: (action, options) => {
					options = {
						...options,
						hoverDelegate: this._hoverDelegate,
					};

					if (action.id !== CommandCenterCenterViewItem._quickOpenCommandId) {
						return createActionViewItem(this._instaService, action, options);
					}

					const that = this;

					return this._instaService.createInstance(class CommandCenterQuickPickItem extends BaseActionViewItem {

						constructor() {
							super(undefined, action, options);
						}

						override onClick(): void {
							// Click handling is owned by the segmented switch buttons.
						}

						override render(container: HTMLElement): void {
							super.render(container);
							container.classList.toggle('command-center-quick-pick');
							container.role = 'presentation';
							container.setAttribute('aria-label', localize('ideViewSwitch', "IDE View Switch"));

							const switchElement = document.createElement('div');
							switchElement.classList.add('ide-page-switch');
							switchElement.setAttribute('role', 'tablist');
							switchElement.setAttribute('aria-label', localize('ideViewSwitchAriaLabel', "IDE view"));

							const buttons = [
								this._createSwitchButton('sandbox', localize('sandboxView', "Sandbox"), async () => {
									await that._commandService.executeCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID);
									return that._commandService.executeCommand(OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID);
								}),
								this._createSwitchButton('editor', localize('editorView', "Editor"), async () => {
									await that._commandService.executeCommand(CLOSE_WORKSPACE_PAGE_COMMAND_ID);
									return that._commandService.executeCommand('workbench.action.focusActiveEditorGroup');
								}),
							];
							for (const button of buttons) {
								switchElement.appendChild(button);
							}
							reset(container, switchElement);

							const hover = this._store.add(that._hoverService.setupManagedHover(that._hoverDelegate, container, this.getTooltip()));
							const updateChecked = () => {
								const activePage = this._getActivePage();
								for (const button of buttons) {
									const checked = button.dataset.page === activePage;
									button.classList.toggle('checked', checked);
									button.setAttribute('aria-selected', String(checked));
									button.tabIndex = checked ? 0 : -1;
								}
							};
							updateChecked();

							// update label & tooltip when window title changes
							this._store.add(that._windowTitle.onDidChange(() => {
								hover.update(this.getTooltip());
							}));

							this._store.add(that._editorService.onDidActiveEditorChange(updateChecked));
							this._store.add(that._editorService.onDidVisibleEditorsChange(updateChecked));
						}

						protected override getTooltip() {
							return localize('ideViewSwitchTooltip', "Switch between Sandbox and Editor");
						}

						private _createSwitchButton(page: TitlebarPage, label: string, run: () => Promise<unknown>): HTMLButtonElement {
							const button = document.createElement('button');
							button.type = 'button';
							button.classList.add('ide-page-switch-button');
							button.dataset.page = page;
							button.textContent = label;
							button.setAttribute('role', 'tab');
							button.title = label;

							this._store.add(addDisposableListener(button, EventType.CLICK, event => {
								event.preventDefault();
								event.stopPropagation();
								run();
							}));
							this._store.add(addDisposableListener(button, EventType.KEY_DOWN, event => {
								if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
									event.preventDefault();
									event.stopPropagation();
									this._focusAdjacentButton(button, event.key === 'ArrowRight');
								}
							}));

							return button;
						}

						private _focusAdjacentButton(button: HTMLButtonElement, next: boolean): void {
							const buttons = Array.from(button.parentElement?.querySelectorAll<HTMLButtonElement>('.ide-page-switch-button') ?? []);
							const index = buttons.indexOf(button);
							if (index === -1) {
								return;
							}
							const nextIndex = (index + (next ? 1 : -1) + buttons.length) % buttons.length;
							buttons[nextIndex]?.focus();
						}

						private _getActivePage(): TitlebarPage {
							switch (that._editorService.activeEditor?.typeId) {
								case AGENT_SESSIONS_WELCOME_INPUT_TYPE_ID:
									return 'sandbox';
								default:
									return 'editor';
							}
						}
					});
				}
			});
			toolbar.setActions(group);
			this._store.add(toolbar);


			// spacer
			if (i < groups.length - 1) {
				const icon = renderIcon(Codicon.circleSmallFilled);
				icon.style.padding = '0 8px';
				icon.style.height = '100%';
				icon.style.opacity = '0.5';
				container.appendChild(icon);
			}
		}
	}

	protected override getTooltip() {

		// tooltip: full windowTitle
		const kb = this._keybindingService.lookupKeybinding(this.action.id)?.getLabel();
		const title = kb
			? localize('title', "Search {0} ({1}) \u2014 {2}", this._windowTitle.workspaceName, kb, this._windowTitle.value)
			: localize('title2', "Search {0} \u2014 {1}", this._windowTitle.workspaceName, this._windowTitle.value);

		return title;
	}
}

MenuRegistry.appendMenuItem(MenuId.CommandCenter, {
	submenu: MenuId.CommandCenterCenter,
	title: localize('title3', "Command Center"),
	icon: Codicon.shield,
	order: 101,
});
