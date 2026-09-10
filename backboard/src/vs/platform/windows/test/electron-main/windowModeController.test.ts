/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICodeWindow } from '../../../window/electron-main/window.js';
import { WindowModeController, WorkbenchMode } from '../../electron-main/windowModeController.js';

suite('WindowModeController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHost() {
		const windows = new Map<WorkbenchMode, ICodeWindow>();
		const activations: ICodeWindow[] = [];
		let closed = false;
		const controller = store.add(new WindowModeController({
			find: mode => windows.get(mode),
			isClosed: () => closed,
			suspend: () => {},
			activate: window => activations.push(window),
		}));
		const add = (mode: WorkbenchMode, ready = true) => {
			const onReady = store.add(new Emitter<void>());
			const window = upcastPartial<ICodeWindow>({ get isReady() { return ready; }, onDidSignalReady: onReady.event, onDidClose: Event.None, win: upcastPartial<Electron.BrowserWindow>({}) });
			windows.set(mode, window);
			return { window, ready: () => { ready = true; onReady.fire(); } };
		};
		return { controller, windows, activations, add, close: () => closed = true };
	}

	test('warm switches never reopen or unload a retained workbench', async () => {
		const h = createHost();
		const simple = h.add('simple').window;
		const editor = h.add('editor').window;
		const open = async () => { assert.fail('warm mode must not reload'); };
		await h.controller.open('simple', open);
		await h.controller.open('editor', open);
		assert.deepStrictEqual(h.activations, [simple, editor]);
	});

	test('repeated clicks during a cold load create one view and activate once', async () => {
		const h = createHost();
		const gate = new DeferredPromise<ICodeWindow[]>();
		let opens = 0;
		const open = () => { opens++; return gate.p; };
		const requests = Array.from({ length: 100 }, () => h.controller.open('advanced', open));
		const advanced = h.add('advanced').window;
		await gate.complete([advanced]);
		await Promise.all(requests);
		assert.deepStrictEqual({ opens, activations: h.activations }, { opens: 1, activations: [advanced] });
	});

	test('a late cold load cannot replace the most recently clicked warm mode', async () => {
		const h = createHost();
		const editor = h.add('editor').window;
		const advanced = h.add('advanced', false);
		const loading = h.controller.open('advanced', async () => [advanced.window], () => false);
		await h.controller.open('editor', async () => { assert.fail('unexpected load'); });
		advanced.ready();
		assert.deepStrictEqual({ stale: await loading, activations: h.activations }, { stale: undefined, activations: [editor] });
	});

	test('closing the host prevents activation after preparation finishes', async () => {
		const h = createHost();
		const gate = new DeferredPromise<ICodeWindow[]>();
		const loading = h.controller.open('simple', () => gate.p);
		h.close();
		await gate.complete([h.add('simple').window]);
		assert.deepStrictEqual([await loading, h.activations], [undefined, []]);
	});

	test('failed cold loads release their slot for retry', async () => {
		const h = createHost();
		await assert.rejects(h.controller.open('simple', async () => { throw new Error('load failed'); }));
		const simple = h.add('simple').window;
		await h.controller.open('simple', async () => [simple]);
		assert.deepStrictEqual(h.activations, [simple]);
	});

	test('changing the editor folder reuses the slot and respects an unload veto', async () => {
		const h = createHost();
		const editor = h.add('editor').window;
		let requested: ICodeWindow | undefined;
		const result = await h.controller.open('editor', async existing => { requested = existing; return []; }, () => false);
		assert.deepStrictEqual({ result, requested, activations: h.activations, slots: h.windows.size }, { result: undefined, requested: editor, activations: [], slots: 1 });
	});

	test('preloading and clicks share one load without replacing the newest selection', async () => {
		const h = createHost();
		const simple = h.add('simple').window;
		const gate = new DeferredPromise<ICodeWindow[]>();
		const preloading = h.controller.preload('advanced', () => gate.p);
		const click = h.controller.open('advanced', async () => { assert.fail('preload must be reused'); });
		await h.controller.open('simple', async () => { assert.fail('warm mode must not reload'); });
		const advanced = h.add('advanced').window;
		await gate.complete([advanced]);
		assert.deepStrictEqual({ preloaded: await preloading, staleClick: await click, activations: h.activations }, { preloaded: advanced, staleClick: undefined, activations: [simple] });
	});

	test('a click activates the preloaded mode once ready', async () => {
		const h = createHost();
		const gate = new DeferredPromise<ICodeWindow[]>();
		const preloading = h.controller.preload('editor', () => gate.p);
		const click = h.controller.open('editor', async () => { assert.fail('duplicate load'); });
		const editor = h.add('editor').window;
		await gate.complete([editor]);
		assert.deepStrictEqual([await preloading, await click, h.activations], [editor, editor, [editor]]);
	});

	test('startup warming is serial, skips existing modes, and only runs once', () => runWithFakedTimers({}, async () => {
		const h = createHost();
		h.add('simple');
		const opened: WorkbenchMode[] = [];
		let concurrent = 0;
		let maximumConcurrent = 0;
		const open = async (mode: WorkbenchMode) => {
			maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
			opened.push(mode);
			await timeout(2000);
			concurrent--;
			return [h.add(mode).window];
		};
		h.controller.schedulePreload(open, error => { throw error; });
		h.controller.schedulePreload(open, error => { throw error; });
		await timeout(7000);
		assert.deepStrictEqual({ opened, maximumConcurrent, activations: h.activations, slots: h.windows.size }, { opened: ['editor', 'advanced'], maximumConcurrent: 1, activations: [], slots: 3 });
	}));

	test('closing during startup stops the remaining warmups', () => runWithFakedTimers({}, async () => {
		const h = createHost();
		h.add('simple');
		const opened: WorkbenchMode[] = [];
		h.controller.schedulePreload(async mode => {
			opened.push(mode);
			h.close();
			return [h.add(mode).window];
		}, error => { throw error; });
		await timeout(5000);
		assert.deepStrictEqual([opened, h.activations], [['editor'], []]);
	}));

	test('disposing cancels scheduled startup work', () => runWithFakedTimers({}, async () => {
		const h = createHost();
		h.controller.schedulePreload(async () => { assert.fail('disposed startup must not load'); }, error => { throw error; });
		h.controller.dispose();
		await timeout(2000);
	}));

	test('background preparation never reloads an existing editor', async () => {
		const h = createHost();
		const editor = h.add('editor').window;
		const result = await h.controller.preload('editor', async () => { assert.fail('must preserve existing workspace and edits'); });
		assert.deepStrictEqual([result, h.activations], [editor, []]);
	});

});
