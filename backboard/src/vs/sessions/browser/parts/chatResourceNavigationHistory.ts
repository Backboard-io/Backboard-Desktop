/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Browser-style history for chats opened inside a single session view.
 *
 * Subagent chats are not members of the session's normal chat list, so the
 * shared session navigation history cannot represent them. This small stack
 * retains the resource that was visible before each subagent drill-in.
 */
export class ChatResourceNavigationHistory {

	private readonly _entries: URI[] = [];

	get canGoBack(): boolean {
		return this._entries.length > 0;
	}

	get previous(): URI | undefined {
		return this._entries.at(-1);
	}

	get root(): URI | undefined {
		return this._entries[0];
	}

	recordOpen(current: URI | undefined, next: URI): void {
		if (!current || isEqual(current, next) || isEqual(this.previous, current)) {
			return;
		}
		this._entries.push(current);
	}

	commitBack(): URI | undefined {
		return this._entries.pop();
	}

	reset(): void {
		this._entries.length = 0;
	}
}
