/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatGeneratedImageGallery.css';
import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';

/**
 * Opens the Sessions window's Canvas on a chat image. The chat layer only
 * knows the id; windows without Canvas simply don't register it.
 */
export const OPEN_CANVAS_COMMAND_ID = 'workbench.action.sessions.rightWorkbench.openCanvas';

/** The CLI's "Saved to `generated-images/…`." note that follows each image. */
const SAVED_TO_NOTE = /^Saved to `?generated-(?:images|videos)\/[^`]+`?\.?$/;

/** Stage height for a landscape image at the full 480px width (16:9 → 270px). */
const DEFAULT_STAGE_HEIGHT = 270;
const MAX_STAGE_WIDTH = 480;
const MAX_STAGE_HEIGHT = 360;

export interface IGeneratedImageGalleryHost {
	/** Whether the Canvas command exists in this window. */
	readonly canOpenCanvas: boolean;
	openCanvas(imageUrl: string, view: 'canvas' | 'focused'): void;
}

/**
 * Replaces a response's generated images (plain markdown `<img>`s) with the
 * Codex image gallery: one large preview, a strip of thumbnails when the
 * turn produced several, and a hover "Canvas" action. Returns the listeners
 * to dispose with the rendered markdown.
 */
export function renderGeneratedImageGalleries(root: HTMLElement, isGeneratedImage: (uri: URI) => boolean, host: IGeneratedImageGalleryHost): IDisposable {
	const store = new DisposableStore();
	// eslint-disable-next-line no-restricted-syntax -- the markdown renderer owns these nodes
	const images = [...root.querySelectorAll('img')].filter(img => {
		const src = img.getAttribute('src');
		try {
			return !!src && isGeneratedImage(URI.parse(src));
		} catch {
			return false;
		}
	});
	if (!images.length) {
		return store;
	}

	const first = images[0];
	const anchor = first.closest('p') ?? first;
	const gallery = $('.chat-generated-image-gallery');
	anchor.before(gallery);
	const entries = images.map(img => ({ src: img.getAttribute('src')!, label: img.getAttribute('alt') || '' }));
	for (const img of images) {
		const parent = img.parentElement;
		img.remove();
		// eslint-disable-next-line no-restricted-syntax -- the markdown renderer owns these nodes
		if (parent?.tagName === 'P' && !parent.textContent?.trim() && !parent.querySelector('img, video')) {
			parent.remove();
		}
	}
	// eslint-disable-next-line no-restricted-syntax -- the markdown renderer owns these nodes
	for (const paragraph of [...root.querySelectorAll('p')]) {
		if (SAVED_TO_NOTE.test(paragraph.textContent?.trim() ?? '')) {
			paragraph.remove();
		}
	}

	const stage = append(gallery, $('.chat-generated-image-stage'));
	stage.style.height = `${DEFAULT_STAGE_HEIGHT}px`;
	const track = append(stage, $('.chat-generated-image-track'));
	const previews = entries.map((entry, index) => {
		const label = entry.label || localize('chat.generatedImage.label', "Generated image {0}", index + 1);
		const preview = append(track, $('button.chat-generated-image-preview')) as HTMLButtonElement;
		preview.type = 'button';
		preview.ariaLabel = label;
		preview.setAttribute('aria-hidden', String(index !== 0));
		const img = append(preview, $('img.chat-generated-image-img')) as HTMLImageElement;
		img.alt = label;
		img.referrerPolicy = 'no-referrer';
		img.src = entry.src;
		if (index === 0) {
			store.add(addDisposableListener(img, EventType.LOAD, () => sizeStage(stage, gallery, img)));
		}
		store.add(addDisposableListener(preview, EventType.CLICK, () => {
			if (host.canOpenCanvas) {
				host.openCanvas(entry.src, 'focused');
			}
		}));
		return preview;
	});

	let current = 0;
	if (host.canOpenCanvas) {
		const actions = append(stage, $('.chat-generated-image-actions'));
		const canvas = append(actions, $('button.chat-generated-image-canvas')) as HTMLButtonElement;
		canvas.type = 'button';
		canvas.appendChild(renderIcon(Codicon.fileMedia));
		append(canvas, $('span', {}, localize('chat.generatedImage.canvas', "Canvas")));
		store.add(addDisposableListener(canvas, EventType.CLICK, () => host.openCanvas(entries[current].src, 'canvas')));
	}

	if (entries.length > 1) {
		const strip = append(gallery, $('.chat-generated-image-strip'));
		strip.setAttribute('role', 'group');
		strip.ariaLabel = localize('chat.generatedImage.strip', "Generated images");
		const thumbs = entries.map((entry, index) => {
			const thumb = append(strip, $('button.chat-generated-image-thumb')) as HTMLButtonElement;
			thumb.type = 'button';
			thumb.ariaLabel = localize('chat.generatedImage.show', "Show generated image {0}", index + 1);
			thumb.setAttribute('aria-pressed', String(index === 0));
			const img = append(thumb, $('img.chat-generated-image-img')) as HTMLImageElement;
			img.alt = '';
			img.loading = 'lazy';
			img.decoding = 'async';
			img.referrerPolicy = 'no-referrer';
			img.src = entry.src;
			store.add(addDisposableListener(thumb, EventType.CLICK, () => {
				current = index;
				track.style.transform = `translateX(-${previews[index].offsetLeft}px)`;
				thumbs.forEach((other, otherIndex) => other.setAttribute('aria-pressed', String(otherIndex === index)));
				previews.forEach((other, otherIndex) => other.setAttribute('aria-hidden', String(otherIndex !== index)));
			}));
			return thumb;
		});
	}
	return store;
}

/** Sizes the stage to the first image's aspect ratio, like Codex's gallery. */
function sizeStage(stage: HTMLElement, gallery: HTMLElement, img: HTMLImageElement): void {
	if (!img.naturalWidth || !img.naturalHeight) {
		return;
	}
	const width = Math.min(MAX_STAGE_WIDTH, stage.clientWidth || MAX_STAGE_WIDTH);
	const height = Math.round(Math.min(MAX_STAGE_HEIGHT, width * img.naturalHeight / img.naturalWidth));
	stage.style.height = `${height}px`;
	gallery.style.setProperty('--chat-generated-image-stage-height', `${height}px`);
}

/**
 * The square "Generating image…" card Codex shows while an image renders: a
 * softly pulsing dot field sized like the eventual preview. The generate_image
 * tool row mounts this while running; the finished image then arrives in the
 * response markdown and renders as a gallery.
 */
export function renderGeneratedImagePlaceholder(container: HTMLElement): HTMLElement {
	const placeholder = append(container, $('.chat-core-tool-card-generateImage.chat-generated-image-placeholder'));
	placeholder.setAttribute('role', 'img');
	placeholder.ariaLabel = localize('chat.generatedImage.loading', "Generating image...");
	append(placeholder, $('.chat-generated-image-placeholder-dots'));
	return placeholder;
}
