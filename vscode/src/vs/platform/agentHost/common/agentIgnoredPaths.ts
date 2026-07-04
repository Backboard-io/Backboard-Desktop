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
 * Matches the atomic-write temp files that editors and agent tooling create
 * while saving: the payload is written to a sibling temp path and then renamed
 * over the target, so the filesystem watcher observes a transient create+delete
 * of the temp file that must never surface as a user-visible edit. Covers the
 * shapes produced across this codebase and its runtime:
 *   - `foo.ts.tmp.98222.fde4c15a7895`  (`.tmp.<pid>.<hex>`)
 *   - `foo.ts.98222.1720000000000.fde4c15a7895.tmp` (`.<pid>.<ts>[.<hex>].tmp`)
 *   - `foo.ts.vsctmp` (VS Code's default write postfix)
 *   - `.18bf259f3f2fcae3-00000000.bun-build` (bun compile scratch file)
 *   - `binary.cstemp` (macOS `codesign` in-place signing temp)
 */
const TEMP_WRITE_FILE_PATTERN = /(?:\.tmp\.\d+\.[0-9a-f]+|\.\d+\.\d+(?:\.[0-9a-f]+)?\.tmp|\.vsctmp|\.bun-build|\.cstemp)$/i;

/**
 * Whether a slash-separated path should not be tracked as a user-visible file
 * edit: it either contains a segment from {@link AGENT_IGNORED_DIRECTORIES}
 * (VCS-internal or build/dependency output) or is an atomic-write temp file
 * (see {@link TEMP_WRITE_FILE_PATTERN}).
 */
export function isIgnoredAgentPath(path: string): boolean {
	return path.split('/').some(segment => ignoredSegments.has(segment))
		|| TEMP_WRITE_FILE_PATTERN.test(path);
}
