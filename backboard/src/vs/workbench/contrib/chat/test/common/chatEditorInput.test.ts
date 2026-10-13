/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatEditorInput } from '../../browser/widgetHosts/editor/chatEditorInput.js';
import { IChatModelReference, IChatService } from '../../common/chatService/chatService.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatModel } from '../../common/model/chatModel.js';

suite('ChatEditorInput model reference lifecycle', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const sessionResource = URI.from({ scheme: 'test-chat-session', authority: 'provider', path: '/session' });

	function createModel(requestInProgress = false, resource = sessionResource): {
		readonly model: IChatModel;
		readonly requestInProgress: ReturnType<typeof observableValue<boolean>>;
	} {
		const requestInProgressObservable = observableValue('requestInProgress', requestInProgress);
		const requestNeedsInput = observableValue('requestNeedsInput', undefined);
		const model = {
			sessionResource: resource,
			title: 'A persisted chat title',
			hasCustomTitle: true,
			hasRequests: true,
			requestInProgress: requestInProgressObservable,
			requestNeedsInput,
			editingSession: undefined,
			onDidChange: Event.None,
			dispose() { },
		} as Partial<IChatModel> as IChatModel;
		return { model, requestInProgress: requestInProgressObservable };
	}

	function createInput(
		acquire: () => Promise<IChatModelReference | undefined>,
		acquireExisting: () => IChatModelReference | undefined = () => undefined,
	): {
		readonly input: ChatEditorInput;
		readonly getAcquireCount: () => number;
	} {
		let acquireCount = 0;
		const chatService = new class extends mock<IChatService>() {
			override acquireOrLoadSession(_resource: URI, _location: ChatAgentLocation, _token: CancellationToken): Promise<IChatModelReference | undefined> {
				acquireCount++;
				return acquire();
			}

			override acquireExistingSession(): IChatModelReference | undefined {
				return acquireExisting();
			}

			override getSession(): IChatModel | undefined {
				return undefined;
			}

			override getSessionTitle(): string | undefined {
				return undefined;
			}
		};
		const chatSessionsService = new class extends mock<IChatSessionsService>() {
			override getChatSessionContribution(): undefined {
				return undefined;
			}
		};

		const input = disposables.add(new ChatEditorInput(
			sessionResource,
			{},
			chatService,
			new class extends mock<IDialogService>() { },
			new class extends mock<IConfigurationService>() { },
			chatSessionsService,
			new class extends mock<IInstantiationService>() { },
			disposables.add(new NullLogService()),
		));
		return { input, getAcquireCount: () => acquireCount };
	}

	function createReference(model: IChatModel): { readonly reference: IChatModelReference; readonly getDisposeCount: () => number } {
		let disposeCount = 0;
		return {
			reference: {
				object: model,
				dispose: () => disposeCount++,
			},
			getDisposeCount: () => disposeCount,
		};
	}

	test('marking an input active cancels its scheduled release', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const { model } = createModel();
			const { reference, getDisposeCount } = createReference(model);
			const { input } = createInput(async () => reference);
			await input.resolve();

			input.scheduleModelReferenceRelease(100);
			input.markModelReferenceActive();
			clock.tick(100);

			assert.strictEqual(getDisposeCount(), 0);
			assert.strictEqual(input.needsModelRestore, false);
		} finally {
			clock.restore();
		}
	});

	test('a cold input releases its model reference and preserves its title', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const { model } = createModel();
			const { reference, getDisposeCount } = createReference(model);
			const { input } = createInput(async () => reference);
			await input.resolve();

			input.scheduleModelReferenceRelease(0);
			clock.tick(0);

			assert.strictEqual(getDisposeCount(), 1);
			assert.strictEqual(input.needsModelRestore, true);
			assert.strictEqual(input.getName(), 'A persisted chat title');
		} finally {
			clock.restore();
		}
	});

	test('a busy input retries release without relying on model change events', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const { model, requestInProgress } = createModel(true);
			const { reference, getDisposeCount } = createReference(model);
			const { input } = createInput(async () => reference);
			await input.resolve();

			input.scheduleModelReferenceRelease(0);
			clock.tick(0);
			assert.strictEqual(getDisposeCount(), 0);

			requestInProgress.set(false, undefined);
			clock.tick(4_999);
			assert.strictEqual(getDisposeCount(), 0);
			clock.tick(1);
			assert.strictEqual(getDisposeCount(), 1);
			assert.strictEqual(input.needsModelRestore, true);
		} finally {
			clock.restore();
		}
	});

	test('concurrent resolves share one acquisition and pending cold release still completes', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const { model } = createModel();
			const { reference, getDisposeCount } = createReference(model);
			const deferredReference = new DeferredPromise<IChatModelReference | undefined>();
			const { input, getAcquireCount } = createInput(() => deferredReference.p);

			const firstResolve = input.resolve();
			const secondResolve = input.resolve();
			input.scheduleModelReferenceRelease(0);
			clock.tick(0);
			assert.strictEqual(getAcquireCount(), 1);

			deferredReference.complete(reference);
			const [firstModel, secondModel] = await Promise.all([firstResolve, secondResolve]);
			assert.strictEqual(firstModel, secondModel);
			clock.tick(5_000);

			assert.strictEqual(getDisposeCount(), 1);
			assert.strictEqual(input.needsModelRestore, true);
		} finally {
			clock.restore();
		}
	});

	test('a reference returned after input disposal is disposed immediately', async () => {
		const { model } = createModel();
		const { reference, getDisposeCount } = createReference(model);
		const deferredReference = new DeferredPromise<IChatModelReference | undefined>();
		const { input } = createInput(() => deferredReference.p);

		const resolvePromise = input.resolve();
		input.dispose();
		deferredReference.complete(reference);

		assert.strictEqual(await resolvePromise, null);
		assert.strictEqual(getDisposeCount(), 1);
	});

	test('a pending resolve cannot overwrite a newer updateModel reference', async () => {
		const newerResource = URI.from({ scheme: 'test-chat-session', authority: 'provider', path: '/newer-session' });
		const { model: staleModel } = createModel();
		const { model: newerModel } = createModel(false, newerResource);
		const stale = createReference(staleModel);
		const newer = createReference(newerModel);
		const deferredReference = new DeferredPromise<IChatModelReference | undefined>();
		const { input } = createInput(() => deferredReference.p, () => newer.reference);

		const resolvePromise = input.resolve();
		input.updateModel(newerModel);
		deferredReference.complete(stale.reference);

		const resolved = await resolvePromise;
		assert.strictEqual(resolved?.model, newerModel);
		assert.strictEqual(input.sessionResource?.toString(), newerResource.toString());
		assert.strictEqual(stale.getDisposeCount(), 1);
		assert.strictEqual(newer.getDisposeCount(), 0);
	});
});
