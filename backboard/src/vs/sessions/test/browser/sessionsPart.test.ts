/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { SessionsPart } from '../../browser/parts/sessionsPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { SessionsService } from '../../services/sessions/browser/sessionsService.js';
import { URI } from '../../../base/common/uri.js';
import { chatResourceNavigationRegistry } from '../../services/chatView/browser/chatResourceNavigationRegistry.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';
import { ISession, SessionStatus } from '../../services/sessions/common/session.js';

/**
 * A grid slot whose view records what the part asks of it, for tests that
 * call `SessionsPart` methods on a stand-in instance.
 */
function createTestSlot(name: string, boundSessionId: string | undefined, log: string[]) {
	return {
		boundSessionId,
		disposables: { dispose: () => log.push(`dispose ${name}`) },
		view: {
			name,
			sidePanel: undefined,
			openSession: (session: IActiveSession | undefined) => log.push(`${name} shows ${session?.sessionId ?? 'placeholder'}`),
			element: { classList: { toggle: () => undefined } },
			setActive: () => undefined,
			mountHeaderIntoPanel: () => undefined,
			mountHeaderIntoSplitHeader: () => undefined,
			restoreHeaderToView: () => undefined,
			setSplitHeaderVisible: () => undefined,
			setSidePanel: () => undefined,
			suspendLayout: () => undefined,
			resumeLayout: () => undefined,
		},
	};
}

function createTestSession(sessionId: string): IActiveSession {
	return { sessionId, isCreated: { get: () => true } } as unknown as IActiveSession;
}

/** A `SessionsPart` stand-in over the given slots, logging grid operations. */
function createTestGridPart(slots: ReturnType<typeof createTestSlot>[], log: string[]): SessionsPart {
	const name = (view: { name: string }) => view.name;
	const directionNames: Record<Direction, string> = { [Direction.Up]: 'Up', [Direction.Down]: 'Down', [Direction.Left]: 'Left', [Direction.Right]: 'Right' };
	let created = 0;
	return Object.assign(Object.create(SessionsPart.prototype), {
		_slots: slots,
		_gridWidget: {
			hasMaximizedView: () => false,
			getNeighborViews: () => [],
			addView: (view: { name: string }, _sizing: unknown, reference: { name: string }, direction: Direction) => log.push(`add ${name(view)} ${directionNames[direction]} of ${name(reference)}`),
			moveView: (view: { name: string }, _sizing: unknown, reference: { name: string }, direction: Direction) => log.push(`move ${name(view)} ${directionNames[direction]} of ${name(reference)}`),
			removeView: (view: { name: string }) => log.push(`remove ${name(view)}`),
		},
		_createSlot: () => createTestSlot(`new${++created}`, undefined, log),
		_newSessionViewOptions: () => ({}),
		_onDidUpdateGrid: { fire: () => undefined },
		_storeGridLayout: () => undefined,
		_updateContextKeys: () => undefined,
		_updateSubagentNavigationContext: () => undefined,
	});
}

suite('Sessions - Sessions Part', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts a grid layout while visibility state is still stale', () => {
		let layoutContentsArgs: readonly [number, number] | undefined;
		let gridLayoutArgs: readonly [number, number, number, number] | undefined;

		const part = {
			layoutService: {
				// Reproduces the Editor -> Simple ordering where the grid has made
				// the view visible but the layout service has not observed it yet.
				isVisible: (partId: string) => partId !== Parts.SESSIONS_PART,
			},
			layoutContents: (width: number, height: number) => {
				layoutContentsArgs = [width, height];
				return {
					contentSize: { width: width - 2, height: height - 2 },
				};
			},
			_gridWidget: {
				layout: (width: number, height: number, top: number, left: number) => {
					gridLayoutArgs = [width, height, top, left];
				},
			},
		};

		SessionsPart.prototype.layout.call(part as unknown as SessionsPart, 1200, 800, 0, 300);

		assert.deepStrictEqual(layoutContentsArgs, [1198, 798]);
		assert.deepStrictEqual(gridLayoutArgs, [1196, 796, 0, 300]);
	});

	test('clears relocated session headers when a draft replaces the active session', () => {
		let titleSlotClears = 0;
		let toolbarSlotClears = 0;
		let openedDraft = false;
		let restoredHeader = false;
		const slot = {
			boundSessionId: 'session-1' as string | undefined,
			view: {
				openSession: (session: undefined) => { openedDraft = session === undefined; },
				element: { classList: { toggle: () => undefined } },
				setActive: () => undefined,
				mountHeaderIntoPanel: () => undefined,
				restoreHeaderToView: () => { restoredHeader = true; },
			},
		};
		const part = Object.assign(Object.create(SessionsPart.prototype), {
			_gridWidget: { hasMaximizedView: () => false },
			_slots: [Object.assign(slot, { view: { ...slot.view, setSplitHeaderVisible: () => undefined, setSidePanel: () => undefined, suspendLayout: () => undefined, resumeLayout: () => undefined } })],
			_newSessionViewOptions: () => ({}),
			_headerSessionTitleSlot: { replaceChildren: () => { titleSlotClears++; } },
			_headerSessionToolbarSlot: { replaceChildren: () => { toolbarSlotClears++; } },
			_updateContextKeys: () => undefined,
			_updateSubagentNavigationContext: () => undefined,
		});

		SessionsPart.prototype.updateVisibleSessions.call(part as SessionsPart, [undefined], undefined);

		assert.strictEqual(openedDraft, true);
		assert.strictEqual(restoredHeader, true);
		assert.strictEqual(titleSlotClears, 1);
		assert.strictEqual(toolbarSlotClears, 1);
	});

	test('places a dropped session next to its target in the dropped direction', () => {
		const log: string[] = [];
		const part = createTestGridPart([createTestSlot('a', 'A', log)], log);

		part.setPendingPlacement({ sessionId: 'B', targetSessionId: 'A', direction: Direction.Down });
		part.updateVisibleSessions([createTestSession('A'), createTestSession('B')], undefined);

		assert.deepStrictEqual(log, ['add new1 Down of a', 'a shows A', 'new1 shows B']);
	});

	test('moves an already visible session to the dropped edge and keeps every cell', () => {
		const log: string[] = [];
		const part = createTestGridPart([createTestSlot('a', 'A', log), createTestSlot('b', 'B', log), createTestSlot('c', 'C', log)], log);

		part.setPendingPlacement({ sessionId: 'C', targetSessionId: 'A', direction: Direction.Up });
		part.updateVisibleSessions([createTestSession('C'), createTestSession('A'), createTestSession('B')], undefined);

		assert.deepStrictEqual(log, ['move c Up of a', 'c shows C', 'a shows A', 'b shows B']);
	});

	test('rebuilds the persisted split shape when restoring the same sessions', () => {
		const log: string[] = [];
		const part = Object.assign(createTestGridPart([createTestSlot('p', undefined, log)], log), {
			getMemento: () => ({ gridLayout: { split: 'h', cells: [{ split: 'v', cells: ['A', 'C'] }, { split: 'v', cells: ['B', 'D', 'gone'] }] } }),
		});

		part.updateVisibleSessions(['A', 'B', 'C', 'D'].map(createTestSession), undefined);

		assert.deepStrictEqual(log, ['add new1 Right of p', 'add new2 Down of p', 'add new3 Down of new1', 'p shows A', 'new1 shows B', 'new2 shows C', 'new3 shows D']);
	});

	test('opens a session in the cell of the session it replaces and removes unused cells', () => {
		const log: string[] = [];
		const part = createTestGridPart([createTestSlot('a', 'A', log), createTestSlot('b', 'B', log), createTestSlot('c', 'C', log)], log);

		part.updateVisibleSessions([createTestSession('A'), createTestSession('D')], undefined);

		assert.deepStrictEqual(log, ['remove c', 'dispose c', 'a shows A', 'b shows D']);
	});

	test('the chat grid lays out visible then recent chats 2×2, skipping drafts and archived ones', () => {
		const chat = (sessionId: string, status = SessionStatus.Completed, archived = false) => ({ sessionId, status: { get: () => status }, isArchived: { get: () => archived } }) as unknown as ISession;
		const calls: unknown[] = [];
		const service = {
			_cancelRestore: () => undefined,
			visibleSessions: { get: () => [chat('A')] },
			activeSession: { get: () => chat('A') },
			getRecentlyOpenedSessions: () => ({ recent: [chat('A'), chat('B'), chat('draft', SessionStatus.Untitled), chat('C')], other: [chat('old', SessionStatus.Completed, true), chat('D'), chat('E'), chat('F'), chat('G'), chat('H'), chat('I')] }),
			sessionsPartService: { setPendingLayout: (layout: unknown) => calls.push(layout) },
			_visibility: { restoreGrid: (slots: { session: ISession }[], activeIndex: number) => calls.push({ ids: slots.map(slot => slot.session.sessionId), activeIndex }) },
		};

		SessionsService.prototype.toggleSessionGrid.call(service as unknown as SessionsService);

		assert.deepStrictEqual(calls, [
			{ split: 'h', cells: [{ split: 'v', cells: ['A', 'C'] }, { split: 'v', cells: ['B', 'D'] }] },
			{ ids: ['A', 'B', 'C', 'D'], activeIndex: 0 },
		]);
	});

	test('the chat grid toggle returns to the active chat when several are visible', () => {
		const active = { sessionId: 'B' } as IActiveSession;
		const calls: unknown[] = [];
		const service = {
			_cancelRestore: () => undefined,
			visibleSessions: { get: () => [{ sessionId: 'A' }, active] },
			activeSession: { get: () => active },
			_visibility: { restoreGrid: (slots: { session: IActiveSession }[], activeIndex: number) => calls.push({ ids: slots.map(slot => slot.session.sessionId), activeIndex }) },
		};

		SessionsService.prototype.toggleSessionGrid.call(service as unknown as SessionsService);

		assert.deepStrictEqual(calls, [{ ids: ['B'], activeIndex: 0 }]);
	});

	test('Back returns to a parent chat before traversing session history', async () => {
		let sessionHistoryCalls = 0;
		const rootResource = URI.parse('chat-session://test/session-1');
		const service = {
			activeSession: { get: () => ({ sessionId: 'session-1', activeChat: { get: () => ({ resource: rootResource }) } }) },
			sessionsPartService: {
				getSessionView: () => ({ navigateBack: () => true }),
			},
			_navigation: {
				goBack: async () => { sessionHistoryCalls++; },
			},
		};

		await SessionsService.prototype.openPreviousSession.call(service as unknown as SessionsService);

		assert.strictEqual(sessionHistoryCalls, 0);
	});

	test('Back falls through to session history outside a subagent chat', async () => {
		let sessionHistoryCalls = 0;
		const rootResource = URI.parse('chat-session://test/session-1');
		const service = {
			activeSession: { get: () => ({ sessionId: 'session-1', activeChat: { get: () => ({ resource: rootResource }) } }) },
			sessionsPartService: {
				getSessionView: () => ({ navigateBack: () => false }),
			},
			_navigation: {
				goBack: async () => { sessionHistoryCalls++; },
			},
		};

		await SessionsService.prototype.openPreviousSession.call(service as unknown as SessionsService);

		assert.strictEqual(sessionHistoryCalls, 1);
	});

	test('Back returns through an Editor chat participant before the hidden SessionsPart', async () => {
		const rootResource = URI.parse('chat-session://test/session-1');
		let editorBackCalls = 0;
		let sessionViewBackCalls = 0;
		let sessionHistoryCalls = 0;
		const registration = chatResourceNavigationRegistry.registerParticipant({
			canHandleChatResource: resource => resource.toString() === rootResource.toString(),
			openChatResource: async () => false,
			navigateBack: async () => {
				editorBackCalls++;
				return true;
			},
		});
		const service = {
			activeSession: { get: () => ({ sessionId: 'session-1', activeChat: { get: () => ({ resource: rootResource }) } }) },
			sessionsPartService: {
				getSessionView: () => ({ navigateBack: () => { sessionViewBackCalls++; return true; } }),
			},
			_navigation: {
				goBack: async () => { sessionHistoryCalls++; },
			},
		};

		try {
			await SessionsService.prototype.openPreviousSession.call(service as unknown as SessionsService);
		} finally {
			registration.dispose();
		}

		assert.strictEqual(editorBackCalls, 1);
		assert.strictEqual(sessionViewBackCalls, 0);
		assert.strictEqual(sessionHistoryCalls, 0);
	});
});
