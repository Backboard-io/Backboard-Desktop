/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { fromAgentHostUri, toAgentHostUri } from '../../../../../../platform/agentHost/common/agentHostUri.js';
import { ISessionFileDiff } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IChatSessionFileChange2 } from '../../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { diffToChange } from '../../browser/agentHostDiffs.js';

function serialize(change: IChatSessionFileChange2 | undefined): object | undefined {
	return change && {
		uri: change.uri.toString(),
		originalUri: change.originalUri?.toString(),
		modifiedUri: change.modifiedUri?.toString(),
		insertions: change.insertions,
		deletions: change.deletions,
	};
}

suite('AgentHost diffs', () => {

	test('uses the live working-tree content URI for the modified side', () => {
		const fileUri = URI.file('/repo/src/file.ts').toString();
		const beforeContentUri = 'session-db://session/before/src/file.ts';
		const diff = {
			before: { uri: fileUri, content: { uri: beforeContentUri } },
			after: { uri: fileUri, content: { uri: fileUri } },
			diff: { added: 2, removed: 1 },
		} satisfies ISessionFileDiff;

		assert.deepStrictEqual(serialize(diffToChange(diff)), {
			uri: fileUri,
			originalUri: beforeContentUri,
			modifiedUri: fileUri,
			insertions: 2,
			deletions: 1,
		});
	});

	test('uses the checkpoint content URI while preserving the logical file URI', () => {
		const fileUri = URI.file('/repo/src/file.ts').toString();
		const beforeContentUri = 'git-blob://session/before/src/file.ts';
		const afterContentUri = 'git-blob://session/after/src/file.ts';
		const diff = {
			before: { uri: fileUri, content: { uri: beforeContentUri } },
			after: { uri: fileUri, content: { uri: afterContentUri } },
			diff: { added: 3, removed: 2 },
		} satisfies ISessionFileDiff;

		assert.deepStrictEqual(serialize(diffToChange(diff)), {
			uri: fileUri,
			originalUri: beforeContentUri,
			modifiedUri: afterContentUri,
			insertions: 3,
			deletions: 2,
		});
	});

	test('uses the after-content snapshot for an addition', () => {
		const fileUri = URI.file('/repo/src/added.ts').toString();
		const afterContentUri = 'git-blob://session/after/src/added.ts';
		const diff = {
			after: { uri: fileUri, content: { uri: afterContentUri } },
			diff: { added: 8, removed: 0 },
		} satisfies ISessionFileDiff;

		assert.deepStrictEqual(serialize(diffToChange(diff)), {
			uri: fileUri,
			originalUri: undefined,
			modifiedUri: afterContentUri,
			insertions: 8,
			deletions: 0,
		});
	});

	test('keeps the modified side empty for a deletion', () => {
		const fileUri = URI.file('/repo/src/deleted.ts').toString();
		const beforeContentUri = 'git-blob://session/before/src/deleted.ts';
		const diff = {
			before: { uri: fileUri, content: { uri: beforeContentUri } },
			diff: { added: 0, removed: 5 },
		} satisfies ISessionFileDiff;

		assert.deepStrictEqual(serialize(diffToChange(diff)), {
			uri: fileUri,
			originalUri: beforeContentUri,
			modifiedUri: undefined,
			insertions: 0,
			deletions: 5,
		});
	});

	test('maps logical and content URIs independently', () => {
		const fileUri = URI.file('/repo/src/file.ts').toString();
		const beforeContentUri = 'session-db://session/before/src/file.ts';
		const afterContentUri = 'git-blob://session/after/src/file.ts';
		const diff = {
			before: { uri: fileUri, content: { uri: beforeContentUri } },
			after: { uri: fileUri, content: { uri: afterContentUri } },
		} satisfies ISessionFileDiff;
		const change = diffToChange(diff, uri => toAgentHostUri(uri, 'remote-host'));

		assert.deepStrictEqual(change && {
			uriScheme: change.uri.scheme,
			uri: fromAgentHostUri(change.uri).toString(),
			originalScheme: change.originalUri?.scheme,
			originalUri: change.originalUri ? fromAgentHostUri(change.originalUri).toString() : undefined,
			modifiedScheme: change.modifiedUri?.scheme,
			modifiedUri: change.modifiedUri ? fromAgentHostUri(change.modifiedUri).toString() : undefined,
		}, {
			uriScheme: 'vscode-agent-host',
			uri: fileUri,
			originalScheme: 'vscode-agent-host',
			originalUri: beforeContentUri,
			modifiedScheme: 'vscode-agent-host',
			modifiedUri: afterContentUri,
		});
	});
});
