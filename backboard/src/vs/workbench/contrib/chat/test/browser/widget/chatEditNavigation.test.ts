/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IDiffEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { EditorType } from '../../../../../../editor/common/editorCommon.js';
import { IDiffEditorOptions } from '../../../../../../editor/common/config/editorOptions.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ITextDiffEditorPane, IResourceDiffEditorInput, IUntypedEditorInput } from '../../../../../common/editor.js';
import { ACTIVE_GROUP, IEditorService, PreferredGroup, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { openChatEdit } from '../../../browser/widget/chatEditNavigation.js';

suite('Chat change navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const openToSide of [false, true]) {
		test(`opens captured snapshots and reveals the workspace file (side: ${openToSide})`, async () => {
			const file = URI.file('/workspace/report.md');
			const before = URI.parse('snapshot:/call-1/before/report.md');
			const after = URI.parse('snapshot:/call-1/after/report.md');
			let diffOptions: IDiffEditorOptions | undefined;
			let firstDiff = 0;
			const control = new class extends mock<IDiffEditor>() {
				override getEditorType() { return EditorType.IDiffEditor; }
				override updateOptions(options: IDiffEditorOptions) { diffOptions = options; }
				override revealFirstDiff() { firstDiff++; }
			}();
			const pane = new class extends mock<ITextDiffEditorPane>() {
				override getControl() { return control; }
				override focus() {}
			}();
			let opened: IResourceDiffEditorInput | undefined;
			let targetGroup: number | undefined;
			const editorService = new class extends mock<IEditorService>() {
				override activeEditorPane = undefined;
				override async openEditor(input: IUntypedEditorInput | EditorInput, group?: PreferredGroup | IEditorOptions) {
					opened = input as IResourceDiffEditorInput;
					targetGroup = group as number;
					return pane;
				}
			}();
			const commands: string[] = [];
			const commandService = new class extends mock<ICommandService>() {
				override async executeCommand<T>(id: string, resource: URI): Promise<T> {
					commands.push(id, resource.toString());
					return undefined as T;
				}
			}();

			await openChatEdit(editorService, commandService, file, before, after, false, { editorOptions: {}, openToSide });
			assert.deepStrictEqual({
				original: opened?.original.resource,
				modified: opened?.modified.resource,
				label: opened?.label,
				group: targetGroup,
				commands,
				diffOptions,
				firstDiff,
			}, {
				original: before, modified: after, label: 'report.md (Change)',
				group: openToSide ? SIDE_GROUP : ACTIVE_GROUP,
				commands: ['revealInExplorer', file.toString()],
				diffOptions: { hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3 } },
				firstDiff: 1,
			});
		});
	}
});
