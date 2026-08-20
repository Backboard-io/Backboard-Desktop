/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	getBackboardTurnFinalContentIndexes,
	resolveBackboardTurnExpandedState,
	shouldScheduleInitialHeightChange,
} from '../../../browser/widget/chatListRenderer.js';

suite('ChatListRenderer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('shouldScheduleInitialHeightChange', () => {
		test('only schedules first measurement updates when needed to avoid clipping', () => {
			assert.deepStrictEqual([
				shouldScheduleInitialHeightChange(120, undefined),
				shouldScheduleInitialHeightChange(120, 120),
				shouldScheduleInitialHeightChange(120, 120.1),
				shouldScheduleInitialHeightChange(121, 120),
				shouldScheduleInitialHeightChange(121, 120.1),
			], [
				true,
				false,
				false,
				true,
				true,
			]);
		});
	});

	suite('Backboard cursor transcript turn folding', () => {
		test('keeps final assistant text outside while folding trailing work and support', () => {
			const roles = [
				'none',
				'work',
				'terminal', // intermediate commentary
				'work',
				'terminal',
				'terminal',
				'terminalSupport',
				'terminal',
				'work', // late file edit emitted after the final response
			] as const;

			assert.deepStrictEqual(getBackboardTurnFinalContentIndexes(roles, true), [4, 5, 7]);
			assert.deepStrictEqual(getBackboardTurnFinalContentIndexes(roles, false), []);
		});

		test('keeps the final response visible when a trailing edit arrives afterward', () => {
			assert.deepStrictEqual(getBackboardTurnFinalContentIndexes([
				'work',
				'terminal',
				'work',
			], true), [1]);
		});

		test('does not release support or invisible nodes without a terminal anchor', () => {
			assert.deepStrictEqual(getBackboardTurnFinalContentIndexes([
				'work',
				'terminalSupport',
				'none',
			], true), []);
		});

		test('restores stored outer-fold state after the DOM is recreated', () => {
			assert.strictEqual(resolveBackboardTurnExpandedState(true, true, undefined, false), true);
			assert.strictEqual(resolveBackboardTurnExpandedState(true, false, undefined, true), false);
			assert.strictEqual(resolveBackboardTurnExpandedState(true, undefined, 'complete', true), true);
			assert.strictEqual(resolveBackboardTurnExpandedState(true, undefined, undefined, true), false);
			assert.strictEqual(resolveBackboardTurnExpandedState(false, false, 'complete', false), false);
			assert.strictEqual(resolveBackboardTurnExpandedState(false, undefined, undefined, false), true);
		});
	});
});
