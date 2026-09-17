/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MultiDiffSourceResolverService } from '../../../../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ISessionFileChange } from '../../../../services/sessions/common/session.js';
import { RightWorkbenchReviewSource } from '../../browser/rightWorkbenchReviewSource.js';

suite('RightWorkbenchReviewSource', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function change(name: string, insertions = 1): ISessionFileChange {
		return { uri: URI.file(`/workspace/${name}`), insertions, deletions: 0 };
	}

	test('adding files updates the existing source and preserves unchanged diff items', async () => {
		const service = new MultiDiffSourceResolverService();
		const resolver = store.add(new RightWorkbenchReviewSource(service));
		const uri = resolver.update([change('a.md')], 1);
		const source = (await service.resolve(uri))!;
		let events = 0;
		store.add(source.resources.onDidChange(() => events++));
		const first = source.resources.value[0];
		const nextUri = resolver.update([change('a.md', 20), change('b.json')], 1);
		const afterAdd = source.resources.value;
		resolver.update([change('a.md', 40), change('b.json', 30)], 1);
		assert.deepStrictEqual({
			sameUri: nextUri.toString() === uri.toString(),
			sameFirstItem: source.resources.value[0] === first,
			sameListAfterCounts: source.resources.value === afterAdd,
			files: source.resources.value.map(item => item.modifiedUri?.path),
			events,
		}, { sameUri: true, sameFirstItem: true, sameListAfterCounts: true, files: ['/workspace/a.md', '/workspace/b.json'], events: 1 });
	});

	test('removes files and isolates a different chat context', async () => {
		const service = new MultiDiffSourceResolverService();
		const resolver = store.add(new RightWorkbenchReviewSource(service));
		const uri = resolver.update([change('a.md'), change('b.json')], 1);
		const source = (await service.resolve(uri))!;
		resolver.update([change('b.json')], 1);
		const nextUri = resolver.update([change('other.md')], 2);
		const nextSource = (await service.resolve(nextUri))!;
		assert.deepStrictEqual({
			newUri: uri.toString() !== nextUri.toString(),
			previousFiles: source.resources.value.map(item => item.modifiedUri?.path),
			currentFiles: nextSource.resources.value.map(item => item.modifiedUri?.path),
		}, { newUri: true, previousFiles: ['/workspace/b.json'], currentFiles: ['/workspace/other.md'] });
		resolver.update([], 2);
		assert.deepStrictEqual(nextSource.resources.value, []);
		resolver.dispose();
		assert.strictEqual(await service.resolve(nextUri), undefined);
	});
});
