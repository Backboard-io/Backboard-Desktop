/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService, InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { SimpleModeBackgroundPicker } from '../../browser/simpleModeBackgroundPicker.js';
import { simpleModeBackgroundPresets } from '../../browser/simpleModeBackgroundPresets.js';
import { ISimpleModeBackgroundService, SimpleModeBackgroundService } from '../../browser/simpleModeBackgroundService.js';

suite('Simple Mode Background', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let storage: InMemoryStorageService;
	let service: SimpleModeBackgroundService;

	setup(() => {
		instantiation = store.add(new TestInstantiationService());
		storage = store.add(new InMemoryStorageService());
		instantiation.stub(IStorageService, storage);
		instantiation.stub(IContextKeyService, new MockContextKeyService());
		instantiation.stub(IFileDialogService, { showOpenDialog: async () => undefined });
		service = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		instantiation.stub(ISimpleModeBackgroundService, service);
	});

	test('presets survive restore by stable id and default removes the selection', () => {
		service.selectPresetBackground('wild-coast');
		assert.strictEqual(storage.get('sessions.simpleMode.backgroundImage', StorageScope.APPLICATION), 'preset:wild-coast');
		const restored = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		assert.strictEqual(restored.backgroundImage?.toString(), simpleModeBackgroundPresets[4].resource.toString());
		restored.clearBackgroundImage();
		assert.strictEqual(restored.backgroundImage, undefined);
		assert.strictEqual(storage.get('sessions.simpleMode.backgroundImage', StorageScope.APPLICATION), '');
	});

	test('migrates a profile selection without reviving it after clearing', () => {
		storage.store('sessions.simpleMode.backgroundImage', 'preset:wild-coast', StorageScope.PROFILE, StorageTarget.MACHINE);
		const migrated = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		assert.strictEqual(migrated.backgroundImage?.toString(), simpleModeBackgroundPresets[4].resource.toString());
		migrated.clearBackgroundImage();
		const restored = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		assert.strictEqual(restored.backgroundImage, undefined);
	});

	test('shares selections with another mode service already open', () => {
		const otherMode = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		service.selectPresetBackground('wild-coast');
		assert.strictEqual(otherMode.backgroundImage?.toString(), service.backgroundImage?.toString());
	});

	test('commits background changes immediately instead of waiting for shutdown', async () => {
		const committed: (string | undefined)[] = [];
		storage.flush = async () => {
			committed.push(storage.get('sessions.simpleMode.backgroundImage', StorageScope.APPLICATION));
		};
		service.selectPresetBackground('wild-coast');
		service.clearBackgroundImage();
		assert.deepStrictEqual(committed, ['preset:wild-coast', '']);
	});

	test('canceling the custom picker preserves the selected preset', async () => {
		service.selectPresetBackground('midnight-peaks');
		await service.chooseBackgroundImage();
		assert.strictEqual(service.backgroundImage?.toString(), simpleModeBackgroundPresets[0].resource.toString());
	});

	test('custom files replace presets and survive restore', async () => {
		const custom = URI.file('/pictures/custom.jpeg');
		instantiation.stub(IFileDialogService, { showOpenDialog: async () => [custom] });
		const customService = store.add(instantiation.createInstance(SimpleModeBackgroundService));
		await customService.chooseBackgroundImage();
		assert.strictEqual(storage.get('sessions.simpleMode.backgroundImage', StorageScope.APPLICATION), custom.toString());
	});

	test('carousel starts with default, previews all images without applying, and ends with upload', () => {
		const host = document.createElement('div');
		const anchor = document.createElement('button');
		host.append(anchor);
		document.body.append(host);
		store.add({ dispose: () => host.remove() });
		instantiation.stub(IContextViewService, {
			showContextView: delegate => {
				const rendered = delegate.render(host);
				return { close: () => { rendered.dispose(); delegate.onHide?.(); } };
			}
		});
		const picker = store.add(instantiation.createInstance(SimpleModeBackgroundPicker));
		picker.toggle(anchor);
		const choices = Array.from(host.querySelectorAll<HTMLButtonElement>('.simple-background-picker-thumbnail'));
		assert.strictEqual(choices.length, 17);
		const filmstrip = host.querySelector<HTMLElement>('.simple-background-picker-filmstrip')!;
		const first = choices[0].getBoundingClientRect();
		const fifth = choices[4].getBoundingClientRect();
		assert.ok(Math.abs(fifth.right - first.left - filmstrip.clientWidth) < 2, 'Five thumbnails fit the visible filmstrip');
		assert.ok(filmstrip.scrollWidth > filmstrip.clientWidth, 'Remaining thumbnails are scrollable');
		filmstrip.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
		assert.ok(filmstrip.scrollLeft > 0, 'Vertical mouse wheel scrolls the filmstrip horizontally');
		assert.strictEqual(choices[0].getAttribute('aria-pressed'), 'true');
		for (let i = 1; i <= 15; i++) {
			choices[i].click();
			assert.ok(host.querySelector<HTMLImageElement>('img')?.src.includes(simpleModeBackgroundPresets[i - 1].id));
			assert.strictEqual(service.backgroundImage, undefined);
		}
		host.querySelector<HTMLButtonElement>('.simple-background-picker-apply')!.click();
		assert.strictEqual(service.backgroundImage?.toString(), simpleModeBackgroundPresets[14].resource.toString());
		choices[16].click();
		assert.strictEqual(host.querySelector<HTMLButtonElement>('.simple-background-picker-apply')!.textContent, 'Add Your Own');
		picker.toggle(anchor);
		assert.strictEqual(host.querySelector('.simple-background-picker'), null);
		assert.strictEqual(anchor.getAttribute('aria-expanded'), 'false');
	});
});
