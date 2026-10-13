/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IModalEditorOptions, IModalEditorOptionsProvider } from '../../../../../platform/editor/common/editor.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { BYOK_KEYS_EDITOR_INPUT_ID } from './byokKeys.js';

/**
 * The API Keys page. A resource-less singleton that always opens in the modal
 * overlay, so it reads the same in the Simple, Editor, and Advanced windows.
 */
export class ByokKeysEditorInput extends EditorInput implements IModalEditorOptionsProvider {

	static readonly ID: string = BYOK_KEYS_EDITOR_INPUT_ID;

	readonly resource = undefined;

	private static _instance: ByokKeysEditorInput | undefined;

	static getOrCreate(): ByokKeysEditorInput {
		if (!ByokKeysEditorInput._instance || ByokKeysEditorInput._instance.isDisposed()) {
			ByokKeysEditorInput._instance = new ByokKeysEditorInput();
		}
		return ByokKeysEditorInput._instance;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof ByokKeysEditorInput;
	}

	override get typeId(): string {
		return ByokKeysEditorInput.ID;
	}

	override getName(): string {
		return localize('byokKeysEditorInputName', "API Keys");
	}

	override getIcon(): ThemeIcon {
		return Codicon.key;
	}

	getModalEditorOptions(): IModalEditorOptions {
		return { compactHeader: true };
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
