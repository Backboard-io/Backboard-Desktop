/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function renderHistoryPane(): string {
	return `
				<div id="historyPane" class="historyPane viewPane" role="tabpanel" aria-label="History">
					<div id="historyEmpty" class="historyEmpty">No history yet.</div>
					<div id="historyList" class="historyList"></div>
				</div>`;
}
