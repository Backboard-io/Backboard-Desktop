/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { LineRange } from '../../../../../../../editor/common/core/ranges/lineRange.js';
import { DetailedLineRangeMapping } from '../../../../../../../editor/common/diff/rangeMapping.js';
import { IEditorWorkerService } from '../../../../../../../editor/common/services/editorWorker.js';
import { ITextModelService } from '../../../../../../../editor/common/services/resolverService.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatExternalEditContentPart, createBoundedDiffPreview, seedChatExternalEditRender } from '../../../../browser/widget/chatContentParts/chatExternalEditContentPart.js';
import { IChatExternalEdit } from '../../../../common/chatService/chatService.js';

suite('ChatExternalEditContentPart performance', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiationService = workbenchInstantiationService(undefined, store);
	});

	teardown(() => {
		disposables.dispose();
	});

	function createExactLineChange(originalStart: number, originalEndExclusive: number, modifiedStart: number, modifiedEndExclusive: number): DetailedLineRangeMapping {
		return new DetailedLineRangeMapping(
			new LineRange(originalStart, originalEndExclusive),
			new LineRange(modifiedStart, modifiedEndExclusive),
			undefined,
		);
	}

	async function waitFor(predicate: () => boolean, message: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) {
				return;
			}
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
		}
		assert.fail(message);
	}

	test('100k-line compact preview materializes only bounded rows without splitting full files', () => {
		const beforeContent = `${'same\n'.repeat(50_000)}old value\n${'tail\n'.repeat(50_000)}`;
		const afterContent = `${'same\n'.repeat(50_000)}new value\n${'tail\n'.repeat(50_000)}`;
		const originalSplit = String.prototype.split;
		let fullFileSplitCount = 0;
		const instrumentedSplit = function (this: string, separator: string | RegExp, limit?: number): string[] {
			const value = String(this);
			if ((value === beforeContent || value === afterContent) && separator === '\n') {
				fullFileSplitCount++;
			}
			return Reflect.apply(originalSplit, value, [separator, limit]) as string[];
		};
		Reflect.set(String.prototype, 'split', instrumentedSplit);

		try {
			const preview = createBoundedDiffPreview(beforeContent, afterContent, 8, 1);
			assert.strictEqual(fullFileSplitCount, 0, 'compact preview must not allocate full line arrays');
			assert.deepStrictEqual(preview, {
				rows: [
					{ kind: 'context', lineNumber: 50_000, text: 'same' },
					{ kind: 'removed', lineNumber: 50_001, text: 'old value' },
					{ kind: 'added', lineNumber: 50_001, text: 'new value' },
					{ kind: 'context', lineNumber: 50_002, text: 'tail' },
				],
				truncated: false,
			});
			assert.ok(preview.rows.length <= 8);
			assert.ok(preview.rows.reduce((length, row) => length + row.text.length, 0) < 100, 'only visible row strings should be materialized');
		} finally {
			Reflect.set(String.prototype, 'split', originalSplit);
		}
	});

	test('hundreds of deferred previews hydrate only cards reported near the viewport', async () => {
		interface IFakeObserverRecord {
			readonly callback: IntersectionObserverCallback;
			readonly observer: IntersectionObserver;
			target: Element | undefined;
			disconnected: boolean;
		}

		const observerRecords: IFakeObserverRecord[] = [];
		class FakeIntersectionObserver {
			readonly root = null;
			readonly rootMargin = '600px 0px';
			readonly thresholds = [0];
			private readonly record: IFakeObserverRecord;

			constructor(callback: IntersectionObserverCallback) {
				this.record = {
					callback,
					observer: this as unknown as IntersectionObserver,
					target: undefined,
					disconnected: false,
				};
				observerRecords.push(this.record);
			}

			disconnect(): void {
				this.record.disconnected = true;
			}

			observe(target: Element): void {
				this.record.target = target;
			}

			takeRecords(): IntersectionObserverEntry[] {
				return [];
			}

			unobserve(_target: Element): void { }
		}

		const intersectionObserverDescriptor = Object.getOwnPropertyDescriptor(mainWindow, 'IntersectionObserver');
		Object.defineProperty(mainWindow, 'IntersectionObserver', {
			configurable: true,
			writable: true,
			value: FakeIntersectionObserver,
		});
		disposables.add({
			dispose: () => {
				if (intersectionObserverDescriptor) {
					Object.defineProperty(mainWindow, 'IntersectionObserver', intersectionObserverDescriptor);
				} else {
					delete (mainWindow as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
				}
			},
		});

		let modelResolveCount = 0;
		let modelDisposeCount = 0;
		let workerDiffCount = 0;
		instantiationService.stub(ITextModelService, {
			_serviceBrand: undefined,
			createModelReference: async (resource: URI) => {
				modelResolveCount++;
				return {
					object: {
						textEditorModel: {
							uri: resource,
							getValue: () => resource.path.includes('/before/') ? 'const value = 1;' : 'const value = 2;',
						},
					},
					dispose: () => modelDisposeCount++,
				};
			},
		} as unknown as ITextModelService);
		instantiationService.stub(IEditorWorkerService, {
			_serviceBrand: undefined,
			computeDiff: async () => {
				workerDiffCount++;
				return null;
			},
		} as unknown as IEditorWorkerService);

		const partCount = 200;
		const parts: ChatExternalEditContentPart[] = [];
		for (let index = 0; index < partCount; index++) {
			const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, {
				kind: 'externalEdit',
				uri: URI.file(`/project/src/file-${index}.ts`),
				editKind: 'edit',
				diff: { added: 1, removed: 1 },
				beforeContentUri: URI.parse(`chat-edit://snapshot/before/file-${index}.ts`),
				afterContentUri: URI.parse(`chat-edit://snapshot/after/file-${index}.ts`),
			}));
			parts.push(part);
			part.showDiffPreview(true);
		}

		await Promise.resolve();
		assert.deepStrictEqual({
			observers: observerRecords.length,
			modelResolveCount,
			workerDiffCount,
			mountedBodies: parts.filter(part => !!part.domNode.querySelector('.chat-external-edit-diff-body')).length,
		}, {
			observers: partCount,
			modelResolveCount: 0,
			workerDiffCount: 0,
			mountedBodies: 0,
		});

		const visibleIndexes = [0, Math.floor(partCount / 2), partCount - 1];
		for (const index of visibleIndexes) {
			const record = observerRecords[index];
			assert.ok(record.target);
			record.callback([{
				isIntersecting: true,
				intersectionRatio: 1,
				target: record.target,
			} as IntersectionObserverEntry], record.observer);
		}

		await waitFor(
			() => visibleIndexes.every(index => parts[index].domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body')?.dataset.renderMode === 'preview'),
			'Near-viewport previews did not finish rendering',
		);
		assert.deepStrictEqual({
			modelResolveCount,
			modelDisposeCount,
			workerDiffCount,
			hydratedCards: parts.filter(part => part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body')?.dataset.renderMode === 'preview').length,
			maxRows: Math.max(...visibleIndexes.map(index => parts[index].domNode.querySelectorAll('.chat-external-edit-diff-row').length)),
			disconnectedVisibleObservers: visibleIndexes.filter(index => observerRecords[index].disconnected).length,
		}, {
			modelResolveCount: visibleIndexes.length * 2,
			modelDisposeCount: visibleIndexes.length * 2,
			workerDiffCount: 0,
			hydratedCards: visibleIndexes.length,
			maxRows: 2,
			disconnectedVisibleObservers: visibleIndexes.length,
		});

		for (const part of parts) {
			part.dispose();
		}
		assert.strictEqual(observerRecords.filter(record => record.disconnected).length, partCount, 'Disposal should disconnect every offscreen observer');
	});

	test('two-sided preview stays bounded and balanced while full diff computes once', async () => {
		const beforeUri = URI.parse('chat-edit://snapshot/before/replacement.ts');
		const afterUri = URI.parse('chat-edit://snapshot/after/replacement.ts');
		const beforeContent = [
			'const head1 = true;',
			'const head2 = true;',
			...Array.from({ length: 12 }, (_, index) => `const old${index + 1} = true;`),
			'const tail1 = true;',
			'const tail2 = true;',
		].join('\n');
		const afterContent = [
			'const head1 = true;',
			'const head2 = true;',
			...Array.from({ length: 12 }, (_, index) => `const next${index + 1} = true;`),
			'const tail1 = true;',
			'const tail2 = true;',
		].join('\n');
		const contentByUri = new Map<string, string>([
			[beforeUri.toString(), beforeContent],
			[afterUri.toString(), afterContent],
		]);
		let modelResolveCount = 0;
		let modelDisposeCount = 0;
		let workerDiffCount = 0;
		instantiationService.stub(ITextModelService, {
			_serviceBrand: undefined,
			createModelReference: async (resource: URI) => {
				modelResolveCount++;
				return {
					object: { textEditorModel: { uri: resource, getValue: () => contentByUri.get(resource.toString()) ?? '' } },
					dispose: () => modelDisposeCount++,
				};
			},
		} as unknown as ITextModelService);
		instantiationService.stub(IEditorWorkerService, {
			_serviceBrand: undefined,
			computeDiff: async () => {
				workerDiffCount++;
				return {
					changes: [createExactLineChange(3, 15, 3, 15)],
					identical: false,
					quitEarly: false,
					moves: [],
				};
			},
		} as unknown as IEditorWorkerService);

		const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, {
			kind: 'externalEdit',
			uri: URI.file('/project/src/replacement.ts'),
			editKind: 'edit',
			diff: { added: 12, removed: 12 },
			beforeContentUri: beforeUri,
			afterContentUri: afterUri,
		}));
		const cardIdentity = part.domNode;
		part.showDiffPreview();
		await waitFor(
			() => part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body')?.dataset.renderMode === 'preview',
			'Collapsed preview did not render',
		);
		const bodyIdentity = part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body');
		assert.ok(bodyIdentity);
		const initialKinds = Array.from(bodyIdentity.querySelectorAll<HTMLElement>('.chat-external-edit-diff-row')).map(row =>
			row.classList.contains('removed') ? 'removed' : row.classList.contains('added') ? 'added' : 'context');

		assert.deepStrictEqual({
			rows: initialKinds.length,
			removed: initialKinds.filter(kind => kind === 'removed').length,
			added: initialKinds.filter(kind => kind === 'added').length,
			context: initialKinds.filter(kind => kind === 'context').length,
			workerDiffCount,
			modelResolveCount,
			modelDisposeCount,
		}, {
			rows: 8,
			removed: 3,
			added: 3,
			context: 2,
			workerDiffCount: 0,
			modelResolveCount: 2,
			modelDisposeCount: 2,
		});

		part.expandDiffBody();
		await waitFor(() => bodyIdentity.dataset.renderMode === 'full', 'Full diff did not render');
		const fullRows = bodyIdentity.querySelectorAll('.chat-external-edit-diff-row').length;
		const expandControl = part.domNode.querySelector<HTMLElement>('.chat-external-edit-expand');
		assert.ok(expandControl);
		expandControl.click();
		await waitFor(() => bodyIdentity.dataset.renderMode === 'preview', 'Collapse did not release the full diff DOM');
		const collapsedKinds = Array.from(bodyIdentity.querySelectorAll<HTMLElement>('.chat-external-edit-diff-row')).map(row =>
			row.classList.contains('removed') ? 'removed' : row.classList.contains('added') ? 'added' : 'context');

		part.expandDiffBody();
		await waitFor(() => bodyIdentity.dataset.renderMode === 'full', 'Cached full diff did not reopen');
		assert.deepStrictEqual({
			cardIdentity: part.domNode === cardIdentity,
			bodyIdentity: part.domNode.querySelector('.chat-external-edit-diff-body') === bodyIdentity,
			fullRows,
			collapsedRows: collapsedKinds.length,
			collapsedRemoved: collapsedKinds.filter(kind => kind === 'removed').length,
			collapsedAdded: collapsedKinds.filter(kind => kind === 'added').length,
			reopenedRows: bodyIdentity.querySelectorAll('.chat-external-edit-diff-row').length,
			workerDiffCount,
			modelResolveCount,
			modelDisposeCount,
		}, {
			cardIdentity: true,
			bodyIdentity: true,
			fullRows: 28,
			collapsedRows: 8,
			collapsedRemoved: 3,
			collapsedAdded: 3,
			reopenedRows: 28,
			workerDiffCount: 1,
			modelResolveCount: 4,
			modelDisposeCount: 4,
		});
	});

	test('partial full-diff model resolution failure disposes the successful reference', async () => {
		const beforeUri = URI.parse('chat-edit://snapshot/before/partial-failure.ts');
		const afterUri = URI.parse('chat-edit://snapshot/after/partial-failure.ts');
		const edit: IChatExternalEdit = {
			kind: 'externalEdit',
			uri: URI.file('/project/src/partial-failure.ts'),
			editKind: 'edit',
			diff: { added: 1, removed: 1 },
			beforeContentUri: beforeUri,
			afterContentUri: afterUri,
		};
		seedChatExternalEditRender(edit, {
			beforeContent: 'const value = 1;',
			afterContent: 'const value = 2;',
		});

		let modelResolveCount = 0;
		let modelDisposeCount = 0;
		let workerDiffCount = 0;
		instantiationService.stub(ITextModelService, {
			_serviceBrand: undefined,
			createModelReference: async (resource: URI) => {
				modelResolveCount++;
				if (resource.toString() === afterUri.toString()) {
					throw new Error('after snapshot unavailable');
				}
				// The successful peer resolves after the rejection, not before it.
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
				return {
					object: { textEditorModel: { uri: resource, getValue: () => 'const value = 1;' } },
					dispose: () => modelDisposeCount++,
				};
			},
		} as unknown as ITextModelService);
		instantiationService.stub(IEditorWorkerService, {
			_serviceBrand: undefined,
			computeDiff: async () => {
				workerDiffCount++;
				return null;
			},
		} as unknown as IEditorWorkerService);

		const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, edit));
		part.showDiffPreview();
		await waitFor(
			() => part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body')?.dataset.renderMode === 'preview',
			'Seeded preview did not render',
		);
		const body = part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body');
		assert.ok(body);
		const previewRows = body.querySelectorAll('.chat-external-edit-diff-row').length;

		part.expandDiffBody();
		await waitFor(() => modelResolveCount === 2 && modelDisposeCount === 1, 'Successful peer model reference was not released after partial failure');
		assert.deepStrictEqual({
			modelResolveCount,
			modelDisposeCount,
			workerDiffCount,
			previewPreserved: body.querySelectorAll('.chat-external-edit-diff-row').length === previewRows,
			diffUnavailable: body.textContent?.includes('Diff unavailable'),
		}, {
			modelResolveCount: 2,
			modelDisposeCount: 1,
			workerDiffCount: 0,
			previewPreserved: true,
			diffUnavailable: false,
		});
	});

	for (const transient of [true, false]) {
		test(`snapshot failure ${transient ? 'recovers automatically' : 'stops retrying and supports explicit retry'}`, async () => {
			let attempts = 0;
			let disposed = 0;
			let available = false;
			instantiationService.stub(ITextModelService, {
				createModelReference: async (resource: URI) => {
					attempts++;
					if (!available && (!transient || attempts === 1)) {
						throw new Error('Snapshot provider unavailable');
					}
					return {
						object: { textEditorModel: { uri: resource, getValue: () => 'saved snapshot contents' } },
						dispose: () => disposed++,
					};
				},
			} as unknown as ITextModelService);
			const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, {
				kind: 'externalEdit',
				uri: URI.file('/project/new.json'),
				editKind: 'create',
				afterContentUri: URI.parse('chat-edit://snapshot/after/new.json'),
			}));
			part.showDiffPreview();
			if (!transient) {
				await waitFor(() => !!part.domNode.querySelector('.chat-external-edit-diff-retry'), 'Failed preview did not offer retry');
				assert.strictEqual(attempts, 2, 'Automatic retry must be bounded');
				available = true;
				part.domNode.querySelector<HTMLButtonElement>('.chat-external-edit-diff-retry')!.click();
			}
			await waitFor(() => !!part.domNode.querySelector('.chat-external-edit-diff-row.added'), 'Snapshot did not recover');
			assert.deepStrictEqual({
				attempts,
				disposed,
				text: part.domNode.querySelector('.chat-external-edit-diff-text')?.textContent,
				retryVisible: !!part.domNode.querySelector('.chat-external-edit-diff-retry'),
			}, { attempts: transient ? 2 : 3, disposed: 1, text: 'saved snapshot contents', retryVisible: false });
		});
	}

});
