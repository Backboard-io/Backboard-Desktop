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
	'.build',
	'notebook-out',
	// Scratch output of the @playwright/cli automation harness (console logs,
	// page snapshots) — written continuously while a browser session is
	// attached, so any turn running alongside automation would report them
	// as file edits.
	'.playwright-cli',
];

/**
 * Build-state and OS-metadata files that land *next to* sources rather than
 * inside an ignored directory, so the directory-segment check can't catch
 * them: TypeScript incremental build state is written beside each tsconfig
 * (e.g. `extensions/emmet/tsconfig.tsbuildinfo`), and Finder drops
 * `.DS_Store` wherever a folder is browsed. A background build running
 * during a turn creates/deletes dozens of these, which would otherwise
 * flood the session step log with "Created tsconfig.tsbuildinfo" entries.
 * Glob-shaped so they can feed file-watcher excludes directly.
 *
 * `*.log` is here because an out-of-band write to a log file during a turn is
 * runtime output by definition — a dev server, watcher, or logger appending in
 * the background. Deliberate agent file edits are reported through the
 * tool-call FileEdit protocol and are unaffected by this list.
 */
export const AGENT_IGNORED_FILE_GLOBS: readonly string[] = [
	'**/*.tsbuildinfo',
	'**/.DS_Store',
	'**/*.log',
];

const ignoredSegments = new Set(AGENT_IGNORED_DIRECTORIES);

const IGNORED_FILE_PATTERN = /(?:\.tsbuildinfo|\/\.DS_Store|\.log)$/;

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
 * (VCS-internal or build/dependency output), is a build-state/OS-metadata
 * file (see {@link AGENT_IGNORED_FILE_GLOBS}), or is an atomic-write temp
 * file (see {@link TEMP_WRITE_FILE_PATTERN}).
 */
export function isIgnoredAgentPath(path: string): boolean {
	return path.split('/').some(segment => ignoredSegments.has(segment))
		|| IGNORED_FILE_PATTERN.test(path)
		|| TEMP_WRITE_FILE_PATTERN.test(path);
}
