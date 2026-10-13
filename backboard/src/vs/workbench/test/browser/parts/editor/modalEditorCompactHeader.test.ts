/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IModalEditorOptions, IModalEditorOptionsProvider, isModalEditorOptionsProvider } from '../../../../../platform/editor/common/editor.js';

const MODAL_HEADER_HEIGHT = 33; // matches fallback in modalEditorPart.ts

/**
 * Mirrors the per-editor class reconciliation in `ModalEditorPart.create`:
 *
 *   const editorModalOptions = isModalEditorOptionsProvider(activeEditor)
 *       ? activeEditor.getModalEditorOptions()
 *       : undefined;
 *   modalElement.classList.toggle('compact-header', !!editorModalOptions?.compactHeader);
 *   modalElement.classList.toggle('full-window', !!editorModalOptions?.fullWindow);
 *
 * and the sash height resolution which prefers the measured header height
 * over the fallback constant.
 */
function applyModalEditorClasses(modalElement: { classList: DOMTokenList }, activeEditor: unknown): void {
	const editorModalOptions = isModalEditorOptionsProvider(activeEditor) ? activeEditor.getModalEditorOptions() : undefined;
	modalElement.classList.toggle('compact-header', !!editorModalOptions?.compactHeader);
	modalElement.classList.toggle('full-window', !!editorModalOptions?.fullWindow);
}

function resolveHeaderHeight(headerElement: { offsetHeight: number }): number {
	return headerElement.offsetHeight || MODAL_HEADER_HEIGHT;
}

class TestEditor implements IModalEditorOptionsProvider {
	constructor(private readonly options: IModalEditorOptions | undefined) { }
	getModalEditorOptions(): IModalEditorOptions | undefined { return this.options; }
}

suite('Modal Editor Per-Editor Options', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	test('isModalEditorOptionsProvider type guard', () => {
		assert.strictEqual(isModalEditorOptionsProvider(undefined), false);
		assert.strictEqual(isModalEditorOptionsProvider(null), false);
		assert.strictEqual(isModalEditorOptionsProvider({}), false);
		assert.strictEqual(isModalEditorOptionsProvider({ getModalEditorOptions: 'nope' }), false);
		assert.strictEqual(isModalEditorOptionsProvider(new TestEditor({ compactHeader: true })), true);
	});

	test('compact-header class toggles based on active editor options', () => {
		const modalElement = document.createElement('div');

		// No active editor → class not set
		applyModalEditorClasses(modalElement, undefined);
		assert.strictEqual(modalElement.classList.contains('compact-header'), false);

		// Editor that doesn't implement the provider → class not set
		applyModalEditorClasses(modalElement, { /* not a provider */ });
		assert.strictEqual(modalElement.classList.contains('compact-header'), false);

		// Provider returning undefined → class not set
		applyModalEditorClasses(modalElement, new TestEditor(undefined));
		assert.strictEqual(modalElement.classList.contains('compact-header'), false);

		// Provider opting out → class not set
		applyModalEditorClasses(modalElement, new TestEditor({ compactHeader: false }));
		assert.strictEqual(modalElement.classList.contains('compact-header'), false);

		// Provider opting in → class set
		applyModalEditorClasses(modalElement, new TestEditor({ compactHeader: true }));
		assert.strictEqual(modalElement.classList.contains('compact-header'), true);

		// Switching back to a non-compact editor clears the class
		applyModalEditorClasses(modalElement, new TestEditor({ compactHeader: false }));
		assert.strictEqual(modalElement.classList.contains('compact-header'), false);
	});

	test('full-window class toggles based on active editor options', () => {
		const modalElement = document.createElement('div');

		applyModalEditorClasses(modalElement, undefined);
		assert.strictEqual(modalElement.classList.contains('full-window'), false);

		applyModalEditorClasses(modalElement, new TestEditor({ fullWindow: true }));
		assert.strictEqual(modalElement.classList.contains('full-window'), true);

		applyModalEditorClasses(modalElement, new TestEditor({ fullWindow: false }));
		assert.strictEqual(modalElement.classList.contains('full-window'), false);
	});

	test('header height prefers measured offsetHeight over fallback constant', () => {
		// Before layout: offsetHeight === 0 → fallback constant is used
		assert.strictEqual(resolveHeaderHeight({ offsetHeight: 0 }), MODAL_HEADER_HEIGHT);

		// Default header measured at 33px
		assert.strictEqual(resolveHeaderHeight({ offsetHeight: 33 }), 33);

		// Compact-header variant measured at 40px → measured value wins
		assert.strictEqual(resolveHeaderHeight({ offsetHeight: 40 }), 40);
	});
});
