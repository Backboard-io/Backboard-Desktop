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
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ITextDiffEditorPane, IResourceDiffEditorInput, IUntypedEditorInput } from '../../../../../common/editor.js';
import { ACTIVE_GROUP, IEditorService, PreferredGroup, SIDE_GROUP } from '../../../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { openChatEdit } from '../../../browser/widget/chatEditNavigation.js';

suite('Chat change navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const openToSide of [false, true]) {
	for (const target of ['file', 'change'] as const) {
		test(`opens ${target} and reveals the workspace file (side: ${openToSide})`, async () => {
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
			let opened: (IResourceDiffEditorInput & { resource?: URI }) | undefined;
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

			await openChatEdit(editorService, commandService, new class extends mock<IFileService>() {}(), file, before, after, false, { editorOptions: {}, openToSide }, target);
			assert.deepStrictEqual({
				resource: opened?.resource,
				original: opened?.original?.resource,
				modified: opened?.modified?.resource,
				label: opened?.label,
				group: targetGroup,
				commands,
				diffOptions,
				firstDiff,
			}, {
				resource: target === 'file' ? file : undefined,
				original: target === 'change' ? before : undefined, modified: target === 'change' ? after : undefined, label: target === 'change' ? 'report.md (Change)' : undefined,
				group: openToSide ? SIDE_GROUP : ACTIVE_GROUP,
				commands: ['revealInExplorer', file.toString()],
				diffOptions: target === 'change' ? { hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3 } } : undefined,
				firstDiff: target === 'change' ? 1 : 0,
			});
		});
	}
	}
	for (const recreated of [false, true]) {
		test(`deleted file links prefer a recreated workspace file: ${recreated}`, async () => {
			const file = URI.file('/workspace/deleted.txt');
			const before = URI.parse('snapshot:/before/deleted.txt');
			let opened: IUntypedEditorInput | EditorInput | undefined;
			const editors = new class extends mock<IEditorService>() {
				override async openEditor(input: IUntypedEditorInput | EditorInput) { opened = input; return undefined; }
			}();
			const commands = new class extends mock<ICommandService>() {
				override async executeCommand<T>(): Promise<T> { return undefined as T; }
			}();
			const files = new class extends mock<IFileService>() {
				override async exists() { return recreated; }
			}();
			await openChatEdit(editors, commands, files, file, before, undefined, true, { editorOptions: {}, openToSide: false });
			assert.deepStrictEqual(opened, { resource: recreated ? file : before, ...(recreated ? {} : { label: 'deleted.txt (Deleted)' }), options: {} });
		});
	}

});
