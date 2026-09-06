/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, ValueWithChangeEvent } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDiffProviderFactoryService } from '../../../../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { RefCounted } from '../../../../../editor/browser/widget/diffEditor/utils.js';
import { MultiDiffEditorViewModel } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { IDiffEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { TestDiffProviderFactoryService } from '../../../../../editor/test/browser/diff/testDiffProviderFactoryService.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { instantiateTextModel } from '../../../../../editor/test/common/testTextModel.js';

suite('RightWorkbenchReviewOptions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('unified review and full-file options survive configuration changes', async () => {
		const services = createCodeEditorServices(store);
		services.stub(IDiffProviderFactoryService, new TestDiffProviderFactoryService());
		const original = store.add(instantiateTextModel(services, 'before'));
		const modified = store.add(instantiateTextModel(services, 'after'));
		const changes = store.add(new Emitter<void>());
		let configuration: IDiffEditorOptions = { renderSideBySide: true, diffWordWrap: 'off' };
		const document = store.add(RefCounted.createOfNonDisposable({
			original, modified,
			get options() { return configuration; },
			onOptionsDidChange: changes.event,
		}, Disposable.None));
		const viewModel = store.add(new MultiDiffEditorViewModel({ documents: ValueWithChangeEvent.const([document]) }, services));
		viewModel.editorOptions.set({ renderSideBySide: false, hideUnchangedRegions: { enabled: false } }, undefined);
		await viewModel.waitForDiffOr1s();
		const item = viewModel.items.get()[0];
		assert.strictEqual(item.options.get().renderSideBySide, false);
		assert.strictEqual(item.options.get().hideUnchangedRegions?.enabled, false);
		configuration = { renderSideBySide: true, diffWordWrap: 'on' };
		changes.fire();
		assert.strictEqual(item.options.get().renderSideBySide, false);
		assert.strictEqual(item.options.get().diffWordWrap, 'on');
		viewModel.editorOptions.set({ renderSideBySide: false, hideUnchangedRegions: { enabled: true } }, undefined);
		assert.strictEqual(item.options.get().hideUnchangedRegions?.enabled, true);
	});
});
