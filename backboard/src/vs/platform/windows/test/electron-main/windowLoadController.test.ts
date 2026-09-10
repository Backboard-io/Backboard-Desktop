/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeWindowConfiguration } from '../../../window/common/window.js';
import { ICodeWindow } from '../../../window/electron-main/window.js';
import { WindowLoadController } from '../../electron-main/windowLoadController.js';

suite('WindowLoadController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const configuration = (windowId: number) => upcastPartial<INativeWindowConfiguration>({ windowId });

	function createWindow() {
		const loads: number[] = [];
		let closed = false;
		const window = upcastPartial<ICodeWindow>({
			isReady: true,
			win: upcastPartial<Electron.BrowserWindow>({ isDestroyed: () => closed }),
			load: config => loads.push(config.windowId),
		});
		return { window, loads, close: () => closed = true };
	}

	test('rapid switches share one unload and prepare only the final destination', async () => {
		const gate = new DeferredPromise<boolean>();
		let unloads = 0;
		let preparations = 0;
		const controller = new WindowLoadController(() => { unloads++; return gate.p; });
		const h = createWindow();
		const switches = Array.from({ length: 150 }, (_, i) => controller.load(h.window, async () => {
			preparations++;
			return configuration(i);
		}));
		await gate.complete(false);
		const results = await Promise.all(switches);
		assert.deepStrictEqual({ unloads, preparations, loads: h.loads, committed: results.filter(Boolean).length }, { unloads: 1, preparations: 1, loads: [149], committed: 1 });
	});

	test('slow profile preparation cannot replace a newer loaded mode', async () => {
		const gate = new DeferredPromise<INativeWindowConfiguration>();
		const started = new DeferredPromise<void>();
		let unloads = 0;
		const controller = new WindowLoadController(async () => { unloads++; return false; });
		const h = createWindow();
		const old = controller.load(h.window, () => { void started.complete(); return gate.p; });
		await started.p;
		const latest = await controller.load(h.window, async () => configuration(2));
		await gate.complete(configuration(1));
		assert.deepStrictEqual([await old, latest, unloads, h.loads], [false, true, 1, [2]]);
	});

	test('a dirty-editor veto stops every request sharing the unload', async () => {
		const gate = new DeferredPromise<boolean>();
		const controller = new WindowLoadController(() => gate.p);
		const h = createWindow();
		const prepare = async () => { assert.fail('must not prepare after veto'); };
		const first = controller.load(h.window, prepare);
		const last = controller.load(h.window, prepare);
		await gate.complete(true);
		assert.deepStrictEqual([await first, await last, h.loads], [false, false, []]);
	});

	test('closed windows do not receive a late load', async () => {
		const gate = new DeferredPromise<INativeWindowConfiguration>();
		const started = new DeferredPromise<void>();
		const controller = new WindowLoadController(async () => false);
		const h = createWindow();
		const result = controller.load(h.window, () => { void started.complete(); return gate.p; });
		await started.p;
		h.close();
		await gate.complete(configuration(1));
		assert.deepStrictEqual([await result, h.loads], [false, []]);
	});

	test('different native windows switch independently', async () => {
		const gate = new DeferredPromise<boolean>();
		const first = createWindow();
		const second = createWindow();
		const controller = new WindowLoadController(window => window === first.window ? gate.p : Promise.resolve(false));
		const blocked = controller.load(first.window, async () => configuration(1));
		await controller.load(second.window, async () => configuration(2));
		assert.deepStrictEqual([first.loads, second.loads], [[], [2]]);
		await gate.complete(false);
		await blocked;
	});

	test('failed preparations release pending state and allow a fresh unload', async () => {
		let unloads = 0;
		const controller = new WindowLoadController(async () => { unloads++; return false; });
		const h = createWindow();
		await assert.rejects(controller.load(h.window, async () => { throw new Error('profile unavailable'); }), /profile unavailable/);
		await controller.load(h.window, async () => configuration(2));
		assert.deepStrictEqual([unloads, h.loads], [2, [2]]);
	});

	test('first load does not wait for an unload handshake', async () => {
		const controller = new WindowLoadController(async () => { assert.fail('new window has no renderer to unload'); });
		const h = createWindow();
		Object.defineProperty(h.window, 'isReady', { value: false });
		const result = await controller.load(h.window, async () => configuration(1));
		assert.deepStrictEqual([result, h.loads], [true, [1]]);
	});
});
