/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';

/** Resolve the completed history before a checkpoint, including the active request. */
export function resolveAgentHostForkIndex(turns: readonly { id: string }[], activeTurnId: string | undefined, requestId: string | undefined): number {
	const requestIndex = requestId === undefined ? turns.length
		: requestId === activeTurnId ? turns.length
			: turns.findIndex(turn => turn.id === requestId);
	if (requestIndex < 0) {
		throw new Error(localize('chat.fork.missingRequest', "This message is no longer available in the conversation history."));
	}
	if (requestIndex === 0) {
		throw new Error(localize('chat.fork.emptyHistory', "There are no completed messages before this point to fork."));
	}
	return requestIndex - 1;
}
