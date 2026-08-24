/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { waitForState } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { assertType } from '../../../../../../base/common/types.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { assertThrowsAsync, ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EditOperation } from '../../../../../../editor/common/core/editOperation.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../../editor/common/languages.js';
import { IEditorWorkerService } from '../../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkbenchAssignmentService } from '../../../../../services/assignment/common/assignmentService.js';
import { NullWorkbenchAssignmentService } from '../../../../../services/assignment/test/common/nullAssignmentService.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { IWorkspaceEditingService } from '../../../../../services/workspaces/common/workspaceEditing.js';
import { TestWorkerService } from '../../../../inlineChat/test/browser/testWorkerService.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { TestMcpService } from '../../../../mcp/test/common/testMcpService.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService } from '../../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { NotebookTextModel } from '../../../../notebook/common/model/notebookTextModel.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatEditingService, ChatExternalEditHydrationQueue, ChatResponsePartAppendCursor } from '../../../browser/chatEditing/chatEditingServiceImpl.js';
import { ChatSessionsService } from '../../../browser/chatSessions/chatSessions.contribution.js';
import { ChatAgentService, IChatAgentData, IChatAgentImplementation, IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatEditingSessionState, IChatEditingService, IChatEditingSession, IStreamingEdits, ModifiedFileEntryState } from '../../../common/editing/chatEditingService.js';
import { ChatModel, IChatResponseModel, IChatTextEditGroup } from '../../../common/model/chatModel.js';
import { ChatAgentVoteDirection, IChatExternalEdit, IChatService } from '../../../common/chatService/chatService.js';
import { ChatService } from '../../../common/chatService/chatServiceImpl.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { IChatSlashCommandService } from '../../../common/participants/chatSlashCommands.js';
import { ChatTransferService, IChatTransferService } from '../../../common/model/chatTransferService.js';
import { IChatVariablesService } from '../../../common/attachments/chatVariables.js';
import { ChatAgentLocation, ChatModeKind } from '../../../common/constants.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { NullLanguageModelsService } from '../../common/languageModels.js';
import { MockChatVariablesService } from '../../common/mockChatVariables.js';
import { MockPromptsService } from '../../common/promptSyntax/service/mockPromptsService.js';
import { IChatDebugService } from '../../../common/chatDebugService.js';
import { ChatDebugServiceImpl } from '../../../common/chatDebugServiceImpl.js';

function getAgentData(id: string): IChatAgentData {
	return {
		name: id,
		id: id,
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionPublisherId: '',
		publisherDisplayName: '',
		extensionDisplayName: '',
		locations: [ChatAgentLocation.Chat],
		modes: [ChatModeKind.Ask],
		metadata: {},
		slashCommands: [],
		disambiguation: [],
	};
}

suite('ChatEditingService', function () {

	const store = new DisposableStore();
	let editingService: ChatEditingService;
	let chatService: IChatService;
	let textModelService: ITextModelService;

	setup(function () {
		const collection = new ServiceCollection();
		collection.set(IWorkbenchAssignmentService, new NullWorkbenchAssignmentService());
		collection.set(IChatAgentService, new SyncDescriptor(ChatAgentService));
		collection.set(IChatVariablesService, new MockChatVariablesService());
		collection.set(IChatSlashCommandService, new class extends mock<IChatSlashCommandService>() { });
		collection.set(IChatTransferService, new SyncDescriptor(ChatTransferService));
		collection.set(IChatSessionsService, new SyncDescriptor(ChatSessionsService));
		collection.set(IChatEditingService, new SyncDescriptor(ChatEditingService));
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(IChatService, new SyncDescriptor(ChatService));
		collection.set(IMcpService, new TestMcpService());
		collection.set(IPromptsService, new MockPromptsService());
		collection.set(ILanguageModelsService, new SyncDescriptor(NullLanguageModelsService));
		collection.set(IChatDebugService, new ChatDebugServiceImpl());
		collection.set(IMultiDiffSourceResolverService, new class extends mock<IMultiDiffSourceResolverService>() {
			override registerResolver(_resolver: IMultiDiffSourceResolver): IDisposable {
				return Disposable.None;
			}
		});
		collection.set(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override readonly onDidEnterWorkspace = Event.None;
		});
		collection.set(INotebookService, new class extends mock<INotebookService>() {
			override getNotebookTextModel(_uri: URI): NotebookTextModel | undefined {
				return undefined;
			}
			override hasSupportedNotebooks(_resource: URI): boolean {
				return false;
			}
		});
		const insta = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
		store.add(insta.get(IEditorWorkerService) as TestWorkerService);
		const value = insta.get(IChatEditingService);
		assert.ok(value instanceof ChatEditingService);
		editingService = value;

		chatService = insta.get(IChatService);

		store.add(insta.get(IChatSessionsService) as ChatSessionsService); // Needs to be disposed in between test runs to clear extensionPoint contribution
		store.add(chatService as ChatService);
		chatService.setSaveModelsEnabled(false);

		const chatAgentService = insta.get(IChatAgentService);

		const agent: IChatAgentImplementation = {
			async invoke(request, progress, history, token) {
				return {};
			},
		};
		store.add(chatAgentService.registerAgent('testAgent', { ...getAgentData('testAgent'), isDefault: true }));
		store.add(chatAgentService.registerAgentImplementation('testAgent', agent));

		textModelService = insta.get(ITextModelService);

		const modelService = insta.get(IModelService);

		store.add(textModelService.registerTextModelContentProvider('test', {
			async provideTextContent(resource) {
				return store.add(modelService.createModel(resource.path.repeat(10), null, resource, false));
			},
		}));
	});

	teardown(async () => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('create session', async function () {
		assert.ok(editingService);

		const modelRef = chatService.startNewLocalSession(ChatAgentLocation.EditorInline);
		const model = modelRef.object as ChatModel;
		const session = editingService.createEditingSession(model, true);

		assert.strictEqual(session.chatSessionResource.toString(), model.sessionResource.toString());
		assert.strictEqual(session.isGlobalEditingSession, true);

		await assertThrowsAsync(async () => {
			// DUPE not allowed
			editingService.createEditingSession(model);
		});

		session.dispose();
		modelRef.dispose();
	});

	test('response edit cursor scans only appended tool parts during long streams', function () {
		const cursor = new ChatResponsePartAppendCursor<object>();
		const parts: { kind: 'tool'; id: number }[] = Array.from({ length: 1_000 }, (_, id) => ({ kind: 'tool', id }));
		let inspectedParts = 0;
		let result = cursor.take(parts);
		inspectedParts += result.endIndex - result.startIndex;

		for (let id = 1_000; id < 1_500; id++) {
			parts.push({ kind: 'tool', id });
			result = cursor.take(parts);
			inspectedParts += result.endIndex - result.startIndex;
		}
		for (let event = 0; event < 500; event++) {
			result = cursor.take(parts);
			inspectedParts += result.endIndex - result.startIndex;
		}

		assert.deepStrictEqual({
			inspectedParts,
			lastEventStart: result.startIndex,
			lastEventEnd: result.endIndex,
			lastEventReset: result.didReset,
		}, {
			inspectedParts: 1_500,
			lastEventStart: 1_500,
			lastEventEnd: 1_500,
			lastEventReset: false,
		}, 'Repeated response state events must not turn the observer into a triangular full-history scan');

		const clonedPrefix = parts.map(part => ({ ...part }));
		result = cursor.take(clonedPrefix);
		assert.deepStrictEqual(result, { startIndex: 0, endIndex: 1_500, didReset: true }, 'A cloned response prefix should trigger one explicit rebuild');
		result = cursor.take(clonedPrefix.slice(0, 10));
		assert.deepStrictEqual(result, { startIndex: 10, endIndex: 10, didReset: true }, 'Truncation should preserve the surviving common prefix');
	});

	test('response prefix replacement keeps active edits incremental and truncation completes the stream', function () {
		const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		assertType(session, 'session not created');

		let startCount = 0;
		let pushCount = 0;
		let completeCount = 0;
		let startedInUndoStop: string | undefined;
		const stream: IStreamingEdits = {
			pushText: () => pushCount++,
			pushNotebookCellText: () => assert.fail('Unexpected notebook cell edit'),
			pushNotebook: () => assert.fail('Unexpected notebook edit'),
			complete: () => completeCount++,
		};
		const originalStartStreamingEdits = session.startStreamingEdits;
		session.startStreamingEdits = (_resource, _responseModel, inUndoStop) => {
			startCount++;
			startedInUndoStop = inUndoStop;
			return stream;
		};
		store.add(toDisposable(() => session.startStreamingEdits = originalStartStreamingEdits));

		const request = model.addRequest({ text: '', parts: [] }, { variables: [] }, 0);
		assertType(request.response);
		request.response.addUndoStop({ kind: 'undoStop', id: 'clone-stop' });
		const uri = URI.from({ scheme: 'test', path: 'cursor-clone.ts' });
		request.response.updateContent({
			kind: 'textEdit',
			uri,
			edits: [{ range: new Range(1, 1, 1, 1), text: 'first\n' }],
			done: false,
		});

		const mutableParts = request.response.response.value as unknown as IChatResponseModel['response']['value'][number][];
		const editIndex = mutableParts.findIndex(part => part.kind === 'textEditGroup');
		assert.ok(editIndex >= 0);
		const existingEdit = mutableParts[editIndex];
		assertType(existingEdit.kind === 'textEditGroup');
		mutableParts[editIndex] = {
			...existingEdit,
			edits: existingEdit.edits.map(batch => batch.slice()),
		} satisfies IChatTextEditGroup;
		request.response.setVote(ChatAgentVoteDirection.Up);

		assert.deepStrictEqual({ startCount, pushCount, completeCount, startedInUndoStop }, {
			startCount: 1,
			pushCount: 1,
			completeCount: 0,
			startedInUndoStop: 'clone-stop',
		}, 'Cloning the response prefix must transfer the active URI stream without replaying its edit batches');

		mutableParts.length = editIndex;
		request.response.setVote(ChatAgentVoteDirection.Down);
		assert.deepStrictEqual({ startCount, pushCount, completeCount }, {
			startCount: 1,
			pushCount: 1,
			completeCount: 1,
		}, 'Truncating away an active edit group must complete and release its stream');
	});

	test('cloned static response prefix does not replay workspace or external edits', async function () {
		const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		assertType(session, 'session not created');

		let workspaceApplications = 0;
		let externalHydrations = 0;
		const hydratableSession = session as IChatEditingSession & {
			hydrateExternalEdit(responseModel: IChatResponseModel, edit: IChatExternalEdit): Promise<void>;
		};
		const originalApplyWorkspaceEdit = session.applyWorkspaceEdit;
		const originalHydrateExternalEdit = hydratableSession.hydrateExternalEdit;
		session.applyWorkspaceEdit = () => workspaceApplications++;
		hydratableSession.hydrateExternalEdit = async () => { externalHydrations++; };
		store.add(toDisposable(() => {
			session.applyWorkspaceEdit = originalApplyWorkspaceEdit;
			hydratableSession.hydrateExternalEdit = originalHydrateExternalEdit;
		}));

		const request = model.addRequest({ text: '', parts: [] }, { variables: [] }, 0);
		assertType(request.response);
		const deletedUri = URI.file('/project/removed.ts');
		const externalUri = URI.file('/project/changed.ts');
		const externalEdit = {
			kind: 'externalEdit' as const,
			uri: externalUri,
			editKind: 'edit' as const,
			beforeContentUri: URI.parse('chat-edit://before/changed.ts'),
			afterContentUri: URI.parse('chat-edit://after/changed.ts'),
		};
		request.response.addUndoStop({ kind: 'undoStop', id: 'static-clone-stop' });
		request.response.updateContent({ kind: 'workspaceEdit', edits: [{ oldResource: deletedUri }] });
		request.response.updateContent(externalEdit);

		const waitForCounts = async (workspace: number, external: number) => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (workspaceApplications === workspace && externalHydrations === external) {
					return;
				}
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			assert.fail(`Timed out waiting for static edit counts ${workspace}/${external}; got ${workspaceApplications}/${externalHydrations}`);
		};
		await waitForCounts(1, 1);

		const mutableParts = request.response.response.value as unknown as IChatResponseModel['response']['value'][number][];
		for (let index = 0; index < mutableParts.length; index++) {
			const part = mutableParts[index];
			if (part.kind === 'workspaceEdit') {
				mutableParts[index] = { ...part, edits: part.edits.map(edit => ({ ...edit })) };
			} else if (part.kind === 'externalEdit') {
				mutableParts[index] = { ...part };
			} else if (part.kind === 'undoStop') {
				mutableParts[index] = { ...part };
			}
		}
		request.response.setVote(ChatAgentVoteDirection.Up);
		for (let attempt = 0; attempt < 10; attempt++) {
			await Promise.resolve();
		}
		assert.deepStrictEqual({ workspaceApplications, externalHydrations }, {
			workspaceApplications: 1,
			externalHydrations: 1,
		}, 'A structural clone should keep the same semantic occurrence keys');

		request.response.updateContent({ kind: 'workspaceEdit', edits: [{ oldResource: deletedUri }] });
		request.response.updateContent({ ...externalEdit });
		await waitForCounts(2, 2);
		assert.deepStrictEqual({ workspaceApplications, externalHydrations }, {
			workspaceApplications: 2,
			externalHydrations: 2,
		}, 'A genuinely repeated identical edit should receive a new occurrence key');
	});

	test('external edit hydration is capped at two and drains after response completion', async function () {
		const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		assertType(session, 'session not created');

		type HydratableSession = {
			hydrateExternalEdit(responseModel: IChatResponseModel, edit: IChatExternalEdit): Promise<void>;
		};
		const hydratableSession = session as unknown as HydratableSession;
		const originalHydrateExternalEdit = hydratableSession.hydrateExternalEdit;
		const releaseHydration = new DeferredPromise<void>();
		let hydrationCalls = 0;
		let activeHydrations = 0;
		let maxActiveHydrations = 0;
		const hydratedUris: string[] = [];
		hydratableSession.hydrateExternalEdit = async (_responseModel, edit) => {
			hydrationCalls++;
			hydratedUris.push(edit.uri.path);
			activeHydrations++;
			maxActiveHydrations = Math.max(maxActiveHydrations, activeHydrations);
			await releaseHydration.p;
			activeHydrations--;
		};
		store.add(toDisposable(() => hydratableSession.hydrateExternalEdit = originalHydrateExternalEdit));

		const request = model.addRequest({ text: '', parts: [] }, { variables: [] }, 0);
		assertType(request.response);
		const editCount = 120;
		for (const path of ['/project/src/.!13356!level.js', '/project/src/XXhU77d6', '/project/src/main.js.tmp']) {
			request.response.updateContent({
				kind: 'externalEdit',
				uri: URI.file(path),
				editKind: 'delete',
				beforeContentUri: URI.parse(`chat-edit://before${path}`),
				afterContentUri: URI.parse(`chat-edit://after${path}`),
			});
		}
		for (let index = 0; index < editCount; index++) {
			request.response.updateContent({
				kind: 'externalEdit',
				uri: URI.file(`/project/file-${index}.ts`),
				editKind: 'edit',
				beforeContentUri: URI.parse(`chat-edit://before/file-${index}.ts`),
				afterContentUri: URI.parse(`chat-edit://after/file-${index}.ts`),
			});
		}

		const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
			for (let attempt = 0; attempt < 200; attempt++) {
				if (predicate()) {
					return;
				}
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			assert.fail(message);
		};
		await waitFor(() => hydrationCalls === 2, 'The first bounded hydration pair did not start');
		assert.deepStrictEqual({ hydrationCalls, activeHydrations, maxActiveHydrations }, {
			hydrationCalls: 2,
			activeHydrations: 2,
			maxActiveHydrations: 2,
		});

		request.response.complete();
		releaseHydration.complete();
		await waitFor(() => hydrationCalls === editCount && activeHydrations === 0, 'The hydration queue did not drain after response completion');
		assert.deepStrictEqual({ hydrationCalls, activeHydrations, maxActiveHydrations }, {
			hydrationCalls: editCount,
			activeHydrations: 0,
			maxActiveHydrations: 2,
		});
		assert.deepStrictEqual(hydratedUris.length, editCount, 'Transient atomic-save rows must not consume hydration work');
		assert.ok(hydratedUris.every(uri => uri.startsWith('/project/file-')), 'Only renderable external edits should reach the hydration queue');
	});

	test('disposing the external hydration queue drops pending work', async function () {
		const releaseHydration = new DeferredPromise<void>();
		let started = 0;
		const errors: unknown[] = [];
		const queue = store.add(new ChatExternalEditHydrationQueue(error => errors.push(error)));
		for (let index = 0; index < 20; index++) {
			queue.enqueue(async () => {
				started++;
				await releaseHydration.p;
			});
		}
		for (let attempt = 0; attempt < 20 && started < 2; attempt++) {
			await Promise.resolve();
		}
		assert.deepStrictEqual({ started, active: queue.activeTaskCount, pending: queue.pendingTaskCount }, {
			started: 2,
			active: 2,
			pending: 18,
		});

		queue.dispose();
		releaseHydration.complete();
		for (let attempt = 0; attempt < 10; attempt++) {
			await Promise.resolve();
		}
		assert.deepStrictEqual({ started, pending: queue.pendingTaskCount, errors }, {
			started: 2,
			pending: 0,
			errors: [],
		}, 'Disposal should not launch queued file hydrations after the editing session is gone');
	});

	test('create session, file entry & isCurrentlyBeingModifiedBy', async function () {
		assert.ok(editingService);

		const uri = URI.from({ scheme: 'test', path: 'HelloWorld' });

		const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		if (!session) {
			assert.fail('session not created');
		}

		const chatRequest = model?.addRequest({ text: '', parts: [] }, { variables: [] }, 0);
		assertType(chatRequest.response);
		chatRequest.response.updateContent({ kind: 'textEdit', uri, edits: [], done: false });
		chatRequest.response.updateContent({ kind: 'textEdit', uri, edits: [{ range: new Range(1, 1, 1, 1), text: 'FarBoo\n' }], done: false });
		chatRequest.response.updateContent({ kind: 'textEdit', uri, edits: [], done: true });

		const entry = await waitForState(session.entries.map(value => value.find(a => isEqual(a.modifiedURI, uri))));

		assert.ok(isEqual(entry.modifiedURI, uri));

		await waitForState(entry.isCurrentlyBeingModifiedBy.map(value => value === chatRequest.response));
		assert.ok(entry.isCurrentlyBeingModifiedBy.get()?.responseModel === chatRequest.response);

		const unset = waitForState(entry.isCurrentlyBeingModifiedBy.map(res => res === undefined));

		chatRequest.response.complete();

		await unset;

		await entry.reject();
	});

	async function idleAfterEdit(session: IChatEditingSession, model: ChatModel, uri: URI, edits: TextEdit[]) {
		const isStreaming = waitForState(session.state.map(s => s === ChatEditingSessionState.StreamingEdits), Boolean);

		const chatRequest = model.addRequest({ text: '', parts: [] }, { variables: [] }, 0);
		assertType(chatRequest.response);

		chatRequest.response.updateContent({ kind: 'textEdit', uri, edits, done: true });

		const entry = await waitForState(session.entries.map(value => value.find(a => isEqual(a.modifiedURI, uri))));

		assert.ok(isEqual(entry.modifiedURI, uri));

		chatRequest.response.complete();

		await isStreaming;

		const isIdle = waitForState(session.state.map(s => s === ChatEditingSessionState.Idle), Boolean);
		await isIdle;

		return entry;
	}

	test('mirror typing outside -> accept', async function () {
		return runWithFakedTimers({}, async () => {
			assert.ok(editingService);

			const uri = URI.from({ scheme: 'test', path: 'abc\n' });

			const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
			const model = modelRef.object as ChatModel;
			const session = model.editingSession;
			assertType(session, 'session not created');

			const entry = await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'FarBoo\n' }]);
			const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
			const modified = store.add(await textModelService.createModelReference(entry.modifiedURI)).object.textEditorModel;

			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);

			assert.strictEqual(original.getValue(), 'abc\n'.repeat(10));
			assert.strictEqual(modified.getValue(), 'FarBoo\n' + 'abc\n'.repeat(10));

			modified.pushEditOperations(null, [EditOperation.insert(new Position(3, 1), 'USER_TYPE\n')], () => null);

			assert.ok(modified.getValue().includes('USER_TYPE'));
			assert.ok(original.getValue().includes('USER_TYPE'));

			await entry.accept();
			assert.strictEqual(modified.getValue(), original.getValue());
			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Accepted);

			assert.ok(modified.getValue().includes('FarBoo'));
			assert.ok(original.getValue().includes('FarBoo'));
		});
	});

	test('mirror typing outside -> reject', async function () {
		return runWithFakedTimers({}, async () => {
			assert.ok(editingService);

			const uri = URI.from({ scheme: 'test', path: 'abc\n' });

			const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
			const model = modelRef.object as ChatModel;
			const session = model.editingSession;
			assertType(session, 'session not created');

			const entry = await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'FarBoo\n' }]);
			const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
			const modified = store.add(await textModelService.createModelReference(entry.modifiedURI)).object.textEditorModel;

			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);

			assert.strictEqual(original.getValue(), 'abc\n'.repeat(10));
			assert.strictEqual(modified.getValue(), 'FarBoo\n' + 'abc\n'.repeat(10));

			modified.pushEditOperations(null, [EditOperation.insert(new Position(3, 1), 'USER_TYPE\n')], () => null);

			assert.ok(modified.getValue().includes('USER_TYPE'));
			assert.ok(original.getValue().includes('USER_TYPE'));

			await entry.reject();
			assert.strictEqual(modified.getValue(), original.getValue());
			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Rejected);

			assert.ok(!modified.getValue().includes('FarBoo'));
			assert.ok(!original.getValue().includes('FarBoo'));
		});
	});

	test('NO mirror typing inside -> accept', async function () {
		return runWithFakedTimers({}, async () => {
			assert.ok(editingService);

			const uri = URI.from({ scheme: 'test', path: 'abc\n' });

			const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
			const model = modelRef.object as ChatModel;
			const session = model.editingSession;
			assertType(session, 'session not created');

			const entry = await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'FarBoo\n' }]);
			const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
			const modified = store.add(await textModelService.createModelReference(entry.modifiedURI)).object.textEditorModel;

			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);

			assert.strictEqual(original.getValue(), 'abc\n'.repeat(10));
			assert.strictEqual(modified.getValue(), 'FarBoo\n' + 'abc\n'.repeat(10));

			modified.pushEditOperations(null, [EditOperation.replace(new Range(1, 2, 1, 7), 'ooBar')], () => null);

			assert.ok(modified.getValue().includes('FooBar'));
			assert.ok(!original.getValue().includes('FooBar')); // typed in the AI edits, DO NOT transpose

			await entry.accept();
			assert.strictEqual(modified.getValue(), original.getValue());
			assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Accepted);

			assert.ok(modified.getValue().includes('FooBar'));
			assert.ok(original.getValue().includes('FooBar'));
		});
	});

	test('ChatEditingService merges text edits it shouldn\'t merge, #272679', async function () {
		return runWithFakedTimers({}, async () => {
			assert.ok(editingService);

			const uri = URI.from({ scheme: 'test', path: 'abc' });

			const modified = store.add(await textModelService.createModelReference(uri)).object.textEditorModel;

			const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
			const model = modelRef.object as ChatModel;
			const session = model.editingSession;
			assertType(session, 'session not created');

			modified.setValue('');
			await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'a' }, { range: new Range(1, 1, 1, 1), text: 'b' }]);
			assert.strictEqual(modified.getValue(), 'ab');

			modified.setValue('');
			await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'a' }]);
			await idleAfterEdit(session, model, uri, [{ range: new Range(1, 1, 1, 1), text: 'b' }]);
			assert.strictEqual(modified.getValue(), 'ba');
		});
	});

});
