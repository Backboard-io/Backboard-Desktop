/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { safeIntl } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatProgressResponseContent, IChatRequestModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { isToolResultInputOutputDetails } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';

/** One image produced in the chat, as shown on the canvas. */
export interface ICanvasImage {
	/** Stable identity across refreshes: the image URL. */
	readonly key: string;
	/** What the tile displays (the hosted URL, or a workspace file). */
	readonly src: URI;
	readonly label: string;
	/** The copy the CLI saved into the session folder, attachable to the composer. */
	readonly localFile: URI | undefined;
}

/** The images one turn produced, shown as a row under its time. */
export interface ICanvasImageGroup {
	readonly timestamp: number;
	readonly images: readonly ICanvasImage[];
}

/** A note pinned to a point of an image while batch-editing in comment mode. */
export interface ICanvasComment {
	/** Pin position as a fraction of the image's width and height. */
	readonly x: number;
	readonly y: number;
	readonly text: string;
}

/**
 * Matches the markdown the Backboard CLI appends for generated media:
 * `![label](url)` optionally followed by "Saved to `generated-images/…`.".
 */
const GENERATED_IMAGE_MARKDOWN = /!\[(?<label>[^\]]*)\]\(\s*(?<url>[^)\s]+)\s*\)(?:\s*Saved to `(?<saved>[^`]+)`)?/g;
const VIDEO_EXTENSION = /\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/i;

/**
 * Collects the images each response rendered, oldest turn first. An image is
 * listed once, in the turn that first showed it.
 */
export function extractCanvasImageGroups(requests: readonly IChatRequestModel[], workingDirectory: URI | undefined): ICanvasImageGroup[] {
	const seen = new Set<string>();
	const groups: ICanvasImageGroup[] = [];
	let count = 0;
	for (const request of requests) {
		const response = request.response;
		if (!response) {
			continue;
		}
		const text = response.response.value.map(partText).join('\n');
		const images: ICanvasImage[] = [];
		for (const match of text.matchAll(GENERATED_IMAGE_MARKDOWN)) {
			const url = match.groups?.url;
			if (!url || seen.has(url) || VIDEO_EXTENSION.test(url)) {
				continue;
			}
			const src = resolveImageUri(url, workingDirectory);
			if (!src) {
				continue;
			}
			seen.add(url);
			count++;
			const saved = match.groups?.saved;
			images.push({
				key: url,
				src,
				label: match.groups?.label?.trim() || localize('rightWorkbench.canvas.generatedImage', "Generated image {0}", count),
				localFile: saved && workingDirectory ? joinPath(workingDirectory, saved) : src.scheme === 'file' ? src : undefined,
			});
		}
		if (images.length) {
			groups.push({ timestamp: response.timestamp || request.timestamp, images });
		}
	}
	return groups;
}

/**
 * The text an image link can appear in: the response markdown, or the
 * `generate_image` tool's result, which carries the same `![…](…)` plus
 * "Saved to …" detail when the final answer omits it.
 */
function partText(part: IChatProgressResponseContent): string {
	if (part.kind === 'markdownContent') {
		return part.content.value;
	}
	if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
		const details = IChatToolInvocation.resultDetails(part);
		if (isToolResultInputOutputDetails(details)) {
			return details.output.map(output => output.type === 'embed' && output.isText ? output.value : '').join('\n');
		}
	}
	return '';
}

function resolveImageUri(url: string, workingDirectory: URI | undefined): URI | undefined {
	if (/^(?:https?:|data:image\/)/i.test(url)) {
		return URI.parse(url);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		return undefined; // Other schemes (javascript:, command:, …) are never images here.
	}
	return workingDirectory ? joinPath(workingDirectory, url) : undefined;
}

export interface IRightWorkbenchCanvasDelegate {
	/** Resolves a tile's displayable URL (e.g. a blob URL for workspace files). */
	toDisplayUrl(image: ICanvasImage): Promise<string | undefined>;
	/** Makes these images the canvas-owned attachments of the chat composer. */
	setComposerImages(images: readonly ICanvasImage[]): void;
	/** Canvas takes the whole window like Codex while the user is working in it. */
	setFullScreen(fullScreen: boolean): void;
	/** Sends one batch-edit request for the commented images. */
	sendComments(comments: ReadonlyMap<ICanvasImage, readonly ICanvasComment[]>): void;
}

export type CanvasView = 'canvas' | 'focused';

const CANVAS_ZOOM_LEVELS = [0.25, 0.5, 1, 1.5, 2];
/** Focused view adds "Zoom to fit" (its default) on top of the fixed levels. */
const FIT = 'fit';
const timeFormatter = safeIntl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The image playground: every image from the chat as a zoomable grid grouped
 * by turn, a focused single-image view, and selection that feeds the composer.
 * Behaviour mirrors Codex: a click selects (a second click keeps it
 * selected), Multi-Select toggles images in and out, and Comment mode pins
 * numbered notes onto images and sends them as one batch edit.
 */
export class RightWorkbenchCanvas extends Disposable {
	private readonly renderStore = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private groups: readonly ICanvasImageGroup[] = [];
	private view: CanvasView = 'canvas';
	private canvasZoom = 1;
	private focusedZoom: number | typeof FIT = FIT;
	private multiSelect = false;
	private commentMode = false;
	private readonly selected = new Set<string>();
	private readonly comments = new Map<string, ICanvasComment[]>();
	/** The unsaved comment being typed, if any. */
	private draft: { readonly key: string; readonly x: number; readonly y: number } | undefined;
	private readonly displayUrls = new Map<string, Promise<string | undefined>>();
	private focusedStage: HTMLElement | undefined;
	private focusedImageElement: HTMLImageElement | undefined;
	private fullScreen: boolean | undefined;
	/**
	 * Full screen follows what the user did (opened Canvas, picked a view,
	 * clicked an image in chat), never a background refresh: switching chats
	 * must not maximize the panel over the chat the user just picked.
	 */
	private fullScreenIntent = true;
	private chatKey: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly delegate: IRightWorkbenchCanvasDelegate,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
		this.root = append(container, $('.sessions-right-workbench-canvas'));
	}

	setGroups(groups: readonly ICanvasImageGroup[], chatKey: string | undefined): void {
		if (this.chatKey !== undefined && chatKey !== this.chatKey) {
			this.fullScreenIntent = false;
			this.selected.clear();
			this.comments.clear();
			this.draft = undefined;
		}
		this.chatKey = chatKey;
		this.groups = groups;
		const keys = new Set(groups.flatMap(group => group.images.map(image => image.key)));
		for (const key of [...this.selected]) {
			if (!keys.has(key)) {
				this.selected.delete(key);
			}
		}
		for (const key of [...this.comments.keys()]) {
			if (!keys.has(key)) {
				this.comments.delete(key);
			}
		}
		this.render();
	}

	/** Selects an image (e.g. one clicked in the chat) and shows it in the given view. */
	reveal(imageKey: string | undefined, view: CanvasView | undefined): void {
		if (imageKey && this.allImages.some(image => image.key === imageKey)) {
			this.selected.clear();
			this.selected.add(imageKey);
			this.publishSelection();
		}
		if (view) {
			this.view = view;
		}
		this.fullScreenIntent = true;
		this.render();
	}

	private get allImages(): ICanvasImage[] {
		return this.groups.flatMap(group => group.images);
	}

	private render(): void {
		this.renderStore.clear();
		clearNode(this.root);
		this.focusedStage = undefined;
		this.focusedImageElement = undefined;
		this.root.classList.toggle('focused', this.view === 'focused');
		this.root.classList.toggle('comment-mode', this.commentMode);
		const fullScreen = this.fullScreenIntent && this.allImages.length > 0;
		if (fullScreen !== this.fullScreen) {
			this.fullScreen = fullScreen;
			this.delegate.setFullScreen(fullScreen);
		}
		if (!this.allImages.length) {
			this.renderEmpty();
			return;
		}
		if (this.view === 'focused') {
			this.renderFocused();
		} else {
			this.renderGrid();
		}
		this.renderToolbar();
	}

	private renderEmpty(): void {
		const empty = append(this.root, $('.sessions-right-workbench-review-empty.sessions-right-workbench-canvas-empty'));
		empty.appendChild(renderIcon(Codicon.fileMedia));
		append(empty, $('h2', {}, localize('rightWorkbench.canvas.emptyTitle', "No Images Yet")));
		append(empty, $('p', {}, localize('rightWorkbench.canvas.emptyDescription', "Images generated in this thread will appear here.")));
	}

	// --- toolbar ------------------------------------------------------------

	private renderToolbar(): void {
		const views = append(this.root, $('.sessions-right-workbench-canvas-views'));
		views.setAttribute('role', 'group');
		views.ariaLabel = localize('rightWorkbench.canvas.views', "Image View");
		this.renderViewButton(views, 'focused', localize('rightWorkbench.canvas.focusedView', "Focused View"));
		this.renderViewButton(views, 'canvas', localize('rightWorkbench.canvas.canvasView', "Canvas View"));

		if (this.view === 'canvas') {
			const anchor = append(this.root, $('.sessions-right-workbench-canvas-pill-anchor'));
			const pill = append(anchor, $('.sessions-right-workbench-canvas-pill'));
			pill.setAttribute('role', 'toolbar');
			pill.ariaLabel = localize('rightWorkbench.canvas.tools', "Image Playground Tools");
			if (this.commentMode) {
				this.renderCommentBanner(pill);
			} else {
				this.renderPillButton(pill, Codicon.commentAdd, localize('rightWorkbench.canvas.comment', "Comment"), undefined, () => this.setCommentMode(true));
				this.renderPillButton(pill, Codicon.selection, localize('rightWorkbench.canvas.multiSelect', "Multi-Select"), this.multiSelect, () => this.toggleMultiSelect());
			}
		}

		this.renderZoom();
	}

	private renderViewButton(container: HTMLElement, view: CanvasView, label: string): void {
		const button = append(container, $('button.sessions-right-workbench-canvas-view-button')) as HTMLButtonElement;
		button.type = 'button';
		button.ariaLabel = button.title = label;
		button.setAttribute('aria-pressed', String(this.view === view));
		if (view === 'focused') {
			button.appendChild(renderIcon(Codicon.window));
		} else {
			// Codicons have no 2×2 grid; draw one so the two views read apart.
			const grid = append(button, $('span.sessions-right-workbench-canvas-grid-icon'));
			grid.setAttribute('aria-hidden', 'true');
			for (let i = 0; i < 4; i++) {
				append(grid, $('span'));
			}
		}
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => this.setView(view)));
	}

	private renderPillButton(container: HTMLElement, icon: ThemeIcon, label: string, pressed: boolean | undefined, run: () => void): void {
		const button = append(container, $('button.sessions-right-workbench-canvas-pill-button')) as HTMLButtonElement;
		button.type = 'button';
		if (pressed !== undefined) {
			button.setAttribute('aria-pressed', String(pressed));
		}
		button.appendChild(renderIcon(icon));
		append(button, $('span.label', {}, label));
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private renderCommentBanner(pill: HTMLElement): void {
		const count = [...this.comments.values()].reduce((sum, list) => sum + list.length, 0);
		append(pill, $('span.sessions-right-workbench-canvas-pill-hint', {}, count === 0
			? localize('rightWorkbench.canvas.commentHint', "Add comments on multiple images to batch edit them")
			: count === 1 ? localize('rightWorkbench.canvas.oneComment', "1 comment") : localize('rightWorkbench.canvas.comments', "{0} comments", count)));
		const send = append(pill, $('button.sessions-right-workbench-canvas-pill-send', {}, localize('rightWorkbench.canvas.send', "Send"))) as HTMLButtonElement;
		send.type = 'button';
		send.disabled = count === 0;
		this.renderStore.add(addDisposableListener(send, EventType.CLICK, () => this.sendComments()));
		const close = append(pill, $('button.sessions-right-workbench-canvas-pill-close')) as HTMLButtonElement;
		close.type = 'button';
		close.ariaLabel = close.title = localize('rightWorkbench.canvas.exitComments', "Exit Comment Mode");
		close.appendChild(renderIcon(Codicon.close));
		this.renderStore.add(addDisposableListener(close, EventType.CLICK, () => this.setCommentMode(false)));
	}

	private renderZoom(): void {
		const zoom = append(this.root, $('button.sessions-right-workbench-canvas-zoom')) as HTMLButtonElement;
		zoom.type = 'button';
		zoom.ariaLabel = localize('rightWorkbench.canvas.zoom', "Zoom");
		zoom.setAttribute('aria-haspopup', 'menu');
		const current = this.view === 'canvas' ? this.canvasZoom : this.focusedZoom;
		const value = append(zoom, $('span.value'));
		if (current === FIT) {
			// Fit shows the effective scale once the image has laid out.
			void this.fittedScale().then(scale => {
				value.textContent = scale === undefined ? '' : `${Math.round(scale * 100)}%`;
			});
		} else {
			value.textContent = `${Math.round(current * 100)}%`;
		}
		zoom.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(addDisposableListener(zoom, EventType.CLICK, () => {
			const levels = CANVAS_ZOOM_LEVELS.map(level => toAction({
				id: `sessions.rightWorkbench.canvas.zoom.${level}`,
				label: `${Math.round(level * 100)}%`,
				checked: level === current,
				run: () => this.setZoom(level),
			}));
			this.contextMenuService.showContextMenu({
				getAnchor: () => zoom,
				getActions: () => this.view === 'canvas' ? levels : [...levels, toAction({
					id: 'sessions.rightWorkbench.canvas.zoom.fit',
					label: localize('rightWorkbench.canvas.zoomToFit', "Zoom to Fit"),
					checked: current === FIT,
					run: () => this.setZoom(FIT),
				})],
			});
		}));
	}

	private setZoom(level: number | typeof FIT): void {
		if (this.view === 'canvas') {
			this.canvasZoom = level === FIT ? 1 : level;
		} else {
			this.focusedZoom = level;
		}
		this.render();
	}

	private setView(view: CanvasView): void {
		if (this.view !== view) {
			this.view = view;
			this.draft = undefined;
			this.fullScreenIntent = true;
			this.render();
		}
	}

	private toggleMultiSelect(): void {
		this.multiSelect = !this.multiSelect;
		this.render();
	}

	private setCommentMode(on: boolean): void {
		this.commentMode = on;
		this.draft = undefined;
		if (!on) {
			this.comments.clear();
		}
		this.render();
	}

	private sendComments(): void {
		const byImage = new Map<ICanvasImage, readonly ICanvasComment[]>();
		for (const image of this.allImages) {
			const list = this.comments.get(image.key);
			if (list?.length) {
				byImage.set(image, list);
			}
		}
		if (!byImage.size) {
			return;
		}
		this.delegate.sendComments(byImage);
		this.setCommentMode(false);
	}

	// --- canvas view --------------------------------------------------------

	private renderGrid(): void {
		const scroll = append(this.root, $('.sessions-right-workbench-canvas-scroll'));
		const content = append(scroll, $('.sessions-right-workbench-canvas-content'));
		content.style.setProperty('--rwb-canvas-zoom', String(this.canvasZoom));
		let selectedFrame: HTMLElement | undefined;
		let lastRow: HTMLElement | undefined;
		for (const group of this.groups) {
			const row = append(content, $('.sessions-right-workbench-canvas-row'));
			const time = append(row, $('time.sessions-right-workbench-canvas-time', {}, timeFormatter.value.format(group.timestamp)));
			time.setAttribute('datetime', new Date(group.timestamp).toISOString());
			for (const image of group.images) {
				const frame = this.renderTile(row, image);
				if (this.selected.has(image.key) || this.draft?.key === image.key) {
					selectedFrame ??= frame;
				}
			}
			lastRow = row;
		}
		(selectedFrame ?? lastRow)?.scrollIntoView({ block: 'nearest' });
	}

	private renderTile(container: HTMLElement, image: ICanvasImage): HTMLElement {
		const frame = append(container, $('.sessions-right-workbench-canvas-frame'));
		const tile = append(frame, $('button.sessions-right-workbench-canvas-tile')) as HTMLButtonElement;
		tile.type = 'button';
		tile.ariaLabel = image.label;
		const hasComments = !!this.comments.get(image.key)?.length;
		// In comment mode the ring marks images carrying notes; otherwise it marks the selection.
		const ringed = this.commentMode ? hasComments || this.draft?.key === image.key : this.selected.has(image.key);
		tile.setAttribute('aria-pressed', String(ringed));
		const img = append(tile, $('img')) as HTMLImageElement;
		img.alt = '';
		img.decoding = 'async';
		img.draggable = false;
		img.referrerPolicy = 'no-referrer';
		void this.loadInto(img, image);
		if (this.multiSelect && !this.commentMode && this.selected.has(image.key)) {
			append(frame, $('span.sessions-right-workbench-canvas-check')).appendChild(renderIcon(Codicon.check));
		}
		this.renderPins(frame, image);
		this.renderStore.add(addDisposableListener(tile, EventType.CLICK, event => {
			if (this.commentMode) {
				const rect = tile.getBoundingClientRect();
				this.draft = { key: image.key, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
				this.render();
			} else {
				this.toggleSelection(image);
			}
		}));
		return frame;
	}

	private renderPins(frame: HTMLElement, image: ICanvasImage): void {
		const list = this.comments.get(image.key) ?? [];
		const numberOffset = this.commentNumberOffset(image.key);
		list.forEach((comment, index) => {
			const pin = append(frame, $('span.sessions-right-workbench-canvas-pin', {}, String(numberOffset + index + 1)));
			pin.style.left = `${comment.x * 100}%`;
			pin.style.top = `${comment.y * 100}%`;
			pin.title = comment.text;
		});
		if (this.draft?.key !== image.key) {
			return;
		}
		const draft = this.draft;
		const pin = append(frame, $('span.sessions-right-workbench-canvas-pin', {}, String(numberOffset + list.length + 1)));
		pin.style.left = `${draft.x * 100}%`;
		pin.style.top = `${draft.y * 100}%`;
		const bubble = append(frame, $('form.sessions-right-workbench-canvas-comment'));
		bubble.style.left = `${draft.x * 100}%`;
		bubble.style.top = `${draft.y * 100}%`;
		// Past the middle the bubble opens to the pin's left so it stays over the image.
		bubble.classList.toggle('flip', draft.x > 0.55);
		const input = append(bubble, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('rightWorkbench.canvas.addComment', "Add a comment…");
		input.ariaLabel = input.placeholder;
		this.renderStore.add(addDisposableListener(bubble, EventType.SUBMIT, event => {
			event.preventDefault();
			const text = input.value.trim();
			if (text) {
				const comments = this.comments.get(draft.key) ?? [];
				comments.push({ x: draft.x, y: draft.y, text });
				this.comments.set(draft.key, comments);
			}
			this.draft = undefined;
			this.render();
		}));
		this.renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.draft = undefined;
				this.render();
			}
		}));
		this.renderStore.add(addDisposableListener(input, EventType.CLICK, event => event.stopPropagation()));
		const timeout = setTimeout(() => input.focus(), 0);
		this.renderStore.add({ dispose: () => clearTimeout(timeout) });
	}

	/** Comment numbers run across images in display order, like Codex. */
	private commentNumberOffset(imageKey: string): number {
		let offset = 0;
		for (const image of this.allImages) {
			if (image.key === imageKey) {
				break;
			}
			offset += this.comments.get(image.key)?.length ?? 0;
		}
		return offset;
	}

	// --- focused view -------------------------------------------------------

	private renderFocused(): void {
		const images = this.allImages;
		const current = images.find(image => this.selected.has(image.key)) ?? images[images.length - 1];
		const stage = append(this.root, $('.sessions-right-workbench-canvas-focused-stage'));
		stage.classList.toggle('fit', this.focusedZoom === FIT);
		stage.tabIndex = 0;
		stage.ariaLabel = current.label;
		this.focusedStage = stage;
		const img = append(stage, $('img')) as HTMLImageElement;
		img.alt = current.label;
		img.draggable = false;
		img.referrerPolicy = 'no-referrer';
		if (this.focusedZoom !== FIT) {
			img.style.setProperty('--rwb-canvas-zoom', String(this.focusedZoom));
		}
		this.focusedImageElement = img;
		void this.loadInto(img, current);
		const index = images.indexOf(current);
		this.renderStore.add(addDisposableListener(stage, EventType.KEY_DOWN, event => {
			if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && images.length > 1) {
				event.preventDefault();
				const next = images[(index + (event.key === 'ArrowRight' ? 1 : -1) + images.length) % images.length];
				this.selected.clear();
				this.selected.add(next.key);
				this.publishSelection();
				this.render();
				this.focusedStage?.focus();
			}
		}));
	}

	/** Resolves the fitted image's effective scale for the zoom readout. */
	private async fittedScale(): Promise<number | undefined> {
		const img = this.focusedImageElement;
		if (!img) {
			return undefined;
		}
		if (!img.complete || !img.naturalWidth) {
			await new Promise<void>(resolve => {
				img.addEventListener('load', () => resolve(), { once: true });
				img.addEventListener('error', () => resolve(), { once: true });
			});
		}
		return img.naturalWidth ? img.getBoundingClientRect().width / img.naturalWidth : undefined;
	}

	// --- selection ----------------------------------------------------------

	private toggleSelection(image: ICanvasImage): void {
		if (this.multiSelect) {
			if (!this.selected.delete(image.key)) {
				this.selected.add(image.key);
			}
		} else if (this.selected.has(image.key) && this.selected.size === 1) {
			return; // Codex keeps a lone selection when it is clicked again.
		} else {
			this.selected.clear();
			this.selected.add(image.key);
		}
		this.publishSelection();
		this.render();
	}

	private publishSelection(): void {
		this.delegate.setComposerImages(this.allImages.filter(image => this.selected.has(image.key)));
	}

	private async loadInto(img: HTMLImageElement, image: ICanvasImage): Promise<void> {
		let url = this.displayUrls.get(image.key);
		if (!url) {
			url = this.delegate.toDisplayUrl(image);
			this.displayUrls.set(image.key, url);
		}
		const resolved = await url;
		if (resolved && img.isConnected) {
			img.src = resolved;
		}
	}
}
