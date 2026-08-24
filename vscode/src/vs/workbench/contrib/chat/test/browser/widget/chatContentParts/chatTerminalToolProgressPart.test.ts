/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../../base/common/event.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../../../base/test/common/timeTravelScheduler.js';
import { timeout } from '../../../../../../../base/common/async.js';
import { TerminalToolAutoExpand, TerminalToolAutoExpandTimeout } from '../../../../browser/widget/chatContentParts/toolInvocationParts/terminalToolAutoExpand.js';
import { getTerminalInitialExpandedState, getTerminalOutputViewportHeight, resolveStoredTerminalOutputLineCount, shouldAutoExpandTerminalFailure, shouldRenderStoredTerminalOutputFirst } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolProgressPart.js';
import { shouldRerenderToolInvocationSubPart } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { ChatToolInvocation } from '../../../../common/model/chatProgressTypes/chatToolInvocation.js';
import { ToolDataSource } from '../../../../common/tools/languageModelToolsService.js';

suite('ChatTerminalToolProgressPart Auto-Expand Logic', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// Mocked events
	let onCommandExecuted: Emitter<unknown>;
	let onCommandFinished: Emitter<unknown>;
	let onWillData: Emitter<string>;

	// State tracking
	let isExpanded: boolean;
	let userToggledOutput: boolean;
	let hasRealOutputValue: boolean;

	function shouldAutoExpand(): boolean {
		return !isExpanded && !userToggledOutput;
	}

	function hasRealOutput(): boolean {
		return hasRealOutputValue;
	}

	function setupAutoExpandLogic(): void {
		// Use the real TerminalToolAutoExpand class with event-based interface
		const autoExpand = store.add(new TerminalToolAutoExpand({
			onCommandExecuted: onCommandExecuted.event,
			onCommandFinished: onCommandFinished.event,
			onWillData: onWillData.event,
			shouldAutoExpand,
			hasRealOutput,
		}));
		store.add(autoExpand.onDidRequestExpand(() => {
			isExpanded = true;
		}));
	}

	setup(() => {
		onCommandExecuted = store.add(new Emitter<unknown>());
		onCommandFinished = store.add(new Emitter<unknown>());
		onWillData = store.add(new Emitter<string>());

		isExpanded = false;
		userToggledOutput = false;
		hasRealOutputValue = false;
	});

	test('Cursor transcript keeps an explicit capped viewport so long output can scroll', () => {
		assert.strictEqual(getTerminalOutputViewportHeight(480, 200, true), '200px');
		assert.strictEqual(getTerminalOutputViewportHeight(120, 200, true), '120px');
		assert.strictEqual(getTerminalOutputViewportHeight(480, 200, false), '');
	});

	test('Cursor transcript starts commands collapsed until output earns expansion', () => {
		assert.strictEqual(getTerminalInitialExpandedState(undefined, true, false, false), false, 'running transcript command');
		assert.strictEqual(getTerminalInitialExpandedState(undefined, true, true, false), false, 'successful transcript command');
		assert.strictEqual(getTerminalInitialExpandedState(undefined, true, true, true), true, 'failed transcript command');
		assert.strictEqual(getTerminalInitialExpandedState(undefined, false, false, false), true, 'running stock command');
		assert.strictEqual(getTerminalInitialExpandedState(true, true, true, false), true, 'stored user state');
		assert.strictEqual(getTerminalInitialExpandedState(false, true, true, true), false, 'stored collapse wins over automatic failure expansion');
	});

	test('same-state terminal data replacement rerenders the terminal subpart', () => {
		const executingState = { type: IChatToolInvocation.StateKind.Executing } as IChatToolInvocation.State;
		const firstData = { kind: 'terminal', terminalCommandOutput: undefined };
		const nextData = { kind: 'terminal', terminalCommandOutput: { text: 'streamed output' } };
		assert.strictEqual(shouldRerenderToolInvocationSubPart({
			state: executingState,
			dataKind: 'terminal',
			data: firstData,
		}, {
			state: executingState,
			dataKind: 'terminal',
			data: nextData,
		}), true);
		assert.strictEqual(shouldRerenderToolInvocationSubPart({
			state: executingState,
			dataKind: 'terminal',
			data: nextData,
		}, {
			state: executingState,
			dataKind: 'terminal',
			data: nextData,
		}), false);
		assert.strictEqual(shouldRerenderToolInvocationSubPart({
			state: executingState,
			dataKind: 'terminal',
			data: nextData,
		}, {
			state: { ...executingState },
			dataKind: 'terminal',
			data: nextData,
		}), true, 'an explicit same-type state notification must repaint mutated payloads');
		assert.strictEqual(shouldRerenderToolInvocationSubPart({
			state: executingState,
			dataKind: 'externalEdit',
			data: { file: 'before.ts' },
		}, {
			state: { ...executingState },
			dataKind: 'externalEdit',
			data: { file: 'after.ts' },
		}), false, 'same-kind edit payloads retain the original diff rendering lifecycle');
	});

	test('same-kind tool data replacement notifies live render observers', () => {
		const invocation = new ChatToolInvocation({
			invocationMessage: 'Running command',
			toolSpecificData: { kind: 'terminal', commandLine: { original: 'printf first' }, language: 'shellscript' },
		}, {
			id: 'test-terminal',
			displayName: 'Terminal',
			modelDescription: 'Runs a command',
			source: ToolDataSource.Internal,
		}, 'call-terminal', undefined, {}, {}, undefined);
		const observedCommands: string[] = [];
		store.add(autorun(reader => {
			invocation.toolSpecificDataKind.read(reader);
			if (invocation.toolSpecificData?.kind === 'terminal') {
				observedCommands.push(invocation.toolSpecificData.commandLine.original);
			}
		}));

		invocation.toolSpecificData = { kind: 'terminal', commandLine: { original: 'printf second' }, language: 'shellscript' };

		assert.deepStrictEqual(observedCommands, ['printf first', 'printf second']);
	});

	test('manual terminal disclosure choice prevents failure auto-expansion', () => {
		assert.strictEqual(shouldAutoExpandTerminalFailure(true, 1, false), true);
		assert.strictEqual(shouldAutoExpandTerminalFailure(true, 1, true), false);
		assert.strictEqual(shouldAutoExpandTerminalFailure(true, 0, false), false);
		assert.strictEqual(shouldAutoExpandTerminalFailure(true, undefined, false), false);
		assert.strictEqual(shouldAutoExpandTerminalFailure(false, 1, false), false);
	});

	test('completed restored commands render stored output before stale live handles', () => {
		assert.strictEqual(shouldRenderStoredTerminalOutputFirst(true, true), true);
		assert.strictEqual(shouldRenderStoredTerminalOutputFirst(true, false), false, 'running commands keep their live mirror');
		assert.strictEqual(shouldRenderStoredTerminalOutputFirst(false, true), false);
	});

	test('restored terminal re-expansion preserves a real output height over stale zero metadata', () => {
		assert.strictEqual(resolveStoredTerminalOutputLineCount('first\nsecond\nthird', 0, undefined), 3);
		assert.strictEqual(resolveStoredTerminalOutputLineCount('first\nsecond\nthird', 0, 3), 3);
		assert.strictEqual(resolveStoredTerminalOutputLineCount('first\nsecond\nthird', 2, 8), 8);
	});

	test('fast command without data should not auto-expand (finishes before timeout)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Command finishes quickly (before timeout)
		onCommandFinished.fire(undefined);

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand for fast command without data');
	}));

	test('fast command with quick data should not auto-expand (data + finish before timeout)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Data arrives
		onWillData.fire('output');

		// Command finishes quickly (before timeout)
		onCommandFinished.fire(undefined);

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.DataEvent + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand when command finishes within timeout of first data');
	}));

	test('long-running command with data should auto-expand (data received, command still running after timeout)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = true; // Has real output
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Data arrives
		onWillData.fire('output');

		// Wait for timeout to fire (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.DataEvent + 100);

		assert.strictEqual(isExpanded, true, 'Should expand when command still running after first data timeout');

		onCommandFinished.fire(undefined);
	}));

	test('long-running command with data but no real output should NOT auto-expand (like sleep with shell sequences)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = false; // Shell integration sequences, not real output
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Shell integration data arrives (not real output)
		onWillData.fire('shell-sequence');

		// Wait for timeout to fire (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.DataEvent + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand when data is shell sequences, not real output');

		onCommandFinished.fire(undefined);
	}));

	test('long-running command without data should NOT auto-expand if no real output (like sleep)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = false; // No real output like `sleep 1`
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Wait for timeout to fire (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand when no real output even after timeout');

		onCommandFinished.fire(undefined);
	}));

	test('long-running command without data SHOULD auto-expand if real output exists', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = true; // Has real output in buffer
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Wait for timeout to fire (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, true, 'Should expand when real output exists after timeout');

		onCommandFinished.fire(undefined);
	}));

	test('data arriving after command finish should not trigger expand', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		setupAutoExpandLogic();

		// Command executes and finishes immediately
		onCommandExecuted.fire(undefined);
		onCommandFinished.fire(undefined);

		// Data arrives after command finished
		onWillData.fire('late output');

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand when data arrives after command finished');
	}));

	test('user toggled output prevents auto-expand', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		userToggledOutput = true;
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Data arrives
		onWillData.fire('output');

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, false, 'Should NOT expand when user has manually toggled output');
		onCommandFinished.fire(undefined);
	}));

	test('already expanded output prevents additional auto-expand', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		isExpanded = true;

		// Track if event was fired
		let eventFired = false;
		const autoExpand = store.add(new TerminalToolAutoExpand({
			onCommandExecuted: onCommandExecuted.event,
			onCommandFinished: onCommandFinished.event,
			onWillData: onWillData.event,
			shouldAutoExpand: () => !isExpanded && !userToggledOutput,
			hasRealOutput: () => hasRealOutputValue,
		}));
		store.add(autoExpand.onDidRequestExpand(() => {
			eventFired = true;
		}));

		// Command executes
		onCommandExecuted.fire(undefined);

		// Data arrives
		onWillData.fire('output');

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(eventFired, false, 'Should NOT fire expand event when already expanded');
		onCommandFinished.fire(undefined);
	}));

	test('data arriving cancels no-data timeout', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = true; // Would have expanded if no-data timeout fired
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Data arrives (cancels no-data timeout)
		onWillData.fire('output');

		// Command finishes immediately after data (before data timeout would fire)
		onCommandFinished.fire(undefined);

		// Wait past all timeouts (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.NoData + 100);

		assert.strictEqual(isExpanded, false, 'No-data timeout should be cancelled when data arrives');
	}));

	test('multiple data events only trigger one timeout', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		hasRealOutputValue = true; // Has real output
		setupAutoExpandLogic();

		// Command executes
		onCommandExecuted.fire(undefined);

		// Multiple data events
		onWillData.fire('output 1');
		onWillData.fire('output 2');
		onWillData.fire('output 3');

		// Wait for timeout to fire (faked timers advance instantly)
		await timeout(TerminalToolAutoExpandTimeout.DataEvent + 100);

		assert.strictEqual(isExpanded, true, 'Should expand exactly once after first data');
		onCommandFinished.fire(undefined);
	}));
});
