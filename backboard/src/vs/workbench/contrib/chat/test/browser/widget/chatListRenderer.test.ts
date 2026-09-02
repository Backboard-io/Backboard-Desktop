/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../base/common/async.js';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import {
	getBackboardTurnChronologicalWorkNodes,
	getBackboardTurnFinalContentIndexes,
	getBackboardSubagentSummary,
	hasBackboardTurnWorkContent,
	isBackboardMutationBatchEdit,
	reconcileBackboardTurnNodeOrder,
	resolveBackboardTurnExpandedState,
	syncBackboardSubagentStrip,
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
		test('packs parallel subagents behind one stable aggregate disclosure', () => {
			const container = mainWindow.document.createElement('div');
			mainWindow.document.body.appendChild(container);
			const items = Array.from({ length: 12 }, (_, index) => ({
				node: mainWindow.document.createElement('div'),
				active: index < 2,
				status: index < 2 ? 'running' : 'complete',
			}));

			syncBackboardSubagentStrip(container, items);
			const strip = container.querySelector<HTMLElement>(':scope > .chat-subagent-strip');
			const summary = strip?.querySelector<HTMLButtonElement>(':scope > .chat-subagent-summary');
			const details = strip?.querySelector<HTMLElement>(':scope > .chat-subagent-items');
			assert.ok(strip);
			assert.ok(summary);
			assert.ok(details);
			assert.strictEqual(summary.querySelector('.chat-subagent-summary-label')?.textContent, '12 workers · 2 running · 10 complete');
			assert.strictEqual(details.hidden, true);
			assert.strictEqual(summary.ariaExpanded, 'false');

			summary.click();
			assert.strictEqual(details.hidden, false);
			assert.strictEqual(summary.ariaExpanded, 'true');

			items[1].node.tabIndex = 0;
			items[1].node.focus();
			const observer = new mainWindow.MutationObserver(() => { });
			observer.observe(strip, { childList: true });
			syncBackboardSubagentStrip(container, items);
			const stableSyncMutations = observer.takeRecords();
			observer.disconnect();
			assert.strictEqual(container.querySelector(':scope > .chat-subagent-strip'), strip, 'Streaming updates should reuse the strip DOM');
			assert.strictEqual(details.hidden, false, 'A rerender should preserve the expanded choice');
			assert.strictEqual(stableSyncMutations.length, 0, 'An unchanged streaming update must not reparent worker rows');
			assert.strictEqual(mainWindow.document.activeElement, items[1].node, 'Stable reconciliation must preserve focus inside the active worker row');
			container.remove();
		});

		test('summarizes running, completed, and failed workers without internal details', () => {
			assert.deepStrictEqual(getBackboardSubagentSummary([
				{ active: true, status: 'running' },
				{ active: false, status: 'integrated' },
				{ active: false, status: 'conflict' },
			]), {
				label: '3 workers · 1 running · 1 complete · 1 needs attention',
				status: 'attention',
			});
		});

		test('throttles the visible worker summary to ten updates per second', async () => {
			const container = mainWindow.document.createElement('div');
			const node = mainWindow.document.createElement('div');
			mainWindow.document.body.appendChild(container);
			syncBackboardSubagentStrip(container, [{ node, active: true, status: 'running' }]);
			const label = container.querySelector<HTMLElement>('.chat-subagent-summary-label');
			assert.strictEqual(label?.textContent, '1 worker · 1 running');

			syncBackboardSubagentStrip(container, [{ node, active: false, status: 'integrated' }]);
			assert.strictEqual(label?.textContent, '1 worker · 1 running', 'Rapid lifecycle churn should not immediately mutate the visible row');
			await timeout(110);
			assert.strictEqual(label?.textContent, '1 worker · 1 complete');
			container.remove();
		});

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
				shouldSplitBackboardThinkingBeforeEdit('externalEdit', true, false, true),
			], [true, true, false, false, false], 'Only a newly mounted standalone Backboard edit should split the active Thought root');
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

		test('recognizes only explicitly batched Backboard external edits for mutation grouping', () => {
			const batched = {
				kind: 'externalEdit' as const,
				uri: URI.file('/workspace/a.ts'),
				editKind: 'edit' as const,
				mutationBatchId: 'turn-1:mutation:write-a',
			};
			assert.deepStrictEqual([
				isBackboardMutationBatchEdit(batched, true),
				isBackboardMutationBatchEdit({ ...batched, mutationBatchId: undefined }, true),
				isBackboardMutationBatchEdit(batched, false),
			], [true, false, false]);
		});
	});
});
