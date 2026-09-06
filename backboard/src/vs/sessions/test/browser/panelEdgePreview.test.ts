/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { PanelEdgePreview } from '../../browser/parts/panelEdgePreview.js';

suite('Panel edge previews', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens and focuses the correct panel, dismisses with Escape, and removes its listeners', () => {
		const calls: string[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IWorkbenchLayoutService, {
			setPartHidden: (hidden: boolean, part: Parts) => { calls.push(`${part}:${hidden}`); },
			focusPart: (part: Parts) => { calls.push(`focus:${part}`); },
		});
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.append(container);
		store.add(toDisposable(() => container.remove()));
		const previews = store.add(instantiation.createInstance(PanelEdgePreview, container));
		const buttons = Array.from(container.querySelectorAll('button'));
		buttons[0].click();
		buttons[1].click();
		assert.deepStrictEqual(calls, [
			`${Parts.SIDEBAR_PART}:false`, `focus:${Parts.SIDEBAR_PART}`,
			`${Parts.AUXILIARYBAR_PART}:false`, `focus:${Parts.AUXILIARYBAR_PART}`,
		]);
		buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		assert.ok(buttons[1].parentElement?.classList.contains('dismissed'));
		buttons[1].parentElement?.dispatchEvent(new MouseEvent('mouseleave'));
		assert.ok(!buttons[1].parentElement?.classList.contains('dismissed'));
		previews.dispose();
		buttons[0].click();
		assert.strictEqual(calls.length, 4);
		assert.strictEqual(container.childElementCount, 0);
	});
});
