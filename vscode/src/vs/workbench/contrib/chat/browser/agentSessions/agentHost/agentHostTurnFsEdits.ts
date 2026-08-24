/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix } from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import { isIgnoredAgentPath } from '../../../../../../platform/agentHost/common/agentIgnoredPaths.js';
import { FileChangeType } from '../../../../../../platform/files/common/files.js';
import { toAgentHostUri } from '../../../../../../platform/agentHost/common/agentHostUri.js';
import { buildGitBlobUri } from '../../../../../../platform/agentHost/common/gitBlobUri.js';
import { IChatExternalEdit } from '../../../common/chatService/chatService.js';

/**
 * Helpers for the per-turn filesystem-watch edit fallback in
 * `agentHostSessionHandler`: out-of-band file writes (MCP tools, shell
 * commands) are detected via file events, so unlike tool-declared
 * {@link FileEdit}s there is no in-memory before-snapshot. Instead, the
 * repository HEAD commit is pinned once at turn start and the "before"
 * content is referenced through a `git-blob:` URI resolved lazily by the
 * agent host (`git show <sha>:<path>`).
 *
 * Everything here is pure or IO-injected so it can be unit tested without a
 * real repository.
 */

/** Reads the text content of an absolute path, `undefined` when unreadable. */
export type ReadTextFn = (absolutePath: string) => Promise<string | undefined>;

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

/** Parses a worktree `.git` pointer file ("gitdir: /path/to/.git/worktrees/x"). */
export function parseGitDirPointer(content: string): string | undefined {
	const match = content.match(/^gitdir:\s*(?<dir>.+?)\s*$/m);
	return match?.groups?.dir;
}

/** Parses `.git/HEAD`: either a symbolic ref or a detached commit sha. */
export function parseGitHeadContent(content: string): { readonly sha?: string; readonly ref?: string } | undefined {
	const trimmed = content.trim();
	if (!trimmed) {
		return undefined;
	}
	const refMatch = trimmed.match(/^ref:\s*(?<ref>\S+)/);
	if (refMatch?.groups) {
		return { ref: refMatch.groups.ref };
	}
	if (SHA_PATTERN.test(trimmed)) {
		return { sha: trimmed };
	}
	return undefined;
}

/** Finds the sha recorded for `ref` in a `packed-refs` file. */
export function findPackedRefSha(packedRefs: string, ref: string): string | undefined {
	for (const line of packedRefs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {
			continue;
		}
		const spaceIndex = trimmed.indexOf(' ');
		if (spaceIndex <= 0) {
			continue;
		}
		if (trimmed.substring(spaceIndex + 1).trim() === ref) {
			return trimmed.substring(0, spaceIndex);
		}
	}
	return undefined;
}

/** Git repository info pinned at turn start for out-of-band edit diffs. */
export interface ITurnRepoInfo {
	/** Repository (or worktree) root, in URI-path space. */
	readonly rootPath: string;
	/** HEAD commit sha at turn start — the diff baseline. */
	readonly sha: string;
}

/**
 * Resolves the HEAD commit sha of the repository rooted at `rootPath`.
 * Handles regular repositories (`.git` directory), worktrees (`.git`
 * pointer file + `commondir` redirection), loose refs, and packed refs.
 * Returns `undefined` when anything is missing or malformed — callers
 * degrade to diff-less edit pills.
 */
export async function resolveRepoHeadSha(readText: ReadTextFn, rootPath: string): Promise<string | undefined> {
	const dotGit = posix.join(rootPath, '.git');
	let gitDir: string | undefined;
	if (await readText(posix.join(dotGit, 'HEAD')) !== undefined) {
		gitDir = dotGit;
	} else {
		const pointer = await readText(dotGit);
		const target = pointer ? parseGitDirPointer(pointer) : undefined;
		if (target) {
			gitDir = posix.resolve(rootPath, target);
		}
	}
	if (!gitDir) {
		return undefined;
	}

	const head = parseGitHeadContent(await readText(posix.join(gitDir, 'HEAD')) ?? '');
	if (!head) {
		return undefined;
	}
	if (head.sha) {
		return head.sha;
	}

	// Symbolic ref: branch refs live in the common dir (relevant for
	// worktrees, whose gitdir carries a `commondir` redirection).
	const commonDirRaw = (await readText(posix.join(gitDir, 'commondir')))?.trim();
	const commonDir = commonDirRaw ? posix.resolve(gitDir, commonDirRaw) : gitDir;
	const looseRef = (await readText(posix.join(commonDir, head.ref!)))?.trim();
	if (looseRef && SHA_PATTERN.test(looseRef)) {
		return looseRef;
	}
	const packedRefs = await readText(posix.join(commonDir, 'packed-refs'));
	return packedRefs ? findPackedRefSha(packedRefs, head.ref!) : undefined;
}

const MAX_REPO_ROOT_PROBE_DEPTH = 8;

/**
 * Walks up from `startPath` looking for a git repository root (a `.git`
 * directory or worktree pointer file), then resolves its HEAD sha.
 */
export async function resolveTurnRepoInfo(readText: ReadTextFn, startPath: string): Promise<ITurnRepoInfo | undefined> {
	let current = startPath;
	for (let depth = 0; depth < MAX_REPO_ROOT_PROBE_DEPTH; depth++) {
		const dotGit = posix.join(current, '.git');
		const isRepoRoot = await readText(posix.join(dotGit, 'HEAD')) !== undefined
			|| parseGitDirPointer(await readText(dotGit) ?? '') !== undefined;
		if (isRepoRoot) {
			const sha = await resolveRepoHeadSha(readText, current);
			return sha ? { rootPath: current, sha } : undefined;
		}
		const parent = posix.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
	return undefined;
}

export interface IUncoveredTurnEditParams {
	/** Raw `file://` URI of the changed path (as reported by file events). */
	readonly uri: URI;
	readonly changeType: FileChangeType;
	/** Repo info pinned at turn start; absent → no before-content diff. */
	readonly repo: ITurnRepoInfo | undefined;
	/** Backend (protocol) session URI string, used to scope git-blob reads. */
	readonly backendSessionUri: string;
	readonly connectionAuthority: string;
	/** Grouping id, typically the turn id. */
	readonly undoStopId: string;
}

/** Compact per-path history retained while a turn's file watcher is active. */
export interface ITurnFileChangeObservation {
	readonly firstType: FileChangeType;
	readonly sawAdded: boolean;
	readonly sawUpdated: boolean;
	readonly sawDeleted: boolean;
}

/** Adds one unordered watcher event to a path's compact turn observation. */
export function accumulateUncoveredTurnFileChange(previous: ITurnFileChangeObservation | undefined, type: FileChangeType): ITurnFileChangeObservation {
	return {
		firstType: previous?.firstType ?? type,
		sawAdded: previous?.sawAdded || type === FileChangeType.ADDED,
		sawUpdated: previous?.sawUpdated || type === FileChangeType.UPDATED,
		sawDeleted: previous?.sawDeleted || type === FileChangeType.DELETED,
	};
}

/**
 * Reconciles an accumulated watcher event with the path's state at turn end.
 *
 * File watcher event batches do not preserve operation order. In particular,
 * an atomic replacement may report both delete and add for the real target,
 * while a sibling scratch file can be created and removed within one turn.
 * The final filesystem state is authoritative:
 *
 * - a path that exists cannot be presented as deleted;
 * - a path first reported as added but gone at turn end was transient;
 * - any other missing changed path is a deletion.
 *
 * Ignored-path filtering is repeated here because buffered events can outlive
 * the watcher callback that originally accepted them.
 */
export function finalizeUncoveredTurnFileChange(
	path: string,
	observation: ITurnFileChangeObservation,
	existsAtTurnEnd: boolean,
	existedAtTurnStart?: boolean,
): FileChangeType | undefined {
	if (isIgnoredAgentPath(path)) {
		return undefined;
	}
	if (existsAtTurnEnd) {
		// Some platform watchers report an atomic rewrite of an existing file as
		// ADDED only. A successful turn-start baseline probe is authoritative in
		// that ambiguous case; without one, retain the historical create fallback.
		if (observation.firstType === FileChangeType.ADDED && !observation.sawDeleted && existedAtTurnStart !== undefined) {
			return existedAtTurnStart ? FileChangeType.UPDATED : FileChangeType.ADDED;
		}
		// A delete followed by a final existing path is an atomic replacement;
		// any other pre-existing path is an update regardless of the watcher's
		// last unordered event.
		return observation.firstType === FileChangeType.ADDED && !observation.sawDeleted
			? FileChangeType.ADDED
			: FileChangeType.UPDATED;
	}
	// A path created during the turn and absent at its end has no net effect.
	// Anything that existed (or was first observed changing/deleting) and is
	// now absent is a real deletion.
	return observation.firstType === FileChangeType.ADDED ? undefined : FileChangeType.DELETED;
}

/**
 * Returns the raw `git-blob:` URI for a changed file at the turn-start
 * commit. Besides hydration, callers use this to distinguish a true create
 * from an existing tracked file whose atomic replacement was reported as a
 * lone ADDED event.
 */
export function buildUncoveredTurnBeforeContentUri(
	uri: URI,
	repo: ITurnRepoInfo | undefined,
	backendSessionUri: string,
): URI | undefined {
	if (!repo || !uri.path.startsWith(`${repo.rootPath}/`)) {
		return undefined;
	}
	const repoRelativePath = uri.path.substring(repo.rootPath.length + 1);
	return URI.parse(buildGitBlobUri(backendSessionUri, repo.sha, repoRelativePath, uri.path));
}

/**
 * Builds a fully-hydrated {@link IChatExternalEdit} for an out-of-band file
 * change so the UI renders the same pill + diff card as tool-declared edits:
 * `before` from a `git-blob:` URI at the turn-start sha, `after` from the
 * working-tree file. Creates omit `before` (nothing existed); deletes omit
 * `after`. Files outside the repository (or with no repo info) fall back to
 * a diff-less pill rather than fabricating content.
 */
export function hydrateUncoveredTurnEdit(params: IUncoveredTurnEditParams): IChatExternalEdit {
	const { uri, changeType, repo, backendSessionUri, connectionAuthority, undoStopId } = params;
	const editKind = changeType === FileChangeType.ADDED ? 'create'
		: changeType === FileChangeType.DELETED ? 'delete'
			: 'edit';

	const wrap = (value: URI) => toAgentHostUri(value, connectionAuthority);

	const rawBeforeContentUri = editKind !== 'create'
		? buildUncoveredTurnBeforeContentUri(uri, repo, backendSessionUri)
		: undefined;
	const beforeContentUri = rawBeforeContentUri ? wrap(rawBeforeContentUri) : undefined;
	const afterContentUri = editKind !== 'delete' ? wrap(uri) : undefined;

	return {
		kind: 'externalEdit',
		uri: wrap(uri),
		editKind,
		beforeContentUri,
		afterContentUri,
		undoStopId,
	};
}
