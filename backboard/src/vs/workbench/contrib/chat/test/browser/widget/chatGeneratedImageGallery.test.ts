/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { renderGeneratedImagePlaceholder, renderGeneratedImageGalleries } from '../../../browser/widget/chatGeneratedImageGallery.js';

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
