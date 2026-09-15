/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { MarkdownString } from '../../../base/common/htmlContent.js';
import { getOptimusActivityPreview, OptimusCard } from '../../browser/parts/optimusCard.js';
import { $, append, getWindow } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { mock } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { ISessionsProvidersService } from '../../../sessions/services/sessions/browser/sessionsProvidersService.js';
import { SessionView } from '../../../sessions/browser/parts/sessionView.js';
import { IChat, ISession, SessionStatus } from '../../../sessions/services/sessions/common/session.js';
import { IActiveSession, ISessionsChangeEvent, ISessionsManagementService } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { IBackboardAuthService } from '../../../workbench/contrib/chat/common/backboardAuth.js';
import { ChatListWidget } from '../../../workbench/contrib/chat/browser/widget/chatListWidget.js';
import { IChatService, IChatModelReference, IChatToolInvocationSerialized } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel, IChatResponseModel, IChatProgressResponseContent, IChatChangeEvent, ChatResponseModelChangeReason, IResponse, IChatRequestModel } from '../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatViewModel } from '../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { TestContextMenuService, TestLayoutService } from '../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../workbench/test/common/workbenchTestServices.js';
import { OptimusGridPart, OPTIMUS_CLOSE_SESSION_COMMAND_ID, OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_SHOW_DASHBOARD_COMMAND_ID } from '../../browser/parts/optimusGridPart.js';

/** Fail immediately if overview cards regress to owning heavyweight chat trees. */
class DashboardInstantiationService extends TestInstantiationService {
	protected override _getClassStub(ctor: Function): unknown {
		assert.ok(ctor !== ChatListWidget && ctor !== ChatViewModel, 'Dashboard must not instantiate chat renderers');
		return super._getClassStub(ctor);
	}
}

function createSession(index: number, status = SessionStatus.Completed) {
	const resource = URI.parse(`test:///agent-${index}`);
	const chat = new class extends mock<IChat>() {
		override readonly resource = resource;
	}();
	return new class extends mock<ISession>() {
		override readonly sessionId = `agent-${index}`;
		override readonly resource = resource;
		override readonly providerId = 'Codex';
		override readonly title = observableValue('title', `Task ${index}`);
		override readonly status = observableValue('status', status);
		override readonly createdAt = new Date(1000 + index);
		override readonly updatedAt = observableValue('updatedAt', new Date(1000 + index));
		override readonly workspace = constObservable(undefined);
		override readonly changes = constObservable([]);
		override readonly isArchived = observableValue('archived', false);
		override readonly isRead = constObservable(true);
		override readonly description = observableValue('description', undefined);
		override readonly mainChat = constObservable(chat);
	}();
}

suite('Optimus dashboard', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setupDashboard(count: number, statusForIndex = (_index: number) => SessionStatus.Completed, view = 'board', loadHistory: IChatService['acquireOrLoadSession'] = async () => undefined) {
		OptimusCard['activityCache'].clear();
		const sessions = Array.from({ length: count }, (_, index) => createSession(index, statusForIndex(index)));
		const storage = store.add(new TestStorageService());
		storage.store('optimus.openSessions', JSON.stringify(sessions.map(session => session.resource.toString())), StorageScope.PROFILE, StorageTarget.MACHINE);
		storage.store('optimus.viewMode', view, StorageScope.PROFILE, StorageTarget.USER);
		const instantiation = store.add(new DashboardInstantiationService());
		const commands: string[] = [];
		const created = store.add(new Emitter<IChatModel>());
		instantiation.stub(IThemeService, new TestThemeService());
		instantiation.stub(IStorageService, storage);
		instantiation.stub(IWorkbenchLayoutService, new TestLayoutService());
		instantiation.stub(ICommandService, { executeCommand: async id => { commands.push(id); } });
		instantiation.stub(IContextKeyService, new MockContextKeyService());
		instantiation.stub(IBackboardAuthService, { refresh: async () => undefined });
		instantiation.stub(IContextMenuService, new TestContextMenuService());
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ISessionsProvidersService, { getProvider: () => undefined });
		const changed = store.add(new Emitter<ISessionsChangeEvent>());
		instantiation.stub(ISessionsManagementService, { getSessions: () => sessions, onDidChangeSessions: changed.event });
		instantiation.stub(IChatService, {
			getSession: () => undefined,
			onDidCreateModel: created.event,
			acquireExistingSession: () => { throw new Error('Dashboard must not acquire sessions'); },
			acquireOrLoadSession: loadHistory,
		});
		const focusedElement = $('div');
		instantiation.stubInstance(SessionView, {
			element: focusedElement, setActive: () => { }, openSession: () => { },
			mountHeaderIntoPanel: () => { }, restoreHeaderToView: () => { }, layout: () => { }, focus: () => { }, dispose: () => { },
		});
		const container = append(mainWindow.document.body, $('.part.sessionspart'));
		container.style.width = '1200px';
		container.style.height = '700px';
		store.add(toDisposable(() => container.remove()));
		const part = store.add(instantiation.createInstance(OptimusGridPart));
		part.create(container);
		part.layout(1200, 700, 0, 0);
		return { part, container, sessions, instantiation, created, commands, changed, storage };
	}

	function createLiveModel(resource: URI) {
		const changes = store.add(new Emitter<IChatChangeEvent>());
		const disposed = store.add(new Emitter<void>());
		const responseChanges = store.add(new Emitter<ChatResponseModelChangeReason>());
		const parts: IChatProgressResponseContent[] = [{ kind: 'markdownContent', content: new MarkdownString('Initial output') }];
		const response = new class extends mock<IChatResponseModel>() {
			override readonly onDidChange = responseChanges.event;
			override readonly response = new class extends mock<IResponse>() { override readonly value = parts; }();
		}();
		const model = new class extends mock<IChatModel>() {
			override readonly sessionResource = resource;
			override readonly onDidChange = changes.event;
			override readonly onDidDispose = disposed.event;
			override get lastRequest() { return new class extends mock<IChatRequestModel>() { override readonly response = response; }(); }
		}();
		return { model, changes, disposed, responseChanges, parts };
	}

	test('Board uses nine lightweight cards or adding a placeholder page', () => {
		const { part, container, created, sessions } = setupDashboard(18);
		const live = createLiveModel(sessions[17].resource);
		created.fire(live.model);
		assert.strictEqual(live.responseChanges.hasListeners(), true);
		assert.strictEqual(part['cardEntries'].size, 9);
		container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')!.click();
		assert.deepStrictEqual({
			page: part['pageIndex'], live: part['cardEntries'].size, subscribed: live.responseChanges.hasListeners(),
			label: container.querySelector('.optimus-grid-pager-label')?.textContent,
			nextDisabled: container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')?.disabled,
			placeholder: part['placeholderCard']?.element.style.display,
		}, { page: 1, live: 9, subscribed: false, label: 'Page 2 of 2 · 18 agents', nextDisabled: true, placeholder: 'none' });
		assert.strictEqual(live.changes.hasListeners(), false);
	});

	test('late models for hidden pages are ignored; disposing an observed model releases listeners', () => {
		const { container, created, sessions } = setupDashboard(14);
		container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')!.click();
		const hidden = createLiveModel(sessions[13].resource);
		created.fire(hidden.model);
		assert.strictEqual(hidden.responseChanges.hasListeners(), false);
		const visible = createLiveModel(sessions[0].resource);
		created.fire(visible.model);
		assert.strictEqual(visible.responseChanges.hasListeners(), true);
		visible.disposed.fire();
		assert.strictEqual(visible.responseChanges.hasListeners(), false);
		assert.strictEqual(visible.changes.hasListeners(), false);
	});

	test('historical previews load two at a time, cancel on paging and release every reference', async () => {
		const pending: { resource: URI; token: CancellationToken; result: DeferredPromise<IChatModelReference | undefined> }[] = [];
		let loaded = 0;
		let released = 0;
		const { container } = setupDashboard(18, () => SessionStatus.Completed, 'board', (resource, _location, token) => {
			loaded++;
			const result = new DeferredPromise<IChatModelReference | undefined>();
			pending.push({ resource, token, result });
			return result.p;
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(pending.length, 2);
		container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')!.click();
		assert.ok(pending.every(item => item.token.isCancellationRequested));
		for (let batch = 0; batch < 8 && pending.length; batch++) {
			assert.ok(pending.length <= 2);
			for (const item of pending.splice(0)) {
				await item.result.complete({ object: createLiveModel(item.resource).model, dispose: () => { released++; } });
			}
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.deepStrictEqual({ loaded, released, previews: [...container.querySelectorAll('.optimus-card:not(.empty) .optimus-card-feed')].map(feed => feed.textContent) }, {
			loaded: 11, released: 11, previews: Array(9).fill('Initial output'),
		});
	});

	test('Kanban pages each lane independently and keeps empty lanes visible', () => {
		const { part, container } = setupDashboard(25, index => index < 21 ? SessionStatus.InProgress : SessionStatus.NeedsInput, 'kanban');
		const counts = () => [...container.querySelectorAll('.optimus-kanban-column-list')].map(lane => lane.childElementCount);
		assert.deepStrictEqual(counts(), [10, 4, 0]);
		container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')!.click();
		assert.deepStrictEqual({ page: part['pageIndex'], live: part['cardEntries'].size, counts: counts(), lanes: container.querySelectorAll('.optimus-kanban-column').length }, { page: 1, live: 10, counts: [10, 0, 0], lanes: 3 });
		part['filteredBuckets'].add('ready');
		part['resetPage']();
		assert.deepStrictEqual({ counts: counts(), display: getWindow(container).getComputedStyle(part['boardContainer']!).display }, { counts: [0, 0, 0], display: 'grid' });
	});

	test('focused sessions release all previews and updates cannot remount them', () => {
		const { part, sessions, created, changed, container, commands } = setupDashboard(87);
		container.querySelector<HTMLButtonElement>('.optimus-grid-pager button:last-child')!.click();
		const focused = Object.assign(new class extends mock<IActiveSession>() { }(), sessions[40], { activeChat: sessions[40].mainChat });
		part['showFocusedSession'](focused);
		changed.fire({ added: [], removed: [], changed: [] });
		part.updateVisibleSessions([focused], focused);
		part['refreshCards']();
		assert.deepStrictEqual({ live: part['cardEntries'].size, cards: part['cardEntries'].size, watchers: part['sessionWatches'].size, subscribed: created.hasListeners() }, { live: 0, cards: 0, watchers: 0, subscribed: false });
		container.querySelector<HTMLButtonElement>('.optimus-focused-dashboard-button')!.click();
		assert.strictEqual(commands.at(-1), OPTIMUS_SHOW_DASHBOARD_COMMAND_ID);
		part['showDashboardContent']();
		assert.deepStrictEqual({ live: part['cardEntries'].size, page: part['pageIndex'], focused: part.getSessionView(undefined) }, { live: 9, page: 1, focused: undefined });
	});

	test('filter removal, reset, and view changes return to page one and remember the view', () => {
		const { part, container, storage } = setupDashboard(87);
		part['pageIndex'] = 2;
		part['filteredProviders'].add('Codex');
		part['resetPage']();
		assert.strictEqual(part['pageIndex'], 0);
		part['pageIndex'] = 1;
		container.querySelector<HTMLButtonElement>('.optimus-dashboard-filter-chip')!.click();
		assert.strictEqual(part['pageIndex'], 0);
		part['pageIndex'] = 1;
		part['setViewMode']('kanban');
		assert.deepStrictEqual({ page: part['pageIndex'], stored: storage.get('optimus.viewMode', StorageScope.PROFILE), resetHidden: container.querySelector<HTMLButtonElement>('.optimus-dashboard-reset')!.hidden }, { page: 0, stored: 'kanban', resetHidden: true });
	});

	test('streaming timestamps do not reconcile the wall; metadata changes retain other cards', () => {
		const { part, sessions, container } = setupDashboard(360, () => SessionStatus.InProgress);
		const cards = [...part['cardEntries'].values()].map(entry => entry.card);
		const watches = [...part['sessionWatches'].values()];
		for (let token = 0; token < 100; token++) {
			sessions[359].updatedAt.set(new Date(10000 + token), undefined);
		}
		assert.strictEqual(part['sessionWatches'].size, 360);
		assert.strictEqual(part['refreshScheduler'].isScheduled(), false);
		sessions[359].title.set('Updated Task', undefined);
		assert.strictEqual(part['refreshScheduler'].isScheduled(), true);
		part['refreshScheduler'].cancel();
		part['refreshCards']();
		assert.deepStrictEqual({ sameCards: cards.every(card => [...part['cardEntries'].values()].some(entry => entry.card === card)), sameWatches: watches.every(watch => [...part['sessionWatches'].values()].includes(watch)), title: container.querySelector('.optimus-card-title')?.textContent }, { sameCards: true, sameWatches: true, title: 'Updated Task' });
	});

	test('streamed output is bounded and batched independently of other cards', async () => {
		const { part, container, sessions, created } = setupDashboard(2, () => SessionStatus.InProgress);
		const live = createLiveModel(sessions[1].resource);
		created.fire(live.model);
		const feeds = [...container.querySelectorAll('.optimus-card:not(.empty) .optimus-card-feed')];
		const other = feeds[1].textContent;
		for (let token = 0; token < 100; token++) {
			live.parts[0] = { kind: 'markdownContent', content: new MarkdownString('x'.repeat(5000) + token) };
			live.responseChanges.fire({ reason: 'other' });
		}
		assert.ok(!feeds[0].textContent?.endsWith('99'));
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.ok(feeds[0].textContent?.endsWith('99'));
		assert.ok(feeds[0].textContent!.length <= 1600);
		assert.strictEqual(feeds[1].textContent, other);
		assert.strictEqual(part['refreshScheduler'].isScheduled(), false);
	});

	test('activity extraction preserves recent assistant, working and tool text with a fixed budget', () => {
		const parts: IChatProgressResponseContent[] = [
			{ kind: 'markdownContent', content: new MarkdownString('old'.repeat(2000)) },
			{ kind: 'thinking', value: 'Checking the build', id: 'thinking' },
			new class extends mock<IChatToolInvocationSerialized>() {
				override readonly kind = 'toolInvocationSerialized';
				override readonly invocationMessage = 'Running tests';
			}(),
			{ kind: 'markdownContent', content: new MarkdownString('Latest result') },
		];
		const preview = getOptimusActivityPreview(parts);
		assert.ok(preview.length <= 1600);
		assert.ok(preview.endsWith('Checking the build\n\nTool: Running tests\n\nLatest result'));
	});

	test('card click and keyboard activation open the full session; close stays separate', () => {
		const { container, commands } = setupDashboard(1);
		const card = container.querySelector<HTMLElement>('.optimus-card:not(.empty)')!;
		card.querySelector<HTMLElement>('.optimus-card-feed')!.click();
		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		const close = card.querySelector<HTMLButtonElement>('.optimus-card-delete')!;
		close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		close.click();
		assert.deepStrictEqual(commands, [OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_FOCUS_SESSION_COMMAND_ID, OPTIMUS_CLOSE_SESSION_COMMAND_ID]);
	});

	test('Kanban keeps all three lanes visible as side panels shrink the workspace', async () => {
		const { part, container } = setupDashboard(9, index => [SessionStatus.InProgress, SessionStatus.NeedsInput, SessionStatus.Completed][index % 3], 'kanban');
		const board = container.querySelector<HTMLElement>('.optimus-kanban')!;
		for (const width of [1200, 640, 450, 1000]) {
			container.style.width = `${width}px`;
			part.layout(width, 700, 0, 0);
			await new Promise<void>(resolve => getWindow(container).requestAnimationFrame(() => resolve()));
			const bounds = board.getBoundingClientRect();
			const lanes = [...board.querySelectorAll<HTMLElement>('.optimus-kanban-column')].map(lane => lane.getBoundingClientRect());
			assert.strictEqual(lanes.length, 3);
			assert.ok(lanes.every(lane => lane.left >= bounds.left && lane.right <= bounds.right + 1), 'All lanes fit inside the available workspace');
			assert.ok(Math.abs(lanes[0].width - lanes[2].width) < 1, 'Lane widths stay equal');
			assert.ok(board.scrollWidth <= board.clientWidth + 1, 'No horizontal scrolling is needed');
		}
	});

	test('Board has three spaced columns and three rows, then adapts to two and one', async () => {
		const { part, container } = setupDashboard(9);
		assert.strictEqual(container.querySelector('.optimus-card-agent'), null);
		assert.strictEqual(getWindow(container).getComputedStyle(part['gridContainer']!.parentElement!).paddingTop, '0px');
		const grid = part['gridContainer']!;
		const cards = [...grid.querySelectorAll<HTMLElement>('.optimus-card:not(.empty)')];
		const first = cards[0].getBoundingClientRect();
		const second = cards[1].getBoundingClientRect();
		const nextRow = cards[3].getBoundingClientRect();
		assert.deepStrictEqual({ columns: getWindow(grid).getComputedStyle(grid).gridTemplateColumns.split(' ').length, horizontalGap: second.left - first.right, verticalGap: nextRow.top - first.bottom, rows: new Set(cards.map(card => card.offsetTop)).size, radius: getWindow(grid).getComputedStyle(cards[0]).borderRadius }, { columns: 3, horizontalGap: 8, verticalGap: 8, rows: 3, radius: '10px' });
		for (const height of [900, 1100, 700]) {
			container.style.height = `${height}px`;
			part.layout(1200, height, 0, 0);
			await new Promise<void>(resolve => getWindow(container).requestAnimationFrame(() => resolve()));
			const wall = grid.getBoundingClientRect();
			const card = cards[0].getBoundingClientRect();
			assert.ok(Math.abs(card.height * 3 + 32 - wall.height) < 2, 'Three equal rows fill the available height');
			assert.ok(Math.abs(cards[8].getBoundingClientRect().bottom + 8 - wall.bottom) < 2, 'No unused space below the ninth card');
		}
		for (const [width, columns] of [[750, 2], [400, 1]]) {
			container.style.width = `${width}px`;
			part.layout(width, 700, 0, 0);
			await new Promise<void>(resolve => getWindow(container).requestAnimationFrame(() => resolve()));
			assert.strictEqual(getWindow(grid).getComputedStyle(grid).gridTemplateColumns.split(' ').length, columns);
		}
	});
});
