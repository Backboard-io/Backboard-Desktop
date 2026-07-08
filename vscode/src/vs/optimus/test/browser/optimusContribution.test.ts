/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Codicon } from '../../../base/common/codicons.js';
import { IChat, ISession, ISessionWorkspace, SessionStatus } from '../../../sessions/services/sessions/common/session.js';
import { collectOptimusFolderCandidates } from '../../common/optimusSessions.js';

function workspace(uri: URI, workingDirectory = uri): ISessionWorkspace {
	return {
		uri,
		label: uri.path,
		icon: Codicon.folder,
		folders: [{
			root: uri,
			workingDirectory,
			name: uri.path,
			description: undefined,
			gitRepository: undefined,
		}],
		requiresWorkspaceTrust: true,
		isVirtualWorkspace: false,
	};
}

const chat: IChat = {
	resource: URI.parse('test:///chat'),
	createdAt: new Date(),
	title: constObservable('Chat'),
	updatedAt: constObservable(new Date()),
	status: constObservable(SessionStatus.Completed),
	changes: constObservable([]),
	checkpoints: constObservable(undefined),
	modelId: constObservable(undefined),
	mode: constObservable(undefined),
	isArchived: constObservable(false),
	isRead: constObservable(true),
	description: constObservable(undefined),
	lastTurnEnd: constObservable(undefined),
};

function session(id: string, workspaceUri: URI, workingDirectory = workspaceUri): ISession {
	return {
		sessionId: id,
		resource: URI.parse(`test:///${id}`),
		providerId: 'test',
		sessionType: 'test',
		icon: Codicon.folder,
		createdAt: new Date(),
		workspace: constObservable(workspace(workspaceUri, workingDirectory)),
		title: constObservable('Test'),
		updatedAt: constObservable(new Date()),
		status: constObservable(SessionStatus.Completed),
		changesets: constObservable([]),
		changes: constObservable([]),
		modelId: constObservable(undefined),
		mode: constObservable(undefined),
		loading: constObservable(false),
		isArchived: constObservable(false),
		isRead: constObservable(true),
		description: constObservable(undefined),
		lastTurnEnd: constObservable(undefined),
		chats: constObservable([chat]),
		mainChat: constObservable(chat),
		capabilities: { supportsMultipleChats: false },
	};
}

suite('Optimus contribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collectOptimusFolderCandidates prefers active/current folders and dedupes sessions', () => {
		const activeRoot = URI.file('/active-root');
		const activeWorkingDirectory = URI.file('/active-worktree');
		const currentWorkspace = URI.file('/current-workspace');
		const recentWorkspace = URI.file('/recent-workspace');
		const otherWorkspace = URI.file('/other-root');
		const otherWorkingDirectory = URI.file('/other-worktree');

		const candidates = collectOptimusFolderCandidates(
			session('active', activeRoot, activeWorkingDirectory),
			[currentWorkspace],
			[recentWorkspace, currentWorkspace],
			[
				session('dupe-active', activeRoot, activeWorkingDirectory),
				session('other', otherWorkspace, otherWorkingDirectory),
			],
		).map(candidate => candidate.toString());

		assert.deepStrictEqual(candidates, [
			activeWorkingDirectory.toString(),
			activeRoot.toString(),
			currentWorkspace.toString(),
			recentWorkspace.toString(),
			otherWorkingDirectory.toString(),
			otherWorkspace.toString(),
		]);
	});
});
