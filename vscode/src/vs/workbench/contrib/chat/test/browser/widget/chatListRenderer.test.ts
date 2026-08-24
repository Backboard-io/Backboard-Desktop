/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	getBackboardTurnChronologicalWorkNodes,
	getBackboardTurnFinalContentIndexes,
	hasBackboardTurnWorkContent,
	reconcileBackboardTurnNodeOrder,
	resolveBackboardTurnExpandedState,
	shouldRenderBackboardEditStandalone,
	shouldScheduleInitialHeightChange,
	shouldSplitBackboardThinkingBeforeEdit,
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
		test('stable timeline performs no moves and a late diff needs one insertion', () => {
			const reconcile = (current: string[], desired: string[]) => {
				let mutations = 0;
				const moves = reconcileBackboardTurnNodeOrder(
					desired,
					() => current[0],
					node => current[current.indexOf(node) + 1],
					(node, before) => {
						mutations++;
						current.splice(current.indexOf(node), 1);
						const targetIndex = before === undefined ? current.length : current.indexOf(before);
						current.splice(targetIndex, 0, node);
					},
				);
				return { current, moves, mutations };
			};

			assert.deepStrictEqual(
				reconcile(['tool-before', 'diff', 'tool-after'], ['tool-before', 'diff', 'tool-after']),
				{ current: ['tool-before', 'diff', 'tool-after'], moves: 0, mutations: 0 },
				'A streaming token update must not reparent an already-stable timeline',
			);
			assert.deepStrictEqual(
				reconcile(['tool-before', 'tool-after', 'diff'], ['tool-before', 'diff', 'tool-after']),
				{ current: ['tool-before', 'diff', 'tool-after'], moves: 1, mutations: 1 },
				'A lazily restored late diff should move once into its response-index position',
			);
		});

		test('restores tool -> diff -> later-tool order and de-duplicates each Thought wrapper', () => {
			const thoughtBefore = { id: 'thought-before' };
			const toolBefore = { id: 'tool-before' };
			const terminal = { id: 'terminal' };
			const diff = { id: 'diff' };
			const thoughtAfter = { id: 'thought-after' };
			const toolAfter = { id: 'tool-after' };
			const final = { id: 'final' };
			const parents = new Map([
				[thoughtBefore, thoughtBefore],
				[toolBefore, thoughtBefore],
				[terminal, terminal],
				[diff, diff],
				[thoughtAfter, thoughtAfter],
				[toolAfter, thoughtAfter],
				[final, final],
			]);

			assert.deepStrictEqual(
				getBackboardTurnChronologicalWorkNodes(
					[thoughtBefore, toolBefore, diff, thoughtAfter, toolAfter, terminal, final],
					new Set([6]),
					node => parents.get(node),
				).map(node => node.id),
				['thought-before', 'diff', 'thought-after', 'terminal'],
				'A restored diff must remain between distinct pre/post edit Thought roots while each shared ancestor moves once',
			);
			assert.deepStrictEqual([
				shouldSplitBackboardThinkingBeforeEdit('textEditGroup', true, false),
				shouldSplitBackboardThinkingBeforeEdit('externalEdit', true, false),
				shouldSplitBackboardThinkingBeforeEdit('externalEdit', true, true),
				shouldSplitBackboardThinkingBeforeEdit('externalEdit', false, false),
			], [true, true, false, false], 'Only a newly mounted standalone Backboard edit should split the active Thought root');
		});

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

		test('keeps a fold for every meaningful non-final work artifact', () => {
			assert.deepStrictEqual([
				hasBackboardTurnWorkContent(['none', 'terminal'], true),
				hasBackboardTurnWorkContent(['none', 'work', 'terminal'], true),
				hasBackboardTurnWorkContent(['none', 'terminal', 'terminalSupport'], true),
				hasBackboardTurnWorkContent(['none', 'terminal'], false),
				hasBackboardTurnWorkContent(['none', 'work', 'terminal'], false),
			], [false, true, true, false, true]);
		});

		test('restores explicit outer-fold state and otherwise collapses completed work', () => {
			assert.deepStrictEqual([
				resolveBackboardTurnExpandedState(true, true),
				resolveBackboardTurnExpandedState(true, false),
				resolveBackboardTurnExpandedState(true, undefined),
				resolveBackboardTurnExpandedState(true, undefined),
				resolveBackboardTurnExpandedState(false, false),
				resolveBackboardTurnExpandedState(false, undefined),
			], [true, false, false, false, false, true]);
		});

		test('collapses the current turn when its live run completes', () => {
			assert.deepStrictEqual([
				resolveBackboardTurnExpandedState(true, undefined),
				resolveBackboardTurnExpandedState(true, undefined),
				resolveBackboardTurnExpandedState(true, undefined),
			], [false, false, false]);
		});

		test('requires a fresh explicit expansion after a response becomes history', () => {
			assert.deepStrictEqual([
				resolveBackboardTurnExpandedState(true, undefined),
				resolveBackboardTurnExpandedState(true, false),
				resolveBackboardTurnExpandedState(true, true),
			], [false, false, true]);
		});

		test('keeps Backboard diff cards outside the nested Thought disclosure', () => {
			assert.deepStrictEqual([
				shouldRenderBackboardEditStandalone('textEditGroup', true),
				shouldRenderBackboardEditStandalone('externalEdit', true),
				shouldRenderBackboardEditStandalone('toolInvocation', true),
				shouldRenderBackboardEditStandalone('textEditGroup', false),
			], [true, true, false, false]);
		});
	});
});
