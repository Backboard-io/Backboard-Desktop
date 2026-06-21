/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const optimusEditorIcon = registerIcon('optimus-editor-label-icon', Codicon.sparkle, localize('optimusEditorLabelIcon', 'Icon of the Optimus editor label.'));

export class OptimusEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.optimus';
	static readonly RESOURCE = URI.from({ scheme: 'optimus', path: 'default' });

	private static _instance: OptimusEditorInput | undefined;

	static get instance(): OptimusEditorInput {
		if (!OptimusEditorInput._instance || OptimusEditorInput._instance.isDisposed()) {
			OptimusEditorInput._instance = new OptimusEditorInput();
		}
		return OptimusEditorInput._instance;
	}

	override get typeId(): string {
		return OptimusEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return OptimusEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	readonly resource = OptimusEditorInput.RESOURCE;

	override getName(): string {
		return localize('optimusEditorInputName', "Optimus");
	}

	override getIcon(): ThemeIcon {
		return optimusEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof OptimusEditorInput;
	}
}
