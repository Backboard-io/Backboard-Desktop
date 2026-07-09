/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../base/common/uri.js';
import { ISession } from '../../sessions/services/sessions/common/session.js';

export function collectOptimusFolderCandidates(
	activeSession: ISession | undefined,
	workspaceFolders: readonly URI[],
	recentWorkspaces: readonly URI[],
	sessions: readonly ISession[],
): URI[] {
	const candidates: URI[] = [];
	const push = (candidate: URI | undefined): void => {
		if (candidate && !candidates.some(existing => existing.toString() === candidate.toString())) {
			candidates.push(candidate);
		}
	};

	push(activeSession?.workspace.get()?.folders[0]?.workingDirectory);
	push(activeSession?.workspace.get()?.folders[0]?.root);
	for (const folder of workspaceFolders) {
		push(folder);
	}
	for (const recent of recentWorkspaces) {
		push(recent);
	}
	for (const session of sessions) {
		push(session.workspace.get()?.folders[0]?.workingDirectory);
		push(session.workspace.get()?.folders[0]?.root);
	}

	return candidates;
}
