/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/previewView.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISandboxPreviewService, ISandboxPreviewState } from '../common/preview.js';

const $ = dom.$;

export class SandboxPreviewViewPane extends ViewPane {
	private readonly _renderStore = this._register(new DisposableStore());
	private _root: HTMLElement | undefined;
	private _lastEmptyRefreshKey: string | undefined;
	private _lastAutoOpenKey: string | undefined;

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
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISandboxPreviewService private readonly _previewService: ISandboxPreviewService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, _openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._root = dom.append(container, $('.sandbox-preview-view'));

		this._register(autorun(reader => {
			const session = this._sessionsManagementService.activeSession.read(reader);
			const state = this._previewService.getState(session?.resource).read(reader);
			if (session && state.status === 'empty' && this.isBodyVisible()) {
				const key = session.resource.toString();
				if (this._lastEmptyRefreshKey !== key) {
					this._lastEmptyRefreshKey = key;
					void this._previewService.prepare(session);
				}
			}
			if (session && this.isBodyVisible()) {
				this._autoOpenWhenVisible(session, state);
			}
			this._render(session, state);
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (!visible) {
				return;
			}
			const session = this._sessionsManagementService.activeSession.get();
			const state = this._previewService.getState(session?.resource).get();
			if (session) {
				if (state.status === 'empty') {
					void this._previewService.prepare(session);
				}
				this._autoOpenWhenVisible(session, state);
			}
		}));
	}

	override focus(): void {
		this._root?.focus();
	}

	private _render(session: ISession | undefined, state: ISandboxPreviewState): void {
		if (!this._root) {
			return;
		}

		this._renderStore.clear();
		dom.reset(this._root);

		const header = dom.append(this._root, $('.sandbox-preview-header'));
		const title = dom.append(header, $('.sandbox-preview-title'));
		this._appendIcon(title, state.status === 'starting' ? Codicon.loading : Codicon.preview);
		dom.append(title, $('span')).textContent = state.candidate?.title ?? localize('sandboxPreview.title', "Preview");

		const actions = dom.append(header, $('.sandbox-preview-actions'));
		this._appendToolbarButton(actions, localize('sandboxPreview.openIntegratedBrowser', "Open Preview"), Codicon.eye, !!session && state.status !== 'empty', () => {
			if (session) {
				void this._openOrStart(session, state);
			}
		});
		this._appendToolbarButton(actions, localize('sandboxPreview.code', "Code"), Codicon.code, !!state.candidate?.entry, () => {
			const entry = state.candidate?.entry;
			if (entry) {
				void this._editorService.openEditor({ resource: entry });
			}
		});
		this._appendToolbarButton(actions, localize('sandboxPreview.refresh', "Refresh"), Codicon.refresh, !!session && state.status !== 'empty', () => {
			if (session) {
				void this._previewService.refresh(session);
			}
		});
		this._appendToolbarButton(actions, localize('sandboxPreview.openExternal', "Open External"), Codicon.linkExternal, !!state.url, () => {
			if (state.url) {
				void this._openerService.open(URI.parse(state.url), { openExternal: true });
			}
		});

		const content = dom.append(this._root, $('.sandbox-preview-content'));

		if (!session) {
			this._renderEmpty(content, localize('sandboxPreview.noSession', "Open a Sandbox session to preview generated apps."));
			return;
		}

		switch (state.status) {
			case 'empty':
				this._renderEmpty(content, localize('sandboxPreview.empty', "Ask Backboard to build a web app and the preview will appear here."));
				break;
			case 'detected':
				this._renderDetected(content, session, state);
				break;
			case 'starting':
				this._renderStarting(content, state);
				break;
			case 'ready':
				this._renderReady(content, session, state);
				break;
			case 'error':
				this._renderError(content, session, state);
				break;
		}
	}

	private _renderEmpty(container: HTMLElement, message: string): void {
		const empty = dom.append(container, $('.sandbox-preview-empty'));
		this._appendIcon(dom.append(empty, $('.sandbox-preview-empty-icon')), Codicon.preview);
		dom.append(empty, $('h3')).textContent = localize('sandboxPreview.noPreview', "No preview yet");
		dom.append(empty, $('p')).textContent = message;
	}

	private _renderDetected(container: HTMLElement, session: ISession, state: ISandboxPreviewState): void {
		const card = dom.append(container, $('.sandbox-preview-card'));
		const heading = dom.append(card, $('h3'));
		heading.textContent = state.candidate?.kind === 'static-html'
			? localize('sandboxPreview.staticDetected', "HTML preview ready")
			: localize('sandboxPreview.appDetected', "Web app detected");
		dom.append(card, $('p')).textContent = state.candidate?.kind === 'static-html'
			? localize('sandboxPreview.staticDescription', "Open the generated HTML file in the Integrated Browser.")
			: localize('sandboxPreview.devDescription', "Start the detected dev server, then open it in the Integrated Browser.");

		if (state.candidate?.command) {
			const command = dom.append(card, $('.sandbox-preview-command'));
			command.textContent = state.candidate.command;
		}

		const buttons = dom.append(card, $('.sandbox-preview-button-row'));
		this._appendActionButton(buttons, state.candidate?.kind === 'static-html'
			? localize('sandboxPreview.openPreview', "Open Preview")
			: localize('sandboxPreview.startPreview', "Start Preview"), true, () => {
				void this._openOrStart(session, state);
			});
	}

	private _renderStarting(container: HTMLElement, state: ISandboxPreviewState): void {
		const working = dom.append(container, $('.sandbox-preview-working'));
		this._appendIcon(dom.append(working, $('.sandbox-preview-working-icon')), Codicon.loading);
		dom.append(working, $('h3')).textContent = localize('sandboxPreview.starting', "Starting preview...");
		dom.append(working, $('p')).textContent = state.candidate?.command ?? localize('sandboxPreview.launching', "Launching the dev server.");
	}

	private _renderReady(container: HTMLElement, session: ISession, state: ISandboxPreviewState): void {
		const card = dom.append(container, $('.sandbox-preview-card'));
		dom.append(card, $('h3')).textContent = localize('sandboxPreview.ready', "Preview open");
		dom.append(card, $('p')).textContent = state.url ?? localize('sandboxPreview.readyFallback', "The preview is open in the Integrated Browser.");
		if (state.candidate?.entry) {
			const entry = dom.append(card, $('.sandbox-preview-command'));
			entry.textContent = basename(state.candidate.entry);
		}
		const buttons = dom.append(card, $('.sandbox-preview-button-row'));
		this._appendActionButton(buttons, localize('sandboxPreview.focusPreview', "Focus Preview"), true, () => {
			void this._previewService.open(session);
		});
	}

	private _renderError(container: HTMLElement, session: ISession, state: ISandboxPreviewState): void {
		const card = dom.append(container, $('.sandbox-preview-card.sandbox-preview-error'));
		dom.append(card, $('h3')).textContent = localize('sandboxPreview.error', "Preview failed");
		dom.append(card, $('p')).textContent = state.error ?? localize('sandboxPreview.unknownError', "The preview could not be started.");
		const buttons = dom.append(card, $('.sandbox-preview-button-row'));
		this._appendActionButton(buttons, localize('sandboxPreview.tryAgain', "Try Again"), true, () => {
			void this._openOrStart(session, state);
		});
	}

	private _appendActionButton(container: HTMLElement, label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
		const button = dom.append(container, $('button.sandbox-preview-button')) as HTMLButtonElement;
		button.classList.toggle('primary', primary);
		button.type = 'button';
		button.textContent = label;
		this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, onClick));
		return button;
	}

	private _appendToolbarButton(container: HTMLElement, label: string, icon: ThemeIcon, enabled: boolean, onClick?: () => void): HTMLButtonElement {
		const button = dom.append(container, $('button.sandbox-preview-toolbar-button')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.disabled = !enabled;
		this._appendIcon(button, icon);
		if (onClick) {
			this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, onClick));
		}
		return button;
	}

	private _appendIcon(container: HTMLElement, icon: ThemeIcon): HTMLElement {
		const element = dom.append(container, $('span.codicon'));
		element.classList.add(...ThemeIcon.asClassNameArray(icon));
		return element;
	}

	private async _openOrStart(session: ISession, state: ISandboxPreviewState): Promise<void> {
		if (state.candidate?.kind === 'dev-server' && state.status !== 'ready') {
			await this._previewService.start(session);
			return;
		}
		await this._previewService.open(session);
	}

	private _autoOpenWhenVisible(session: ISession, state: ISandboxPreviewState): void {
		if (state.status === 'empty' || state.status === 'starting' || state.status === 'error') {
			return;
		}

		const key = `${session.resource.toString()}\n${state.url ?? state.candidate?.entry?.toString() ?? state.candidate?.command ?? ''}\n${state.status}`;
		if (this._lastAutoOpenKey === key) {
			return;
		}

		this._lastAutoOpenKey = key;
		void this._openOrStart(session, state);
	}
}
