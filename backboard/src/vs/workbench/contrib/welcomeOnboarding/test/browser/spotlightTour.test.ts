/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SpotlightTour } from '../../browser/spotlightTour.js';

suite('Spotlight tour layout', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('remeasures an opening sidebar and its final transition position', async () => {
		const container = document.body.appendChild(document.createElement('div'));
		disposables.add(toDisposable(() => container.remove()));
		const anchor = container.appendChild(document.createElement('div'));
		anchor.style.cssText = 'position:fixed;left:40px;top:40px;width:10px;height:200px';
		const tour = disposables.add(new SpotlightTour({
			container,
			window,
			steps: [{ title: 'Explorer', body: 'Files', anchor: () => anchor }],
		}));
		const frames = async () => {
			for (let index = 0; index < 8; index++) {
				await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
			}
		};
		tour.start();
		await frames();
		anchor.style.width = '300px';
		await frames();
		const cutout = container.querySelector<HTMLElement>('.spotlight-tour-cutout')!;
		assert.strictEqual(cutout.style.width, '312px');
		anchor.style.transform = 'translateX(20px)';
		anchor.dispatchEvent(new Event('transitionend', { bubbles: true }));
		assert.strictEqual(cutout.style.left, '54px');
	});
});
