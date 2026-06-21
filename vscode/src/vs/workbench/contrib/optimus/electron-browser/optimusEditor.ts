/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../../optimus/browser/media/optimus.css';
import { Dimension } from '../../../../base/browser/dom.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { OptimusApp } from '../../../../optimus/browser/optimusApp.js';
import { OptimusRunStore } from '../../../../optimus/browser/optimusRunStore.js';
import { ElectronOptimusBackboardBridge } from '../../../../optimus/electron-browser/optimusBackboardBridge.js';
import { ElectronOptimusHistoryProvider } from '../../../../optimus/electron-browser/optimusHistoryService.js';
import { OptimusEditorInput } from './optimusEditorInput.js';

export class OptimusEditor extends EditorPane {

	static readonly ID = 'workbench.editor.optimus';

	private container: HTMLElement | undefined;
	private optimusApp: OptimusApp | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService
	) {
		super(OptimusEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'optimus-editor-container';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		parent.appendChild(this.container);
	}

	override async setInput(input: OptimusEditorInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container || this.optimusApp) {
			return;
		}

		const bridge = new ElectronOptimusBackboardBridge();
		const historyProvider = new ElectronOptimusHistoryProvider();
		const store = this._register(new OptimusRunStore(bridge));
		this.optimusApp = this._register(new OptimusApp(this.container, store, historyProvider));
		this.optimusApp.start();
	}

	override focus(): void {
		this.container?.focus();
	}

	override layout(dimension: Dimension): void {
		this.container?.style.setProperty('width', `${dimension.width}px`);
		this.container?.style.setProperty('height', `${dimension.height}px`);
	}
}
