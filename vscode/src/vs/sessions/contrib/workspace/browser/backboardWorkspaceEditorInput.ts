/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

const BackboardWorkspaceEditorIcon = registerIcon('backboard-workspace-editor-icon', Codicon.layoutPanel, localize('backboardWorkspaceEditorIcon', 'Icon of the Backboard Workspace editor.'));

export class BackboardWorkspaceEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.backboardWorkspace';
	static readonly instance = new BackboardWorkspaceEditorInput();

	readonly resource = undefined;

	override get typeId(): string {
		return BackboardWorkspaceEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('backboardWorkspaceEditorInputName', "Workspace");
	}

	override getIcon(): ThemeIcon {
		return BackboardWorkspaceEditorIcon;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof BackboardWorkspaceEditorInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
