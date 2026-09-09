/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOpenEditorOptions } from '../../../../../platform/editor/browser/editor.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';

/** Opens the workspace file by default; historical comparisons require an explicit target. */
export async function openChatEdit(
	editorService: IEditorService,
	commandService: ICommandService,
	fileService: IFileService,
	resource: URI,
	original: URI | undefined,
	modified: URI | undefined,
	isDeletion: boolean,
	{ editorOptions: options, openToSide }: IOpenEditorOptions,
	target: 'file' | 'change' = 'file',
): Promise<void> {
	const deleted = isDeletion && (target === 'change' || !await fileService.exists(resource));
	const group = openToSide ? SIDE_GROUP : ACTIVE_GROUP;
	const pane = target === 'change' && original && modified
		? await editorService.openEditor({
			original: { resource: original },
			modified: { resource: modified },
			label: localize('chat.change.title', "{0} (Change)", basename(resource)),
			description: resource.path,
			options,
		}, group)
		: await editorService.openEditor({ resource: deleted && original ? original : target === 'change' ? modified ?? resource : resource,
			...(deleted ? { label: localize('chat.deletedFile.title', "{0} (Deleted)", basename(resource)) } : {}), options }, group);
	const control = pane?.getControl();
	if (target === 'change' && isDiffEditor(control)) {
		control.updateOptions({ hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3 } });
		control.revealFirstDiff();
	}
	if (!deleted) {
		// This command resolves the workspace file, never the internal snapshot URI.
		await commandService.executeCommand('revealInExplorer', resource).catch(onUnexpectedError);
		if (!options.preserveFocus && editorService.activeEditorPane === pane) {
			pane?.focus();
		}
	}
}
