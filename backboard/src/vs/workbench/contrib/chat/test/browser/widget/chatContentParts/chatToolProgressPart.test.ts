/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { IRenderedMarkdown, MarkdownRenderOptions, renderAsPlaintext } from '../../../../../../../base/browser/markdownRenderer.js';
import { IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { IChatMarkdownAnchorService } from '../../../../browser/widget/chatContentParts/chatMarkdownAnchorService.js';
import { IChatContentPartRenderContext, InlineTextModelCollection } from '../../../../browser/widget/chatContentParts/chatContentParts.js';
import { ChatProgressContentPart, ChatWorkingProgressContentPart } from '../../../../browser/widget/chatContentParts/chatProgressContentPart.js';
import { ChatToolInvocationPart } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import { ChatToolProgressSubPart } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolProgressPart.js';
import { ChatToolStreamingSubPart, formatStreamingToolInput } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolStreamingSubPart.js';
import { isMcpToolInvocation } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolPartUtilities.js';
import { DiffEditorPool, EditorPool } from '../../../../browser/widget/chatContentParts/chatContentCodePools.js';
import { CollapsibleListPool } from '../../../../browser/widget/chatContentParts/chatReferencesContentPart.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { ChatToolInvocation } from '../../../../common/model/chatProgressTypes/chatToolInvocation.js';
import { IChatResponseViewModel, IChatWorkingProgress } from '../../../../common/model/chatViewModel.js';
import { IChatTodoListService } from '../../../../common/tools/chatTodoListService.js';
import { ILanguageModelToolsService, ToolDataSource, type ToolDataSource as ToolDataSourceType } from '../../../../common/tools/languageModelToolsService.js';

suite('ChatToolProgressSubPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let mockMarkdownRenderer: IMarkdownRenderer;
	let mockAnchorService: IChatMarkdownAnchorService;
	let mockHoverService: IHoverService;
	let mockConfigurationService: TestConfigurationService;
	let mockEditorPool: EditorPool;

	function createRenderContext(isComplete: boolean = false): IChatContentPartRenderContext {
		const mockElement: Partial<IChatResponseViewModel> = {
			isComplete,
			id: 'test-response-id',
			sessionResource: URI.parse('chat-session://test/session1'),
			setVote: () => { },
			get model() { return {} as IChatResponseViewModel['model']; }
		};

		return {
			element: mockElement as IChatResponseViewModel,
			inlineTextModels: {} as InlineTextModelCollection,
			elementIndex: 0,
			container: mainWindow.document.createElement('div'),
			content: [],
			contentIndex: 0,
			editorPool: mockEditorPool,
			codeBlockStartIndex: 0,
			treeStartIndex: 0,
			diffEditorPool: {} as DiffEditorPool,
			currentWidth: observableValue('currentWidth', 500),
			onDidChangeVisibility: Event.None
		};
	}

	function createSerializedToolInvocation(options: {
		source?: ToolDataSourceType;
		toolId?: string;
		isComplete?: boolean;
		invocationMessage?: string;
	} = {}): IChatToolInvocationSerialized {
		return {
			presentation: undefined,
			toolSpecificData: undefined,
			originMessage: undefined,
			invocationMessage: options.invocationMessage ?? 'Running tool...',
			pastTenseMessage: undefined,
			resultDetails: undefined,
			isConfirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
			isComplete: options.isComplete ?? false,
			toolCallId: 'tool-call-id',
			toolId: options.toolId ?? 'test_tool',
			source: options.source,
			kind: 'toolInvocationSerialized'
		};
	}

	function createToolInvocation(options: {
		source?: ToolDataSourceType;
		toolId?: string;
		invocationMessage?: string;
		progressMessage?: string;
	} = {}): IChatToolInvocation {
		const source = options.source ?? ToolDataSource.Internal;
		const toolId = options.toolId ?? 'test_tool';
		return {
			presentation: undefined,
			toolSpecificData: undefined,
			originMessage: undefined,
			invocationMessage: options.invocationMessage ?? 'Running tool...',
			pastTenseMessage: undefined,
			source,
			toolId,
			toolCallId: 'live-tool-call-id',
			state: observableValue('state', {
				type: IChatToolInvocation.StateKind.Executing,
				parameters: undefined,
				confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
				progress: observableValue('progress', { message: options.progressMessage, progress: undefined })
			}),
			toolSpecificDataKind: observableValue('test', undefined),
			isAttachedToThinking: false,
			kind: 'toolInvocation',
			toJSON: () => createSerializedToolInvocation({ source, toolId, invocationMessage: options.invocationMessage })
		};
	}

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiationService = workbenchInstantiationService(undefined, store);

		mockConfigurationService = new TestConfigurationService();
		instantiationService.stub(IConfigurationService, mockConfigurationService);
		instantiationService.stub(ILanguageModelToolsService, {
			_serviceBrand: undefined,
			onDidPrepareToolCallBecomeUnresponsive: Event.None,
		} as unknown as ILanguageModelToolsService);
		instantiationService.stub(IChatTodoListService, {
			_serviceBrand: undefined,
			onDidUpdateTodos: Event.None,
			getTodos: () => [],
			setTodos: () => { },
			migrateTodos: () => { },
		});

		mockMarkdownRenderer = {
			render: (markdown: IMarkdownString, _options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown => {
				const element = outElement ?? mainWindow.document.createElement('div');
				const content = typeof markdown === 'string' ? markdown : renderAsPlaintext(markdown);
				element.textContent = content;
				return {
					element,
					dispose: () => { }
				};
			}
		};

		mockAnchorService = {
			_serviceBrand: undefined,
			register: () => ({ dispose: () => { } }),
			lastFocusedAnchor: undefined
		};
		instantiationService.stub(IChatMarkdownAnchorService, mockAnchorService);

		mockHoverService = {
			_serviceBrand: undefined,
			showHover: () => undefined,
			showDelayedHover: () => undefined,
			showAndFocusLastHover: () => { },
			hideHover: () => { },
			setupDelayedHover: () => ({ dispose: () => { } }),
			setupManagedHover: () => ({ dispose: () => { }, show: () => { }, hide: () => { }, update: () => { } }),
			showManagedHover: () => undefined,
			isHovered: () => false,
		} as unknown as IHoverService;
		instantiationService.stub(IHoverService, mockHoverService);

		mockEditorPool = {} as EditorPool;
	});

	teardown(() => {
		disposables.dispose();
	});

	test('detects MCP tool invocations for live and serialized rows', () => {
		const mcpSource: ToolDataSourceType = {
			type: 'mcp',
			label: 'Weather MCP',
			serverLabel: 'Weather',
			instructions: undefined,
			collectionId: 'collection',
			definitionId: 'definition'
		};

		const cases = [
			isMcpToolInvocation(createToolInvocation({ source: mcpSource })),
			isMcpToolInvocation(createSerializedToolInvocation({ source: undefined, toolId: 'mcp__weather' })),
			isMcpToolInvocation(createSerializedToolInvocation({ source: ToolDataSource.Internal, toolId: 'fetch_webpage' }))
		];

		assert.deepStrictEqual(cases, [true, true, false]);
	});

	test('stops the ring when an unchanged tool message completes while the response is still running', () => {
		const state = observableValue<IChatToolInvocation.State>('lifecycle', {
			type: IChatToolInvocation.StateKind.Executing,
			parameters: undefined,
			confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
			progress: observableValue('progress', { progress: undefined })
		});
		const invocation = { ...createToolInvocation({ invocationMessage: 'Discovering tests...' }), state };
		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart, invocation, createRenderContext(false), mockMarkdownRenderer, new Set<string>()
		));
		assert.ok(part.domNode.querySelector('.codicon-loading.codicon-modifier-spin'));
		state.set({
			type: IChatToolInvocation.StateKind.Completed,
			parameters: undefined,
			confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
			resultDetails: undefined,
			postConfirmed: undefined,
			contentForModel: []
		}, undefined);
		assert.strictEqual(part.domNode.querySelector('.codicon-modifier-spin'), null);
		assert.strictEqual(part.domNode.textContent, 'Discovering tests...');
		assert.ok(part.domNode.querySelector('.codicon-check'));
	});

	test('does not add shimmer styling for active MCP tool progress', () => {
		const mcpTool = createToolInvocation({
			source: {
				type: 'mcp',
				label: 'Weather MCP',
				serverLabel: 'Weather',
				instructions: undefined,
				collectionId: 'collection',
				definitionId: 'definition'
			},
			toolId: 'weather_lookup'
		});

		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			mcpTool,
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));

		assert.strictEqual(part.domNode.querySelector('.shimmer-progress'), null);
	});

	test('uses the same loading ring for question tool progress', () => {
		const askQuestionsTool = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			createToolInvocation({
				toolId: 'vscode_askQuestions',
				invocationMessage: 'Asking a question (Target)'
			}),
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));
		const askMultipleQuestionsTool = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			createToolInvocation({
				toolId: 'vscode_askQuestions',
				invocationMessage: 'Asking 3 questions (What should we work on?, Preferred area, How hands-on?)'
			}),
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));
		const analyzingAnswersTool = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			createToolInvocation({
				toolId: 'vscode_askQuestions',
				invocationMessage: 'Asking a question (Target)',
				progressMessage: 'Analyzing your answers...'
			}),
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));

		assert.deepStrictEqual([
			!!askQuestionsTool.domNode.querySelector('.shimmer-progress'),
			askQuestionsTool.domNode.querySelector('.chat-progress-shimmer-text')?.textContent,
			askQuestionsTool.domNode.textContent,
			askMultipleQuestionsTool.domNode.querySelector('.chat-progress-shimmer-text')?.textContent,
			askMultipleQuestionsTool.domNode.textContent,
			!!analyzingAnswersTool.domNode.querySelector('.shimmer-progress'),
			analyzingAnswersTool.domNode.querySelector('.chat-progress-shimmer-text')?.textContent
		], [false, undefined, 'Asking a question (Target)', undefined, 'Asking 3 questions (What should we work on?, Preferred area, How hands-on?)', false, undefined]);
	});

	test('streams the actual tool input into a live preview', () => {
		const partialInput = observableValue<unknown>('partialInput', undefined);
		const invocation: IChatToolInvocation = {
			...createToolInvocation({ invocationMessage: 'Generating Write input…', toolId: 'write' }),
			state: observableValue('streamingState', {
				type: IChatToolInvocation.StateKind.Streaming,
				partialInput,
				streamingMessage: observableValue('streamingMessage', 'Generating Write input…')
			})
		};
		const part = disposables.add(instantiationService.createInstance(
			ChatToolStreamingSubPart,
			invocation,
			createRenderContext(false),
			mockMarkdownRenderer,
		));

		assert.strictEqual(part.domNode.classList.contains('has-streaming-input'), false);
		partialInput.set('{"path":"cats.md","content":"# Cats', undefined);
		assert.strictEqual(part.domNode.querySelector('.chat-tool-streaming-input code')?.textContent, '{"path":"cats.md","content":"# Cats');
		assert.strictEqual(part.domNode.classList.contains('has-streaming-input'), true);
		assert.strictEqual(formatStreamingToolInput({ path: 'cats.md' }), '{\n  "path": "cats.md"\n}');
	});

	test('coalesces streamed input bursts without rerendering an unchanged status message', async () => {
		const partialInput = observableValue<unknown>('partialInput', undefined);
		const invocation: IChatToolInvocation = {
			...createToolInvocation({ invocationMessage: 'Generating Write input…', toolId: 'write' }),
			state: observableValue('streamingState', {
				type: IChatToolInvocation.StateKind.Streaming,
				partialInput,
				streamingMessage: observableValue('streamingMessage', 'Generating Write input…')
			})
		};
		let markdownRenderCount = 0;
		const countingRenderer: IMarkdownRenderer = {
			render: (markdown: IMarkdownString, options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown => {
				markdownRenderCount++;
				return mockMarkdownRenderer.render(markdown, options, outElement);
			}
		};
		const part = disposables.add(instantiationService.createInstance(
			ChatToolStreamingSubPart,
			invocation,
			createRenderContext(false),
			countingRenderer,
		));
		const initialMarkdownRenderCount = markdownRenderCount;

		for (let i = 1; i <= 250; i++) {
			partialInput.set(`{"path":"cats.md","content":"${'x'.repeat(i)}`, undefined);
		}

		assert.strictEqual(markdownRenderCount, initialMarkdownRenderCount, 'argument deltas must not reparse the unchanged status markdown');
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		assert.strictEqual(
			part.domNode.querySelector('.chat-tool-streaming-input code')?.textContent,
			`{"path":"cats.md","content":"${'x'.repeat(250)}`,
		);
	});

	test('keeps progress DOM stable across numeric ticks with an unchanged message', () => {
		const progress = observableValue('progress', { message: undefined, progress: undefined as number | undefined });
		const tool: IChatToolInvocation = {
			...createToolInvocation({ invocationMessage: 'Reading files…' }),
			state: observableValue('state', {
				type: IChatToolInvocation.StateKind.Executing,
				parameters: undefined,
				confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
				progress,
			}),
		};
		const state = tool.state.get();
		assert.strictEqual(state.type, IChatToolInvocation.StateKind.Executing);
		if (state.type !== IChatToolInvocation.StateKind.Executing) {
			return;
		}
		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			tool,
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>(),
		));
		const initialProgressNode = part.domNode.firstElementChild;

		for (let i = 1; i <= 250; i++) {
			progress.set({ message: undefined, progress: i / 250 }, undefined);
		}

		assert.strictEqual(part.domNode.firstElementChild, initialProgressNode);
	});

	test('does not mutate subpart codeblocks when merging MCP app codeblocks', () => {
		const baseCodeblock = { id: 'base' };
		const mcpCodeblock = { id: 'mcp' };
		const invocationPart = Object.create(ChatToolInvocationPart.prototype) as ChatToolInvocationPart;
		Reflect.set(invocationPart, 'subPart', { codeblocks: [baseCodeblock] });
		Reflect.set(invocationPart, 'mcpAppPart', { value: { codeblocks: [mcpCodeblock] } });

		const firstRead = invocationPart.codeblocks;
		const secondRead = invocationPart.codeblocks;

		assert.deepStrictEqual(firstRead, [baseCodeblock, mcpCodeblock]);
		assert.deepStrictEqual(secondRead, [baseCodeblock, mcpCodeblock]);
		assert.notStrictEqual(firstRead, secondRead);
		assert.deepStrictEqual(Reflect.get(invocationPart, 'subPart').codeblocks, [baseCodeblock]);
	});

	test('preserves core-tool disclosure state and focus across live payload rerenders', () => {
		const invocation = new ChatToolInvocation({
			invocationMessage: 'Reading file',
			toolSpecificData: {
				kind: 'coreTool',
				toolKind: 'read',
				input: { path: '/workspace/read.ts' },
				output: { content: 'first snapshot' },
			},
		}, {
			id: 'read',
			displayName: 'Read',
			modelDescription: 'Reads a file',
			source: ToolDataSource.Internal,
		}, 'call-read', undefined, {}, {}, undefined);
		const part = disposables.add(instantiationService.createInstance(
			ChatToolInvocationPart,
			invocation,
			createRenderContext(false),
			mockMarkdownRenderer,
			{} as CollapsibleListPool,
			{} as EditorPool,
			() => 500,
			undefined,
			0,
		));
		mainWindow.document.body.appendChild(part.domNode);
		disposables.add({ dispose: () => part.domNode.remove() });

		const firstDisclosure = part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header');
		assert.ok(firstDisclosure);
		firstDisclosure.click();
		firstDisclosure.focus();

		invocation.toolSpecificData = {
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/read.ts' },
			output: { content: 'second snapshot' },
		};
		const expandedDisclosure = part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header');
		const expandedDetails = part.domNode.querySelector<HTMLElement>('.chat-core-tool-card-details');
		assert.ok(expandedDisclosure);
		assert.notStrictEqual(expandedDisclosure, firstDisclosure);
		assert.deepStrictEqual({
			expanded: expandedDisclosure.ariaExpanded,
			detailsHidden: expandedDetails?.hidden,
			focused: mainWindow.document.activeElement === expandedDisclosure,
		}, {
			expanded: 'true',
			detailsHidden: false,
			focused: true,
		});

		expandedDisclosure.click();
		expandedDisclosure.focus();
		invocation.toolSpecificData = {
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/read.ts' },
			output: { content: 'third snapshot' },
		};
		const collapsedDisclosure = part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header');
		const collapsedDetails = part.domNode.querySelector<HTMLElement>('.chat-core-tool-card-details');
		assert.deepStrictEqual({
			expanded: collapsedDisclosure?.ariaExpanded,
			detailsHidden: collapsedDetails?.hidden,
			focused: mainWindow.document.activeElement === collapsedDisclosure,
		}, {
			expanded: 'false',
			detailsHidden: true,
			focused: true,
		});
	});

	test('keeps a clean-chat provider status visibly ticking during silent gaps', () => {
		const context = createRenderContext(false);
		context.container.classList.add('backboard-clean-chat');
		const part = disposables.add(instantiationService.createInstance(
			ChatProgressContentPart,
			{ kind: 'progressMessage', content: new MarkdownString('Working…') },
			mockMarkdownRenderer,
			context,
			true,
			true,
			undefined,
			undefined,
			true,
		));

		assert.strictEqual(part.domNode.querySelector('.chat-progress-elapsed'), null, 'Progress rows never show elapsed time');
	});

	test('shows Codex\'s Thinking placeholder for pending transcript work across rerenders', () => {
		const context = createRenderContext(false);
		context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
		const createPendingState = () => ({
			confirmationAdjustedTimestamp: observableValue('confirmationAdjustedTimestamp', Date.now() - 8_000),
			completionTokenCountObs: observableValue<number | undefined>('completionTokenCount', undefined),
			isComplete: false,
		});
		const progress: IChatWorkingProgress = { kind: 'working', state: createPendingState() };
		const part = disposables.add(instantiationService.createInstance(
			ChatWorkingProgressContentPart,
			progress,
			mockMarkdownRenderer,
			context,
		));

		assert.deepStrictEqual({
			cursorRow: part.domNode.classList.contains('chat-cursor-working-row'),
			label: part.domNode.querySelector('.chat-working-progress-step > p')?.textContent,
			stats: part.domNode.querySelector('.chat-working-progress-step > span')?.textContent,
			loading: !!part.domNode.querySelector('.codicon-loading.codicon-modifier-spin'),
			compactIndicator: !!part.domNode.querySelector('.chat-cursor-working-indicator'),
			placeholder: part.domNode.querySelector('.cx-thinking-placeholder')?.textContent,
			shimmer: part.domNode.classList.contains('shimmer-progress'),
			role: part.domNode.getAttribute('role'),
			live: part.domNode.getAttribute('aria-live'),
			atomic: part.domNode.getAttribute('aria-atomic'),
			reused: part.hasSameContent({ kind: 'working', state: createPendingState() }, [], context.element),
		}, {
			cursorRow: true,
			label: 'Thinking',
			stats: '',
			loading: false,
			compactIndicator: false,
			placeholder: 'ThinkingThinking',
			shimmer: false,
			role: 'status',
			live: 'polite',
			atomic: 'true',
			reused: true,
		});
	});

	test('uses the same loading ring for active provider progress', () => {
		const context = createRenderContext(false);
		context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
		const part = disposables.add(instantiationService.createInstance(
			ChatProgressContentPart,
			{ kind: 'progressMessage', content: new MarkdownString('Loading context…') },
			mockMarkdownRenderer,
			context,
			true,
			true,
			undefined,
			undefined,
			true,
		));

		assert.deepStrictEqual({
			compactRow: part.domNode.classList.contains('chat-cursor-progress-row'),
			compactIndicator: !!part.domNode.querySelector('.chat-cursor-working-indicator'),
			indicatorHiddenFromScreenReaders: part.domNode.querySelector('.codicon-loading')?.getAttribute('aria-hidden'),
			shimmer: part.domNode.classList.contains('shimmer-progress'),
			spinner: !!part.domNode.querySelector('.codicon-loading.codicon-modifier-spin'),
			status: part.domNode.textContent,
			role: part.domNode.getAttribute('role'),
			live: part.domNode.getAttribute('aria-live'),
		}, {
			compactRow: true,
			compactIndicator: false,
			indicatorHiddenFromScreenReaders: 'true',
			shimmer: false,
			spinner: true,
			status: 'Loading context…',
			role: 'status',
			live: 'polite',
		});
	});

	test('uses the same loading ring for active Playwright progress', () => {
		const tool = createToolInvocation({
			toolId: 'run_playwright_code',
			invocationMessage: 'Running Playwright code...'
		});

		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			tool,
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));

		assert.ok(part.domNode.querySelector('.codicon-loading.codicon-modifier-spin'));
	});

	test('does not add shimmer styling for non-MCP tool progress', () => {
		const tool = createSerializedToolInvocation({
			source: ToolDataSource.Internal,
			toolId: 'fetch_webpage'
		});

		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			tool,
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));

		assert.strictEqual(part.domNode.querySelector('.shimmer-progress'), null);
	});

	test('does not add shimmer styling for completed MCP tool progress', () => {
		const mcpTool = createSerializedToolInvocation({
			source: {
				type: 'mcp',
				label: 'Weather MCP',
				serverLabel: 'Weather',
				instructions: undefined,
				collectionId: 'collection',
				definitionId: 'definition'
			},
			toolId: 'weather_lookup'
		});

		const part = disposables.add(instantiationService.createInstance(
			ChatToolProgressSubPart,
			mcpTool,
			createRenderContext(false),
			mockMarkdownRenderer,
			new Set<string>()
		));

		assert.strictEqual(part.domNode.querySelector('.shimmer-progress'), null);
	});
});
