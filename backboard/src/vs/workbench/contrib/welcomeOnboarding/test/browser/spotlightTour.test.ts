/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindow } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SpotlightTour, TourPlacement } from '../../browser/spotlightTour.js';

suite('Spotlight tour layout', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function settle(container: HTMLElement): Promise<void> {
		for (let i = 0; i < 8; i++) {
			await new Promise<void>(resolve => getWindow(container).requestAnimationFrame(() => resolve()));
		}
	}

	function fixture(width: number, height: number, zoom = 1): { container: HTMLElement; anchor: HTMLElement } {
		const container = document.createElement('div');
		container.style.cssText = `position: fixed; left: 30px; top: 20px; width: ${width}px; height: ${height}px; transform: scale(${zoom}); transform-origin: top left;`;
		document.body.appendChild(container);
		disposables.add(toDisposable(() => container.remove()));
		const style = document.createElement('style');
		style.textContent = '.spotlight-tour-card { transition: none !important; }';
		container.appendChild(style);
		const anchor = document.createElement('div');
		anchor.style.cssText = 'position: absolute; left: 12px; top: 40px; width: 6px; height: 180px;';
		container.appendChild(anchor);
		return { container, anchor };
	}

	test('highlight follows a panel expanding after setup, inside a scaled container', async () => {
		const { container, anchor } = fixture(800, 500, 0.8);
		const tour = disposables.add(new SpotlightTour({
			container, window: getWindow(container),
			steps: [{ title: 'Project', body: 'Project files', anchor: () => anchor, preferredPlacement: TourPlacement.Right }],
		}));
		tour.start();
		await settle(container);
		anchor.style.width = '240px';
		await settle(container);
		const cutout = container.querySelector<HTMLElement>('.spotlight-tour-cutout')!;
		const bounds = cutout.getBoundingClientRect();
		const target = anchor.getBoundingClientRect();
		assert.ok(Math.abs(bounds.width - (target.width + 12 * 0.8)) < 1, 'highlight must track the full panel width');
		assert.ok(Math.abs(bounds.left - (target.left - 6 * 0.8)) < 1, 'highlight must share the target coordinate space');
	});

	test('long content, eight progress dots, and navigation stay inside a small window on every step', async () => {
		const { container, anchor } = fixture(320, 280);
		anchor.style.cssText = 'position: absolute; inset: 0;';
		const tour = disposables.add(new SpotlightTour({
			container, window: getWindow(container),
			steps: Array.from({ length: 8 }, (_, index) => ({
				title: `Step ${index + 1}`,
				body: 'A long description that must scroll without pushing navigation out of the window. '.repeat(12),
				anchor: () => anchor,
				nextLabel: index === 7 ? 'Start Building' : undefined,
			})),
		}));
		tour.start();
		for (let index = 0; index < 8; index++) {
			await settle(container);
			const card = container.querySelector<HTMLElement>('.spotlight-tour-card')!;
			const bounds = card.getBoundingClientRect();
			const viewport = container.getBoundingClientRect();
			assert.ok(bounds.left >= viewport.left + 15 && bounds.right <= viewport.right - 15 && bounds.top >= viewport.top + 15 && bounds.bottom <= viewport.bottom - 15, `step ${index + 1} card fits`);
			for (const button of card.querySelectorAll('button')) {
				const rect = button.getBoundingClientRect();
				assert.ok(rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom, `step ${index + 1} navigation fits`);
			}
			assert.strictEqual(card.querySelector<HTMLElement>('.spotlight-tour-arrow')!.style.display, 'none');
			if (index < 7) {
				card.querySelector<HTMLButtonElement>('.spotlight-tour-btn-primary')!.click();
			}
		}
	});
});
