/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IModalEditorOptions, IModalEditorOptionsProvider } from '../../../../platform/editor/common/editor.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class BackboardBillingEditorInput extends EditorInput implements IModalEditorOptionsProvider {
	static readonly ID = 'workbench.input.backboardBilling';
	readonly resource = undefined;
	private static instance: BackboardBillingEditorInput | undefined;

	static getOrCreate(): BackboardBillingEditorInput {
		if (!this.instance || this.instance.isDisposed()) { this.instance = new BackboardBillingEditorInput(); }
		return this.instance;
	}
	override get capabilities(): EditorInputCapabilities { return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal; }
	override get typeId(): string { return BackboardBillingEditorInput.ID; }
	override getName(): string { return localize('backboardBilling.name', "Billing"); }
	override getIcon(): ThemeIcon { return Codicon.creditCard; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean { return super.matches(other) || other instanceof BackboardBillingEditorInput; }
	getModalEditorOptions(): IModalEditorOptions { return { compactHeader: true }; }
	override async resolve(): Promise<null> { return null; }
}
