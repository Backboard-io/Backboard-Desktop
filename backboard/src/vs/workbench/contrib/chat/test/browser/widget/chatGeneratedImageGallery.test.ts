/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { renderGeneratedImagePlaceholder, renderGeneratedImageGalleries, savedMediaPath } from '../../../browser/widget/chatGeneratedImageGallery.js';

suite('ChatGeneratedImageGallery', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a generated video renders in the image gallery frame with its own controls and Canvas', () => {
		const root = mainWindow.document.createElement('div');
		root.innerHTML = '<p>Done.</p><p><video class="generated-video" src="blob:clip" data-media-url="https://host/generated-video/v.mp4" aria-label="Cat and dog"></video></p><p>Saved to `generated-videos/v.mp4`.</p>';
		const opened: string[] = [];
		store.add(renderGeneratedImageGalleries(root, () => false, { canOpenCanvas: true, openCanvas: (url, view) => opened.push(`${view}:${url}`) }));
		const stage = root.querySelector<HTMLElement>('.chat-generated-image-stage')!;
		const video = stage.querySelector<HTMLVideoElement>('video.chat-generated-image-img')!;
		root.querySelector<HTMLButtonElement>('.chat-generated-image-canvas')!.click();

		assert.deepStrictEqual({
			paragraphs: [...root.querySelectorAll(':scope > p')].map(p => p.textContent),
			videoStage: stage.classList.contains('video'),
			previewIsButton: video.parentElement!.tagName === 'BUTTON',
			controls: video.controls,
			src: video.getAttribute('src'),
			label: video.ariaLabel,
			legacyPlayers: root.querySelectorAll('video.generated-video').length,
			opened,
		}, {
			paragraphs: ['Done.'],
			videoStage: true,
			previewIsButton: false,
			controls: true,
			src: 'blob:clip',
			label: 'Cat and dog',
			legacyPlayers: 0,
			opened: ['canvas:https://host/generated-video/v.mp4'],
		});
	});

	test('an image shown from its saved copy keeps its markdown URL for Canvas', () => {
		const root = mainWindow.document.createElement('div');
		root.innerHTML = '<p><img src="vscode-file://vscode-app/ws/generated-images/a.svg" data-media-url="https://host/generated-images/a.svg" alt="Apple"></p><p>Saved to <code>generated-images/a.svg</code>.</p>';
		const opened: string[] = [];
		store.add(renderGeneratedImageGalleries(root, uri => uri.scheme === 'https', { canOpenCanvas: true, openCanvas: (url, view) => opened.push(`${view}:${url}`) }));
		root.querySelector<HTMLButtonElement>('.chat-generated-image-canvas')!.click();

		assert.deepStrictEqual({
			paragraphs: root.querySelectorAll(':scope > p').length,
			src: root.querySelector('img.chat-generated-image-img')?.getAttribute('src'),
			opened,
		}, {
			paragraphs: 0,
			src: 'vscode-file://vscode-app/ws/generated-images/a.svg',
			opened: ['canvas:https://host/generated-images/a.svg'],
		});
	});

	test('savedMediaPath reads the path from a rendered "Saved to" note only', () => {
		const paragraph = (html: string) => {
			const element = mainWindow.document.createElement('p');
			element.innerHTML = html;
			return element;
		};
		const heading = mainWindow.document.createElement('h2');
		heading.textContent = 'Saved to `generated-images/a.svg`.';
		assert.deepStrictEqual([
			savedMediaPath(paragraph('Saved to <code>generated-images/a.svg</code>.')),
			savedMediaPath(paragraph('Saved to `generated-videos/clip.mp4`')),
			savedMediaPath(paragraph('Saved to <code>notes/a.svg</code>.')),
			savedMediaPath(heading),
			savedMediaPath(undefined),
		], ['generated-images/a.svg', 'generated-videos/clip.mp4', undefined, undefined, undefined]);
	});

	test('the generating placeholder is square for images and 16:9 for videos', () => {
		const container = mainWindow.document.createElement('div');
		const image = renderGeneratedImagePlaceholder(container);
		const video = renderGeneratedImagePlaceholder(container, 'video');
		assert.deepStrictEqual(
			[image, video].map(placeholder => ({ video: placeholder.classList.contains('video'), label: placeholder.ariaLabel })),
			[{ video: false, label: 'Generating image...' }, { video: true, label: 'Generating video...' }],
		);
	});
});
