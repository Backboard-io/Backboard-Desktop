/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/panelHeader.css';
import { isWCOEnabled } from '../../../base/browser/browser.js';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow, prepend } from '../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { safeIntl } from '../../../base/common/date.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh, isNative, isWeb, platformLocale } from '../../../base/common/platform.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { getTitleBarStyle, getWindowControlsStyle, hasNativeTitlebar, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { SessionsWelcomeVisibleContext } from '../../common/contextkeys.js';
import { Menus } from '../menus.js';

/**
 * A toolbar rendered into one of the header sections. The toolbar renders the
 * given menu; contributions control their own visibility via `when` clauses.
 */
export interface ISessionsPanelHeaderToolbar {
	readonly menuId: MenuId;
	readonly telemetrySource: string;
	/** Additional class names for the toolbar container. */
	readonly containerClasses?: readonly string[];
	/** Hide this toolbar while the sessions welcome view is visible. */
	readonly hideOnWelcome?: boolean;
}

export interface ISessionsPanelHeaderOptions {
	/** Additional class names for the header element. */
	readonly classes?: readonly string[];
	/**
	 * Render inline inside an existing header row (appended, fills remaining
	 * width) instead of as a standalone strip prepended to a part container.
	 * Used by the auxiliary bar, whose composite title area already is the
	 * panel's header row.
	 */
	readonly inline?: boolean;
	/** Toolbars in the left section (start-aligned). */
	readonly left?: readonly ISessionsPanelHeaderToolbar[];
	/** Toolbars in the center section (center-aligned). */
	readonly center?: readonly ISessionsPanelHeaderToolbar[];
	/** Toolbars in the right section (end-aligned). */
	readonly right?: readonly ISessionsPanelHeaderToolbar[];
	/**
	 * Whether this header reserves space for the native window controls at the
	 * window's left edge (macOS traffic lights) and/or right edge (Windows/
	 * Linux/web controls). Only the header of the part that sits at that window
	 * edge should reserve the space; headers that only sit at the edge when
	 * another part is hidden reserve it too and are shown/hidden via CSS.
	 */
	readonly windowControls?: { readonly left?: boolean; readonly right?: boolean };
}

/**
 * A 38px header strip rendered as the first row inside a workbench part. It
 * hosts menu-driven toolbars and acts as a window drag region, replacing the
 * former global integrated chrome bar. Interactive children opt out of window
 * dragging via CSS (`panelHeader.css`).
 */
export class SessionsPanelHeader extends Disposable {

	static readonly HEIGHT = 38;

	readonly element: HTMLElement;

	private readonly welcomeHiddenContainers: HTMLElement[] = [];

	constructor(
		parent: HTMLElement,
		options: ISessionsPanelHeaderOptions,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.element = $('.sessions-panel-header');
		if (options.classes) {
			this.element.classList.add(...options.classes);
		}
		if (options.inline) {
			this.element.classList.add('inline');
			append(parent, this.element);
		} else {
			prepend(parent, this.element);
		}

		prepend(this.element, $('div.titlebar-drag-region'));

		const leftContent = append(this.element, $('.sessions-panel-header-left'));
		const centerContent = append(this.element, $('.sessions-panel-header-center'));
		const rightContent = append(this.element, $('.sessions-panel-header-right'));

		this.createWindowControls(leftContent, rightContent, options.windowControls);

		for (const [content, toolbars] of [[leftContent, options.left], [centerContent, options.center], [rightContent, options.right]] as const) {
			for (const toolbar of toolbars ?? []) {
				this.createToolbar(content, toolbar);
			}
		}

		this._register(addDisposableListener(this.element, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e);
			this.onContextMenu(e);
		}));

		if (this.welcomeHiddenContainers.length) {
			const welcomeVisibleKeySet = new Set([SessionsWelcomeVisibleContext.key]);
			this._register(this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(welcomeVisibleKeySet)) {
					this.updateWelcomeToolbarVisibility();
				}
			}));
			this.updateWelcomeToolbarVisibility();
		}
	}

	/**
	 * The rendered height of the header. `0` when the header is hidden via CSS
	 * (e.g. in the phone layout), so parts can subtract it from their content
	 * layout unconditionally.
	 */
	get height(): number {
		return this.element.offsetHeight;
	}

	private createToolbar(parent: HTMLElement, toolbar: ISessionsPanelHeaderToolbar): void {
		const container = append(parent, $('div.panel-header-toolbar-container'));
		if (toolbar.containerClasses) {
			container.classList.add(...toolbar.containerClasses);
		}
		if (toolbar.hideOnWelcome) {
			this.welcomeHiddenContainers.push(container);
		}
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, container, toolbar.menuId, {
			contextMenu: Menus.TitleBarContext,
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: toolbar.telemetrySource,
			toolbarOptions: { primaryGroup: () => true },
		}));
	}

	private createWindowControls(leftContent: HTMLElement, rightContent: HTMLElement, windowControls: ISessionsPanelHeaderOptions['windowControls']): void {
		if (!windowControls || hasNativeTitlebar(this.configurationService, getTitleBarStyle(this.configurationService))) {
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
			// Invisible spacer that keeps toolbars clear of the traffic lights.
			// Hidden in fullscreen and on phone via CSS (`panelHeader.css`).
			if (windowControls.left) {
				append(leftContent, $('div.mac-window-controls-spacer'));
			}
		} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
			return;
		} else {
			const primaryContent = primaryWindowControlsLocation === 'left' ? leftContent : rightContent;
			const hostsPrimary = primaryWindowControlsLocation === 'left' ? windowControls.left : windowControls.right;
			if (hostsPrimary) {
				const windowControlsContainer = append(primaryContent, $('div.window-controls-container'));
				if (isWCOEnabled()) {
					windowControlsContainer.classList.add('wco-enabled');
				}
			}
			const secondaryContent = primaryWindowControlsLocation === 'left' ? rightContent : leftContent;
			const hostsSecondary = primaryWindowControlsLocation === 'left' ? windowControls.right : windowControls.left;
			if (isWeb && hostsSecondary) {
				append(secondaryContent, $('div.window-controls-container'));
			}
		}
	}

	private updateWelcomeToolbarVisibility(): void {
		const hideForWelcome = !!SessionsWelcomeVisibleContext.getValue(this.contextKeyService);
		for (const container of this.welcomeHiddenContainers) {
			container.classList.toggle('hidden-for-welcome', hideForWelcome);
		}
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
