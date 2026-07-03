/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Directory names that agent tooling treats as noise: VCS internals and
 * dependency/build output. Shared by the Backboard agent's ripgrep-based
 * search tools and the per-turn filesystem watcher that reports out-of-band
 * file edits — both must agree so a search never surfaces a path the edit
 * tracker would discard (and vice versa).
 *
 * VCS internals matter most for the edit tracker: a `git commit` or worktree
 * operation during a turn writes loose objects and lock/temp files under
 * `.git/**`, which would otherwise be reported to the user as
 * "Created 8418b716db4a94…" file edits.
 */
export const AGENT_IGNORED_DIRECTORIES: readonly string[] = [
	'.git',
	'.hg',
	'.svn',
	'node_modules',
	'out',
	'dist',
	'target',
	'.next',
	'.turbo',
];

const ignoredSegments = new Set(AGENT_IGNORED_DIRECTORIES);

/**
 * Whether a slash-separated path contains a segment from
 * {@link AGENT_IGNORED_DIRECTORIES} — i.e. the path is VCS-internal or
 * build/dependency output and should not be tracked as a user-visible file
 * edit.
 */
export function isIgnoredAgentPath(path: string): boolean {
	return path.split('/').some(segment => ignoredSegments.has(segment));
}
