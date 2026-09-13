/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
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

	test('terminal requests open the bottom panel without changing the right tab', async () => {
		const pane = Object.create(RightWorkbenchViewPane.prototype) as RightWorkbenchViewPane;
		const commands: { id: string; location: TerminalLocation }[] = [];
		Reflect.set(pane, 'activeTabId', 'files');
		Reflect.set(pane, 'commandService', {
			executeCommand: async (id: string, options: { location: TerminalLocation }): Promise<void> => {
				commands.push({ id, location: options.location });
			}
		});
		await pane['openMode']('terminal');
		await pane['openNewTab']('terminal');
		assert.deepStrictEqual({ activeTab: Reflect.get(pane, 'activeTabId'), commands }, {
			activeTab: 'files',
			commands: [
				{ id: 'workbench.action.terminal.new', location: TerminalLocation.Panel },
				{ id: 'workbench.action.terminal.new', location: TerminalLocation.Panel }
			]
		});
	});

	test('returning to a warm terminal restores instance visibility and focus', async () => {
		const pane = Object.create(RightWorkbenchViewPane.prototype) as RightWorkbenchViewPane;
		const events: string[] = [];
		const tab = {
			id: 'terminal', mode: 'terminal',
			terminalInstance: {
				isDisposed: false,
				setVisible: (visible: boolean) => events.push(`visible:${visible}`),
				focus: (force: boolean) => events.push(`focus:${force}`),
			},
		};
		for (const [key, value] of Object.entries({
			tabs: [tab], activeTabId: tab.id, embeddedEditorHost: document.createElement('div'),
			revealWarmEditor: () => { events.push('reveal'); return true; },
		})) {
			Reflect.set(pane, key, value);
		}
		await pane['ensureTerminalEditor']();
		assert.deepStrictEqual(events, ['reveal', 'visible:true', 'focus:true']);
	});

	test('a new terminal is attached before it becomes visible', async () => {
		const pane = Object.create(RightWorkbenchViewPane.prototype) as RightWorkbenchViewPane;
		const events: string[] = [];
		let attached = false;
		const instance = {
			isDisposed: false, onDisposed: Event.None, onTitleChanged: Event.None,
			setVisible: (visible: boolean) => {
				if (visible && !attached) { throw new Error('Terminal shown before attachment'); }
				events.push(`visible:${visible}`);
			},
			focus: () => events.push('focus'),
		};
		const tab = { id: 'terminal', mode: 'terminal' };
		for (const [key, value] of Object.entries({
			tabs: [tab], activeTabId: tab.id, embeddedEditorHost: document.createElement('div'),
			environmentService: { isOptimusWindow: false }, tabStores: new Map(),
			sessionsService: { activeSession: { get: () => undefined } },
			ensureEmbeddedEditorPart: async (): Promise<void> => undefined,
			isActivationCurrent: (): boolean => true,
			terminalService: { createTerminal: async () => instance },
			terminalEditorService: { openEditor: async () => { attached = true; events.push('attach'); } },
			editorPool: { setVisible: () => undefined, getPart: () => undefined },
			refreshTabLabels: (): void => undefined, rememberEditor: (): void => undefined,
			layoutEmbeddedEditorPart: (): void => undefined,
		})) {
			Reflect.set(pane, key, value);
		}
		await pane['ensureTerminalEditor']();
		assert.deepStrictEqual(events, ['visible:false', 'attach', 'visible:true', 'focus']);
	});

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
