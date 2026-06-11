/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/noAgentHostEmptyState.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderFormattedText } from '../../../../base/browser/formattedTextRenderer.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMobile } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';

const $ = dom.$;

/**
 * Empty state shown in the new-session view when the agents window is
 * open and no Backboard agent host has been discovered. Replaces the
 * workspace picker, which cannot surface useful items until the bridge
 * publishes workspaces and agents.
 */
export class NoAgentHostEmptyState extends Disposable {

	private _root: HTMLElement | undefined;

	render(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.no-agent-host-empty-state'));
		this._root.setAttribute('role', 'group');
		this._root.setAttribute('aria-label', localize('noAgentHost.aria', "No Sandbox hosts available"));
		// Make the root programmatically focusable so screen readers land
		// on the heading when the chat input — which would normally take
		// focus on view mount — is hidden by the `.no-agent-host` class.
		this._root.tabIndex = -1;

		// --- Hero icon (skipped on phone-layout viewports for vertical room)
		if (!isMobile) {
			const iconWrap = dom.append(this._root, $('.no-agent-host-icon'));
			iconWrap.append(...renderLabelWithIcons(`$(${Codicon.serverProcess.id})`));
		}

		// --- Heading + description ------------------------------------------
		const heading = dom.append(this._root, $('h2.no-agent-host-title'));
		heading.textContent = localize('noAgentHost.title', "Backboard Sandbox is not connected");

		const description = dom.append(this._root, $('p.no-agent-host-description'));
		renderFormattedText(
			localize(
				'noAgentHost.description',
				"Start the ``Backboard bridge`` for this IDE session, then choose a workspace to start a Sandbox session."
			),
			{ renderCodeSegments: true },
			description
		);
	}

	focus(): void {
		this._root?.focus();
	}

	override dispose(): void {
		this._root?.remove();
		this._root = undefined;
		super.dispose();
	}
}
