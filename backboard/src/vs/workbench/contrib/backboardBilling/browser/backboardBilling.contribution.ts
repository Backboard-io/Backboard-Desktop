/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { OPEN_BILLING_COMMAND_ID } from '../common/backboardBilling.js';
import { BackboardBillingEditor } from './backboardBillingEditor.js';
import { BackboardBillingEditorInput } from './backboardBillingEditorInput.js';
import './backboardBillingService.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(BackboardBillingEditor, BackboardBillingEditor.ID, localize('billingEditor', "Billing")),
	[new SyncDescriptor(BackboardBillingEditorInput)],
);
class BillingEditorSerializer implements IEditorSerializer {
	canSerialize(_input: EditorInput): boolean { return true; }
	serialize(_input: EditorInput): string { return ''; }
	deserialize(_instantiationService: IInstantiationService): BackboardBillingEditorInput { return BackboardBillingEditorInput.getOrCreate(); }
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(BackboardBillingEditorInput.ID, BillingEditorSerializer);
registerAction2(class extends Action2 {
	constructor() { super({ id: OPEN_BILLING_COMMAND_ID, title: localize2('backboard.openBilling', "Billing"), category: localize2('backboard.category', "Backboard"), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IEditorService).openEditor(BackboardBillingEditorInput.getOrCreate(), { pinned: true }); }
});
MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
	command: { id: OPEN_BILLING_COMMAND_ID, title: localize('backboard.accountBilling', "Billing"), icon: Codicon.creditCard },
	group: '2_settings', order: 3,
});
