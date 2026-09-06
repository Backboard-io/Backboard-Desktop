/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { parseUnifiedDiff } from '../../../../browser/widget/chatContentParts/chatDiffBlockPart.js';

suite('Chat markdown unified diff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('omits patch metadata and preserves code indentation', () => {
		const patch = ['diff --git a/a.ts b/a.ts', 'index 123..456 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' function run() {', '-  old();', '+  next();', ' }'].join('\n');
		assert.deepStrictEqual(parseUnifiedDiff(patch), {
			before: 'function run() {\n  old();\n}',
			after: 'function run() {\n  next();\n}',
		});
	});

	test('preserves content resembling headers within a hunk', () => {
		assert.deepStrictEqual(parseUnifiedDiff('@@ -1 +1 @@\n--- literal\n+++ literal\n\\ No newline at end of file'), {
			before: '-- literal', after: '++ literal',
		});
	});

	test('retains tabs, blank context, and simple headerless snippets', () => {
		assert.deepStrictEqual(parseUnifiedDiff('-\tbefore\n+\tafter\n \n unchanged'), {
			before: '\tbefore\n\nunchanged', after: '\tafter\n\nunchanged',
		});
	});
});
