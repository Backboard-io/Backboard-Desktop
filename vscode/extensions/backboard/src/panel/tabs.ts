/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function renderRecentTabs(): string {
	return `
				<div class="recentTabsShell">
					<div id="recentTabs" class="recentTabs" role="tablist" aria-label="Recent chats"></div>
					<div class="recentTabsActions">
						<button id="inlineNewChatBtn" class="recentActionButton" type="button" title="New Chat" aria-label="New Chat"><span class="codicon codicon-add"></span></button>
						<button id="inlineHistoryBtn" class="recentActionButton" type="button" title="History" aria-label="History"><span class="codicon codicon-history"></span><span id="inlineHistoryCount" class="tabCount">0</span></button>
					</div>
				</div>`;
}

export function renderCheckpointStrip(): string {
	return `
				<div id="checkpointStrip" class="checkpointStrip" aria-label="Checkpoints">
					<span class="checkpointTitle">Checkpoints</span>
					<div id="checkpointList" class="checkpointList"></div>
				</div>`;
}
