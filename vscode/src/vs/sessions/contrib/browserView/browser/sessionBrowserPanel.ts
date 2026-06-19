/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionBrowserPanel.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

const $ = dom.$;

export const SESSIONS_BROWSER_VIEW_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.browserContainer';
export const SESSIONS_BROWSER_VIEW_ID = 'sessions.browser.view';

export class SessionsBrowserViewPane extends ViewPane {

	private readonly _domStore = this._register(new DisposableStore());
	private readonly _listStore = this._register(new DisposableStore());
	private _body: HTMLElement | undefined;
	private _input: HTMLInputElement | undefined;
	private _list: HTMLElement | undefined;

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
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly _editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly _browserViewService: IBrowserViewWorkbenchService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._browserViewService.onDidChangeBrowserViews(() => this._renderBrowserList()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._domStore.clear();
		this._listStore.clear();
		this._body = dom.append(container, $('.sessions-browser-view'));

		const urlRow = dom.append(this._body, $('.sessions-browser-url-row'));
		const urlIcon = dom.append(urlRow, $('.sessions-browser-url-icon'));
		urlIcon.appendChild(renderIcon(Codicon.globe));
		this._input = dom.append(urlRow, $('input.sessions-browser-url-input')) as HTMLInputElement;
		this._input.type = 'text';
		this._input.placeholder = localize('sessions.browser.urlPlaceholder', "Paste a URL or type a port");
		this._input.setAttribute('aria-label', localize('sessions.browser.urlAriaLabel', "Browser URL"));

		const openButton = dom.append(urlRow, $('button.sessions-browser-open-button')) as HTMLButtonElement;
		openButton.type = 'button';
		openButton.title = localize('sessions.browser.open', "Open Browser");
		openButton.setAttribute('aria-label', localize('sessions.browser.open', "Open Browser"));
		openButton.appendChild(renderIcon(Codicon.arrowRight));

		this._domStore.add(dom.addDisposableListener(this._input, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this._openFromInput();
			}
		}));
		this._domStore.add(dom.addDisposableListener(openButton, dom.EventType.CLICK, () => this._openFromInput()));

		this._list = dom.append(this._body, $('.sessions-browser-list'));
		this._renderBrowserList();
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._body) {
			this._body.style.height = `${height}px`;
			this._body.style.width = `${width}px`;
		}
	}

	private async _openFromInput(): Promise<void> {
		const url = this._normalizeUrl(this._input?.value ?? '');
		if (!url) {
			return;
		}

		this._input!.value = url;
		await this._editorService.openEditor({
			resource: BrowserViewUri.forId(generateUuid()),
			options: {
				pinned: true,
				viewState: { url }
			}
		});
		this._renderBrowserList();
	}

	private _normalizeUrl(value: string): string | undefined {
		const trimmed = value.trim();
		if (!trimmed) {
			return undefined;
		}
		if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
			return trimmed;
		}
		if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(trimmed)) {
			return `http://${trimmed}`;
		}
		if (/^\d{2,5}$/.test(trimmed)) {
			return `http://localhost:${trimmed}`;
		}
		return `https://${trimmed}`;
	}

	private _renderBrowserList(): void {
		if (!this._list) {
			return;
		}

		this._listStore.clear();
		dom.clearNode(this._list);
		const browserInputs = [...this._browserViewService.getContextualBrowserViews().values()];

		if (browserInputs.length === 0) {
			const empty = dom.append(this._list, $('.sessions-browser-empty'));
			const emptyIcon = dom.append(empty, $('.sessions-browser-empty-icon'));
			emptyIcon.appendChild(renderIcon(Codicon.globe));
			const emptyTitle = dom.append(empty, $('.sessions-browser-empty-title'));
			emptyTitle.textContent = localize('sessions.browser.emptyTitle', "No browser page open");
			const emptyMessage = dom.append(empty, $('.sessions-browser-empty-message'));
			emptyMessage.textContent = localize('sessions.browser.empty', "Preview localhost apps and web pages here.");
			return;
		}

		for (const input of browserInputs) {
			this._renderBrowserItem(this._list, input);
		}
	}

	private _renderBrowserItem(container: HTMLElement, input: BrowserEditorInput): void {
		const button = dom.append(container, $('button.sessions-browser-item')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.globe));
		button.lastElementChild?.classList.add('sessions-browser-item-icon');

		const content = dom.append(button, $('.sessions-browser-item-main'));
		const title = dom.append(content, $('.sessions-browser-item-title'));
		title.textContent = input.title || localize('sessions.browser.defaultTitle', "Browser");

		const url = dom.append(content, $('.sessions-browser-item-url'));
		url.textContent = input.url || localize('sessions.browser.blank', "Blank page");

		this._listStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			this._editorService.openEditor(input);
		}));
	}
}
