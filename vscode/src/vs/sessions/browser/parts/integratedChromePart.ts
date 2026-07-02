/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isFullscreen, isWCOEnabled, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow, getWindowId, prepend, size } from '../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { isMacintosh, isNative, isWeb, platformLocale } from '../../../base/common/platform.js';
import { safeIntl } from '../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { getTitleBarStyle, getWindowControlsStyle, hasNativeTitlebar, TitlebarStyle, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { Menus } from '../menus.js';
import { SessionsWelcomeVisibleContext } from '../../common/contextkeys.js';

export class SessionsIntegratedChromePart extends Disposable {

	static readonly HEIGHT = 38;

	readonly element: HTMLElement;

	private readonly titleBarStyle: TitlebarStyle;
	private readonly rightToolbarContainer: HTMLElement;
	private readonly sessionActionsContainer: HTMLElement;
	private readonly boundaryObserverStore = this._register(new DisposableStore());
	private boundarySidebar: HTMLElement | undefined;
	private boundaryAuxiliaryBar: HTMLElement | undefined;

	constructor(
		parent: HTMLElement,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.titleBarStyle = getTitleBarStyle(this.configurationService);
		this.element = append(parent, $('.sessions-integrated-chrome'));

		prepend(this.element, $('div.titlebar-drag-region'));
		append(this.element, $('div.sessions-integrated-chrome-divider.sidebar-divider'));
		append(this.element, $('div.sessions-integrated-chrome-divider.auxiliary-divider'));

		const leftContent = append(this.element, $('.sessions-integrated-chrome-left'));
		const centerContent = append(this.element, $('.sessions-integrated-chrome-center'));
		const rightContent = append(this.element, $('.sessions-integrated-chrome-right'));

		this.createWindowControls(leftContent, rightContent);

		const leftToolbarContainer = append(leftContent, $('div.left-toolbar-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, leftToolbarContainer, Menus.TitleBarLeftLayout, {
			contextMenu: Menus.TitleBarContext,
			telemetrySource: 'sessionsIntegratedChrome.left',
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
		}));

		const centerActionsContainer = append(centerContent, $('div.titlebar-actions-container.titlebar-center-actions-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, centerActionsContainer, Menus.TitleBarCenterRight, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'sessionsIntegratedChrome.centerRight',
			toolbarOptions: { primaryGroup: () => true },
		}));

		const rightPanelToolbarContainer = append(rightContent, $('div.sessions-integrated-chrome-right-panel-toolbar'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, rightPanelToolbarContainer, Menus.TitleBarRightPanel, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'sessionsIntegratedChrome.rightPanel',
			toolbarOptions: { primaryGroup: () => true },
		}));

		this.rightToolbarContainer = prepend(rightContent, $('div.titlebar-actions-container.titlebar-right-layout-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.rightToolbarContainer, Menus.TitleBarRightLayout, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'sessionsIntegratedChrome.right',
			toolbarOptions: { primaryGroup: () => true },
		}));

		this.sessionActionsContainer = prepend(rightContent, $('div.titlebar-actions-container.titlebar-session-actions-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.sessionActionsContainer, Menus.TitleBarSessionMenu, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'sessionsIntegratedChrome.sessionActions',
			toolbarOptions: { primaryGroup: () => true },
		}));

		this._register(addDisposableListener(this.element, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e);
			this.onContextMenu(e);
		}));
		const targetWindow = getWindow(this.element);
		this._register(addDisposableListener(targetWindow, EventType.POINTER_DOWN, () => this.schedulePanelBoundaryStylesUpdate()));
		this._register(addDisposableListener(targetWindow, EventType.POINTER_MOVE, () => this.updatePanelBoundaryStyles()));
		this._register(addDisposableListener(targetWindow, EventType.POINTER_UP, () => this.schedulePanelBoundaryStylesUpdate()));
		this._register(addDisposableListener(targetWindow, EventType.MOUSE_DOWN, () => this.schedulePanelBoundaryStylesUpdate()));
		this._register(addDisposableListener(targetWindow, EventType.MOUSE_MOVE, () => this.updatePanelBoundaryStyles()));
		this._register(addDisposableListener(targetWindow, EventType.MOUSE_UP, () => this.schedulePanelBoundaryStylesUpdate()));

		const welcomeVisibleKeySet = new Set([SessionsWelcomeVisibleContext.key]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(welcomeVisibleKeySet)) {
				this.updateWelcomeToolbarVisibility();
			}
		}));
		this.updateWelcomeToolbarVisibility();
	}

	layout(width: number, height: number): void {
		size(this.element, width, height);
	}

	updatePanelBoundaries(sidebar: HTMLElement | undefined, auxiliaryBar: HTMLElement | undefined): void {
		if (this.boundarySidebar !== sidebar || this.boundaryAuxiliaryBar !== auxiliaryBar) {
			this.boundarySidebar = sidebar;
			this.boundaryAuxiliaryBar = auxiliaryBar;
			this.updateBoundaryObservers();
		}

		this.updatePanelBoundaryStyles();
	}

	private schedulePanelBoundaryStylesUpdate(): void {
		this.updatePanelBoundaryStyles();
		getWindow(this.element).requestAnimationFrame(() => this.updatePanelBoundaryStyles());
	}

	private updatePanelBoundaryStyles(): void {
		const chromeBounds = this.element.getBoundingClientRect();
		const sidebarBoundaryElement = this.boundarySidebar?.closest('.split-view-view');
		const sidebarBounds = sidebarBoundaryElement instanceof HTMLElement
			? sidebarBoundaryElement.getBoundingClientRect()
			: this.boundarySidebar?.getBoundingClientRect();
		const auxiliaryBoundaryElement = this.boundaryAuxiliaryBar?.closest('.split-view-view');
		const auxiliaryBarBounds = auxiliaryBoundaryElement instanceof HTMLElement
			? auxiliaryBoundaryElement.getBoundingClientRect()
			: this.boundaryAuxiliaryBar?.getBoundingClientRect();
		const measuredSidebarWidth = sidebarBounds && sidebarBounds.width > 0
			? Math.max(0, sidebarBounds.right - chromeBounds.left)
			: 0;
		const measuredAuxiliaryBarLeft = auxiliaryBarBounds && auxiliaryBarBounds.width > 0
			? Math.max(0, auxiliaryBarBounds.left - chromeBounds.left)
			: -1;
		const sidebarSash = measuredSidebarWidth > 0
			? this.getNearestVerticalSash(measuredSidebarWidth, chromeBounds)
			: undefined;
		const auxiliarySash = measuredAuxiliaryBarLeft >= 0
			? this.getNearestVerticalSash(measuredAuxiliaryBarLeft, chromeBounds)
			: undefined;
		const sidebarDividerLeft = measuredSidebarWidth;
		const sidebarHoverLeft = sidebarSash
			? sidebarSash.centerLeft - sidebarSash.width
			: measuredSidebarWidth;
		const auxiliaryDividerLeft = auxiliarySash
			? auxiliarySash.centerLeft - (auxiliarySash.width / 2)
			: measuredAuxiliaryBarLeft;
		const auxiliaryHoverLeft = auxiliarySash
			? auxiliarySash.centerLeft - auxiliarySash.width
			: measuredAuxiliaryBarLeft;

		this.element.style.setProperty('--sessions-sidebar-width', `${measuredSidebarWidth}px`);
		this.element.style.setProperty('--sessions-sidebar-divider-left', `${Math.round(sidebarDividerLeft)}px`);
		this.element.style.setProperty('--sessions-sidebar-hover-left', `${sidebarHoverLeft}px`);
		this.element.style.setProperty('--sessions-auxiliary-divider-left', `${Math.round(auxiliaryDividerLeft)}px`);
		this.element.style.setProperty('--sessions-auxiliary-hover-left', `${auxiliaryHoverLeft}px`);
		this.element.classList.toggle('has-sidebar-divider', measuredSidebarWidth > 0);
		this.element.classList.toggle('has-auxiliary-divider', auxiliaryDividerLeft >= 0);
		this.element.classList.toggle('sidebar-sash-active', !!sidebarSash?.active);
		this.element.classList.toggle('auxiliary-sash-active', !!auxiliarySash?.active);
	}

	private getNearestVerticalSash(targetLeft: number, chromeBounds: DOMRect): { centerLeft: number; width: number; active: boolean } | undefined {
		const targetWindow = getWindow(this.element);
		let nearestSash: { centerLeft: number; width: number; active: boolean } | undefined;
		let nearestDistance = Number.POSITIVE_INFINITY;
		let nearestActiveSash: { centerLeft: number; width: number; active: boolean } | undefined;
		let nearestActiveDistance = Number.POSITIVE_INFINITY;
		for (const sash of Array.from(targetWindow.document.querySelectorAll<HTMLElement>('.agent-sessions-workbench > .monaco-grid-view .monaco-sash.vertical'))) {
			const sashBounds = sash.getBoundingClientRect();
			if (sashBounds.width <= 0 || sashBounds.height <= 0) {
				continue;
			}
			const sashCenter = sashBounds.left + sashBounds.width / 2 - chromeBounds.left;
			const distance = Math.abs(sashCenter - targetLeft);
			const active = sash.classList.contains('hover') || sash.classList.contains('active');
			const candidate = {
				centerLeft: sashCenter,
				width: sashBounds.width,
				active,
			};
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestSash = candidate;
			}
			if (active && distance < nearestActiveDistance) {
				nearestActiveDistance = distance;
				nearestActiveSash = candidate;
			}
		}
		if (nearestActiveDistance <= 12) {
			return nearestActiveSash;
		}
		return nearestDistance <= 8 ? nearestSash : undefined;
	}

	private updateBoundaryObservers(): void {
		this.boundaryObserverStore.clear();

		const targetWindow = getWindow(this.element);
		const ResizeObserverCtor = targetWindow.ResizeObserver;
		if (!ResizeObserverCtor) {
			return;
		}

		const resizeObserver = new ResizeObserverCtor(() => this.updatePanelBoundaryStyles());
		this.boundaryObserverStore.add({ dispose: () => resizeObserver.disconnect() });
		resizeObserver.observe(this.element);
		if (this.boundarySidebar) {
			resizeObserver.observe(this.boundarySidebar);
			const sidebarBoundaryElement = this.boundarySidebar.closest('.split-view-view');
			if (sidebarBoundaryElement instanceof HTMLElement) {
				resizeObserver.observe(sidebarBoundaryElement);
			}
		}
		if (this.boundaryAuxiliaryBar) {
			resizeObserver.observe(this.boundaryAuxiliaryBar);
			const auxiliaryBoundaryElement = this.boundaryAuxiliaryBar.closest('.split-view-view');
			if (auxiliaryBoundaryElement instanceof HTMLElement) {
				resizeObserver.observe(auxiliaryBoundaryElement);
			}
		}
	}

	private createWindowControls(leftContent: HTMLElement, rightContent: HTMLElement): void {
		if (hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
		if (isMacintosh && isNative) {
			const localeInfo = safeIntl.Locale(platformLocale).value;
			const textInfo = (localeInfo as { textInfo?: { direction?: string } }).textInfo;
			if (textInfo?.direction === 'rtl') {
				primaryWindowControlsLocation = 'right';
			}
		}

		if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
			const spacer = append(leftContent, $('div.mac-window-controls-spacer'));
			const updateSpacerVisibility = () => {
				const targetWindow = getWindow(this.element);
				const fullscreen = isFullscreen(targetWindow);
				spacer.style.display = fullscreen ? 'none' : '';
				spacer.style.width = fullscreen ? '0' : '70px';
			};
			updateSpacerVisibility();
			spacer.style.flexShrink = '0';
			this._register(onDidChangeFullscreen(windowId => {
				if (windowId === getWindowId(getWindow(this.element))) {
					updateSpacerVisibility();
				}
			}));
		} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
			return;
		} else {
			const windowControlsContainer = append(primaryWindowControlsLocation === 'left' ? leftContent : rightContent, $('div.window-controls-container'));
			if (isWeb) {
				append(primaryWindowControlsLocation === 'left' ? rightContent : leftContent, $('div.window-controls-container'));
			}
			if (isWCOEnabled()) {
				windowControlsContainer.classList.add('wco-enabled');
			}
		}
	}

	private updateWelcomeToolbarVisibility(): void {
		const hideRightTitlebarActions = !!SessionsWelcomeVisibleContext.getValue(this.contextKeyService);
		this.rightToolbarContainer.classList.toggle('hidden-for-welcome', hideRightTitlebarActions);
		this.sessionActionsContainer.classList.toggle('hidden-for-welcome', hideRightTitlebarActions);
	}

	private onContextMenu(e: MouseEvent): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId: Menus.TitleBarContext,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}
}
