/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OPEN_API_KEYS_COMMAND_ID } from './byokKeys.js';
import { ByokKeysEditor } from './byokKeysEditor.js';
import { ByokKeysEditorInput } from './byokKeysEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ByokKeysEditor,
		ByokKeysEditor.ID,
		localize('byokKeysEditor', "API Keys Editor"),
	),
	[new SyncDescriptor(ByokKeysEditorInput)],
);

class ByokKeysEditorInputSerializer implements IEditorSerializer {

	canSerialize(_editorInput: EditorInput): boolean {
		return true;
	}

	serialize(_input: ByokKeysEditorInput): string {
		return '';
	}

	deserialize(_instantiationService: IInstantiationService): ByokKeysEditorInput {
		return ByokKeysEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ByokKeysEditorInput.ID, ByokKeysEditorInputSerializer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_API_KEYS_COMMAND_ID,
			title: localize2('backboard.openApiKeys', "API Keys"),
			category: localize2('backboard.category', "Backboard"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(ByokKeysEditorInput.getOrCreate(), { pinned: true });
	}
});
