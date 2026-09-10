/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { MockScopableContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { EditorService } from '../../../../../workbench/services/editor/browser/editorService.js';
import { IEditorGroupsService, IModalEditorPart } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { MODAL_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { RightWorkbenchEditorPool } from '../../browser/rightWorkbenchEditorPool.js';

suite('RightWorkbenchEditorPool', () => {

	const tracked = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	setup(() => { store = tracked.add(new DisposableStore()); });

	test('deduplicates concurrent construction and reuses a closed host safely', async () => {
		const creation = new DeferredPromise<IModalEditorPart>();
		const closed = store.add(new Emitter<void>());
		let constructions = 0;
		const part = new class extends mock<IModalEditorPart>() {
			override readonly onWillClose = closed.event;
			override async close(): Promise<boolean> { closed.fire(); return true; }
		}();
		const service = new class extends mock<IEditorGroupsService>() {
			override createModalEditorPart(): Promise<IModalEditorPart> { constructions++; return creation.p; }
		}();
		const pool = store.add(new RightWorkbenchEditorPool(service));
		const host = pool.getHost('files');
		const first = pool.acquire(host);
		const second = pool.acquire(host);
		await creation.complete(part);
		assert.deepStrictEqual([await first, await second, await pool.acquire(host), constructions], [part, part, part, 1]);
		closed.fire();
		assert.strictEqual(pool.getPart(host), undefined);
		await pool.acquire(host);
		assert.strictEqual(constructions, 2);
		await part.close();
	});

	test('keeps four hosts regardless of navigation count', () => {
		const pool = store.add(new RightWorkbenchEditorPool(new class extends mock<IEditorGroupsService>() { }()));
		const hosts = new Set<HTMLElement>();
		for (let i = 0; i < 100; i++) {
			for (const kind of ['files', 'review', 'browser', 'terminal'] as const) {
				hosts.add(pool.getHost(kind));
			}
		}
		assert.strictEqual(hosts.size, 4);
	});

	test('hiding and reactivating retains the native pane and dirty document; closing targets only requested inputs', async () => {
		const editorId = 'rightWorkbenchPoolTestEditor';
		const inputId = 'rightWorkbenchPoolTestInput';
		store.add(registerTestEditor(editorId, [new SyncDescriptor(TestFileEditorInput)], inputId));
		const services = workbenchInstantiationService({ contextKeyService: instantiationService => instantiationService.createInstance(MockScopableContextKeyService) }, store);
		services.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(services, store);
		services.stub(IEditorGroupsService, parts);
		const editors = store.add(services.createInstance(EditorService, undefined));
		const pool = store.add(services.createInstance(RightWorkbenchEditorPool));
		const host = pool.getHost('files');
		const part = await pool.acquire(host);
		const input = store.add(new TestFileEditorInput(URI.file('/pool/dirty.txt'), inputId));
		const other = store.add(new TestFileEditorInput(URI.file('/pool/other.txt'), inputId));
		const options = { pinned: true, modal: { embeddedHost: host, maximized: true } };
		await editors.openEditor(other, options, MODAL_GROUP);
		const pane = await editors.openEditor(input, options, MODAL_GROUP);
		input.setDirty();
		for (let i = 0; i < 25; i++) {
			pool.setVisible(host, false);
			assert.strictEqual(pane?.isVisible(), false);
			pool.setVisible(host, true);
		}
		await pool.closeEditors([other]);
		assert.deepStrictEqual({
			samePart: await pool.acquire(host) === part,
			samePane: part.activeGroup.activeEditorPane === pane,
			visible: pane?.isVisible(),
			dirty: input.isDirty(),
			disposed: input.isDisposed(),
			inputs: part.groups.flatMap(group => [...group.editors]).map((editor: EditorInput) => editor.resource?.path),
		}, { samePart: true, samePane: true, visible: true, dirty: true, disposed: false, inputs: ['/pool/dirty.txt'] });
		await part.close({ mergeAllEditorsToMainPart: true });
	});
});
