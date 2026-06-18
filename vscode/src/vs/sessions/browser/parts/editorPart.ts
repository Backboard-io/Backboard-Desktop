/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { mainWindow } from '../../../base/browser/window.js';
import { MainEditorPart as MainEditorPartBase } from '../../../workbench/browser/parts/editor/editorPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';

export class MainEditorPart extends MainEditorPartBase {
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_LEFT = 0;
	static readonly MARGIN_RIGHT = 0;

	override get minimumWidth() {
		return Math.max(300, super.minimumWidth);
	}

	override priority = LayoutPriority.High;

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			return;
		}

		// Keep the editor flush with adjacent agent-session parts. Only borders are
		// removed from the internal layout.
		const marginLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART) ||
			this.layoutService.isVisible(Parts.SESSIONS_PART)
			? 0
			: MainEditorPart.MARGIN_LEFT;
		const marginBottom = this.layoutService.isVisible(Parts.PANEL_PART)
			? MainEditorPart.MARGIN_BOTTOM
			: 0;

		const adjustedWidth = width - MainEditorPart.MARGIN_RIGHT - marginLeft - 2 /* border width */;
		const adjustedHeight = height - MainEditorPart.MARGIN_TOP - marginBottom - 2 /* border width */;

		super.layout(adjustedWidth, adjustedHeight, top, left);
	}
}
