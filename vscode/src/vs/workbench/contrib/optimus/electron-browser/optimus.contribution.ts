/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { OptimusEditor } from './optimusEditor.js';
import { OptimusEditorInput } from './optimusEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(OptimusEditor, OptimusEditor.ID, localize('optimusEditor', "Optimus")),
	[new SyncDescriptor(OptimusEditorInput)]
);

class OptimusEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return true;
	}

	serialize(editorInput: EditorInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return OptimusEditorInput.instance;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(OptimusEditorInput.ID, OptimusEditorInputSerializer);

class OptimusEditorResolverContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService
	) {
		editorResolverService.registerEditor(
			`${OptimusEditorInput.RESOURCE.scheme}:**/**`,
			{
				id: OptimusEditor.ID,
				label: localize('promptOpenWith.optimus.displayName', "Optimus"),
				priority: RegisteredEditorPriority.exclusive
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === OptimusEditorInput.RESOURCE.scheme
			},
			{
				createEditorInput: ({ options }) => ({
					editor: OptimusEditorInput.instance,
					options: {
						pinned: true,
						...options
					}
				})
			}
		);
	}
}

registerWorkbenchContribution2(OptimusEditorResolverContribution.ID, OptimusEditorResolverContribution, WorkbenchPhase.BlockStartup);
