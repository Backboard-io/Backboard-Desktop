/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../base/common/uri.js';
import { ISession, SessionStatus } from '../../sessions/services/sessions/common/session.js';

export type OptimusDashboardBucket = 'running' | 'blocked' | 'ready';
export type OptimusDashboardSort = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc';
export type OptimusDashboardTimeRange = 'all' | 'hour' | 'day' | 'week' | 'month';
export type OptimusDashboardArchiveFilter = 'exclude' | 'include' | 'only';

export interface IOptimusSessionSummary {
	readonly key: string;
	readonly title: string;
	readonly providerId: string;
	readonly workspaceLabel: string;
	readonly status: SessionStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly isArchived: boolean;
	readonly isRead: boolean;
}

export interface IOptimusDashboardFilters {
	readonly query: string;
	readonly buckets: readonly OptimusDashboardBucket[];
	readonly timeRange: OptimusDashboardTimeRange;
	readonly archive: OptimusDashboardArchiveFilter;
	readonly providers: readonly string[];
	readonly workspaces: readonly string[];
}

export function getOptimusDashboardBucket(status: SessionStatus): OptimusDashboardBucket {
	switch (status) {
		case SessionStatus.InProgress:
			return 'running';
		case SessionStatus.NeedsInput:
		case SessionStatus.Error:
			return 'blocked';
		default:
			return 'ready';
	}
}

function getTimeRangeThreshold(timeRange: OptimusDashboardTimeRange, now: number): number | undefined {
	switch (timeRange) {
		case 'hour':
			return now - 60 * 60 * 1000;
		case 'day':
			return now - 24 * 60 * 60 * 1000;
		case 'week':
			return now - 7 * 24 * 60 * 60 * 1000;
		case 'month':
			return now - 30 * 24 * 60 * 60 * 1000;
		default:
			return undefined;
	}
}

export function filterAndSortOptimusSessions(
	sessions: readonly IOptimusSessionSummary[],
	filters: IOptimusDashboardFilters,
	sort: OptimusDashboardSort,
	unreadFirst: boolean,
	now = Date.now(),
): IOptimusSessionSummary[] {
	const normalizedQuery = filters.query.trim().toLocaleLowerCase();
	const timeThreshold = getTimeRangeThreshold(filters.timeRange, now);
	const buckets = new Set(filters.buckets);
	const providers = new Set(filters.providers);
	const workspaces = new Set(filters.workspaces);

	const filtered = sessions.filter(session => {
		if (normalizedQuery) {
			const searchableText = `${session.title}\n${session.providerId}\n${session.workspaceLabel}`.toLocaleLowerCase();
			if (!searchableText.includes(normalizedQuery)) {
				return false;
			}
		}
		if (buckets.size > 0 && !buckets.has(getOptimusDashboardBucket(session.status))) {
			return false;
		}
		if (timeThreshold !== undefined && session.updatedAt < timeThreshold) {
			return false;
		}
		if (filters.archive === 'exclude' && session.isArchived) {
			return false;
		}
		if (filters.archive === 'only' && !session.isArchived) {
			return false;
		}
		if (providers.size > 0 && !providers.has(session.providerId)) {
			return false;
		}
		if (workspaces.size > 0 && !workspaces.has(session.workspaceLabel)) {
			return false;
		}
		return true;
	});

	return filtered.sort((a, b) => {
		if (unreadFirst && a.isRead !== b.isRead) {
			return a.isRead ? 1 : -1;
		}
		switch (sort) {
			case 'updated-asc':
				return a.updatedAt - b.updatedAt;
			case 'created-desc':
				return b.createdAt - a.createdAt;
			case 'created-asc':
				return a.createdAt - b.createdAt;
			case 'title-asc':
				return a.title.localeCompare(b.title);
			case 'title-desc':
				return b.title.localeCompare(a.title);
			default:
				return b.updatedAt - a.updatedAt;
		}
	});
}

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
