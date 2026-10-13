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

/**
 * The Editor window's stand-in for {@link OPEN_CANVAS_COMMAND_ID}: switches to
 * the Simple window on the same chat and opens its Canvas on the image.
 */
export const OPEN_CANVAS_IN_SIMPLE_COMMAND_ID = 'workbench.action.chat.openImageInSimpleCanvas';

/** The CLI's "Saved to `generated-images/…`." note that follows each image. */
const SAVED_TO_NOTE = /^Saved to `?generated-(?:images|videos)\/[^`]+`?\.?$/;

/** Aspect ratio the stage holds until the first image reports its size. */
const DEFAULT_STAGE_ASPECT = '16 / 9';

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
	// Generated images, plus the clips the markdown renderer already upgraded to players.
	// eslint-disable-next-line no-restricted-syntax -- the markdown renderer owns these nodes
	const images = [...root.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video.generated-video')].filter(media => {
		if (media instanceof HTMLVideoElement) {
			return !!media.getAttribute('src');
		}
		const src = media.getAttribute('src');
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
	const entries = images.map(media => {
		const src = media.getAttribute('src')!;
		const kind: 'image' | 'video' = media instanceof HTMLVideoElement ? 'video' : 'image';
		// Canvas knows media by the URL written in the markdown.
		const key = media instanceof HTMLVideoElement ? media.dataset.mediaUrl ?? src : src;
		return { src, key, kind, label: (media instanceof HTMLVideoElement ? media.getAttribute('aria-label') : media.getAttribute('alt')) || '' };
	});
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
	stage.style.aspectRatio = DEFAULT_STAGE_ASPECT;
	const track = append(stage, $('.chat-generated-image-track'));
	stage.classList.toggle('video', entries[0].kind === 'video');
	const previews = entries.map((entry, index) => {
		const label = entry.label || (entry.kind === 'video'
			? localize('chat.generatedVideo.label', "Generated video {0}", index + 1)
			: localize('chat.generatedImage.label', "Generated image {0}", index + 1));
		if (entry.kind === 'video') {
			// A clip keeps its own player controls, so its frame is not a button.
			const preview = append(track, $('.chat-generated-image-preview.video'));
			preview.setAttribute('aria-hidden', String(index !== 0));
			const video = append(preview, $('video.chat-generated-image-img')) as HTMLVideoElement;
			video.controls = true;
			video.preload = 'metadata';
			video.playsInline = true;
			video.ariaLabel = label;
			video.src = entry.src;
			if (index === 0) {
				store.add(addDisposableListener(video, 'loadedmetadata', () => sizeStage(stage, video.videoWidth, video.videoHeight)));
			}
			return preview;
		}
		const preview = append(track, $('button.chat-generated-image-preview')) as HTMLButtonElement;
		preview.type = 'button';
		preview.ariaLabel = label;
		preview.setAttribute('aria-hidden', String(index !== 0));
		const img = append(preview, $('img.chat-generated-image-img')) as HTMLImageElement;
		img.alt = label;
		img.referrerPolicy = 'no-referrer';
		img.src = entry.src;
		if (index === 0) {
			store.add(addDisposableListener(img, EventType.LOAD, () => sizeStage(stage, img.naturalWidth, img.naturalHeight)));
		}
		store.add(addDisposableListener(preview, EventType.CLICK, () => {
			if (host.canOpenCanvas) {
				host.openCanvas(entry.key, 'focused');
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
		store.add(addDisposableListener(canvas, EventType.CLICK, () => host.openCanvas(entries[current].key, 'canvas')));
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
			if (entry.kind === 'video') {
				const video = append(thumb, $('video.chat-generated-image-img')) as HTMLVideoElement;
				video.muted = true;
				video.preload = 'metadata';
				video.playsInline = true;
				video.src = entry.src;
				append(thumb, $('span.chat-generated-image-thumb-play')).appendChild(renderIcon(Codicon.play));
			} else {
				const img = append(thumb, $('img.chat-generated-image-img')) as HTMLImageElement;
				img.alt = '';
				img.loading = 'lazy';
				img.decoding = 'async';
				img.referrerPolicy = 'no-referrer';
				img.src = entry.src;
			}
			store.add(addDisposableListener(thumb, EventType.CLICK, () => {
				current = index;
				stage.classList.toggle('video', entry.kind === 'video');
				track.style.transform = `translateX(-${previews[index].offsetLeft}px)`;
				thumbs.forEach((other, otherIndex) => other.setAttribute('aria-pressed', String(otherIndex === index)));
				previews.forEach((other, otherIndex) => other.setAttribute('aria-hidden', String(otherIndex !== index)));
			}));
			return thumb;
		});
	}
	return store;
}

/**
 * Shapes the stage to the first image, like Codex's gallery (SPEC §6.2): the
 * frame takes the image's own aspect ratio, so there is never an empty band
 * around it, and its width is capped by shape — portrait 400px, up to 2:1
 * 480px, wider panoramas the full column. CSS `aspect-ratio` keeps this right
 * however the column is laid out when the image loads.
 */
function sizeStage(stage: HTMLElement, width: number, height: number): void {
	if (!width || !height) {
		return;
	}
	const aspect = width / height;
	stage.style.aspectRatio = `${width} / ${height}`;
	stage.style.maxWidth = aspect < 1 ? '400px' : aspect < 2 ? '480px' : '100%';
}

/**
 * The "Generating image…" card Codex shows while media renders: a softly
 * pulsing dot field sized like the eventual preview — square for an image,
 * 16:9 for a video. The generate_image / generate_video tool row mounts this
 * while running; the finished media then arrives in the response markdown and
 * renders as a gallery.
 */
export function renderGeneratedImagePlaceholder(container: HTMLElement, kind: 'image' | 'video' = 'image'): HTMLElement {
	const placeholder = append(container, $('.chat-core-tool-card-generateImage.chat-generated-image-placeholder'));
	placeholder.classList.toggle('video', kind === 'video');
	placeholder.setAttribute('role', 'img');
	placeholder.ariaLabel = kind === 'video'
		? localize('chat.generatedVideo.loading', "Generating video...")
		: localize('chat.generatedImage.loading', "Generating image...");
	append(placeholder, $('.chat-generated-image-placeholder-dots'));
	return placeholder;
}
