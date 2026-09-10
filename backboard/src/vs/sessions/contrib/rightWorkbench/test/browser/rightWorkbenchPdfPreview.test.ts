/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { RightWorkbenchViewPane } from '../../browser/rightWorkbenchViewPane.js';

suite('RightWorkbench PDF Preview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const isOptimusWindow of [false, true]) {
		test(`opens PDFs from the file list and editor links in ${isOptimusWindow ? 'Advanced' : 'Simple'} mode`, async () => {
			const pane = Object.create(RightWorkbenchViewPane.prototype) as RightWorkbenchViewPane;
			const opened: IUntypedEditorInput[] = [];
			const host = document.createElement('div');
			for (const [key, value] of Object.entries({
				tabs: [{ id: 'files', mode: 'files', fileViewSource: false }],
				activeTabId: 'files', activationGeneration: 0, isRightWorkbenchVisible: true,
				environmentService: { isOptimusWindow }, embeddedEditorHost: host,
				editorPool: { setVisible: () => { } },
				refreshTabLabels: () => { }, scheduleEmbeddedEditorPartLayout: () => { },
				ensureEmbeddedEditorPart: async () => { },
				openTrackedEditor: async (_tab: object, _host: HTMLElement, editor: IUntypedEditorInput) => { opened.push(editor); },
			})) {
				Reflect.set(pane, key, value);
			}
			const resource = URI.file('/workspace/Report with spaces.PDF');
			await pane['openSelectedFile'](resource);
			await pane['openEditorInRightWorkbench']({ resource });
			await pane['openEditorInRightWorkbench']({ resource, options: { override: 'default' } });
			await pane['openSelectedFile'](URI.file('/workspace/code.ts'));
			await pane['openSelectedFile'](URI.file('/workspace/README.md'));
			assert.deepStrictEqual(opened.map(editor => editor.options?.override), [
				'vscode.pdfPreview', 'vscode.pdfPreview', 'default', 'default', 'vscode.markdown.preview.editor',
			]);
		});
	}
});
