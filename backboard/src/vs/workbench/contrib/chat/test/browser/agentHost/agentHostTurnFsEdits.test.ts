/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { match } from '../../../../../../base/common/glob.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileChangeType } from '../../../../../../platform/files/common/files.js';
import { fromAgentHostUri } from '../../../../../../platform/agentHost/common/agentHostUri.js';
import { AGENT_IGNORED_FILE_GLOBS, isIgnoredAgentPath } from '../../../../../../platform/agentHost/common/agentIgnoredPaths.js';
import { parseGitBlobUri } from '../../../../../../platform/agentHost/common/gitBlobUri.js';
import { accumulateUncoveredTurnFileChange, buildUncoveredTurnBeforeContentUri, finalizeUncoveredTurnFileChange, findPackedRefSha, hydrateUncoveredTurnEdit, parseGitDirPointer, parseGitHeadContent, resolveRepoHeadSha, resolveTurnRepoInfo, type ITurnFileChangeObservation, type ReadTextFn } from '../../../browser/agentSessions/agentHost/agentHostTurnFsEdits.js';

suite('agentHostTurnFsEdits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const SHA = 'a'.repeat(40);
	const OTHER_SHA = 'b'.repeat(40);

	function fakeFs(files: Record<string, string>): ReadTextFn {
		return async path => files[path];
	}

	suite('isIgnoredAgentPath', () => {
		test('filters only the owned worker UUID sibling, including restored review rows', () => {
			const owned = '/repo/src/.backboard-write-73364876-b55a-46b9-9e05-42929fbee6ac';
			const userFiles = ['/repo/src/.backboard-write-notes', `${owned}.ts`, '/repo/.env', '/repo/.backboard-write-73364876-b55a-16b9-9e05-42929fbee6ac'];
			assert.deepStrictEqual({
				owned: isIgnoredAgentPath(owned),
				watcher: AGENT_IGNORED_FILE_GLOBS.some(pattern => match(pattern, owned)),
				userFiles: userFiles.map(isIgnoredAgentPath),
				userWatcher: userFiles.map(path => AGENT_IGNORED_FILE_GLOBS.some(pattern => match(pattern, path))),
			}, { owned: true, watcher: true, userFiles: [false, false, false, false], userWatcher: [false, false, false, false] });
		});

		test('flags VCS internals and build output, keeps normal files', () => {
			assert.deepStrictEqual({
				gitObject: isIgnoredAgentPath('/repo/.git/objects/84/18b716db4a948a0b53c14417a85c23fbfbe1'),
				gitTmp: isIgnoredAgentPath('/repo/.git/objects/tmp_obj_mxrwlz'),
				nodeModules: isIgnoredAgentPath('/repo/node_modules/foo/index.js'),
				atomicTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.tmp.98222.fde4c15a7895'),
				postfixTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.98222.1720000000000.fde4c15a7895.tmp'),
				vscTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.vsctmp'),
				vscodeAtomicSibling: isIgnoredAgentPath('/repo/src/.!13356!level.js'),
				mkstempRootScratch: isIgnoredAgentPath('/repo/XXSf7h6t'),
				mkstempSecondRootScratch: isIgnoredAgentPath('/repo/XXsFmXbz'),
				mkstempNestedScratch: isIgnoredAgentPath('/repo/src/XX1Q1uqN'),
				mkstempSecondNestedScratch: isIgnoredAgentPath('/repo/src/XXhU77d6'),
				plainTmpScratch: isIgnoredAgentPath('/repo/src/main.js.tmp'),
				bunBuildTmp: isIgnoredAgentPath('/repo/cli-ts/.18bf259f3f2fcae3-00000000.bun-build'),
				codesignTmp: isIgnoredAgentPath('/repo/bin/backboard-cli-ts.cstemp'),
				tsBuildInfo: isIgnoredAgentPath('/repo/extensions/emmet/tsconfig.tsbuildinfo'),
				notebookOut: isIgnoredAgentPath('/repo/extensions/markdown-math/notebook-out/fonts/KaTeX_Main-Bold.woff2'),
				dotBuild: isIgnoredAgentPath('/repo/.build/extensions/foo.js'),
				dsStore: isIgnoredAgentPath('/repo/src/.DS_Store'),
				playwrightCli: isIgnoredAgentPath('/repo/.playwright-cli/console-2026-07-23T20-52-19-886Z.log'),
				logFile: isIgnoredAgentPath('/repo/server.log'),
				normalFile: isIgnoredAgentPath('/repo/src/EXTENSIONS_AND_RIGHT_PANEL.md'),
				gitLikeName: isIgnoredAgentPath('/repo/src/gitHelpers.ts'),
				normalTmpName: isIgnoredAgentPath('/repo/src/template.ts'),
				buildInfoLikeName: isIgnoredAgentPath('/repo/src/tsbuildinfoParser.ts'),
				logLikeName: isIgnoredAgentPath('/repo/src/catalog.ts'),
				mkstempTooLong: isIgnoredAgentPath('/repo/src/XXSf7h6t0'),
				mkstempWrongPrefix: isIgnoredAgentPath('/repo/src/AXSf7h6t'),
				mkstempNonAlphanumeric: isIgnoredAgentPath('/repo/src/XXSf7h6-'),
				mkstempWithExtension: isIgnoredAgentPath('/repo/src/XXSf7h6t.js'),
				tmpInsideName: isIgnoredAgentPath('/repo/src/main.tmp.js'),
				tmpPrefix: isIgnoredAgentPath('/repo/src/.tmpfile'),
			}, {
				gitObject: true,
				gitTmp: true,
				nodeModules: true,
				atomicTmp: true,
				postfixTmp: true,
				vscTmp: true,
				vscodeAtomicSibling: true,
				mkstempRootScratch: true,
				mkstempSecondRootScratch: true,
				mkstempNestedScratch: true,
				mkstempSecondNestedScratch: true,
				plainTmpScratch: true,
				bunBuildTmp: true,
				codesignTmp: true,
				tsBuildInfo: true,
				notebookOut: true,
				dotBuild: true,
				dsStore: true,
				playwrightCli: true,
				logFile: true,
				normalFile: false,
				gitLikeName: false,
				normalTmpName: false,
				buildInfoLikeName: false,
				logLikeName: false,
				mkstempTooLong: false,
				mkstempWrongPrefix: false,
				mkstempNonAlphanumeric: false,
				mkstempWithExtension: false,
				tmpInsideName: false,
				tmpPrefix: false,
			});
		});

		test('watcher globs match only the exact mkstemp and tmp sibling shapes', () => {
			const isExcludedByWatcher = (path: string) => AGENT_IGNORED_FILE_GLOBS.some(pattern => match(pattern, path));
			assert.deepStrictEqual({
				mkstempRoot: isExcludedByWatcher('/repo/XXsFmXbz'),
				mkstempNested: isExcludedByWatcher('/repo/src/XXhU77d6'),
				plainTmp: isExcludedByWatcher('/repo/src/main.js.tmp'),
				mkstempTooLong: isExcludedByWatcher('/repo/src/XXSf7h6t0'),
				mkstempWithExtension: isExcludedByWatcher('/repo/src/XXSf7h6t.js'),
				tmpInsideName: isExcludedByWatcher('/repo/src/main.tmp.js'),
			}, {
				mkstempRoot: true,
				mkstempNested: true,
				plainTmp: true,
				mkstempTooLong: false,
				mkstempWithExtension: false,
				tmpInsideName: false,
			});
		});
	});

	suite('git metadata parsing', () => {
		test('parses HEAD, gitdir pointers, and packed refs', () => {
			assert.deepStrictEqual({
				symbolicHead: parseGitHeadContent('ref: refs/heads/f-ide\n'),
				detachedHead: parseGitHeadContent(`${SHA}\n`),
				garbageHead: parseGitHeadContent('not a head'),
				pointer: parseGitDirPointer('gitdir: /repo/.git/worktrees/session-1\n'),
				packedHit: findPackedRefSha(`# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/f-ide\n^${OTHER_SHA}\n`, 'refs/heads/f-ide'),
				packedMiss: findPackedRefSha(`${SHA} refs/heads/main\n`, 'refs/heads/f-ide'),
			}, {
				symbolicHead: { ref: 'refs/heads/f-ide' },
				detachedHead: { sha: SHA },
				garbageHead: undefined,
				pointer: '/repo/.git/worktrees/session-1',
				packedHit: SHA,
				packedMiss: undefined,
			});
		});
	});

	suite('finalizeUncoveredTurnFileChange', () => {
		test('does not present mkdir events or removed worker siblings as file edits', () => {
			const added = accumulateUncoveredTurnFileChange(undefined, FileChangeType.ADDED);
			const deleted = accumulateUncoveredTurnFileChange(undefined, FileChangeType.DELETED);
			assert.deepStrictEqual({
				directory: finalizeUncoveredTurnFileChange('/repo/new-directory', added, true, false, true),
				file: finalizeUncoveredTurnFileChange('/repo/new-directory/app.ts', added, true, false, false),
				missedTempCreate: finalizeUncoveredTurnFileChange('/repo/.backboard-write-40604691-bee8-4425-8fd2-8319221acf3c', deleted, false),
			}, { directory: undefined, file: FileChangeType.ADDED, missedTempCreate: undefined });
		});

		test('uses final filesystem state and drops transient or ignored paths', () => {
			const observe = (...types: FileChangeType[]): ITurnFileChangeObservation => {
				let result: ITurnFileChangeObservation | undefined;
				for (const type of types) {
					result = accumulateUncoveredTurnFileChange(result, type);
				}
				return result!;
			};
			assert.deepStrictEqual({
				existingAdded: finalizeUncoveredTurnFileChange('/repo/new.ts', observe(FileChangeType.ADDED), true),
				trackedAtomicReplacementReportedOnlyAdded: finalizeUncoveredTurnFileChange('/repo/index.html', observe(FileChangeType.ADDED), true, true),
				newFileReportedAdded: finalizeUncoveredTurnFileChange('/repo/new.ts', observe(FileChangeType.ADDED), true, false),
				existingUpdated: finalizeUncoveredTurnFileChange('/repo/app.ts', observe(FileChangeType.UPDATED), true),
				existingAfterDeleteEvent: finalizeUncoveredTurnFileChange('/repo/app.ts', observe(FileChangeType.DELETED), true),
				atomicDeleteThenAdd: finalizeUncoveredTurnFileChange('/repo/app.ts', observe(FileChangeType.DELETED, FileChangeType.ADDED), true),
				atomicAddThenDelete: finalizeUncoveredTurnFileChange('/repo/app.ts', observe(FileChangeType.ADDED, FileChangeType.DELETED), true),
				missingAfterAddEvent: finalizeUncoveredTurnFileChange('/repo/transient.ts', observe(FileChangeType.ADDED), false),
				transientAddThenDelete: finalizeUncoveredTurnFileChange('/repo/transient.ts', observe(FileChangeType.ADDED, FileChangeType.DELETED), false),
				missingAfterUpdateEvent: finalizeUncoveredTurnFileChange('/repo/removed.ts', observe(FileChangeType.UPDATED), false),
				missingAfterDeleteEvent: finalizeUncoveredTurnFileChange('/repo/removed.ts', observe(FileChangeType.DELETED), false),
				ignoredAtomicSiblingStillPresent: finalizeUncoveredTurnFileChange('/repo/src/.!13356!level.js', observe(FileChangeType.ADDED), true),
				ignoredAtomicSiblingDeleted: finalizeUncoveredTurnFileChange('/repo/src/.!13356!level.js', observe(FileChangeType.DELETED), false),
			}, {
				existingAdded: FileChangeType.ADDED,
				trackedAtomicReplacementReportedOnlyAdded: FileChangeType.UPDATED,
				newFileReportedAdded: FileChangeType.ADDED,
				existingUpdated: FileChangeType.UPDATED,
				existingAfterDeleteEvent: FileChangeType.UPDATED,
				atomicDeleteThenAdd: FileChangeType.UPDATED,
				atomicAddThenDelete: FileChangeType.UPDATED,
				missingAfterAddEvent: undefined,
				transientAddThenDelete: undefined,
				missingAfterUpdateEvent: FileChangeType.DELETED,
				missingAfterDeleteEvent: FileChangeType.DELETED,
				ignoredAtomicSiblingStillPresent: undefined,
				ignoredAtomicSiblingDeleted: undefined,
			});
		});
	});

	suite('resolveRepoHeadSha', () => {
		test('resolves a regular repository via loose ref', async () => {
			const sha = await resolveRepoHeadSha(fakeFs({
				'/repo/.git/HEAD': 'ref: refs/heads/main\n',
				'/repo/.git/refs/heads/main': `${SHA}\n`,
			}), '/repo');
			assert.strictEqual(sha, SHA);
		});

		test('resolves a worktree via gitdir pointer + commondir + packed refs', async () => {
			const sha = await resolveRepoHeadSha(fakeFs({
				'/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
				'/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/session-branch\n',
				'/main/.git/worktrees/wt/commondir': '../..\n',
				'/main/.git/packed-refs': `${SHA} refs/heads/session-branch\n`,
			}), '/wt');
			assert.strictEqual(sha, SHA);
		});

		test('returns undefined outside a repository', async () => {
			assert.strictEqual(await resolveRepoHeadSha(fakeFs({}), '/not-a-repo'), undefined);
		});
	});

	suite('resolveTurnRepoInfo', () => {
		test('walks up to find the repository root', async () => {
			const info = await resolveTurnRepoInfo(fakeFs({
				'/repo/.git/HEAD': `${SHA}\n`,
			}), '/repo/packages/app');
			assert.deepStrictEqual(info, { rootPath: '/repo', sha: SHA });
		});
	});

	suite('hydrateUncoveredTurnEdit', () => {
		const base = {
			repo: { rootPath: '/repo', sha: SHA },
			backendSessionUri: 'copilotcli:/session-1',
			connectionAuthority: 'local',
			undoStopId: 'turn-1',
		} as const;

		test('edit gets a git-blob before URI at the turn-start sha and a working-tree after URI', () => {
			const edit = hydrateUncoveredTurnEdit({ ...base, uri: URI.file('/repo/src/app.ts'), changeType: FileChangeType.UPDATED });
			// The before URI is wrapped in agenthost:// for provider routing;
			// unwrap it the same way the fs provider does before parsing.
			const blobFields = parseGitBlobUri(fromAgentHostUri(edit.beforeContentUri!).toString());
			assert.deepStrictEqual({
				editKind: edit.editKind,
				blobFields,
				afterContentUri: edit.afterContentUri?.toString(),
				uri: edit.uri.toString(),
				undoStopId: edit.undoStopId,
			}, {
				editKind: 'edit',
				blobFields: { sessionUri: 'copilotcli:/session-1', sha: SHA, repoRelativePath: 'src/app.ts' },
				afterContentUri: URI.file('/repo/src/app.ts').toString(),
				uri: URI.file('/repo/src/app.ts').toString(),
				undoStopId: 'turn-1',
			});
		});

		test('builds the baseline probe URI without exposing it as the edited file label', () => {
			const changed = URI.file('/repo/style.css');
			const before = buildUncoveredTurnBeforeContentUri(changed, base.repo, base.backendSessionUri);
			assert.deepStrictEqual(parseGitBlobUri(before!.toString()), {
				sessionUri: base.backendSessionUri,
				sha: SHA,
				repoRelativePath: 'style.css',
			});
			assert.strictEqual(before!.path, changed.path);
			assert.strictEqual(buildUncoveredTurnBeforeContentUri(URI.file('/elsewhere/style.css'), base.repo, base.backendSessionUri), undefined);
		});

		test('create omits before content; delete omits after content', () => {
			const created = hydrateUncoveredTurnEdit({ ...base, uri: URI.file('/repo/new.ts'), changeType: FileChangeType.ADDED });
			const deleted = hydrateUncoveredTurnEdit({ ...base, uri: URI.file('/repo/old.ts'), changeType: FileChangeType.DELETED });
			assert.deepStrictEqual({
				createdKind: created.editKind,
				createdBefore: created.beforeContentUri,
				createdHasAfter: !!created.afterContentUri,
				deletedKind: deleted.editKind,
				deletedHasBefore: !!deleted.beforeContentUri,
				deletedAfter: deleted.afterContentUri,
			}, {
				createdKind: 'create',
				createdBefore: undefined,
				createdHasAfter: true,
				deletedKind: 'delete',
				deletedHasBefore: true,
				deletedAfter: undefined,
			});
		});

		test('files outside the repository (or with no repo info) fall back to a diff-less edit', () => {
			const outside = hydrateUncoveredTurnEdit({ ...base, uri: URI.file('/elsewhere/x.ts'), changeType: FileChangeType.UPDATED });
			const noRepo = hydrateUncoveredTurnEdit({ ...base, repo: undefined, uri: URI.file('/repo/src/app.ts'), changeType: FileChangeType.UPDATED });
			assert.deepStrictEqual(
				{ outsideBefore: outside.beforeContentUri, noRepoBefore: noRepo.beforeContentUri },
				{ outsideBefore: undefined, noRepoBefore: undefined }
			);
		});
	});
});
