/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ChatRequestQueueKind, IChatService } from '../../../common/chatService/chatService.js';
import { IChatViewModel } from '../../../common/model/chatViewModel.js';
import { ChatPendingDragController } from '../../../browser/widget/chatPendingDragAndDrop.js';

suite('ChatPendingDragController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createKeyboardEvent(key: string, code: string, keyCode: number): KeyboardEvent {
		const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
		// StandardKeyboardEvent reads the legacy browser keyCode. Synthetic DOM events leave it at 0.
		Object.defineProperty(event, 'keyCode', { get: () => keyCode });
		return event;
	}

	test('uses spinbutton semantics, owns activation keys, and reorders with arrows', () => {
		const store = new DisposableStore();

		try {
			const container = document.createElement('div');
			document.body.append(container);
			store.add({ dispose: () => container.remove() });

			const first = { id: 'first', messageText: 'First queued message', pendingKind: ChatRequestQueueKind.Queued } as any;
			const second = { id: 'second', messageText: 'Second queued message', pendingKind: ChatRequestQueueKind.Queued } as any;
			const third = { id: 'third', messageText: 'Third queued message', pendingKind: ChatRequestQueueKind.Queued } as any;
			const requestsById = new Map([first, second, third].map(request => [request.id, request]));
			const pendingRequests = [first, second, third].map(request => ({ request, kind: ChatRequestQueueKind.Queued }));
			let reordered: readonly { requestId: string; kind: ChatRequestQueueKind }[] | undefined;
			const viewModel = {
				sessionResource: URI.parse('chat-test://queue'),
				model: { getPendingRequests: () => pendingRequests },
			} as unknown as IChatViewModel;
			const chatService = {
				setPendingRequests: (_resource: URI, value: readonly { requestId: string; kind: ChatRequestQueueKind }[]) => {
					reordered = value;
					pendingRequests.splice(0, pendingRequests.length, ...value.map(item => ({ request: requestsById.get(item.requestId)!, kind: item.kind })));
				},
			} as unknown as IChatService;
			const controller = store.add(new ChatPendingDragController(container, () => viewModel, chatService));

			const row = document.createElement('div');
			const handle = document.createElement('span');
			row.append(handle);
			container.append(row);
			const handleDisposables = store.add(new DisposableStore());
			controller.attachDragHandle(first, handle, row, handleDisposables);

			assert.strictEqual(handle.getAttribute('role'), 'spinbutton');
			assert.strictEqual(handle.getAttribute('aria-valuenow'), '1');
			assert.strictEqual(handle.getAttribute('aria-valuemax'), '3');
			assert.strictEqual(handle.getAttribute('aria-valuetext'), 'Position 1 of 3');

			let rowActivationCount = 0;
			row.addEventListener('keydown', () => rowActivationCount++);
			const enter = createKeyboardEvent('Enter', 'Enter', 13);
			handle.dispatchEvent(enter);
			assert.strictEqual(enter.defaultPrevented, true);
			assert.strictEqual(rowActivationCount, 0);

			const arrowDown = createKeyboardEvent('ArrowDown', 'ArrowDown', 40);
			handle.dispatchEvent(arrowDown);
			assert.strictEqual(arrowDown.defaultPrevented, true);
			assert.strictEqual(rowActivationCount, 0);
			assert.deepStrictEqual(reordered, [
				{ requestId: 'second', kind: ChatRequestQueueKind.Queued },
				{ requestId: 'first', kind: ChatRequestQueueKind.Queued },
				{ requestId: 'third', kind: ChatRequestQueueKind.Queued },
			]);

			// Simulate the smart tree reattaching a shifted row after its position is
			// included in the diff identity. Its spinbutton metadata must be refreshed.
			const refreshedRow = document.createElement('div');
			const refreshedHandle = document.createElement('span');
			refreshedRow.append(refreshedHandle);
			container.append(refreshedRow);
			const refreshedDisposables = store.add(new DisposableStore());
			controller.attachDragHandle(first, refreshedHandle, refreshedRow, refreshedDisposables);
			assert.strictEqual(refreshedHandle.getAttribute('aria-valuenow'), '2');
			assert.strictEqual(refreshedHandle.getAttribute('aria-valuemax'), '3');
			assert.strictEqual(refreshedHandle.getAttribute('aria-valuetext'), 'Position 2 of 3');
		} finally {
			store.dispose();
		}
	});

	test('keeps system-generated requests fixed and outside the keyboard order', () => {
		const store = new DisposableStore();

		try {
			const container = document.createElement('div');
			document.body.append(container);
			store.add({ dispose: () => container.remove() });

			const first = { id: 'first', messageText: 'First user message', pendingKind: ChatRequestQueueKind.Steering } as any;
			const system = { id: 'system', messageText: 'Provider notification', pendingKind: ChatRequestQueueKind.Steering, isSystemInitiated: true } as any;
			const second = { id: 'second', messageText: 'Second user message', pendingKind: ChatRequestQueueKind.Steering } as any;
			const pendingRequests = [first, system, second].map(request => ({ request, kind: ChatRequestQueueKind.Steering }));
			let reordered: readonly { requestId: string; kind: ChatRequestQueueKind }[] | undefined;
			const viewModel = {
				sessionResource: URI.parse('chat-test://mixed-queue'),
				model: { getPendingRequests: () => pendingRequests },
			} as unknown as IChatViewModel;
			const chatService = {
				setPendingRequests: (_resource: URI, value: readonly { requestId: string; kind: ChatRequestQueueKind }[]) => reordered = value,
			} as unknown as IChatService;
			const controller = store.add(new ChatPendingDragController(container, () => viewModel, chatService));

			const row = document.createElement('div');
			const handle = document.createElement('span');
			row.append(handle);
			container.append(row);
			controller.attachDragHandle(first, handle, row, store.add(new DisposableStore()));

			assert.strictEqual(handle.getAttribute('aria-valuenow'), '1');
			assert.strictEqual(handle.getAttribute('aria-valuemax'), '2');
			assert.strictEqual(handle.getAttribute('aria-valuetext'), 'Position 1 of 2');

			handle.dispatchEvent(createKeyboardEvent('ArrowDown', 'ArrowDown', 40));
			assert.deepStrictEqual(reordered, [
				{ requestId: 'second', kind: ChatRequestQueueKind.Steering },
				{ requestId: 'system', kind: ChatRequestQueueKind.Steering },
				{ requestId: 'first', kind: ChatRequestQueueKind.Steering },
			]);
		} finally {
			store.dispose();
		}
	});
});
