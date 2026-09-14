/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/byokKeys.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { BYOK_KEYS_EDITOR_ID } from './byokKeys.js';
import { ByokKeysEditorInput } from './byokKeysEditorInput.js';
import { ByokKeysWidget } from './byokKeysWidget.js';

const $ = DOM.$;

export class ByokKeysEditor extends EditorPane {

	static readonly ID: string = BYOK_KEYS_EDITOR_ID;

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private widget: ByokKeysWidget | undefined;
	private bodyContainer: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ByokKeysEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.bodyContainer = DOM.append(parent, $('.backboard-api-keys-editor'));
		this.widget = this.editorDisposables.add(this.instantiationService.createInstance(ByokKeysWidget));
		this.bodyContainer.appendChild(this.widget.element);
	}

	override async setInput(input: ByokKeysEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.dimension) {
			this.layout(this.dimension);
		}
		this.widget?.render();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.widget?.layout(dimension.height);
	}

	override focus(): void {
		super.focus();
		this.widget?.focus();
	}
}
