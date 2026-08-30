/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function renderPanelHeader(showHeader: boolean): string {
	return showHeader ? `
			<div class="panelHeader">
				<div class="brandMark"><span class="codicon codicon-sparkle"></span></div>
				<div class="brandTitle">Backboard</div>
				<div class="headerSpacer"></div>
				<div id="headerBadge" class="headerBadge">Full Access</div>
				<div class="headerActions" role="tablist" aria-label="Backboard panel">
					<button id="chatTab" class="headerIconButton active" type="button" role="tab" aria-selected="true" aria-controls="log" title="Chat" aria-label="Chat"><span class="codicon codicon-comment-discussion"></span></button>
					<button id="newChatBtn" class="headerIconButton" type="button" title="New Chat" aria-label="New Chat"><span class="codicon codicon-add"></span></button>
					<button id="historyTab" class="headerIconButton historyHeaderButton" type="button" role="tab" aria-selected="false" aria-controls="historyPane" title="History" aria-label="History"><span class="codicon codicon-history"></span><span id="historyCount" class="tabCount">0</span></button>
				</div>
			</div>` : '<div id="headerBadge" class="headerBadge hidden">Full Access</div>';
}
