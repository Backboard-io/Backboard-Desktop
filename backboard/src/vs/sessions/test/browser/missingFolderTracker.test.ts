/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { MissingFolderTracker } from '../../browser/missingFolderTracker.js';

suite('MissingFolderTracker', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFileService(options: { existing?: readonly URI[]; providerSchemes?: readonly string[]; throwOnExists?: boolean }): IFileService {
		const existing = new Set((options.existing ?? []).map(uri => uri.toString()));
		const providerSchemes = new Set(options.providerSchemes ?? [Schemas.file]);
		return {
			hasProvider: (resource: URI) => providerSchemes.has(resource.scheme),
			exists: async (resource: URI) => {
				if (options.throwOnExists) {
					throw new Error('boom');
				}
				return existing.has(resource.toString());
			},
		} as unknown as IFileService; // no-as-any justification: lightweight mock of the two members the tracker uses
	}

	test('reports a deleted local folder as missing and fires once', async () => {
		const present = URI.file('/present');
		const deleted = URI.file('/deleted');
		const tracker = store.add(new MissingFolderTracker(createFileService({ existing: [present] })));

		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));

		await tracker.refresh([present, deleted]);

		assert.deepStrictEqual(
			{ present: tracker.isMissing(present), deleted: tracker.isMissing(deleted), changes },
			{ present: false, deleted: true, changes: 1 },
		);
	});

	test('never reports non-local or provider-less folders as missing', async () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'host', path: '/x' });
		const localNoProvider = URI.file('/gone');
		// A provider exists only for the remote scheme, so the local folder cannot be checked.
		const tracker = store.add(new MissingFolderTracker(createFileService({ existing: [], providerSchemes: ['vscode-remote'] })));

		await tracker.refresh([remote, localNoProvider]);

		assert.deepStrictEqual(
			{ remote: tracker.isMissing(remote), localNoProvider: tracker.isMissing(localNoProvider) },
			{ remote: false, localNoProvider: false },
		);
	});

	test('treats a stat error as present', async () => {
		const folder = URI.file('/maybe');
		const tracker = store.add(new MissingFolderTracker(createFileService({ throwOnExists: true })));

		await tracker.refresh([folder]);

		assert.strictEqual(tracker.isMissing(folder), false);
	});

	test('drops a folder from missing once it exists again, firing on each change', async () => {
		const folder = URI.file('/recreated');
		const existing = new Set<string>();
		const fileService = {
			hasProvider: () => true,
			exists: async (resource: URI) => existing.has(resource.toString()),
		} as unknown as IFileService; // no-as-any justification: lightweight mock of the two members the tracker uses
		const tracker = store.add(new MissingFolderTracker(fileService));

		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));

		await tracker.refresh([folder]); // deleted
		existing.add(folder.toString());
		await tracker.refresh([folder]); // recreated

		assert.deepStrictEqual(
			{ missing: tracker.isMissing(folder), changes },
			{ missing: false, changes: 2 },
		);
	});

	test('does not fire again when the missing set is unchanged', async () => {
		const deleted = URI.file('/still-gone');
		const tracker = store.add(new MissingFolderTracker(createFileService({ existing: [] })));

		let changes = 0;
		store.add(tracker.onDidChange(() => changes++));

		await tracker.refresh([deleted]);
		await tracker.refresh([deleted]);

		assert.deepStrictEqual({ missing: tracker.isMissing(deleted), changes }, { missing: true, changes: 1 });
	});
});
