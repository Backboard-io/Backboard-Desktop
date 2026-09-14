/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWebPreviewCard.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { BrowserViewCommandId } from '../../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../browserView/common/browserView.js';
import { BrowserEditorInput } from '../../../../browserView/common/browserEditorInput.js';
import { IChatWebPreviewPart } from '../../../common/chatService/chatService.js';
import { getWebPreviewOriginKey, OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID } from '../../../common/chatWebPreview.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { createImageThumbnail } from '../../chatImageUtils.js';
import { ChatTreeItem } from '../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';

/** Max edge length of the downscaled card thumbnail, in pixels. */
const THUMBNAIL_MAX_SIZE = 640;

/** How often to refresh the thumbnail while the card is visible. */
const THUMBNAIL_REFRESH_INTERVAL = 10_000;

/**
 * An inline card previewing a local web app the agent started or opened: a
 * live screenshot thumbnail, the page title, and actions to reveal the app in
 * the integrated browser. The card binds to the session's live browser view
 * when one exists and falls back to a static rendering (e.g. for restored
 * sessions) otherwise.
 */
export class ChatWebPreviewContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private readonly _bindingStore = this._register(new DisposableStore());
	private readonly _captureLoop = this._register(new MutableDisposable());
	private readonly _thumbnailUrl = this._register(new MutableDisposable());

	private readonly _thumbnailButton: HTMLButtonElement;
	private readonly _thumbnailImage: HTMLElement;
	private readonly _favicon: HTMLImageElement;
	private readonly _faviconFallback: HTMLElement;
	private readonly _title: HTMLElement;
	private readonly _subtitle: HTMLElement;
	private readonly _openButton: Button;

	private _input: BrowserEditorInput | undefined;
	private _model: IBrowserViewModel | undefined;
	private _visible = true;
	private _capturing = false;
	private _stopped = false;

	constructor(
		private readonly content: IChatWebPreviewPart,
		context: IChatContentPartRenderContext,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.domNode = dom.$('.chat-web-preview-part');

		this._thumbnailButton = dom.append(this.domNode, dom.$('button.chat-web-preview-thumbnail')) as HTMLButtonElement;
		this._thumbnailButton.type = 'button';
		this._thumbnailImage = dom.append(this._thumbnailButton, dom.$('.chat-web-preview-thumbnail-image'));
		this._register(dom.addDisposableListener(this._thumbnailButton, dom.EventType.CLICK, () => this._open()));

		const footer = dom.append(this.domNode, dom.$('.chat-web-preview-footer'));
		const info = dom.append(footer, dom.$('.chat-web-preview-info'));
		const titleRow = dom.append(info, dom.$('.chat-web-preview-title-row'));
		this._favicon = dom.append(titleRow, dom.$('img.chat-web-preview-favicon')) as HTMLImageElement;
		this._favicon.alt = '';
		this._faviconFallback = dom.append(titleRow, dom.$('.chat-web-preview-favicon-fallback'));
		this._faviconFallback.appendChild(renderIcon(Codicon.globe));
		const backboardHeading = dom.append(titleRow, dom.$('span.chat-web-preview-backboard-heading'));
		backboardHeading.textContent = localize('chat.webPreview.workEntryLabel', 'Web preview');
		this._title = dom.append(titleRow, dom.$('.chat-web-preview-title'));
		this._subtitle = dom.append(info, dom.$('.chat-web-preview-subtitle'));

		const actions = dom.append(footer, dom.$('.chat-web-preview-actions'));
		this._openButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, title: localize('chat.webPreview.open', "Open in Browser") }));
		this._openButton.label = localize('chat.webPreview.openLabel', "Open");
		this._register(this._openButton.onDidClick(() => this._open()));

		const moreButton = dom.append(actions, dom.$('button.chat-web-preview-more')) as HTMLButtonElement;
		moreButton.type = 'button';
		moreButton.setAttribute('aria-label', localize('chat.webPreview.more', "More Actions..."));
		moreButton.appendChild(renderIcon(Codicon.ellipsis));
		this._register(dom.addDisposableListener(moreButton, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this._showMoreActions(moreButton);
		}));

		this._register(context.onDidChangeVisibility(visible => {
			this._visible = visible;
			this._updateCaptureLoop();
		}));

		// Rebind when browser views come and go (e.g. the view's model resolves
		// later, or the server view is disposed and recreated).
		this._register(this.browserViewService.onDidChangeBrowserViews(() => this._resolveAndBind()));
		this._resolveAndBind();
		this._updateLabels();
	}

	private _currentUrl(): string {
		return this._input?.url || this.content.url;
	}

	private _resolveAndBind(): void {
		const input = this._resolveInput();
		if (input === this._input && input?.model === this._model) {
			return;
		}

		this._bindingStore.clear();
		this._input = input;
		this._model = undefined;

		if (input) {
			this._bindingStore.add(input.onceModelResolves(model => this._bindModel(model)));
			this._bindingStore.add(input.onWillDispose(() => {
				this._bindingStore.clear();
				this._input = undefined;
				this._model = undefined;
				this._updateCaptureLoop();
				this._updateLabels();
			}));
		}

		this._updateCaptureLoop();
		this._updateLabels();
	}

	private _resolveInput(): BrowserEditorInput | undefined {
		const known = this.browserViewService.getKnownBrowserViews();
		if (this.content.browserViewId) {
			const byId = known.get(this.content.browserViewId);
			if (byId) {
				return byId;
			}
		}

		const origin = getWebPreviewOriginKey(this.content.url);
		if (!origin) {
			return undefined;
		}
		for (const input of known.values()) {
			if (input.url && getWebPreviewOriginKey(input.url) === origin) {
				return input;
			}
		}
		return undefined;
	}

	private _bindModel(model: IBrowserViewModel): void {
		this._model = model;

		this._bindingStore.add(model.onDidNavigate(() => {
			this._updateLabels();
			this._scheduleCapture();
		}));
		this._bindingStore.add(model.onDidChangeTitle(() => this._updateLabels()));
		this._bindingStore.add(model.onDidChangeFavicon(() => this._updateLabels()));
		this._bindingStore.add(model.onDidChangeLoadingState(e => {
			this._updateLabels();
			if (!e.loading && !e.error) {
				this._scheduleCapture();
			}
		}));

		// Seed the thumbnail from the model's cached screenshot before the
		// first fresh capture lands.
		if (model.screenshot?.byteLength) {
			this._setThumbnail(model.screenshot.buffer);
		}
		this._scheduleCapture();
		this._updateCaptureLoop();
		this._updateLabels();
	}

	private _updateCaptureLoop(): void {
		if (this._visible) {
			if (!this._captureLoop.value) {
				this._captureLoop.value = dom.disposableWindowInterval(dom.getWindow(this.domNode), () => this._tick(), THUMBNAIL_REFRESH_INTERVAL);
			}
		} else {
			this._captureLoop.clear();
		}
	}

	/**
	 * Periodic self-heal: while unbound, keep trying to resolve a browser view
	 * (covers event-ordering races around view creation); while bound, refresh
	 * the thumbnail.
	 */
	private _tick(): void {
		if (!this._input) {
			this._resolveAndBind();
		} else {
			this._scheduleCapture();
		}
	}

	private _scheduleCapture(): void {
		const model = this._model;
		if (!model || this._capturing || !this._visible) {
			return;
		}
		this._capturing = true;
		model.captureScreenshot({ quality: 80 }).then(buffer => {
			this._capturing = false;
			// Zero-byte captures happen while the native view is hidden — keep
			// the last good thumbnail instead.
			if (!this._store.isDisposed && buffer.byteLength > 0) {
				this._setThumbnail(buffer.buffer);
			}
		}, () => {
			this._capturing = false;
		});
	}

	private _setThumbnail(data: Uint8Array): void {
		// Not the LRU-cached variant: captures change every refresh, and a
		// byte-length-keyed cache can serve a stale frame.
		createImageThumbnail(data, THUMBNAIL_MAX_SIZE).then(blob => {
			if (!blob || this._store.isDisposed) {
				return;
			}
			const url = URL.createObjectURL(blob);
			this._thumbnailUrl.value = toDisposable(() => URL.revokeObjectURL(url));
			this._thumbnailImage.style.backgroundImage = `url("${url}")`;
			this.domNode.classList.add('has-thumbnail');
		});
	}

	private _updateLabels(): void {
		const url = this._currentUrl();
		const authority = URL.parse(url)?.host ?? url;
		this._stopped = !!this._model?.error;

		const title = this._model?.title || this._input?.title || authority;
		this._title.textContent = title;

		const favicon = this._model?.favicon ?? this._input?.favicon;
		if (favicon) {
			this._favicon.src = favicon;
		}
		this._favicon.style.display = favicon ? '' : 'none';
		this._faviconFallback.style.display = favicon ? 'none' : '';

		if (this._stopped) {
			this._subtitle.textContent = localize('chat.webPreview.serverStopped', "{0} · Server stopped", authority);
		} else if (this._input) {
			this._subtitle.textContent = localize('chat.webPreview.openedInBrowser', "{0} · Opened in Browser", authority);
		} else {
			this._subtitle.textContent = authority;
		}
		this.domNode.classList.toggle('stopped', this._stopped);

		this._openButton.enabled = !this._stopped;
		this._thumbnailButton.disabled = this._stopped;
		this._thumbnailButton.setAttribute('aria-label', localize('chat.webPreview.openAria', "Open {0} in browser", title));
	}

	private async _open(): Promise<void> {
		if (this._stopped) {
			return;
		}
		const url = this._currentUrl();
		try {
			// Sessions window: reveal the right workbench Browser tab.
			await this.commandService.executeCommand(OPEN_RIGHT_WORKBENCH_BROWSER_COMMAND_ID, this._input ? { browserViewId: this._input.id } : { url });
		} catch {
			// Normal window: the sessions command is not registered — open the
			// integrated browser editor instead.
			await this.commandService.executeCommand(BrowserViewCommandId.Open, { url });
		}
	}

	private _showMoreActions(anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'chat.webPreview.copyUrl', label: localize('chat.webPreview.copyUrl', "Copy URL"), run: () => this.clipboardService.writeText(this._currentUrl()) }),
				toAction({ id: 'chat.webPreview.openExternal', label: localize('chat.webPreview.openExternal', "Open in External Browser"), run: () => this.openerService.open(URI.parse(this._currentUrl()), { openExternal: true }) }),
				toAction({ id: 'chat.webPreview.reload', label: localize('chat.webPreview.reload', "Reload"), enabled: !!this._model, run: () => this._model?.reload() }),
			],
		});
	}

	hasSameContent(other: IChatRendererContent, followingContent: IChatRendererContent[], element: ChatTreeItem): boolean {
		return other.kind === 'webPreview'
			&& getWebPreviewOriginKey(other.url) === getWebPreviewOriginKey(this.content.url)
			&& other.browserViewId === this.content.browserViewId;
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}
