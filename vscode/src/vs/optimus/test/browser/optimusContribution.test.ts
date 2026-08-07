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
import { collectOptimusFolderCandidates, filterAndSortOptimusSessions, getOptimusDashboardBucket, IOptimusDashboardFilters, IOptimusSessionSummary } from '../../common/optimusSessions.js';

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

	test('dashboard groups provider statuses into Running, Blocked, and Ready', () => {
		assert.deepStrictEqual([
			getOptimusDashboardBucket(SessionStatus.InProgress),
			getOptimusDashboardBucket(SessionStatus.NeedsInput),
			getOptimusDashboardBucket(SessionStatus.Error),
			getOptimusDashboardBucket(SessionStatus.Completed),
			getOptimusDashboardBucket(SessionStatus.Untitled),
		], ['running', 'blocked', 'blocked', 'ready', 'ready']);
	});

	test('dashboard combines search, filters, unread priority, and display sorting', () => {
		const now = new Date('2026-08-06T16:00:00Z').getTime();
		const summaries: IOptimusSessionSummary[] = [
			{ key: 'old', title: 'Archived API work', providerId: 'claude', workspaceLabel: 'backend', status: SessionStatus.Completed, createdAt: now - 10_000, updatedAt: now - 9_000, isArchived: true, isRead: false },
			{ key: 'read', title: 'API migration', providerId: 'codex', workspaceLabel: 'backend', status: SessionStatus.InProgress, createdAt: now - 8_000, updatedAt: now - 1_000, isArchived: false, isRead: true },
			{ key: 'unread', title: 'API tests', providerId: 'codex', workspaceLabel: 'backend', status: SessionStatus.InProgress, createdAt: now - 7_000, updatedAt: now - 2_000, isArchived: false, isRead: false },
			{ key: 'other', title: 'Landing page', providerId: 'codex', workspaceLabel: 'frontend', status: SessionStatus.InProgress, createdAt: now - 6_000, updatedAt: now - 500, isArchived: false, isRead: false },
		];
		const filters: IOptimusDashboardFilters = {
			query: 'api',
			buckets: ['running'],
			timeRange: 'day',
			archive: 'exclude',
			providers: ['codex'],
			workspaces: ['backend'],
		};

		assert.deepStrictEqual(
			filterAndSortOptimusSessions(summaries, filters, 'updated-desc', true, now).map(summary => summary.key),
			['unread', 'read'],
		);
	});
});
