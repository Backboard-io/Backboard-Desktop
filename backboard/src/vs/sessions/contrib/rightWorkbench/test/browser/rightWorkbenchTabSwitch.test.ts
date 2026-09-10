/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { RightWorkbenchEditorPool } from '../../browser/rightWorkbenchEditorPool.js';
import { RightWorkbenchViewPane } from '../../browser/rightWorkbenchViewPane.js';

suite('RightWorkbenchTabSwitch', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('rapid activation keeps tab buttons and listeners alive without closing editors', async () => {
		// Exercise the real panel chrome and switching path without starting
		// terminals, browser processes, or agent backends in this UI test.
		const pane = Object.create(RightWorkbenchViewPane.prototype) as RightWorkbenchViewPane;
		const root = document.createElement('div');
		const pool = store.add(new RightWorkbenchEditorPool(new class extends mock<IEditorGroupsService>() { }()));
		const layout = new class extends mock<IWorkbenchLayoutService>() {
			override readonly onDidChangeAuxiliaryBarMaximized = Event.None;
			override setPartHidden(): void { }
			override isAuxiliaryBarMaximized(): boolean { return false; }
		}();
		let closes = 0;
		for (const [key, value] of Object.entries({
			root, editorPool: pool, layoutService: layout, environmentService: { isOptimusWindow: false },
			domStore: store.add(new DisposableStore()), headerStore: store.add(new DisposableStore()),
			modePickerStore: store.add(new DisposableStore()), tabLabelElements: new Map(),
			tabs: ['a', 'b', 'c'].map(id => ({ id, mode: 'files', editorInputs: new Set(), pendingEditorOpens: new Set() })),
			activeTabId: 'a', activationGeneration: 0, isRightWorkbenchVisible: true,
			renderModeBody: (body: HTMLElement) => { body.textContent = pane['activeTabId'] ?? ''; },
			closeEmbeddedEditorPart: async () => { closes++; return true; },
		})) {
			Reflect.set(pane, key, value);
		}
		pane['renderShell']();
		const buttons = [...root.querySelectorAll<HTMLElement>('[data-tab-id]')];
		await Promise.all([pane['openTab']('b'), pane['openTab']('c'), pane['openTab']('a')]);
		buttons[1].click();
		assert.deepStrictEqual({
			closes,
			active: pane['activeTabId'],
			content: root.querySelector('.sessions-right-workbench-body')?.textContent,
			sameButtons: buttons.every((button, i) => button === root.querySelectorAll('[data-tab-id]')[i]),
			selection: buttons.map(button => [button.getAttribute('aria-selected'), button.tabIndex]),
		}, { closes: 0, active: 'b', content: 'b', sameButtons: true, selection: [['false', -1], ['true', 0], ['false', -1]] });
	});
});
