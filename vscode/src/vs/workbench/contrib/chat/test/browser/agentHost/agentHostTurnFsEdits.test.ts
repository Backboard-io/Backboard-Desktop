/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileChangeType } from '../../../../../../platform/files/common/files.js';
import { fromAgentHostUri } from '../../../../../../platform/agentHost/common/agentHostUri.js';
import { isIgnoredAgentPath } from '../../../../../../platform/agentHost/common/agentIgnoredPaths.js';
import { parseGitBlobUri } from '../../../../../../platform/agentHost/common/gitBlobUri.js';
import { findPackedRefSha, hydrateUncoveredTurnEdit, parseGitDirPointer, parseGitHeadContent, resolveRepoHeadSha, resolveTurnRepoInfo, type ReadTextFn } from '../../../browser/agentSessions/agentHost/agentHostTurnFsEdits.js';

suite('agentHostTurnFsEdits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const SHA = 'a'.repeat(40);
	const OTHER_SHA = 'b'.repeat(40);

	function fakeFs(files: Record<string, string>): ReadTextFn {
		return async path => files[path];
	}

	suite('isIgnoredAgentPath', () => {
		test('flags VCS internals and build output, keeps normal files', () => {
			assert.deepStrictEqual({
				gitObject: isIgnoredAgentPath('/repo/.git/objects/84/18b716db4a948a0b53c14417a85c23fbfbe1'),
				gitTmp: isIgnoredAgentPath('/repo/.git/objects/tmp_obj_mxrwlz'),
				nodeModules: isIgnoredAgentPath('/repo/node_modules/foo/index.js'),
				atomicTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.tmp.98222.fde4c15a7895'),
				postfixTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.98222.1720000000000.fde4c15a7895.tmp'),
				vscTmp: isIgnoredAgentPath('/repo/src/AgentController.ts.vsctmp'),
				bunBuildTmp: isIgnoredAgentPath('/repo/cli-ts/.18bf259f3f2fcae3-00000000.bun-build'),
				codesignTmp: isIgnoredAgentPath('/repo/bin/backboard-cli-ts.cstemp'),
				normalFile: isIgnoredAgentPath('/repo/src/EXTENSIONS_AND_RIGHT_PANEL.md'),
				gitLikeName: isIgnoredAgentPath('/repo/src/gitHelpers.ts'),
				normalTmpName: isIgnoredAgentPath('/repo/src/template.ts'),
			}, {
				gitObject: true,
				gitTmp: true,
				nodeModules: true,
				atomicTmp: true,
				postfixTmp: true,
				vscTmp: true,
				bunBuildTmp: true,
				codesignTmp: true,
				normalFile: false,
				gitLikeName: false,
				normalTmpName: false,
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
