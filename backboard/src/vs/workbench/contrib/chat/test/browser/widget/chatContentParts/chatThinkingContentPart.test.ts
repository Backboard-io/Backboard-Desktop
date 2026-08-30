/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, addDisposableListener } from '../../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ChatThinkingContentPart, lastNonEmptyThinkingLine, maybePickFunWorkingMessage } from '../../../../browser/widget/chatContentParts/chatThinkingContentPart.js';
import { ChatExternalEditContentPart } from '../../../../browser/widget/chatContentParts/chatExternalEditContentPart.js';
import { ChatTextEditContentPart, ICodeCompareModelService, TextEditGroupHistoryIndex } from '../../../../browser/widget/chatContentParts/chatTextEditContentPart.js';
import { ChatTerminalThinkingCollapsibleWrapper, getCollapsedTerminalOutputPreview } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolProgressPart.js';
import { IChatExternalEdit, IChatMarkdownContent, IChatThinkingPart, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { IChatContentPartRenderContext, InlineTextModelCollection } from '../../../../browser/widget/chatContentParts/chatContentParts.js';
import { IChatRendererContent, IChatResponseViewModel } from '../../../../common/model/chatViewModel.js';
import { IEditSessionDiffStats } from '../../../../common/editing/chatEditingService.js';
import { IChatMarkdownAnchorService } from '../../../../browser/widget/chatContentParts/chatMarkdownAnchorService.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IRenderedMarkdown, MarkdownRenderOptions } from '../../../../../../../base/browser/markdownRenderer.js';
import { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { ChatConfiguration, ThinkingDisplayMode } from '../../../../common/constants.js';
import { EditorPool, DiffEditorPool } from '../../../../browser/widget/chatContentParts/chatContentCodePools.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { ToolDataSource } from '../../../../common/tools/languageModelToolsService.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { LineRange } from '../../../../../../../editor/common/core/ranges/lineRange.js';
import { DetailedLineRangeMapping } from '../../../../../../../editor/common/diff/rangeMapping.js';
import { IEditorWorkerService } from '../../../../../../../editor/common/services/editorWorker.js';
import { ITextModelService } from '../../../../../../../editor/common/services/resolverService.js';
import { IChatModel, IChatResponseModel, IChatTextEditGroup } from '../../../../common/model/chatModel.js';

suite('ChatThinkingContentPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let mockConfigurationService: TestConfigurationService;
	let mockMarkdownRenderer: IMarkdownRenderer;
	let mockAnchorService: IChatMarkdownAnchorService;
	let mockHoverService: IHoverService;
	let mockLanguageModelsService: ILanguageModelsService;

	function createMockRenderContext(isComplete: boolean = false): IChatContentPartRenderContext {
		const mockElement: Partial<IChatResponseViewModel> = {
			isComplete,
			id: 'test-response-id',
			sessionResource: URI.parse('chat-session://test/session1'),
			get model() { return {} as IChatResponseViewModel['model']; }
		};

		return {
			element: mockElement as IChatResponseViewModel,
			inlineTextModels: {} as InlineTextModelCollection,
			elementIndex: 0,
			container: mainWindow.document.createElement('div'),
			content: [],
			contentIndex: 0,
			editorPool: {} as EditorPool,
			codeBlockStartIndex: 0,
			treeStartIndex: 0,
			diffEditorPool: {} as DiffEditorPool,
			currentWidth: observableValue('currentWidth', 500),
			onDidChangeVisibility: Event.None
		};
	}

	function createThinkingPart(value?: string, id?: string): IChatThinkingPart {
		return {
			kind: 'thinking',
			value: value ?? '',
			id: id ?? 'test-thinking-id'
		};
	}

	function createExactLineChange(originalStart: number, originalEndExclusive: number, modifiedStart: number, modifiedEndExclusive: number): DetailedLineRangeMapping {
		return new DetailedLineRangeMapping(
			new LineRange(originalStart, originalEndExclusive),
			new LineRange(modifiedStart, modifiedEndExclusive),
			undefined,
		);
	}

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiationService = workbenchInstantiationService(undefined, store);

		mockConfigurationService = new TestConfigurationService();
		instantiationService.stub(IConfigurationService, mockConfigurationService);
		instantiationService.stub(IEditorWorkerService, {
			_serviceBrand: undefined,
			computeDiff: async () => null,
		} as unknown as IEditorWorkerService);

		// Create a mock markdown renderer
		mockMarkdownRenderer = {
			render: (_markdown: IMarkdownString, options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown => {
				const element = outElement ?? mainWindow.document.createElement('div');
				const content = typeof _markdown === 'string' ? _markdown : (_markdown.value ?? '');
				element.textContent = content;
				return {
					element,
					dispose: () => { }
				};
			}
		};

		// Mock the anchor service
		mockAnchorService = {
			_serviceBrand: undefined,
			register: () => toDisposable(() => { }),
			lastFocusedAnchor: undefined
		};
		instantiationService.stub(IChatMarkdownAnchorService, mockAnchorService);

		// Mock hover service
		mockHoverService = {
			_serviceBrand: undefined,
			showHover: () => undefined,
			showDelayedHover: () => undefined,
			showAndFocusLastHover: () => { },
			hideHover: () => { },
			setupDelayedHover: () => toDisposable(() => { }),
			setupManagedHover: () => ({ dispose: () => { }, show: () => { }, hide: () => { }, update: () => { } }),
			showManagedHover: () => undefined,
			isHovered: () => false,
		} as unknown as IHoverService;
		instantiationService.stub(IHoverService, mockHoverService);

		// Mock language models service
		mockLanguageModelsService = {
			_serviceBrand: undefined,
			onDidChangeLanguageModels: Event.None,
			getLanguageModelIds: () => [],
			lookupLanguageModel: () => undefined,
			selectLanguageModels: async () => [],
			registerLanguageModelChat: () => toDisposable(() => { }),
			sendChatRequest: async () => ({ stream: (async function* () { })(), result: Promise.resolve({}) }),
			computeTokenLength: async () => 0
		} as unknown as ILanguageModelsService;
		instantiationService.stub(ILanguageModelsService, mockLanguageModelsService);
	});

	teardown(() => {
		disposables.dispose();
	});

	test('replace thinking phrases suppresses fun default phrases', () => {
		mockConfigurationService.setUserConfiguration(ChatConfiguration.ThinkingPhrases, {
			mode: 'replace',
			phrases: ['Custom phrase'],
		});

		assert.strictEqual(maybePickFunWorkingMessage(mockConfigurationService, () => 0), undefined);
	});

	test('lastNonEmptyThinkingLine reads only the meaningful tail semantics', () => {
		assert.strictEqual(lastNonEmptyThinkingLine(''), undefined);
		assert.strictEqual(lastNonEmptyThinkingLine('\n\n  \n'), undefined);
		assert.strictEqual(lastNonEmptyThinkingLine('first\n> **Newest detail**\n\n'), 'Newest detail');
		assert.strictEqual(lastNonEmptyThinkingLine('first\r\n- second\r\n'), 'second');
	});

	suite('ThinkingDisplayMode.Collapsed', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('should start collapsed', () => {
			const content = createThinkingPart('**Analyzing code**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true, 'Should be collapsed by default');
		});

		test('should have chat-thinking-box class', () => {
			const content = createThinkingPart('**Processing**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			assert.ok(part.domNode.classList.contains('chat-thinking-box'), 'Should have chat-thinking-box class');
		});

		test('should extract title from bold markdown', () => {
			const content = createThinkingPart('**Reading configuration files**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const button = part.domNode.querySelector('.chat-used-context-label .monaco-button');
			assert.ok(button, 'Should have collapse button');
			// The title should contain the extracted text
			const labelElement = button.querySelector('.icon-label');
			assert.ok(labelElement?.textContent?.includes('Reading configuration files') || button.textContent?.includes('Reading configuration files'),
				'Title should contain extracted text');
		});

		test('lazy rendering - should not render content until expanded', () => {
			const content = createThinkingPart('**Initial thinking content**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// In collapsed mode, content wrapper should not be initialized
			const contentList = part.domNode.querySelector('.chat-used-context-list');
			assert.strictEqual(contentList, null, 'Content should not be rendered when collapsed');
		});

		test('lazy rendering - should render content when expanded', () => {
			const content = createThinkingPart('**Thinking content to render**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Click the button to expand
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.ok(button, 'Should have expand button');
			button.click();

			// Now content should be rendered
			const contentList = part.domNode.querySelector('.chat-used-context-list');
			assert.ok(contentList, 'Content should be rendered after expanding');
		});
	});

	suite('ThinkingDisplayMode.CollapsedPreview', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.CollapsedPreview);
		});

		test('should start expanded when streaming (not complete)', () => {
			const content = createThinkingPart('**Analyzing**\nSome detailed reasoning about the code structure');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// In CollapsedPreview mode, should be expanded while streaming
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), false,
				'Should be expanded during streaming in CollapsedPreview mode');
		});

		test('should be collapsed when complete', () => {
			const content = createThinkingPart('**Completed task**');
			const context = createMockRenderContext(true); // isComplete = true

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true // streamingCompleted
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// When complete, should be collapsed
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true,
				'Should be collapsed when complete');
		});

		test('should be collapsed when streamingCompleted is true even if element.isComplete is false (look-ahead completion)', () => {
			// This tests the scenario where we know the thinking part is complete
			// based on look-ahead (subsequent non-pinnable parts exist), but the
			// overall response is still in progress
			const content = createThinkingPart('**Finished analyzing**');
			const context = createMockRenderContext(false); // element.isComplete = false

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true // streamingCompleted = true (look-ahead detected this thinking is done)
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Even though element.isComplete is false, this thinking part should be
			// collapsed because streamingCompleted is true (determined by look-ahead)
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true,
				'Should be collapsed when streamingCompleted is true, even if element.isComplete is false');
		});

		test('should use lazy rendering when streamingCompleted is true even if element.isComplete is false', () => {
			// Verify lazy rendering is triggered when streamingCompleted=true and element.isComplete=false
			const content = createThinkingPart('**Looking ahead completed**');
			const context = createMockRenderContext(false); // element.isComplete = false

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true // streamingCompleted = true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Content should not be rendered because it's collapsed (lazy rendering)
			const contentList = part.domNode.querySelector('.chat-used-context-list');
			assert.strictEqual(contentList, null, 'Content should not be rendered when streamingCompleted=true (collapsed = lazy)');
		});
	});

	suite('ThinkingDisplayMode.StreamThenCollapse', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.StreamThenCollapse);
		});

		function createPart(content: string, elementIsComplete: boolean, streamingCompleted: boolean): ChatThinkingContentPart {
			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart(content),
				createMockRenderContext(elementIsComplete),
				mockMarkdownRenderer,
				streamingCompleted
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));
			return part;
		}

		test('streams expanded at full height, without the fixed-scrolling clamp', () => {
			const part = createPart('**Analyzing**\nLots of streamed reasoning', false, false);

			assert.deepStrictEqual({
				collapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				fixedMode: part.domNode.classList.contains('chat-thinking-fixed-mode'),
				active: part.domNode.classList.contains('chat-thinking-active'),
				hasScrollableClamp: !!part.domNode.querySelector('.monaco-scrollable-element'),
			}, {
				collapsed: false,
				fixedMode: false,
				active: true,
				hasScrollableClamp: false,
			}, 'Should stream expanded inline without the fixed-height scroll window');
		});

		test('collapseContentAnimated collapses a live part (instantly under reduced motion)', () => {
			// The workbench test accessibility service reports reduced motion,
			// so the animated collapse takes the instant path deterministically.
			const part = createPart('**Working**\nStreaming content', false, false);
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), false);

			part.collapseContentAnimated();

			assert.deepStrictEqual({
				collapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				animating: part.domNode.classList.contains('chat-thinking-collapsing'),
			}, {
				collapsed: true,
				animating: false,
			}, 'Should collapse without leaving the animation class behind');
		});

		test('renders straight to collapsed with no animation for already-complete responses', () => {
			const part = createPart('**Finished earlier**', true, true);

			part.collapseContentAnimated();

			assert.deepStrictEqual({
				collapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				animating: part.domNode.classList.contains('chat-thinking-collapsing'),
			}, {
				collapsed: true,
				animating: false,
			}, 'History renders should start collapsed and never animate');
		});

		test('collapses when look-ahead marks streaming complete even if the response is still running', () => {
			const part = createPart('**Done with this section**', false, true);

			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true,
				'Should be collapsed when streamingCompleted is true, even if element.isComplete is false');
		});
	});

	suite('Activity polish (spinner labels, summary pill, groups)', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.StreamThenCollapse);
		});

		function createLivePart(thinkingText: string, isCanceled = false): ChatThinkingContentPart {
			const context = createMockRenderContext(false);
			if (isCanceled) {
				Object.assign(context.element, { isCanceled: true });
			}
			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart(thinkingText),
				context,
				mockMarkdownRenderer,
				false
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));
			return part;
		}

		function createCompletedToolInvocation(toolId: string, invocationMessage: string, toolCallId: string, toolSpecificDataKind?: 'terminal' | 'search'): IChatToolInvocationSerialized {
			return {
				kind: 'toolInvocationSerialized',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				resultDetails: undefined,
				toolSpecificData: toolSpecificDataKind === 'terminal'
					? { kind: 'terminal', commandLine: { original: 'echo hi' }, language: 'sh' } as IChatToolInvocationSerialized['toolSpecificData']
					: undefined,
				isConfirmed: { type: 0 },
				isComplete: true,
				source: ToolDataSource.Internal,
				generatedTitle: undefined,
				isAttachedToThinking: false,
			} as IChatToolInvocationSerialized;
		}

		function createRunningToolInvocation(toolId: string, invocationMessage: string, toolCallId: string): IChatToolInvocation {
			return {
				kind: 'toolInvocation',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				source: ToolDataSource.Internal,
				isAttachedToThinking: false,
				generatedTitle: undefined,
				state: observableValue('state', {
					type: IChatToolInvocation.StateKind.Executing,
					confirmed: { type: 0 },
					progress: observableValue('progress', { progress: 0 }),
					parameters: {},
					confirmationMessages: undefined,
				}),
				toolSpecificDataKind: observableValue('test', undefined),
				toJSON: () => ({} as IChatToolInvocationSerialized),
			} as IChatToolInvocation;
		}

		function appendTool(part: ChatThinkingContentPart, tool: IChatToolInvocation | IChatToolInvocationSerialized): void {
			part.appendItem(
				() => ({ domNode: $('div', {}, tool.invocationMessage as string) }),
				tool.toolId,
				tool
			);
		}

		test('working spinner prefers the running tool label over the random pool', () => {
			const part = createLivePart('plain reasoning without a bold title');
			appendTool(part, createRunningToolInvocation('read_file', 'Reading package.json', 'call-1'));

			const spinnerLabel = part.domNode.querySelector('.chat-thinking-spinner-label');
			assert.ok(/^Reading package\.json · \d+s$/.test(spinnerLabel?.textContent ?? ''), 'Spinner should show the running tool label and elapsed time');
		});

		test('clean chat always exposes a stable reasoning or live tool status', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat');
			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('plain reasoning without a bold title'),
				context,
				mockMarkdownRenderer,
				false
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			assert.ok(part.domNode.querySelector('.chat-thinking-spinner-item .codicon-loading.codicon-modifier-spin'), 'Clean chat should render an animated loading icon while reasoning');
			assert.ok(/^Reasoning · \d+s$/.test(part.domNode.querySelector('.chat-thinking-spinner-label')?.textContent ?? ''), 'Clean chat should use a stable reasoning fallback with elapsed time');

			appendTool(part, createRunningToolInvocation('write', 'Generating Write input…', 'call-write'));
			const liveGroupHeader = part.domNode.querySelector('.chat-thinking-group-live > .chat-thinking-group-header');
			const liveGroupLabel = liveGroupHeader?.querySelector('.chat-thinking-group-label')?.textContent ?? '';
			const liveElapsed = liveGroupHeader?.querySelector('.chat-thinking-group-live-elapsed');
			assert.strictEqual(liveGroupLabel, 'Generating Write input…');
			assert.ok(/^ · \d+s$/.test(liveElapsed?.textContent ?? ''), 'Visible elapsed time should keep ticking separately from the announced status');
			assert.deepStrictEqual({
				role: liveGroupHeader?.getAttribute('role'),
				live: liveGroupHeader?.getAttribute('aria-live'),
				tabIndex: (liveGroupHeader as HTMLElement | null)?.tabIndex,
				expanded: liveGroupHeader?.getAttribute('aria-expanded'),
				elapsedHidden: liveElapsed?.getAttribute('aria-hidden'),
				loading: !!liveGroupHeader?.querySelector('.codicon-loading.codicon-modifier-spin'),
			}, {
				role: 'status',
				live: null,
				tabIndex: -1,
				expanded: null,
				elapsedHidden: 'true',
				loading: true,
			});

			const liveGroup = liveGroupHeader?.closest('.chat-thinking-work-group');
			const collapsedBefore = liveGroup?.classList.contains('chat-thinking-work-overflow-collapsed');
			(liveGroupHeader as HTMLElement | null)?.click();
			liveGroupHeader?.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			assert.strictEqual(liveGroup?.classList.contains('chat-thinking-work-overflow-collapsed'), collapsedBefore, 'A passive live status must not retain hidden mouse/keyboard disclosure behavior');
		});

		test('completed pill shows elapsed time and step count meta', () => {
			mockConfigurationService.setUserConfiguration(ChatConfiguration.ThinkingGenerateTitles, false);
			const part = createLivePart('**Analyzing**\nreasoning body');
			appendTool(part, createCompletedToolInvocation('read_file', 'Read a.ts', 'call-1'));
			appendTool(part, createCompletedToolInvocation('read_file', 'Read b.ts', 'call-2'));

			part.finalizeTitleIfDefault();

			const meta = part.domNode.querySelector('.chat-thinking-title-meta');
			assert.ok(meta, 'Completed pill should render the meta span');
			assert.ok(/ · \d+s · 3 steps$/.test(meta.textContent ?? ''), `Meta should read "· <n>s · 3 steps" but was "${meta.textContent}"`);
		});

		test('cancelled run finalizes to "Stopped after Ns" with a circle-slash icon', () => {
			const part = createLivePart('plain reasoning without a bold title', true);
			appendTool(part, createCompletedToolInvocation('read_file', 'Read a.ts', 'call-1'));
			appendTool(part, createCompletedToolInvocation('search_code', 'Searched for foo', 'call-2'));

			part.finalizeTitleIfDefault();

			const label = part.domNode.querySelector('.chat-used-context-label');
			assert.deepStrictEqual({
				stopped: /^Stopped after \d+s/.test(label?.textContent ?? ''),
				slashIcon: !!part.domNode.querySelector('.chat-used-context-label .codicon-circle-slash'),
			}, {
				stopped: true,
				slashIcon: true,
			}, `Cancelled pill should read "Stopped after Ns" with circle-slash (was "${label?.textContent}")`);
		});

		test('grouped activity pills: consecutive reads summarize as "Explored N files"', () => {
			const part = createLivePart('**Analyzing**\nreasoning body');
			appendTool(part, createCompletedToolInvocation('read_file', 'Read a.ts', 'call-1'));
			appendTool(part, createCompletedToolInvocation('read_file', 'Read b.ts', 'call-2'));
			appendTool(part, createCompletedToolInvocation('read_file', 'Read c.ts', 'call-3'));

			part.finalizeTitleIfDefault();

			const group = part.domNode.querySelector('.chat-thinking-group');
			assert.deepStrictEqual({
				groupCount: part.domNode.querySelectorAll('.chat-thinking-group').length,
				label: group?.querySelector('.chat-thinking-group-label')?.textContent,
				collapsed: group?.classList.contains('chat-thinking-group-collapsed'),
				rowCount: group?.querySelectorAll('.chat-thinking-tool-wrapper').length,
			}, {
				groupCount: 1,
				label: 'Explored 3 files',
				collapsed: true,
				rowCount: 3,
			});
		});

		test('grouped activity pills: mixed read + search summarizes as exploration counts', () => {
			const part = createLivePart('**Analyzing**\nreasoning body');
			appendTool(part, createCompletedToolInvocation('read_file', 'Read a.ts', 'call-1'));
			appendTool(part, createCompletedToolInvocation('search_code', 'Searched for z-index', 'call-2'));

			part.finalizeTitleIfDefault();

			const label = part.domNode.querySelector('.chat-thinking-group-label');
			assert.strictEqual(label?.textContent, 'Explored 1 file, 1 search');
		});

		test('grouped activity pills: a single item keeps its own label and category changes split groups', () => {
			const part = createLivePart('**Analyzing**\nreasoning body');
			appendTool(part, createCompletedToolInvocation('read_file', 'Read titlebarpart.css', 'call-1'));
			appendTool(part, createCompletedToolInvocation('run_in_terminal', 'Ran npm test', 'call-2', 'terminal'));

			part.finalizeTitleIfDefault();

			const labels = Array.from(part.domNode.querySelectorAll('.chat-thinking-group-label')).map(el => el.textContent);
			assert.deepStrictEqual(labels, ['Read titlebarpart.css', 'Ran npm test']);
		});

		test('external edit diff card renders header controls and +/- counts', () => {
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/titlebarpart.css'),
				editKind: 'edit',
				diff: { added: 5, removed: 2 },
				beforeContentUri: URI.parse('chat-edit://before/titlebarpart.css'),
				afterContentUri: URI.parse('chat-edit://after/titlebarpart.css'),
			};
			const part = store.add(instantiationService.createInstance(ChatExternalEditContentPart, edit));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			assert.deepStrictEqual({
				isCard: part.domNode.classList.contains('chat-external-edit-card'),
				hasChevron: !!part.domNode.querySelector('.chat-external-edit-expand'),
				hasCopy: !!part.domNode.querySelector('.chat-external-edit-copy'),
				added: part.domNode.querySelector('.label-added')?.textContent,
				removed: part.domNode.querySelector('.label-removed')?.textContent,
			}, {
				isCard: true,
				hasChevron: true,
				hasCopy: true,
				added: '+5',
				removed: '-2',
			});
		});

		test('edit pills are not wrapped in a redundant group summary header', () => {
			// Regression test: edit pills (markdownContent/externalEdit) already
			// render their own icon + filename + diff via ChatEditPillElement.
			// Wrapping them in an activity-group header duplicated that text
			// and, because the fallback label read the pill's raw textContent,
			// concatenated it without spacing (e.g. "Editedfoo.ts+2-1").
			const part = createLivePart('**Analyzing**\nreasoning body');
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/tsconfig.node.json'),
				editKind: 'edit',
				diff: { added: 2, removed: 1 },
			};
			part.appendItem(
				() => ({ domNode: $('div', {}, 'Edited', $('span.file-icon', {}, 'tsconfig.node.json'), $('span.label-added', {}, '+2'), $('span.label-removed', {}, '-1')) }),
				undefined,
				edit
			);

			part.finalizeTitleIfDefault();

			assert.deepStrictEqual({
				groupCount: part.domNode.querySelectorAll('.chat-thinking-group').length,
				editRowCount: part.domNode.querySelectorAll('.chat-thinking-tool-wrapper').length,
			}, {
				groupCount: 0,
				editRowCount: 1,
			}, 'Edit pill should render as its own row with no wrapping group header');
		});
	});

	suite('Cursor transcript presentation', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.StreamThenCollapse);
		});

		function createCursorPart(thinkingText: string): ChatThinkingContentPart {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart(thinkingText),
				context,
				mockMarkdownRenderer,
				false
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));
			return part;
		}

		function createCursorTool(toolId: string, invocationMessage: string, toolCallId: string, terminal = false): IChatToolInvocationSerialized {
			return {
				kind: 'toolInvocationSerialized',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				resultDetails: undefined,
				toolSpecificData: terminal
					? { kind: 'terminal', commandLine: { original: 'printf ready' }, language: 'sh' } as IChatToolInvocationSerialized['toolSpecificData']
					: undefined,
				isConfirmed: { type: 0 },
				isComplete: true,
				source: ToolDataSource.Internal,
				generatedTitle: undefined,
				isAttachedToThinking: false,
			} as IChatToolInvocationSerialized;
		}

		function createCompletableCursorTool(toolId: string, invocationMessage: string, toolCallId: string, parameters: unknown = {}): { tool: IChatToolInvocation; complete: () => void } {
			const state = observableValue<IChatToolInvocation.State>('state', {
				type: IChatToolInvocation.StateKind.Executing,
				confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
				progress: observableValue('progress', { progress: 0 }),
				parameters,
				confirmationMessages: undefined,
			});
			const tool = {
				kind: 'toolInvocation',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				source: ToolDataSource.Internal,
				isAttachedToThinking: false,
				generatedTitle: undefined,
				state,
				toolSpecificDataKind: observableValue('toolSpecificDataKind', undefined),
				toJSON: () => ({} as IChatToolInvocationSerialized),
			} as IChatToolInvocation;

			return {
				tool,
				complete: () => state.set({
					type: IChatToolInvocation.StateKind.Completed,
					confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
					parameters,
					confirmationMessages: undefined,
					resultDetails: undefined,
					postConfirmed: undefined,
					contentForModel: [],
				}, undefined),
			};
		}

		function createNativeTerminalDisclosure(context: IChatContentPartRenderContext, command: string, output: string, hasError = false, isDenied = false) {
			const nativeOutput = $('pre.chat-terminal-output-content.cursor-test-native-shell-output', {}, output);
			const nativeShell = $('div.chat-terminal-output-container.cursor-test-native-shell', {}, nativeOutput);
			const disclosure = disposables.add(instantiationService.createInstance(
				ChatTerminalThinkingCollapsibleWrapper,
				command,
				false,
				nativeShell,
				context,
				false,
				true,
				false,
				isDenied,
				false,
				hasError,
				undefined,
				() => { },
			));
			return { disclosure, nativeShell, nativeOutput };
		}

		test('shows a stable live reasoning label and finalizes it in place', () => {
			const part = createCursorPart('Reasoning about the implementation');
			const liveLabel = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-reasoning-label');

			assert.deepStrictEqual({
				text: liveLabel?.textContent,
				live: liveLabel?.classList.contains('chat-thinking-cursor-reasoning-live'),
			}, {
				text: 'Thinking 1s',
				live: true,
			});

			part.markAsInactive();

			assert.strictEqual(part.domNode.querySelector('.chat-thinking-cursor-reasoning-label'), liveLabel,
				'Completion should update the existing reasoning label instead of replacing it');
			assert.deepStrictEqual({
				text: liveLabel?.textContent,
				live: liveLabel?.classList.contains('chat-thinking-cursor-reasoning-live'),
			}, {
				text: 'Thought 1s',
				live: false,
			});
		});

		test('measures each reasoning segment instead of repeating the turn duration', () => {
			const originalNow = Date.now;
			let now = 1_000;
			Date.now = () => now;
			try {
				const part = createCursorPart('First reasoning segment');
				now = 5_000;
				const read = createCursorTool('read_file', 'Read chat.ts', 'call-reasoning-clock');
				part.appendItem(() => ({ domNode: $('div.cursor-test-clock-read', {}, 'Read chat.ts') }), read.toolId, read);
				now = 7_000;
				part.setupThinkingContainer(createThinkingPart('Second reasoning segment', 'cursor-reasoning-clock-2'));
				now = 9_000;
				part.markAsInactive();

				assert.deepStrictEqual(
					Array.from(part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-cursor-reasoning-label-text')).map(label => label.textContent),
					['Thought 4s', 'Thought 2s'],
				);
			} finally {
				Date.now = originalNow;
			}
		});

		test('summarizes mixed exploration while preserving native row order', () => {
			const part = createCursorPart('Checking the relevant files');
			const appendExploration = (tool: IChatToolInvocationSerialized, order: string) => {
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': order }, tool.invocationMessage as string) }),
					tool.toolId,
					tool
				);
			};

			appendExploration(createCursorTool('read_file', 'Read a.ts', 'call-read-a'), 'read-a');
			appendExploration(createCursorTool('search_code', 'Searched for transcript', 'call-search'), 'search');
			appendExploration(createCursorTool('read_file', 'Read b.ts', 'call-read-b'), 'read-b');
			part.finalizeTitleIfDefault();

			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group[data-work-category="explore"]');
			assert.deepStrictEqual({
				label: group?.querySelector('.chat-thinking-group-label')?.textContent,
				collapsed: group?.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: group?.querySelector('.chat-thinking-group-header')?.getAttribute('aria-expanded'),
				order: Array.from(group?.querySelectorAll<HTMLElement>('.cursor-test-native-row') ?? []).map(row => row.dataset.order),
			}, {
				label: 'Explored 2 files, 1 search',
				collapsed: true,
				expanded: 'false',
				order: ['read-a', 'search', 'read-b'],
			});
		});

		test('coalesces a 600-call read, search, and write burst without duplicating or rebuilding rows', async () => {
			const part = createCursorPart('Inspecting and updating a large workspace');
			const appendTool = (index: number, kind: 'read' | 'search' | 'write') => {
				const toolCallId = `call-stress-${kind}-${index}`;
				const tool = kind === 'read'
					? createCursorTool('read_file', `Read file-${index}.ts`, toolCallId)
					: kind === 'search'
						? createCursorTool('search_code', `Searched for symbol-${index}`, toolCallId)
						: createCursorTool('write_file', `Wrote file-${index}.ts`, toolCallId);
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-stress-row', { 'data-tool-call-id': toolCallId }, tool.invocationMessage as string) }),
					tool.toolId,
					tool,
				);
			};

			// The first call creates the group synchronously. Every additional call in
			// this provider burst should reuse it and coalesce its summary refresh.
			appendTool(0, 'read');
			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			const header = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-header');
			const label = header?.querySelector<HTMLElement>(':scope > .chat-thinking-group-label');
			const body = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-body');
			assert.ok(group && header && label && body, 'The first tool should mount one reusable activity group');

			let labelMutationCount = 0;
			const observer = new mainWindow.MutationObserver(records => labelMutationCount += records.length);
			observer.observe(label, { childList: true, characterData: true, subtree: true });
			disposables.add(toDisposable(() => observer.disconnect()));

			for (let index = 1; index < 200; index++) {
				appendTool(index, 'read');
			}
			for (let index = 0; index < 200; index++) {
				appendTool(index, 'search');
				appendTool(index, 'write');
			}

			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			await Promise.resolve(); // Let MutationObserver deliver the coalesced label change.

			const rows = Array.from(body.querySelectorAll<HTMLElement>('.cursor-test-stress-row'));
			const rowIds = rows.map(row => row.dataset.toolCallId);
			assert.deepStrictEqual({
				groupCount: part.domNode.querySelectorAll('.chat-thinking-work-group').length,
				rowCount: rows.length,
				uniqueRowCount: new Set(rowIds).size,
				firstRow: rowIds[0],
				lastRow: rowIds.at(-1),
				label: label.textContent,
			}, {
				groupCount: 1,
				rowCount: 600,
				uniqueRowCount: 600,
				firstRow: 'call-stress-read-0',
				lastRow: 'call-stress-write-199',
				label: 'Edited 200 files',
			}, 'One synchronous tool burst should preserve every unique row in one group');
			assert.ok(labelMutationCount <= 2, `Expected at most 2 label mutations for 599 appends, got ${labelMutationCount}`);

			part.finalizeTitleIfDefault();
			assert.strictEqual(part.domNode.querySelector('.chat-thinking-work-group'), group, 'Completion should retain the activity group');
			assert.strictEqual(group.querySelector(':scope > .chat-thinking-group-header'), header, 'Completion should retain the group header');
			assert.strictEqual(group.querySelector(':scope > .chat-thinking-group-body'), body, 'Completion should retain the 600 completed rows');
			assert.strictEqual(body.querySelectorAll('.cursor-test-stress-row').length, 600);
		});

		test('a single live read is visible beneath its exploration summary', () => {
			const part = createCursorPart('Checking one file');
			const tool = createCursorTool('read_file', 'Read 10/120 lines', 'call-single-read');
			part.appendItem(
				() => ({ domNode: $('div.cursor-test-single-read', {}, 'Read 10/120 lines') }),
				tool.toolId,
				tool,
			);

			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			const header = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-header');
			assert.ok(group && header, 'Expected a summary even for one read');
			assert.deepStrictEqual({
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				headerVisible: header.style.display !== 'none',
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				rawReadMounted: group.querySelectorAll('.cursor-test-single-read').length,
			}, {
				label: 'Explored 1 file',
				headerVisible: true,
				collapsed: false,
				expanded: 'true',
				rawReadMounted: 1,
			});
		});

		test('grouped tool-call disclosure toggles its body on every click', () => {
			const part = createCursorPart('Checking the relevant files');
			for (const tool of [
				createCursorTool('read_file', 'Read a.ts', 'call-toggle-read'),
				createCursorTool('search_code', 'Searched for transcript', 'call-toggle-search'),
			]) {
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-native-row', {}, tool.invocationMessage as string) }),
					tool.toolId,
					tool
				);
			}
			part.finalizeTitleIfDefault();

			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			const header = group?.querySelector<HTMLElement>('.chat-thinking-group-header');
			const body = group?.querySelector<HTMLElement>('.chat-thinking-group-body');
			assert.ok(group && header && body, 'Expected a grouped tool-call disclosure');
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				rows: body.querySelectorAll('.cursor-test-native-row').length,
			}, {
				collapsed: true,
				expanded: 'false',
				rows: 2,
			});

			header.click();
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				bodyStillMounted: group.querySelector('.chat-thinking-group-body') === body,
			}, {
				collapsed: false,
				expanded: 'true',
				bodyStillMounted: true,
			}, 'First click should reveal the grouped tool-call body');

			header.click();
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
			}, {
				collapsed: true,
				expanded: 'false',
			}, 'Second click should collapse the grouped tool-call body again');
		});

		test('shared passive work rows stay flat under the single group disclosure', async () => {
			const part = createCursorPart('Using a skill while exploring the codebase');
			const entries = [
				{ entry: createCompletableCursorTool('use_skill', 'Used transcript skill', 'call-a', { skill: 'transcript' }), order: 'other' },
				{ entry: createCompletableCursorTool('read_file', 'Read chat.ts', 'call-b', { filePath: '/project/src/chat.ts' }), order: 'read' },
				{ entry: createCompletableCursorTool('search_code', 'Searched for disclosure', 'call-c', { query: 'chat-thinking-work-row' }), order: 'search' },
			];
			for (const { entry, order } of entries) {
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': order }, entry.tool.invocationMessage as string) }),
					entry.tool.toolId,
					entry.tool
				);
				entry.complete();
			}
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));

			const groups = part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-work-group');
			const group = groups[0];
			const header = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-header');
			const rows = Array.from(group?.querySelectorAll<HTMLElement>('.chat-thinking-tool-wrapper') ?? []);
			assert.ok(group && header, 'Expected one shared group with a group-level disclosure');
			assert.deepStrictEqual({
				groupCount: groups.length,
				groupRole: header.getAttribute('role'),
				groupExpanded: header.getAttribute('aria-expanded'),
				groupDisclosures: header.querySelectorAll('.chat-thinking-group-chevron').length,
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				order: rows.map(row => row.querySelector<HTMLElement>('.cursor-test-native-row')?.dataset.order),
				rowExpandable: rows.map(row => row.classList.contains('chat-thinking-work-row-expandable')),
				rowRoles: rows.map(row => row.getAttribute('role')),
				rowExpanded: rows.map(row => row.getAttribute('aria-expanded')),
				rowDetails: group.querySelectorAll('.chat-thinking-work-row-details').length,
				rowDisclosureSvgs: group.querySelectorAll('.chat-thinking-work-row-disclosure svg').length,
			}, {
				groupCount: 1,
				groupRole: 'button',
				groupExpanded: 'false',
				groupDisclosures: 1,
				label: 'Explored 1 file, 1 search',
				order: ['other', 'read', 'search'],
				rowExpandable: [false, false, false],
				rowRoles: [null, null, null],
				rowExpanded: [null, null, null],
				rowDetails: 0,
				rowDisclosureSvgs: 0,
			}, 'Parameterized passive rows should not create competing per-row disclosures');

			header.click();
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				order: Array.from(group.querySelectorAll<HTMLElement>('.cursor-test-native-row')).map(row => row.dataset.order),
			}, {
				collapsed: false,
				expanded: 'true',
				order: ['other', 'read', 'search'],
			}, 'The group header should reveal every flat row without removing them');

			header.click();
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				rows: group.querySelectorAll('.chat-thinking-tool-wrapper').length,
			}, {
				collapsed: true,
				expanded: 'false',
				rows: 3,
			}, 'The same group header should hide all flat rows again');
		});

		test('task progress disclosure explains TodoWrite and reveals its real checklist', () => {
			const part = createCursorPart('Tracking a two-step change');
			const planTool = {
				...createCursorTool('todo_write', 'TodoWrite', 'call-plan-progress'),
				pastTenseMessage: 'Updated 2 todos: [completed] Inspect the existing behavior, [in_progress] Implement and verify the fix',
			} as IChatToolInvocationSerialized;
			const emptyNativeProgress = $('div.cursor-test-plan-native', {}, $('div.progress-container', {}, 'TodoWrite'));

			part.appendItem(() => ({ domNode: emptyNativeProgress }), planTool.toolId, planTool);

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-plan-row');
			const summary = row?.querySelector<HTMLElement>(':scope > .chat-thinking-work-row-summary');
			const details = row?.querySelector<HTMLElement>(':scope > .chat-thinking-plan-details');
			const items = Array.from(details?.querySelectorAll<HTMLElement>('.chat-thinking-plan-item') ?? []);
			assert.ok(row && summary && details, 'Expected TodoWrite to render a useful task-progress disclosure');
			assert.deepStrictEqual({
				heading: summary.querySelector('.chat-thinking-work-row-heading')?.textContent,
				preview: summary.querySelector('.chat-thinking-work-row-preview')?.textContent,
				title: summary.title,
				expandable: row.classList.contains('chat-thinking-work-row-expandable'),
				nativeExpandable: row.classList.contains('chat-thinking-work-row-native-expandable'),
				expanded: row.getAttribute('aria-expanded'),
				legacyRail: row.querySelector('.chat-thinking-work-row-details-content'),
				items: items.map(item => item.textContent),
				statuses: items.map(item => item.className),
			}, {
				heading: 'Task progress',
				preview: '1 of 2 done',
				title: 'Tracks the steps the agent is working through. It does not run commands.',
				expandable: true,
				nativeExpandable: false,
				expanded: 'false',
				legacyRail: null,
				items: ['✓Inspect the existing behavior', '→Implement and verify the fix'],
				statuses: [
					'chat-thinking-plan-item chat-thinking-plan-item-completed',
					'chat-thinking-plan-item chat-thinking-plan-item-in-progress',
				],
			});

			summary.click();
			assert.deepStrictEqual({
				expanded: row.getAttribute('aria-expanded'),
				expandedClass: row.classList.contains('chat-thinking-work-row-expanded'),
				checklistStillMounted: row.querySelector(':scope > .chat-thinking-plan-details') === details,
				emptyNativeUsedAsDisclosure: row.classList.contains('chat-thinking-work-row-native-expandable'),
			}, {
				expanded: 'true',
				expandedClass: true,
				checklistStillMounted: true,
				emptyNativeUsedAsDisclosure: false,
			});
		});

		test('task progress without checklist data never exposes an empty native disclosure', () => {
			const part = createCursorPart('Tracking work');
			const planTool = createCursorTool('todo_write', 'TodoWrite', 'call-plan-without-items');
			const emptyNativeProgress = $('div.cursor-test-empty-plan-native', {}, $('div.progress-container', {}, 'TodoWrite'));

			part.appendItem(() => ({ domNode: emptyNativeProgress }), planTool.toolId, planTool);

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-plan-row');
			assert.ok(row, 'Expected TodoWrite to retain its task-progress summary');
			assert.deepStrictEqual({
				heading: row.querySelector('.chat-thinking-work-row-heading')?.textContent,
				expandable: row.classList.contains('chat-thinking-work-row-expandable'),
				nativeExpandable: row.classList.contains('chat-thinking-work-row-native-expandable'),
				role: row.getAttribute('role'),
				expanded: row.getAttribute('aria-expanded'),
				details: row.querySelector('.chat-thinking-work-row-details'),
				disclosureIcon: row.querySelector('.chat-thinking-work-row-disclosure .chat-thinking-work-row-svg'),
			}, {
				heading: 'Task progress',
				expandable: false,
				nativeExpandable: false,
				role: null,
				expanded: null,
				details: null,
				disclosureIcon: null,
			}, 'Missing provider details should produce a flat explanatory row, never an empty rail');
		});

		test('live TodoWrite has one aggregate working marker for the whole row', () => {
			const part = createCursorPart('Updating task progress');
			const progress = createCompletableCursorTool('todo_write', 'TodoWrite', 'call-live-plan');
			part.appendItem(() => ({ domNode: $('div.cursor-test-live-plan-native', {}, 'TodoWrite') }), progress.tool.toolId, progress.tool);

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-plan-row');
			assert.ok(row, 'Expected a single aggregate TodoWrite row');
			assert.strictEqual(row.querySelectorAll(':scope > .chat-thinking-work-row-summary > .chat-thinking-work-row-status-working').length, 1);
			assert.strictEqual(row.querySelectorAll('.chat-thinking-plan-item .chat-thinking-work-row-status-working').length, 0);

			progress.complete();
			assert.strictEqual(row.querySelectorAll('.chat-thinking-work-row-status-working').length, 0, 'Completing TodoWrite must stop its aggregate animation');
		});

		test('live edit delegates its visible loading state to one aggregate empty diff shell', async () => {
			const part = createCursorPart('Preparing a file edit');
			const edit = createCompletableCursorTool('edit_file', 'Edit', 'call-pending-edit', { filePath: '/project/src/render.js' });
			const nativeEdit = $('div.cursor-test-pending-edit-native', {}, 'Edit');

			part.appendItem(() => ({ domNode: nativeEdit }), edit.tool.toolId, edit.tool);

			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			const header = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-header');
			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-edit-row');
			assert.ok(group && header && row, 'Expected one aggregate edit group with its invocation still mounted');
			assert.deepStrictEqual({
				liveGroup: group.classList.contains('chat-thinking-work-edit-live'),
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				count: group.dataset.editCount,
				role: header.getAttribute('role'),
				ariaLabel: header.getAttribute('aria-label'),
				ariaExpanded: header.getAttribute('aria-expanded'),
				pending: row.classList.contains('chat-thinking-cursor-edit-pending'),
				expandable: row.classList.contains('chat-thinking-work-row-expandable'),
				rowRole: row.getAttribute('role'),
				expanded: row.getAttribute('aria-expanded'),
				details: row.querySelector('.chat-thinking-work-row-details'),
				nativeIdentity: row.querySelector('.cursor-test-pending-edit-native') === nativeEdit,
				statusWorking: row.querySelector('.chat-thinking-work-row-status')?.classList.contains('chat-thinking-work-row-status-working'),
			}, {
				liveGroup: true,
				label: 'Spawned 1 edit',
				count: '1',
				role: 'status',
				ariaLabel: 'Spawned 1 edit',
				ariaExpanded: null,
				pending: true,
				expandable: false,
				rowRole: null,
				expanded: null,
				details: null,
				nativeIdentity: true,
				statusWorking: true,
			}, 'The aggregate label and empty diff should own the only visible loading treatment');

			edit.complete();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.deepStrictEqual({
				liveGroup: group.classList.contains('chat-thinking-work-edit-live'),
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				count: header.dataset.editCount,
				role: header.getAttribute('role'),
				pending: row.classList.contains('chat-thinking-cursor-edit-pending'),
				nativeIdentity: row.querySelector('.cursor-test-pending-edit-native') === nativeEdit,
				statusComplete: row.querySelector('.chat-thinking-work-row-status')?.classList.contains('chat-thinking-work-row-status-complete'),
			}, {
				liveGroup: false,
				label: 'Edited 1 file',
				count: undefined,
				role: 'button',
				pending: false,
				nativeIdentity: true,
				statusComplete: true,
			}, 'Completion should remove only the waiting skin while preserving the live tool subtree');
		});

		test('multiple live edits render one aggregate empty diff with a stable spawned count', async () => {
			const part = createCursorPart('Applying a batch of edits');
			const edits = [
				createCompletableCursorTool('edit_file', 'Edit first', 'call-pending-edit-a', { filePath: '/project/src/a.js' }),
				createCompletableCursorTool('edit_file', 'Edit second', 'call-pending-edit-b', { filePath: '/project/src/b.js' }),
				createCompletableCursorTool('edit_file', 'Edit third', 'call-pending-edit-c', { filePath: '/project/src/c.js' }),
			];
			for (const [index, edit] of edits.entries()) {
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-batch-edit-native', { 'data-index': String(index) }, 'Edit') }),
					edit.tool.toolId,
					edit.tool
				);
			}
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));

			const groups = part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-work-group');
			const group = groups[0];
			const header = group?.querySelector<HTMLElement>(':scope > .chat-thinking-group-header');
			assert.ok(group && header, 'Expected one aggregate edit group');
			assert.deepStrictEqual({
				groups: groups.length,
				liveCards: part.domNode.querySelectorAll('.chat-thinking-work-edit-live > .chat-thinking-group-header').length,
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				count: group.dataset.editCount,
				ariaLabel: header.getAttribute('aria-label'),
				role: header.getAttribute('role'),
				pendingRowsMounted: group.querySelectorAll('.chat-thinking-cursor-edit-pending').length,
			}, {
				groups: 1,
				liveCards: 1,
				label: 'Spawned 3 edits',
				count: '3',
				ariaLabel: 'Spawned 3 edits',
				role: 'status',
				pendingRowsMounted: 3,
			});
			header.click();
			assert.strictEqual(group.classList.contains('chat-thinking-work-summary-collapsed'), true, 'The live status card must not expose the mounted batch rows');

			edits[0].complete();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.strictEqual(group.dataset.editCount, '3', 'The batch count must not decrement as individual edits settle');
			assert.strictEqual(group.classList.contains('chat-thinking-work-edit-live'), true);

			edits[1].complete();
			edits[2].complete();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.deepStrictEqual({
				live: group.classList.contains('chat-thinking-work-edit-live'),
				label: header.querySelector('.chat-thinking-group-label')?.textContent,
				count: header.dataset.editCount,
				role: header.getAttribute('role'),
			}, {
				live: false,
				label: 'Edited 3 files',
				count: undefined,
				role: 'button',
			});
		});

		test('live activity group stays user-collapsed as another tool appends and completes', () => {
			const part = createCursorPart('Running a live sequence of tools');
			const appendTool = (entry: ReturnType<typeof createCompletableCursorTool>, order: string) => {
				part.appendItem(
					() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': order }, entry.tool.invocationMessage as string) }),
					entry.tool.toolId,
					entry.tool
				);
			};
			appendTool(createCompletableCursorTool('read_file', 'Read a.ts', 'call-collapse-read'), 'read');
			appendTool(createCompletableCursorTool('search_code', 'Searched for transcript', 'call-collapse-search'), 'search');

			const group = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			const header = group?.querySelector<HTMLElement>('.chat-thinking-group-header');
			assert.ok(group && header, 'Expected a live multi-tool activity group');
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
			}, {
				collapsed: false,
				expanded: 'true',
			});

			header.click();
			assert.deepStrictEqual({
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
			}, {
				collapsed: true,
				expanded: 'false',
			}, 'The user should be able to collapse the automatically expanded live group');

			const appended = createCompletableCursorTool('use_skill', 'Used transcript skill', 'call-collapse-other');
			appendTool(appended, 'other');
			appended.complete();

			const groups = part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-work-group');
			assert.deepStrictEqual({
				groupCount: groups.length,
				sameGroup: groups[0] === group,
				collapsed: group.classList.contains('chat-thinking-work-summary-collapsed'),
				expanded: header.getAttribute('aria-expanded'),
				order: Array.from(group.querySelectorAll<HTMLElement>('.cursor-test-native-row')).map(row => row.dataset.order),
			}, {
				groupCount: 1,
				sameGroup: true,
				collapsed: true,
				expanded: 'false',
				order: ['read', 'search', 'other'],
			}, 'Appending and completing another tool must preserve the user-selected collapsed state and every row');
		});

		test('completed Thought disclosure toggles the reasoning body on every click', () => {
			const part = createCursorPart('Reasoning body that should be disclosed independently');
			part.markAsInactive();

			const disclosure = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-reasoning-label');
			const reasoningBody = part.domNode.querySelector<HTMLElement>('.chat-thinking-item.markdown-content');
			assert.ok(disclosure && reasoningBody, 'Expected a completed Thought disclosure and reasoning body');

			assert.deepStrictEqual({
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				bodyHidden: reasoningBody.hidden,
			}, {
				expanded: 'false',
				preview: false,
				bodyHidden: true,
			}, 'Completed reasoning should begin closed without rendering a body');
			disclosure.click();
			assert.deepStrictEqual({
				role: disclosure.getAttribute('role'),
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				bodyHidden: reasoningBody.hidden,
			}, {
				role: 'button',
				expanded: 'true',
				preview: true,
				bodyHidden: false,
			}, 'Clicking Thought should open the bounded reasoning preview');

			disclosure.click();
			assert.deepStrictEqual({
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				bodyHidden: reasoningBody.hidden,
			}, {
				expanded: 'false',
				preview: false,
				bodyHidden: true,
			}, 'A second click should remove the reasoning body from layout');
		});

		test('live Thought opens in a bounded viewport and still supports manual collapse', async () => {
			const part = createCursorPart('First reasoning line');
			const disclosure = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-reasoning-label');
			const reasoningBody = part.domNode.querySelector<HTMLElement>('.chat-thinking-item.markdown-content');
			assert.ok(disclosure && reasoningBody, 'Expected a live Thought disclosure and reasoning viewport');

			let assignedScrollTop = 0;
			Object.defineProperties(reasoningBody, {
				clientHeight: { configurable: true, get: () => 48 },
				scrollHeight: { configurable: true, get: () => 120 },
				scrollTop: {
					configurable: true,
					get: () => assignedScrollTop,
					set: (value: number) => assignedScrollTop = value,
				},
			});

			assert.strictEqual(reasoningBody.hidden, false, 'A live Thought should expose its bounded viewport without an extra click');
			part.updateThinking(createThinkingPart('First reasoning line\nSecond reasoning line\nThird reasoning line\nNewest reasoning line'));
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.deepStrictEqual({
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				hidden: reasoningBody.hidden,
				overflowing: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-overflowing'),
				scrollTop: assignedScrollTop,
			}, {
				expanded: 'true',
				preview: true,
				hidden: false,
				overflowing: true,
				scrollTop: 120,
			}, 'Open streaming reasoning should stay bounded, masked, and follow the newest content');

			let outerWheelEvents = 0;
			disposables.add(addDisposableListener(part.domNode, 'wheel', () => outerWheelEvents++));
			assignedScrollTop = 20;
			reasoningBody.dispatchEvent(new mainWindow.WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true }));
			assert.deepStrictEqual({ scrollTop: assignedScrollTop, outerWheelEvents }, { scrollTop: 40, outerWheelEvents: 0 },
				'Thought should consume wheel input while it can scroll in that direction');
			assignedScrollTop = 72;
			reasoningBody.dispatchEvent(new mainWindow.WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true }));
			assert.deepStrictEqual({ scrollTop: assignedScrollTop, outerWheelEvents }, { scrollTop: 72, outerWheelEvents: 1 },
				'Thought should hand wheel input to the chat after reaching its edge');

			assignedScrollTop = 20;
			reasoningBody.dispatchEvent(new mainWindow.Event('scroll'));
			part.updateThinking(createThinkingPart('First reasoning line\nSecond reasoning line\nThird reasoning line\nFourth reasoning line\nFifth reasoning line\nNew content while reviewing'));
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.strictEqual(assignedScrollTop, 20, 'Streaming should not fight a user who scrolls up inside the open Thought preview');

			assignedScrollTop = 72;
			reasoningBody.dispatchEvent(new mainWindow.Event('scroll'));
			part.updateThinking(createThinkingPart('First reasoning line\nSecond reasoning line\nThird reasoning line\nFourth reasoning line\nFifth reasoning line\nNewest reasoning line'));
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.strictEqual(assignedScrollTop, 120, 'Returning to the bottom should resume live tail-following');

			disclosure.click();
			assert.deepStrictEqual({
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				hidden: reasoningBody.hidden,
				overflowing: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-overflowing'),
				scrollTop: assignedScrollTop,
			}, {
				expanded: 'false',
				preview: false,
				hidden: true,
				overflowing: false,
				scrollTop: 0,
			}, 'Closing Thought should remove the preview from layout and clear its viewport state');

			disclosure.click();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.deepStrictEqual({
				expanded: disclosure.getAttribute('aria-expanded'),
				preview: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-preview'),
				hidden: reasoningBody.hidden,
				overflowing: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-overflowing'),
				scrollTop: assignedScrollTop,
			}, {
				expanded: 'true',
				preview: true,
				hidden: false,
				overflowing: true,
				scrollTop: 120,
			}, 'Reopening the same Thought should restore the bounded live preview');
		});

		test('restored Thought measures its preview only after both disclosures open', async () => {
			const context = createMockRenderContext(true);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('First reasoning line\nSecond reasoning line\nThird reasoning line\nNewest reasoning line', 'restored-overflow-thinking'),
				context,
				mockMarkdownRenderer,
				true
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const outerDisclosure = part.domNode.querySelector<HTMLElement>('.chat-used-context-label .monaco-button');
			const thoughtDisclosure = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-reasoning-label');
			const reasoningBody = part.domNode.querySelector<HTMLElement>('.chat-thinking-item.markdown-content');
			assert.ok(outerDisclosure && thoughtDisclosure && reasoningBody, 'Expected the outer Worked disclosure and restored Thought viewport');

			let assignedScrollTop = 0;
			Object.defineProperties(reasoningBody, {
				clientHeight: { configurable: true, get: () => 48 },
				scrollHeight: { configurable: true, get: () => 120 },
				scrollTop: {
					configurable: true,
					get: () => assignedScrollTop,
					set: (value: number) => assignedScrollTop = value,
				},
			});

			outerDisclosure.click();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
			assert.deepStrictEqual({
				outerCollapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				thoughtHidden: reasoningBody.hidden,
				overflowing: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-overflowing'),
			}, {
				outerCollapsed: false,
				thoughtHidden: true,
				overflowing: false,
			}, 'Opening the outer work fold should leave the inner Thought body closed');

			thoughtDisclosure.click();
			await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));

			assert.deepStrictEqual({
				outerCollapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				thoughtHidden: reasoningBody.hidden,
				overflowing: reasoningBody.classList.contains('chat-thinking-cursor-reasoning-overflowing'),
				scrollTop: assignedScrollTop,
			}, {
				outerCollapsed: false,
				thoughtHidden: false,
				overflowing: true,
				scrollTop: 0,
			}, 'Opening restored completed reasoning should measure a bounded preview from the beginning');
		});

		test('restored multi-section Thought mounts an independent disclosure for every reasoning block', () => {
			const context = createMockRenderContext(true);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('First restored reasoning', 'restored-thinking-1'),
				context,
				mockMarkdownRenderer,
				true
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			part.setupThinkingContainer(createThinkingPart('Second restored reasoning', 'restored-thinking-2'));
			part.setupThinkingContainer(createThinkingPart('Third restored reasoning', 'restored-thinking-3'));

			const wrapper = part.domNode.querySelector<HTMLElement>('.chat-used-context-list.chat-thinking-collapsible');
			const disclosures = Array.from(wrapper?.querySelectorAll<HTMLElement>(':scope > .chat-thinking-cursor-reasoning-label') ?? []);
			const reasoningBlocks = Array.from(wrapper?.querySelectorAll<HTMLElement>(':scope > .chat-thinking-item.markdown-content') ?? []);
			assert.ok(wrapper, 'Expected the restored Thought wrapper and its custom disclosures');
			assert.deepStrictEqual({
				disclosures: disclosures.length,
				blocks: reasoningBlocks.length,
				text: reasoningBlocks.map(block => block.textContent),
				adjacent: disclosures.map((disclosure, index) => disclosure.nextElementSibling === reasoningBlocks[index]),
				expanded: disclosures.map(disclosure => disclosure.getAttribute('aria-expanded')),
				hidden: reasoningBlocks.map(block => block.hidden),
			}, {
				disclosures: 3,
				blocks: 3,
				text: ['', '', ''],
				adjacent: [true, true, true],
				expanded: ['false', 'false', 'false'],
				hidden: [true, true, true],
			}, 'Closed restored reasoning should preserve chronology without mounting markdown DOM');

			disclosures[1].click();
			assert.deepStrictEqual({
				expanded: disclosures.map(disclosure => disclosure.getAttribute('aria-expanded')),
				hidden: reasoningBlocks.map(block => block.hidden),
				text: reasoningBlocks.map(block => block.textContent),
			}, {
				expanded: ['false', 'true', 'false'],
				hidden: [true, false, true],
				text: ['', 'Second restored reasoning', ''],
			}, 'A restored Thought disclosure should expand only its adjacent reasoning preview');

			disclosures[1].click();
			assert.deepStrictEqual({
				expanded: disclosures.map(disclosure => disclosure.getAttribute('aria-expanded')),
				hidden: reasoningBlocks.map(block => block.hidden),
				text: reasoningBlocks.map(block => block.textContent),
			}, {
				expanded: ['false', 'false', 'false'],
				hidden: [true, true, true],
				text: ['', '', ''],
			}, 'Collapsing a restored Thought should hide only its adjacent reasoning body');
		});

		test('uninterrupted mixed-category tool calls remain in one activity group', () => {
			const part = createCursorPart('Using a skill before exploring files');
			part.domNode.remove();
			const first = createCompletableCursorTool('use_skill', 'Used transcript skill', 'call-sequential-other');
			part.appendItem(
				() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': 'other' }, 'Used transcript skill') }),
				first.tool.toolId,
				first.tool
			);
			const originalGroup = part.domNode.querySelector<HTMLElement>('.chat-thinking-work-group');
			assert.ok(originalGroup, 'Expected the first live tool call to create an activity group');

			first.complete();
			const second = createCompletableCursorTool('read_file', 'Read a.ts', 'call-sequential-read');
			part.appendItem(
				() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': 'read' }, 'Read a.ts') }),
				second.tool.toolId,
				second.tool
			);
			second.complete();
			const third = createCompletableCursorTool('search_code', 'Searched for transcript', 'call-sequential-search');
			part.appendItem(
				() => ({ domNode: $('div.cursor-test-native-row', { 'data-order': 'search' }, 'Searched for transcript') }),
				third.tool.toolId,
				third.tool
			);
			third.complete();
			part.finalizeTitleIfDefault();

			const groups = part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-work-group');
			assert.deepStrictEqual({
				groupCount: groups.length,
				sameGroup: groups[0] === originalGroup,
				label: groups[0]?.querySelector('.chat-thinking-group-label')?.textContent,
				order: Array.from(groups[0]?.querySelectorAll<HTMLElement>('.cursor-test-native-row') ?? []).map(row => row.dataset.order),
			}, {
				groupCount: 1,
				sameGroup: true,
				label: 'Explored 1 file, 1 search',
				order: ['other', 'read', 'search'],
			});
		});

		test('metadata-light native disclosure remains expandable without synthetic details', () => {
			const part = createCursorPart('Inspecting provider-native tool output');
			const nativeLeaf = $('span.cursor-test-native-leaf', {}, 'Provider-native details');
			const nativeControl = $('button.cursor-test-native-control', { type: 'button' }, 'Run native action');
			const nativeSubtree = $('div.cursor-test-native-disclosure', {}, nativeLeaf, nativeControl);

			part.appendItem(
				() => ({ domNode: nativeSubtree }),
				'provider_native_tool'
			);

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-tool-wrapper');
			const summary = row?.querySelector<HTMLElement>('.chat-thinking-work-row-summary');
			assert.ok(row && summary, 'Expected the metadata-light provider tool to render as a Cursor work row');
			assert.deepStrictEqual({
				expandable: row.classList.contains('chat-thinking-work-row-expandable'),
				nativeExpandable: row.classList.contains('chat-thinking-work-row-native-expandable'),
				role: row.getAttribute('role'),
				expanded: row.getAttribute('aria-expanded'),
				syntheticDetails: row.querySelector('.chat-thinking-work-row-details'),
				nativeRootPreserved: row.querySelector(':scope > .chat-thinking-work-native-content') === nativeSubtree,
				nativeLeafPreserved: row.querySelector('.cursor-test-native-leaf') === nativeLeaf,
			}, {
				expandable: true,
				nativeExpandable: true,
				role: 'button',
				expanded: 'false',
				syntheticDetails: null,
				nativeRootPreserved: true,
				nativeLeafPreserved: true,
			});

			summary.click();
			assert.deepStrictEqual({
				expandedClass: row.classList.contains('chat-thinking-work-row-expanded'),
				expanded: row.getAttribute('aria-expanded'),
				nativeRootPreserved: row.querySelector(':scope > .chat-thinking-work-native-content') === nativeSubtree,
			}, {
				expandedClass: true,
				expanded: 'true',
				nativeRootPreserved: true,
			}, 'First click should reveal the preserved provider-native subtree');

			const enterEvent = new mainWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			const spaceEvent = new mainWindow.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
			nativeControl.dispatchEvent(enterEvent);
			nativeControl.dispatchEvent(spaceEvent);
			assert.deepStrictEqual({
				enterDefaultPrevented: enterEvent.defaultPrevented,
				spaceDefaultPrevented: spaceEvent.defaultPrevented,
				expandedClass: row.classList.contains('chat-thinking-work-row-expanded'),
				expanded: row.getAttribute('aria-expanded'),
			}, {
				enterDefaultPrevented: false,
				spaceDefaultPrevented: false,
				expandedClass: true,
				expanded: 'true',
			}, 'Keyboard input owned by a native control must not cancel or toggle the outer work-row disclosure');

			summary.click();
			assert.deepStrictEqual({
				expandedClass: row.classList.contains('chat-thinking-work-row-expanded'),
				expanded: row.getAttribute('aria-expanded'),
			}, {
				expandedClass: false,
				expanded: 'false',
			}, 'Second click should collapse the provider-native subtree again');
		});

		test('non-Cursor clean host does not install the native disclosure fallback', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Inspecting provider-native tool output'),
				context,
				mockMarkdownRenderer,
				false
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));
			const nativeLeaf = $('span.cursor-test-non-cursor-native-leaf', {}, 'Provider-native details');
			const nativeSubtree = $('div.cursor-test-non-cursor-native-disclosure', {}, nativeLeaf);

			part.appendItem(
				() => ({ domNode: nativeSubtree }),
				'provider_native_tool'
			);

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-tool-wrapper');
			assert.ok(row, 'Expected the clean host to retain its ordinary work row');
			assert.deepStrictEqual({
				expandable: row.classList.contains('chat-thinking-work-row-expandable'),
				nativeExpandable: row.classList.contains('chat-thinking-work-row-native-expandable'),
				role: row.getAttribute('role'),
				expanded: row.getAttribute('aria-expanded'),
				nativeRootPreserved: row.querySelector(':scope > .chat-thinking-work-native-content') === nativeSubtree,
			}, {
				expandable: false,
				nativeExpandable: false,
				role: null,
				expanded: null,
				nativeRootPreserved: true,
			});
		});

		test('keeps every reasoning disclosure immediately before its chronological block across diff and tool rows', () => {
			const part = createCursorPart('Reasoning before the diff');
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/chat.ts'),
				editKind: 'edit',
				diff: { added: 1, removed: 1 },
			};
			const nativeDiff = $('div.chat-external-edit-card.cursor-test-chronology-diff', {}, 'Changed chat.ts');
			part.appendItem(() => ({ domNode: nativeDiff }), undefined, edit);

			part.setupThinkingContainer(createThinkingPart('Reasoning between the diff and tool', 'cursor-reasoning-middle'));
			const tool = createCursorTool('read_file', 'Read chat.ts', 'call-chronology');
			const nativeTool = $('div.cursor-test-chronology-tool', {}, 'Read chat.ts');
			part.appendItem(() => ({ domNode: nativeTool }), tool.toolId, tool);
			part.setupThinkingContainer(createThinkingPart('Reasoning after the tool', 'cursor-reasoning-last'));

			const wrapper = part.domNode.querySelector<HTMLElement>('.chat-used-context-list.chat-thinking-collapsible');
			const labels = Array.from(wrapper?.querySelectorAll<HTMLElement>(':scope > .chat-thinking-cursor-reasoning-label') ?? []);
			const reasoningBlocks = Array.from(wrapper?.querySelectorAll<HTMLElement>(':scope > .chat-thinking-item.markdown-content') ?? []);
			const editRow = nativeDiff.closest<HTMLElement>('.chat-thinking-cursor-edit-row');
			const toolRow = nativeTool.closest<HTMLElement>('.chat-thinking-cursor-read-row');
			assert.ok(wrapper && editRow && toolRow, 'Expected chronological reasoning, diff, and tool transcript rows');
			const precedes = (left: Node, right: Node) => !!(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);

			assert.deepStrictEqual({
				labels: labels.length,
				blocks: reasoningBlocks.map(block => block.textContent),
				adjacent: labels.map((label, index) => label.nextElementSibling === reasoningBlocks[index]),
				expanded: labels.map(label => label.getAttribute('aria-expanded')),
				hidden: reasoningBlocks.map(block => block.hidden),
				chronological: [
					precedes(reasoningBlocks[0], editRow),
					precedes(editRow, labels[1]),
					precedes(reasoningBlocks[1], toolRow),
					precedes(toolRow, labels[2]),
				],
			}, {
				labels: 3,
				blocks: ['Reasoning before the diff', 'Reasoning between the diff and tool', 'Reasoning after the tool'],
				adjacent: [true, true, true],
				expanded: ['true', 'true', 'true'],
				hidden: [false, false, false],
				chronological: [true, true, true, true],
			});

			for (let index = 0; index < labels.length; index++) {
				labels[index].click();
				assert.deepStrictEqual({
					expanded: labels.map(label => label.getAttribute('aria-expanded')),
					hidden: reasoningBlocks.map(block => block.hidden),
					adjacent: labels.map((label, labelIndex) => label.nextElementSibling === reasoningBlocks[labelIndex]),
					text: reasoningBlocks.map(block => block.textContent),
				}, {
					expanded: labels.map((_, labelIndex) => String(labelIndex !== index)),
					hidden: labels.map((_, labelIndex) => labelIndex === index),
					adjacent: [true, true, true],
					text: labels.map((_, labelIndex) => labelIndex === index
						? ''
						: ['Reasoning before the diff', 'Reasoning between the diff and tool', 'Reasoning after the tool'][labelIndex]),
				}, `Thought disclosure ${index + 1} should close only its own immediately-following live preview`);

				labels[index].click();
				assert.deepStrictEqual({
					expanded: labels.map(label => label.getAttribute('aria-expanded')),
					hidden: reasoningBlocks.map(block => block.hidden),
					text: reasoningBlocks.map(block => block.textContent),
				}, {
					expanded: ['true', 'true', 'true'],
					hidden: [false, false, false],
					text: ['Reasoning before the diff', 'Reasoning between the diff and tool', 'Reasoning after the tool'],
				}, `Thought disclosure ${index + 1} should reopen its own live preview`);
			}
		});

		test('synthetic diff-only thinking does not add an empty Thought disclosure before the card', () => {
			const part = createCursorPart('');
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/diff-only.ts'),
				editKind: 'edit',
				diff: { added: 1, removed: 0 },
			};
			const nativeDiff = $('div.chat-external-edit-card.cursor-test-diff-only-card', {}, 'Changed diff-only.ts');
			part.appendItem(() => ({ domNode: nativeDiff }), undefined, edit);

			const wrapper = part.domNode.querySelector<HTMLElement>('.chat-used-context-list.chat-thinking-collapsible');
			const editRow = nativeDiff.closest<HTMLElement>('.chat-thinking-cursor-edit-row');
			const meaningfulChildren = Array.from(wrapper?.children ?? []).filter(child => !child.classList.contains('chat-thinking-spinner-item') && !(child instanceof HTMLElement && child.hidden));
			assert.ok(wrapper && editRow, 'Expected the diff-only Cursor transcript card');
			assert.deepStrictEqual({
				reasoningLabels: wrapper.querySelectorAll(':scope > .chat-thinking-cursor-reasoning-label').length,
				visibleReasoningBlocks: wrapper.querySelectorAll(':scope > .chat-thinking-item.markdown-content:not([hidden])').length,
				hiddenOrderingAnchors: wrapper.querySelectorAll(':scope > .chat-thinking-item.markdown-content[hidden]').length,
				firstMeaningfulChild: meaningfulChildren[0] === editRow,
				cardIdentity: editRow.querySelector(':scope > .cursor-test-diff-only-card') === nativeDiff,
			}, {
				reasoningLabels: 0,
				visibleReasoningBlocks: 0,
				hiddenOrderingAnchors: 1,
				firstMeaningfulChild: true,
				cardIdentity: true,
			});
		});

		test('first reasoning delta claims its reserved position ahead of an already-rendered diff', () => {
			const part = createCursorPart('');
			const wrapper = part.domNode.querySelector<HTMLElement>('.chat-used-context-list.chat-thinking-collapsible');
			const orderingAnchor = wrapper?.querySelector<HTMLElement>(':scope > .chat-thinking-item.markdown-content[hidden]');
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/late-reasoning.ts'),
				editKind: 'edit',
				diff: { added: 1, removed: 0 },
			};
			const nativeDiff = $('div.chat-external-edit-card.cursor-test-late-reasoning-diff', {}, 'Changed late-reasoning.ts');
			part.appendItem(() => ({ domNode: nativeDiff }), undefined, edit);
			part.updateThinking(createThinkingPart('Reasoning that streamed before the diff', 'test-thinking-id'));

			const label = wrapper?.querySelector<HTMLElement>(':scope > .chat-thinking-cursor-reasoning-label');
			const editRow = nativeDiff.closest<HTMLElement>('.chat-thinking-cursor-edit-row');
			assert.ok(wrapper && orderingAnchor && label && editRow, 'Expected the reserved reasoning position and diff card');
			assert.deepStrictEqual({
				sameAnchor: label.nextElementSibling === orderingAnchor,
				anchorVisible: !orderingAnchor.hidden,
				text: orderingAnchor.textContent,
				reasoningBeforeDiff: !!(orderingAnchor.compareDocumentPosition(editRow) & Node.DOCUMENT_POSITION_FOLLOWING),
			}, {
				sameAnchor: true,
				anchorVisible: true,
				text: 'Reasoning that streamed before the diff',
				reasoningBeforeDiff: true,
			});

			label.click();
			assert.deepStrictEqual({
				anchorVisible: !orderingAnchor.hidden,
				text: orderingAnchor.textContent,
				reasoningBeforeDiff: !!(orderingAnchor.compareDocumentPosition(editRow) & Node.DOCUMENT_POSITION_FOLLOWING),
			}, {
				anchorVisible: false,
				text: '',
				reasoningBeforeDiff: true,
			}, 'Closing the live Thought should clear its rendered body while preserving its chronological anchor');
		});

		test('Cursor terminal preview keeps four output rows and marks overflow', () => {
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview('\n\u001b[32mready\u001b[0m\n  indented\nthird\nfourth\nfifth\n'),
				{ text: 'ready\n  indented\nthird\nfourth', overflowing: true },
			);
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview('one\ntwo'),
				{ text: 'one\ntwo', overflowing: false },
			);
		});

		test('Cursor terminal preview removes a command echo already shown in its header', () => {
			const command = 'cd expo-app && npx tsc --noEmit 2>&1 | head -5';
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview(`Success\n$ ${command}\ntypecheck passed\n`, command),
				{ text: 'typecheck passed', overflowing: false },
			);
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview('Success\n$ cd expo-app && npx tsc --noEmit 2>&1 |\nhead -5\n', command),
				{ text: 'Success\n$ cd expo-app && npx tsc --noEmit 2>&1 |\nhead -5', overflowing: false },
			);
			assert.deepStrictEqual(getCollapsedTerminalOutputPreview('Success', command), { text: 'Success', overflowing: false });
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview('before\n$ echo foo bar\nafter', 'echo foo bar'),
				{ text: 'before\n$ echo foo bar\nafter', overflowing: false },
				'Prompt-looking text later in stdout is real output',
			);
			assert.deepStrictEqual(
				getCollapsedTerminalOutputPreview("$ printf 'a b'\noutput", "printf 'a  b'"),
				{ text: "$ printf 'a b'\noutput", overflowing: false },
				'Whitespace inside a quoted argument is semantically meaningful',
			);
		});

		test('Cursor terminal disclosure announces failed commands in the stable shell', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const { disclosure } = createNativeTerminalDisclosure(context, 'npm test', 'failed output', true);
			context.container.appendChild(disclosure.domNode);

			const button = disclosure.domNode.querySelector<HTMLElement>('.chat-used-context-label .monaco-button');
			assert.ok(button?.textContent?.includes('Failed npm test'));
			assert.strictEqual(button?.ariaLabel, 'Failed npm test');
			assert.ok(button?.querySelector('.codicon-error'));
		});

		test('Cursor terminal disclosure updates a late-resolved failure', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const { disclosure } = createNativeTerminalDisclosure(context, 'npm test', 'failed output');
			context.container.appendChild(disclosure.domNode);

			disclosure.markComplete(true);
			const button = disclosure.domNode.querySelector<HTMLElement>('.chat-used-context-label .monaco-button');
			assert.ok(button?.textContent?.includes('Failed npm test'));
			assert.strictEqual(button?.ariaLabel, 'Failed npm test');
			assert.ok(button?.querySelector('.codicon-error'));
		});

		test('Cursor terminal disclosure distinguishes an explicitly denied command', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const { disclosure } = createNativeTerminalDisclosure(context, 'rm generated.txt', '', false, true);
			context.container.appendChild(disclosure.domNode);

			const button = disclosure.domNode.querySelector<HTMLElement>('.chat-used-context-label .monaco-button');
			assert.ok(button?.textContent?.includes('Denied rm generated.txt'));
			assert.strictEqual(button?.ariaLabel, 'Denied rm generated.txt');
			assert.ok(button?.querySelector('.codicon-error'));
		});

		test('Cursor Execute disclosure toggles without replacing the native shell command or output subtree', () => {
			const shell = $('.cursor-test-terminal-shell');
			const tabs = $('div.chat-view-title-tabs', { 'data-test-state': 'tabs' }, $('span', {}, 'Agent'));
			const composer = $('div.backboard-composer', { 'data-test-state': 'composer' }, $('textarea', { 'aria-label': 'Message' }));
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			shell.append(tabs, context.container, composer);
			mainWindow.document.body.appendChild(shell);
			disposables.add(toDisposable(() => shell.remove()));
			const chromeBefore = { tabs: tabs.outerHTML, composer: composer.outerHTML };

			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Running a verification command'),
				context,
				mockMarkdownRenderer,
				false
			));
			context.container.appendChild(part.domNode);
			const command = 'printf ready';
			const native = createNativeTerminalDisclosure(context, command, 'ready\nall checks passed');
			const nativeRoot = native.disclosure.domNode;
			const nativeCommand = nativeRoot.querySelector<HTMLElement>('.chat-used-context-label code');
			// Model the lifecycle that produced the reported duplicate chrome: an
			// opaque provider call arrives before its native terminal subpart mounts,
			// and the serialized metadata has no toolSpecificData discriminator.
			const tool = createCursorTool('opaque-provider-tool', 'Terminal - printf ready', 'call-terminal');
			const lateNativeHost = $('div.chat-tool-invocation-part', {}, $('span.cursor-test-terminal-loading', {}, 'Loading terminal'));

			part.appendItem(() => ({ domNode: lateNativeHost }), tool.toolId, tool);
			lateNativeHost.querySelector('.cursor-test-terminal-loading')?.remove();
			lateNativeHost.appendChild(nativeRoot);
			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-terminal-row');
			const nativeToggle = nativeRoot.querySelector<HTMLElement>(':scope > .chat-used-context-label .monaco-button');
			assert.ok(row && nativeToggle && nativeCommand, 'Expected the Cursor terminal row to retain its one native command disclosure');
			assert.deepStrictEqual({
				activityGroups: part.domNode.querySelectorAll('.chat-thinking-work-group').length,
				otherRows: part.domNode.querySelectorAll('.chat-thinking-cursor-other-row').length,
				nativeHeaders: row.querySelectorAll('.chat-terminal-thinking-collapsible > .chat-used-context-label').length,
				standaloneParent: row.parentElement?.classList.contains('chat-thinking-collapsible'),
				syntheticSummary: row.querySelector('.chat-thinking-work-row-summary'),
				syntheticDetails: row.querySelector('.chat-thinking-work-row-details'),
				outerRole: row.getAttribute('role'),
				outerAria: row.getAttribute('aria-expanded'),
				nativeRoot: row.querySelector('.chat-terminal-thinking-collapsible') === nativeRoot,
				nativeCollapsed: nativeRoot.classList.contains('chat-used-context-collapsed'),
				nativeExpanded: native.disclosure.expanded.get(),
				nativeCommand: row.querySelector('.chat-used-context-label code') === nativeCommand,
				commandText: nativeCommand.textContent,
				nativeShellMounted: !!row.querySelector('.cursor-test-native-shell'),
				chrome: { tabs: tabs.outerHTML, composer: composer.outerHTML },
			}, {
				activityGroups: 0,
				otherRows: 0,
				nativeHeaders: 1,
				standaloneParent: true,
				syntheticSummary: null,
				syntheticDetails: null,
				outerRole: null,
				outerAria: null,
				nativeRoot: true,
				nativeCollapsed: true,
				nativeExpanded: false,
				nativeCommand: true,
				commandText: command,
				nativeShellMounted: false,
				chrome: chromeBefore,
			});

			nativeToggle.click();
			assert.deepStrictEqual({
				nativeCollapsed: nativeRoot.classList.contains('chat-used-context-collapsed'),
				nativeExpanded: native.disclosure.expanded.get(),
				nativeRoot: row.querySelector('.chat-terminal-thinking-collapsible') === nativeRoot,
				nativeCommand: row.querySelector('.chat-used-context-label code') === nativeCommand,
				nativeShell: row.querySelector('.cursor-test-native-shell') === native.nativeShell,
				nativeOutput: row.querySelector('.cursor-test-native-shell-output') === native.nativeOutput,
			}, {
				nativeCollapsed: false,
				nativeExpanded: true,
				nativeRoot: true,
				nativeCommand: true,
				nativeShell: true,
				nativeOutput: true,
			}, 'Expanding Execute must reveal the original native shell subtree');

			nativeToggle.click();
			assert.deepStrictEqual({
				nativeCollapsed: nativeRoot.classList.contains('chat-used-context-collapsed'),
				nativeExpanded: native.disclosure.expanded.get(),
				nativeRoot: row.querySelector('.chat-terminal-thinking-collapsible') === nativeRoot,
				nativeCommand: row.querySelector('.chat-used-context-label code') === nativeCommand,
				nativeShell: row.querySelector('.cursor-test-native-shell') === native.nativeShell,
				nativeOutput: row.querySelector('.cursor-test-native-shell-output') === native.nativeOutput,
				outputText: native.nativeOutput.textContent,
				chrome: { tabs: tabs.outerHTML, composer: composer.outerHTML },
			}, {
				nativeCollapsed: true,
				nativeExpanded: false,
				nativeRoot: true,
				nativeCommand: true,
				nativeShell: true,
				nativeOutput: true,
				outputText: 'ready\nall checks passed',
				chrome: chromeBefore,
			}, 'Collapsing Execute must hide without replacing or leaking the native subtree');
		});

		test('sequential Cursor shell calls stay as independent native cards without a command group', () => {
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Running two shell commands'),
				context,
				mockMarkdownRenderer,
				false
			));
			context.container.appendChild(part.domNode);

			const first = createNativeTerminalDisclosure(context, 'pwd', '/project');
			const second = createNativeTerminalDisclosure(context, 'npm test', '18 passing');
			const firstTool = createCursorTool('Execute', 'Execute pwd', 'call-shell-a');
			const secondTool = createCursorTool('exec_command', 'Execute tests', 'call-shell-b');
			part.appendItem(() => ({ domNode: first.disclosure.domNode }), firstTool.toolId, firstTool);
			part.appendItem(() => ({ domNode: second.disclosure.domNode }), secondTool.toolId, secondTool);

			const rows = Array.from(part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-cursor-terminal-row'));
			assert.deepStrictEqual({
				activityGroups: part.domNode.querySelectorAll('.chat-thinking-work-group').length,
				rowCount: rows.length,
				commands: rows.map(row => row.querySelector('.chat-used-context-label code')?.textContent),
				roots: [
					rows[0]?.querySelector('.chat-terminal-thinking-collapsible') === first.disclosure.domNode,
					rows[1]?.querySelector('.chat-terminal-thinking-collapsible') === second.disclosure.domNode,
				],
			}, {
				activityGroups: 0,
				rowCount: 2,
				commands: ['pwd', 'npm test'],
				roots: [true, true],
			});

			const secondToggle = second.disclosure.domNode.querySelector<HTMLElement>(':scope > .chat-used-context-label .monaco-button');
			assert.ok(secondToggle);
			secondToggle.click();
			assert.strictEqual(second.disclosure.expanded.get(), true);
			assert.strictEqual(first.disclosure.expanded.get(), false, 'Opening one shell card must not change another');
			assert.strictEqual(rows[1].querySelector('.cursor-test-native-shell-output'), second.nativeOutput);
		});

		test('non-Cursor host keeps native terminal content without Cursor transcript disclosures or chrome leakage', () => {
			const shell = $('.cursor-test-non-cursor-terminal-shell');
			const tabs = $('div.chat-view-title-tabs', { 'data-test-state': 'tabs' }, $('span', {}, 'Agent'));
			const composer = $('div.backboard-composer', { 'data-test-state': 'composer' }, $('textarea', { 'aria-label': 'Message' }));
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat');
			shell.append(tabs, context.container, composer);
			mainWindow.document.body.appendChild(shell);
			disposables.add(toDisposable(() => shell.remove()));
			const chromeBefore = { tabs: tabs.outerHTML, composer: composer.outerHTML };

			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Ordinary clean-host reasoning'),
				context,
				mockMarkdownRenderer,
				false
			));
			context.container.appendChild(part.domNode);
			const native = createNativeTerminalDisclosure(context, 'printf ordinary', 'ordinary output');
			native.disclosure.expand();
			const nativeRoot = native.disclosure.domNode;
			const tool = createCursorTool('Execute', 'Execute ordinary command', 'call-non-cursor-terminal', true);
			part.appendItem(() => ({ domNode: nativeRoot }), tool.toolId, tool);

			const row = nativeRoot.closest<HTMLElement>('.chat-thinking-tool-wrapper');
			assert.ok(row, 'Expected the ordinary host to preserve its native terminal row');
			assert.deepStrictEqual({
				cursorReasoningLabels: part.domNode.querySelectorAll('.chat-thinking-cursor-reasoning-label').length,
				cursorTerminalRows: part.domNode.querySelectorAll('.chat-thinking-cursor-terminal-row').length,
				nativeExpandable: row.classList.contains('chat-thinking-work-row-native-expandable'),
				expandedAria: row.getAttribute('aria-expanded'),
				nativeRoot: row.querySelector(':scope > .chat-thinking-work-native-content') === nativeRoot,
				nativeShell: row.querySelector('.cursor-test-native-shell') === native.nativeShell,
				nativeOutput: row.querySelector('.cursor-test-native-shell-output') === native.nativeOutput,
				chrome: { tabs: tabs.outerHTML, composer: composer.outerHTML },
				chromeCursorArtifacts: tabs.querySelectorAll('.chat-thinking-cursor-reasoning-label, .chat-thinking-cursor-terminal-row').length
					+ composer.querySelectorAll('.chat-thinking-cursor-reasoning-label, .chat-thinking-cursor-terminal-row').length,
			}, {
				cursorReasoningLabels: 0,
				cursorTerminalRows: 0,
				nativeExpandable: false,
				expandedAria: null,
				nativeRoot: true,
				nativeShell: true,
				nativeOutput: true,
				chrome: chromeBefore,
				chromeCursorArtifacts: 0,
			});
		});

		test('Cursor external edit renders a collapsed inline diff preview without touching tabs or composer', async () => {
			const beforeContentUri = URI.parse('chat-edit://before/chat.css');
			const afterContentUri = URI.parse('chat-edit://after/chat.css');
			const contentByUri = new Map<string, string>([
				[beforeContentUri.toString(), 'const stable = true;\nconst first = "old";\nconst second = "old";\nexport { first, second };\nconst tail = true;'],
				[afterContentUri.toString(), 'const stable = true;\nconst first = "new";\nconst second = "new";\nexport { first, second };\nconst tail = true;'],
			]);
			instantiationService.stub(ITextModelService, {
				_serviceBrand: undefined,
				createModelReference: async (resource: URI) => ({
					object: {
						textEditorModel: {
							getValue: () => contentByUri.get(resource.toString()) ?? '',
						},
					},
					dispose: () => { },
				}),
			} as unknown as ITextModelService);

			const shell = $('.cursor-test-chat-shell');
			const tabs = $('div.chat-view-title-tabs', { 'data-test-state': 'tabs' }, $('span', {}, 'Agent'));
			const composer = $('div.backboard-composer', { 'data-test-state': 'composer' }, $('textarea', { 'aria-label': 'Message' }));
			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			shell.append(tabs, context.container, composer);
			mainWindow.document.body.appendChild(shell);
			disposables.add(toDisposable(() => shell.remove()));
			const chromeBefore = { tabs: tabs.outerHTML, composer: composer.outerHTML };

			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Reviewing an inline file change'),
				context,
				mockMarkdownRenderer,
				false
			));
			context.container.appendChild(part.domNode);
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/chat.css'),
				editKind: 'edit',
				diff: { added: 4, removed: 1 },
				beforeContentUri,
				afterContentUri,
			};
			const editPart = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, edit));

			// ChatListRenderer invokes this public hook only for a Cursor transcript.
			editPart.showDiffPreview();
			part.appendItem(() => ({ domNode: editPart.domNode }), undefined, edit);
			part.finalizeTitleIfDefault();
			for (let attempt = 0; attempt < 20 && !editPart.domNode.querySelector('.chat-external-edit-diff-row'); attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
			}

			const row = part.domNode.querySelector<HTMLElement>('.chat-thinking-cursor-edit-row');
			const card = row?.querySelector<HTMLElement>(':scope > .chat-external-edit-card');
			const body = card?.querySelector<HTMLElement>(':scope > .chat-external-edit-diff-body');
			const diffContent = body?.querySelector<HTMLElement>(':scope > .chat-external-edit-diff-content');
			const diffRows = Array.from(diffContent?.querySelectorAll<HTMLElement>(':scope > .chat-external-edit-diff-row') ?? []);
			const markers = diffRows.map(diffRow => diffRow.querySelector('.chat-external-edit-diff-marker')?.textContent);
			assert.deepStrictEqual({
				nativeCard: card === editPart.domNode,
				preview: card?.classList.contains('chat-external-edit-preview'),
				expanded: card?.classList.contains('chat-external-edit-expanded'),
				header: !!card?.querySelector(':scope > .chat-codeblock-pill-widget'),
				expandControl: !!card?.querySelector(':scope > .chat-external-edit-expand'),
				copyControl: !!card?.querySelector(':scope > .chat-external-edit-copy'),
				expandAria: card?.querySelector('.chat-external-edit-expand')?.getAttribute('aria-expanded'),
				body: !!body,
				bodyRole: body?.getAttribute('role'),
				bodyTabIndex: body?.tabIndex,
				sharedWidthWrapper: !!diffContent,
				overflowFade: body?.classList.contains('chat-external-edit-diff-overflow'),
				rowKinds: {
					context: diffRows.some(diffRow => diffRow.classList.contains('context')),
					removed: diffRows.some(diffRow => diffRow.classList.contains('removed')),
					added: diffRows.some(diffRow => diffRow.classList.contains('added')),
				},
				markers: {
					blank: markers.includes(''),
					removed: markers.includes('-'),
					added: markers.includes('+'),
				},
				rowAnatomy: diffRows.every(diffRow =>
					!!diffRow.querySelector(':scope > .chat-external-edit-diff-gutter') &&
					!!diffRow.querySelector(':scope > .chat-external-edit-diff-marker') &&
					!!diffRow.querySelector(':scope > .chat-external-edit-diff-text')),
				added: row?.querySelector('.label-added')?.textContent,
				removed: row?.querySelector('.label-removed')?.textContent,
				activityGroups: part.domNode.querySelectorAll('.chat-thinking-work-group').length,
				chromeAfter: { tabs: tabs.outerHTML, composer: composer.outerHTML },
			}, {
				nativeCard: true,
				preview: true,
				expanded: false,
				header: true,
				expandControl: true,
				copyControl: true,
				expandAria: 'false',
				body: true,
				bodyRole: 'region',
				bodyTabIndex: -1,
				sharedWidthWrapper: true,
				overflowFade: true,
				rowKinds: { context: true, removed: true, added: true },
				markers: { blank: true, removed: true, added: true },
				rowAnatomy: true,
				added: '+4',
				removed: '-1',
				activityGroups: 0,
				chromeAfter: chromeBefore,
			});

			const expandControl = card?.querySelector<HTMLElement>(':scope > .chat-external-edit-expand');
			assert.ok(card && expandControl && body);
			expandControl.click();
			body.style.height = '20px';
			body.style.maxHeight = '20px';
			body.style.overflowY = 'auto';
			assert.ok(body.scrollHeight > body.clientHeight, 'Expanded diff fixture must have real vertical overflow');
			let outerWheelEvents = 0;
			shell.addEventListener('wheel', () => outerWheelEvents++);
			const downWheel = new mainWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 });
			body.dispatchEvent(downWheel);
			const afterDown = body.scrollTop;
			const outerAfterDown = outerWheelEvents;
			const upWheel = new mainWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -25 });
			body.dispatchEvent(upWheel);
			const afterUp = body.scrollTop;
			const outerAfterUp = outerWheelEvents;
			body.scrollTop = 0;
			const edgeWheel = new mainWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -60 });
			body.dispatchEvent(edgeWheel);
			assert.deepStrictEqual({
				expanded: card.classList.contains('chat-external-edit-expanded'),
				expandAria: expandControl.getAttribute('aria-expanded'),
				bodyTabIndex: body.tabIndex,
				downScrolled: afterDown > 0,
				upScrolled: afterUp < afterDown,
				downConsumed: downWheel.defaultPrevented,
				upConsumed: upWheel.defaultPrevented,
				outerAfterDown,
				outerAfterUp,
				outerWheelEvents,
			}, {
				expanded: true,
				expandAria: 'true',
				bodyTabIndex: 0,
				downScrolled: true,
				upScrolled: true,
				downConsumed: true,
				upConsumed: true,
				outerAfterDown: 0,
				outerAfterUp: 0,
				outerWheelEvents: 1,
			});
		});

				test('finalized text edit history is indexed once per response and observes live applied state', () => {
					const targetChange = disposables.add(new Emitter<void>());
					const createGroup = (index: number): IChatTextEditGroup => ({
						kind: 'textEditGroup',
						uri: URI.file(`/project/src/indexed-${index}.ts`),
						edits: [[]],
						done: true,
						state: { sha1: `sha-${index}`, applied: 0 },
					});
					const groups = Array.from({ length: 25 }, (_, index) => createGroup(index));
					const priorGroup = createGroup(100);
					const laterGroup = createGroup(200);
					const priorResponse = {
						response: { value: [priorGroup] },
						onDidChange: Event.None,
					} as unknown as IChatResponseModel;
					const targetResponse = {
						response: { value: groups },
						onDidChange: targetChange.event,
					} as unknown as IChatResponseModel;
					const laterResponse = {
						response: { value: [laterGroup] },
						onDidChange: Event.None,
					} as unknown as IChatResponseModel;
					let historyTraversalCount = 0;
					const chatModel = {
						getRequests: () => {
							historyTraversalCount++;
							return [
								{ response: priorResponse },
								{ response: targetResponse },
								{ response: laterResponse },
							];
						},
					} as unknown as IChatModel;
					const index = new TextEditGroupHistoryIndex();

					for (const group of groups) {
						assert.deepStrictEqual(index.getUnappliedGroups(chatModel, targetResponse, group.uri, true), [group]);
					}
					assert.strictEqual(historyTraversalCount, 1, 'all finalized file cards should share one history traversal');
					assert.deepStrictEqual(index.getUnappliedGroups(chatModel, targetResponse, laterGroup.uri, true), [], 'groups after the target response must stay excluded');

					groups[0].state!.applied = 1;
					assert.deepStrictEqual(index.getUnappliedGroups(chatModel, targetResponse, groups[0].uri, true), [], 'cached live groups must observe applied-state mutation');
					assert.strictEqual(historyTraversalCount, 1);

					targetChange.fire();
					assert.deepStrictEqual(index.getUnappliedGroups(chatModel, targetResponse, groups[1].uri, true), [groups[1]]);
					assert.strictEqual(historyTraversalCount, 2, 'a target response change must invalidate cached membership');

					index.getUnappliedGroups(chatModel, targetResponse, groups[2].uri, false);
					index.getUnappliedGroups(chatModel, targetResponse, groups[3].uri, false);
					assert.strictEqual(historyTraversalCount, 4, 'incomplete responses must never reuse a mutable history index');
					targetChange.fire();
				});

				test('Cursor textEditGroup replaces the full compare editor with the same compact diff card', async () => {
			const fileUri = URI.file('/project/src/entities.js');
			const beforeUri = URI.parse('chat-text-edit://before/entities.js');
			const afterUri = URI.parse('chat-text-edit://after/entities.js');
			const beforeContent = 'const stable = true;\nconst first = "old";\nconst second = "old";\nexport { first, second };\nconst tail = true;';
			const afterContent = 'const stable = true;\nconst first = "new";\nconst second = "new";\nexport { first, second };\nconst tail = true;';
			const contentByUri = new Map<string, string>([
				[beforeUri.toString(), beforeContent],
				[afterUri.toString(), afterContent],
			]);
			let modelRefDisposeCount = 0;
			let workerDiffCount = 0;
			let previewModelResolveCount = 0;
			instantiationService.stub(ICodeCompareModelService, {
				_serviceBrand: undefined,
				createModel: async () => ({
					object: {
						originalSha1: 'before-sha',
						original: { textEditorModel: { uri: beforeUri, getValue: () => beforeContent } },
						modified: { textEditorModel: { uri: afterUri, getValue: () => afterContent } },
					},
					dispose: () => modelRefDisposeCount++,
				}),
			} as unknown as ICodeCompareModelService);
			instantiationService.stub(IEditorWorkerService, {
				_serviceBrand: undefined,
				computeDiff: async () => {
					workerDiffCount++;
					return {
						changes: [createExactLineChange(2, 4, 2, 4)],
						identical: false,
						quitEarly: false,
						moves: [],
					};
				},
			} as unknown as IEditorWorkerService);
			instantiationService.stub(ITextModelService, {
				_serviceBrand: undefined,
				createModelReference: async (resource: URI) => {
					previewModelResolveCount++;
					return {
						object: { textEditorModel: { uri: resource, getValue: () => contentByUri.get(resource.toString()) ?? '' } },
						dispose: () => { },
					};
				},
			} as unknown as ITextModelService);

			const context = createMockRenderContext(true);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			Object.assign(context.element, { setVote: () => undefined });
			const edit: IChatTextEditGroup = {
				kind: 'textEditGroup',
				uri: fileUri,
				edits: [[], []],
				done: true,
			};
			const part = disposables.add(instantiationService.createInstance(
				ChatTextEditContentPart,
				edit,
				context,
				{},
				{} as DiffEditorPool,
				500,
			));
			let reportedStats: IEditSessionDiffStats | undefined;
			disposables.add(part.onDidChangeDiff(stats => reportedStats = stats));
			context.container.appendChild(part.domNode);
			mainWindow.document.body.appendChild(context.container);
			disposables.add(toDisposable(() => context.container.remove()));
			for (let attempt = 0; attempt < 100 && !part.domNode.classList.contains('chat-external-edit-preview'); attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}
			for (let attempt = 0; attempt < 100 && !part.domNode.querySelector('.chat-external-edit-diff-row'); attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}

			const body = part.domNode.querySelector<HTMLElement>(':scope > .chat-external-edit-diff-body');
			assert.deepStrictEqual({
				compactCard: part.domNode.classList.contains('chat-external-edit-card'),
				preview: part.domNode.classList.contains('chat-external-edit-preview'),
				fullCompareEditors: context.container.querySelectorAll('.interactive-result-code-block.compare, .interactive-result-editor').length,
				fileName: part.domNode.querySelector('.icon-label')?.textContent,
				added: part.domNode.querySelector('.label-added')?.textContent,
				removed: part.domNode.querySelector('.label-removed')?.textContent,
				rows: body?.querySelectorAll('.chat-external-edit-diff-content > .chat-external-edit-diff-row').length,
				overflowFade: body?.classList.contains('chat-external-edit-diff-overflow'),
				workerDiffCount,
				previewModelResolveCount,
				reportedStats,
			}, {
				compactCard: true,
				preview: true,
				fullCompareEditors: 0,
				fileName: 'entities.js',
				added: '+2',
				removed: '-2',
				rows: 6,
				overflowFade: true,
				workerDiffCount: 1,
				previewModelResolveCount: 0,
				reportedStats: { added: 2, removed: 2 },
			});

				part.dispose();
					assert.strictEqual(modelRefDisposeCount, 1, 'Disposing the compact card should release compare models immediately');
				});

				test('Cursor textEditGroup uses one viewport gate and mounts its seeded preview immediately after intersection', async () => {
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

						disconnect(): void { this.record.disconnected = true; }
						observe(target: Element): void { this.record.target = target; }
						takeRecords(): IntersectionObserverEntry[] { return []; }
						unobserve(_target: Element): void { }
					}

					const intersectionObserverDescriptor = Object.getOwnPropertyDescriptor(mainWindow, 'IntersectionObserver');
					Object.defineProperty(mainWindow, 'IntersectionObserver', {
						configurable: true,
						writable: true,
						value: FakeIntersectionObserver,
					});
					disposables.add(toDisposable(() => {
						if (intersectionObserverDescriptor) {
							Object.defineProperty(mainWindow, 'IntersectionObserver', intersectionObserverDescriptor);
						} else {
							delete (mainWindow as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
						}
					}));

					const beforeUri = URI.parse('chat-text-edit://before/viewport.ts');
					const afterUri = URI.parse('chat-text-edit://after/viewport.ts');
					const beforeContent = 'const value = 1;';
					const afterContent = 'const value = 2;';
					instantiationService.stub(ICodeCompareModelService, {
						_serviceBrand: undefined,
						createModel: async () => ({
							object: {
								originalSha1: 'before-sha',
								original: { textEditorModel: { uri: beforeUri, getValue: () => beforeContent } },
								modified: { textEditorModel: { uri: afterUri, getValue: () => afterContent } },
							},
							dispose: () => { },
						}),
					} as unknown as ICodeCompareModelService);
					instantiationService.stub(IEditorWorkerService, {
						_serviceBrand: undefined,
						computeDiff: async () => null,
					} as unknown as IEditorWorkerService);

					const context = createMockRenderContext(true);
					context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
					Object.assign(context.element, { setVote: () => undefined });
					const part = disposables.add(instantiationService.createInstance(
						ChatTextEditContentPart,
						{ kind: 'textEditGroup', uri: URI.file('/project/src/viewport.ts'), edits: [[]], done: true },
						context,
						{},
						{} as DiffEditorPool,
						500,
					));
					context.container.appendChild(part.domNode);

					assert.strictEqual(observerRecords.length, 1, 'the lightweight shell should own one viewport observer');
					assert.strictEqual(part.domNode.querySelector('.chat-external-edit-diff-body'), null);
					const outerObserver = observerRecords[0];
					assert.ok(outerObserver.target);
					outerObserver.callback([{
						isIntersecting: true,
						intersectionRatio: 1,
						target: outerObserver.target,
					} as IntersectionObserverEntry], outerObserver.observer);

					for (let attempt = 0; attempt < 100 && !part.domNode.querySelector('.chat-external-edit-diff-row'); attempt++) {
						await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
					}
					assert.deepStrictEqual({
						observers: observerRecords.length,
						outerDisconnected: outerObserver.disconnected,
						rows: part.domNode.querySelectorAll('.chat-external-edit-diff-row').length,
					}, {
						observers: 1,
						outerDisconnected: true,
						rows: 2,
					}, 'the proven-near replacement card must not allocate a second observer');
				});

				test('Cursor textEditGroup mounts its preview before the worker diff and updates the same card', async () => {
				const fileUri = URI.file('/project/src/deferred-worker.ts');
				const beforeUri = URI.parse('chat-text-edit://before/deferred-worker.ts');
				const afterUri = URI.parse('chat-text-edit://after/deferred-worker.ts');
				const beforeContent = 'const stable = true;\nconst oldA = 1;\nconst oldB = 2;\nconst tail = true;';
				const afterContent = 'const stable = true;\nconst nextA = 3;\nconst nextB = 4;\nconst tail = true;';
				let modelRefDisposeCount = 0;
				let workerDiffCount = 0;
				let resolveWorkerDiff!: (value: {
					changes: DetailedLineRangeMapping[];
					identical: boolean;
					quitEarly: boolean;
					moves: never[];
				}) => void;
				const workerDiff = new Promise<{
					changes: DetailedLineRangeMapping[];
					identical: boolean;
					quitEarly: boolean;
					moves: never[];
				}>(resolve => resolveWorkerDiff = resolve);
				instantiationService.stub(ICodeCompareModelService, {
					_serviceBrand: undefined,
					createModel: async () => ({
						object: {
							originalSha1: 'before-sha',
							original: { textEditorModel: { uri: beforeUri, getValue: () => beforeContent } },
							modified: { textEditorModel: { uri: afterUri, getValue: () => afterContent } },
						},
						dispose: () => modelRefDisposeCount++,
					}),
				} as unknown as ICodeCompareModelService);
				instantiationService.stub(IEditorWorkerService, {
					_serviceBrand: undefined,
					computeDiff: () => {
						workerDiffCount++;
						return workerDiff;
					},
				} as unknown as IEditorWorkerService);
				instantiationService.stub(ITextModelService, {
					_serviceBrand: undefined,
					createModelReference: async () => {
						throw new Error('Seeded preview should not resolve snapshot models');
					},
				} as unknown as ITextModelService);

				const context = createMockRenderContext(true);
				context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
				Object.assign(context.element, { setVote: () => undefined });
				const part = disposables.add(instantiationService.createInstance(
					ChatTextEditContentPart,
					{
						kind: 'textEditGroup',
						uri: fileUri,
						edits: [[]],
						done: true,
					},
					context,
					{},
					{} as DiffEditorPool,
					500,
				));
				let reportedStats: IEditSessionDiffStats | undefined;
				disposables.add(part.onDidChangeDiff(stats => reportedStats = stats));
				context.container.appendChild(part.domNode);
				mainWindow.document.body.appendChild(context.container);
				disposables.add(toDisposable(() => context.container.remove()));

				for (let attempt = 0; attempt < 100 && !part.domNode.querySelector('.chat-external-edit-diff-row'); attempt++) {
					await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
				}
				const cardIdentity = part.domNode;
				assert.deepStrictEqual({
					cardMounted: cardIdentity.classList.contains('chat-external-edit-card'),
					previewRows: cardIdentity.querySelectorAll('.chat-external-edit-diff-row').length,
					addedCounter: cardIdentity.querySelector('.label-added'),
					removedCounter: cardIdentity.querySelector('.label-removed'),
					workerDiffCount,
					reportedStats,
				}, {
					cardMounted: true,
					previewRows: 6,
					addedCounter: null,
					removedCounter: null,
					workerDiffCount: 1,
					reportedStats: undefined,
				}, 'The compact preview must be useful while exact stats are still pending');

				resolveWorkerDiff({
					changes: [createExactLineChange(2, 4, 2, 4)],
					identical: false,
					quitEarly: false,
					moves: [],
				});
				for (let attempt = 0; attempt < 100 && !part.domNode.querySelector('.label-added'); attempt++) {
					await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
				}

				assert.deepStrictEqual({
					sameCard: part.domNode === cardIdentity,
					added: part.domNode.querySelector('.label-added')?.textContent,
					removed: part.domNode.querySelector('.label-removed')?.textContent,
					workerDiffCount,
					reportedStats,
				}, {
					sameCard: true,
					added: '+2',
					removed: '-2',
					workerDiffCount: 1,
					reportedStats: { added: 2, removed: 2 },
				}, 'Worker completion should update counters in place without re-rendering the card');

				part.dispose();
				assert.strictEqual(modelRefDisposeCount, 1);
			});

			test('Cursor streaming textEditGroup reuses a lightweight shell until the diff is final', async () => {
			let modelCreateCount = 0;
			let workerDiffCount = 0;
			instantiationService.stub(ICodeCompareModelService, {
				_serviceBrand: undefined,
				createModel: async () => {
					modelCreateCount++;
					throw new Error('streaming diff should not resolve models');
				},
			} as unknown as ICodeCompareModelService);
			instantiationService.stub(IEditorWorkerService, {
				_serviceBrand: undefined,
				computeDiff: async () => {
					workerDiffCount++;
					return null;
				},
			} as unknown as IEditorWorkerService);

			const context = createMockRenderContext(false);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			Object.assign(context.element, { setVote: () => undefined });
			const fileUri = URI.file('/project/src/streaming.ts');
			const part = disposables.add(instantiationService.createInstance(
				ChatTextEditContentPart,
				{
					kind: 'textEditGroup',
					uri: fileUri,
					edits: [[]],
					done: false,
				},
				context,
				{},
				{} as DiffEditorPool,
				500,
			));

			await Promise.resolve();
			const nextStreamingBatch: IChatTextEditGroup = {
				kind: 'textEditGroup',
				uri: fileUri,
				edits: [[], [], []],
				done: false,
			};
			const completedEdit: IChatTextEditGroup = {
				...nextStreamingBatch,
				done: true,
			};

			assert.deepStrictEqual({
				label: part.domNode.textContent,
				modelCreateCount,
				workerDiffCount,
				reusesStreamingShell: part.hasSameContent(nextStreamingBatch, [], context.element),
				rerendersOnceAtCompletion: !part.hasSameContent(completedEdit, [], context.element),
			}, {
				label: 'Editing streaming.ts…',
				modelCreateCount: 0,
				workerDiffCount: 0,
				reusesStreamingShell: true,
				rerendersOnceAtCompletion: true,
			});
		});

		test('Cursor external edit caps its collapsed preview and hydrates the full diff on expansion', async () => {
			const afterUri = URI.parse('chat-edit://after/large-preview.ts');
			const afterContent = Array.from({ length: 40 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n');
			let modelResolveCount = 0;
			instantiationService.stub(ITextModelService, {
				_serviceBrand: undefined,
				createModelReference: async () => {
					modelResolveCount++;
					return {
						object: { textEditorModel: { getValue: () => afterContent } },
						dispose: () => { },
					};
				},
			} as unknown as ITextModelService);

			const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, {
				kind: 'externalEdit',
				uri: URI.file('/project/src/large-preview.ts'),
				editKind: 'create',
				diff: { added: 40, removed: 0 },
				afterContentUri: afterUri,
			}));
			part.showDiffPreview();
			for (let attempt = 0; attempt < 100 && part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body')?.dataset.renderMode !== 'preview'; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}

			const body = part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body');
			assert.ok(body);
			const previewRows = body.querySelectorAll('.chat-external-edit-diff-row').length;
			part.expandDiffBody();
			for (let attempt = 0; attempt < 100 && body.dataset.renderMode !== 'full'; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}
			const fullRows = body.querySelectorAll('.chat-external-edit-diff-row').length;
			const expandControl = part.domNode.querySelector<HTMLElement>('.chat-external-edit-expand');
			assert.ok(expandControl);
			expandControl.click();
			for (let attempt = 0; attempt < 100 && body.dataset.renderMode !== 'preview'; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}
			const releasedRows = body.querySelectorAll('.chat-external-edit-diff-row').length;
			part.expandDiffBody();
			for (let attempt = 0; attempt < 100 && body.dataset.renderMode !== 'full'; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}

			assert.deepStrictEqual({
				previewRows,
				fullRows,
				releasedRows,
				reopenedRows: body.querySelectorAll('.chat-external-edit-diff-row').length,
				renderMode: body.dataset.renderMode,
				expanded: part.domNode.classList.contains('chat-external-edit-expanded'),
				modelResolveCount,
			}, {
				previewRows: 8,
				fullRows: 40,
				releasedRows: 8,
				reopenedRows: 40,
				renderMode: 'full',
				expanded: true,
				modelResolveCount: 1,
			});
		});

		test('Cursor external edit keeps its compact preview when full hydration fails', async () => {
			const beforeUri = URI.parse('chat-edit://before/resilient-preview.ts');
			const afterUri = URI.parse('chat-edit://after/resilient-preview.ts');
			const contentByUri = new Map<string, string>([
				[beforeUri.toString(), 'export const value = 1;'],
				[afterUri.toString(), 'export const value = 2;'],
			]);
			let modelResolveCount = 0;
			instantiationService.stub(ITextModelService, {
				_serviceBrand: undefined,
				createModelReference: async (resource: URI) => {
					modelResolveCount++;
					return {
						object: { textEditorModel: { uri: resource, getValue: () => contentByUri.get(resource.toString()) ?? '' } },
						dispose: () => { },
					};
				},
			} as unknown as ITextModelService);
			instantiationService.stub(IEditorWorkerService, {
				_serviceBrand: undefined,
				computeDiff: async () => {
					throw new Error('transient full hydration failure');
				},
			} as unknown as IEditorWorkerService);

			const part = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, {
				kind: 'externalEdit',
				uri: URI.file('/project/src/resilient-preview.ts'),
				editKind: 'edit',
				diff: { added: 1, removed: 1 },
				beforeContentUri: beforeUri,
				afterContentUri: afterUri,
			}));
			part.showDiffPreview();
			const body = part.domNode.querySelector<HTMLElement>('.chat-external-edit-diff-body');
			assert.ok(body);
			for (let attempt = 0; attempt < 100 && body.dataset.renderMode !== 'preview'; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}
			const previewRows = body.querySelectorAll('.chat-external-edit-diff-row').length;

			part.expandDiffBody();
			for (let attempt = 0; attempt < 100 && modelResolveCount < 4; attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}
			await Promise.resolve();

			assert.deepStrictEqual({
				renderMode: body.dataset.renderMode,
				rows: body.querySelectorAll('.chat-external-edit-diff-row').length,
				unavailable: body.textContent?.includes('Diff unavailable'),
				expanded: part.domNode.classList.contains('chat-external-edit-expanded'),
				modelResolveCount,
			}, {
				renderMode: 'preview',
				rows: previewRows,
				unavailable: false,
				expanded: true,
				modelResolveCount: 4,
			});
		});

		test('restored Cursor transcript eagerly mounts one-sided create and delete previews plus markdown artifacts', async () => {
			const createAfterUri = URI.parse('chat-edit://after/created.ts');
			const deleteBeforeUri = URI.parse('chat-edit://before/deleted.ts');
			const contentByUri = new Map<string, string>([
				[createAfterUri.toString(), 'export const created = true;\nexport const ready = true;'],
				[deleteBeforeUri.toString(), 'export const removed = true;\nexport const stale = true;'],
			]);
			instantiationService.stub(ITextModelService, {
				_serviceBrand: undefined,
				createModelReference: async (resource: URI) => ({
					object: {
						textEditorModel: {
							getValue: () => contentByUri.get(resource.toString()) ?? '',
						},
					},
					dispose: () => { },
				}),
			} as unknown as ITextModelService);

			const context = createMockRenderContext(true);
			context.container.classList.add('backboard-clean-chat', 'backboard-cursor-transcript');
			const part = disposables.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				createThinkingPart('Restored completed reasoning'),
				context,
				mockMarkdownRenderer,
				true
			));
			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true, 'Restored completed Thought should begin outer-collapsed');

			const createEdit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/created.ts'),
				editKind: 'create',
				diff: { added: 2, removed: 0 },
				afterContentUri: createAfterUri,
			};
			const deleteEdit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/deleted.ts'),
				editKind: 'delete',
				diff: { added: 0, removed: 2 },
				beforeContentUri: deleteBeforeUri,
			};
			const createPart = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, createEdit));
			const deletePart = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, deleteEdit));
			createPart.showDiffPreview();
			deletePart.showDiffPreview();
			const markdown: IChatMarkdownContent = {
				kind: 'markdownContent',
				content: { value: 'Updated inline markdown artifact' },
			};
			const markdownRoot = $('div.cursor-test-restored-markdown-artifact', {}, 'Updated inline markdown artifact');
			const materialized: string[] = [];
			part.appendItem(() => {
				materialized.push('create');
				return { domNode: createPart.domNode };
			}, undefined, createEdit);
			part.appendItem(() => {
				materialized.push('delete');
				return { domNode: deletePart.domNode };
			}, undefined, deleteEdit);
			part.appendItem(() => {
				materialized.push('markdown');
				return { domNode: markdownRoot };
			}, undefined, markdown);

			for (let attempt = 0; attempt < 100 && (!createPart.domNode.querySelector('.chat-external-edit-diff-row') || !deletePart.domNode.querySelector('.chat-external-edit-diff-row')); attempt++) {
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 5));
			}

			const editRows = Array.from(part.domNode.querySelectorAll<HTMLElement>('.chat-thinking-cursor-edit-row'));
			const createMarkers = Array.from(createPart.domNode.querySelectorAll<HTMLElement>('.chat-external-edit-diff-marker')).map(marker => marker.textContent);
			const deleteMarkers = Array.from(deletePart.domNode.querySelectorAll<HTMLElement>('.chat-external-edit-diff-marker')).map(marker => marker.textContent);
			assert.deepStrictEqual({
				outerCollapsed: part.domNode.classList.contains('chat-used-context-collapsed'),
				materialized,
				rowCount: editRows.length,
				create: {
					card: createPart.domNode.classList.contains('chat-external-edit-card'),
					preview: createPart.domNode.classList.contains('chat-external-edit-preview'),
					expandAria: createPart.domNode.querySelector('.chat-external-edit-expand')?.getAttribute('aria-expanded'),
					body: !!createPart.domNode.querySelector('.chat-external-edit-diff-body'),
					overflowFade: createPart.domNode.querySelector('.chat-external-edit-diff-body')?.classList.contains('chat-external-edit-diff-overflow'),
					note: createPart.domNode.querySelector('.chat-external-edit-diff-note')?.textContent,
					markers: createMarkers,
				},
				delete: {
					card: deletePart.domNode.classList.contains('chat-external-edit-card'),
					preview: deletePart.domNode.classList.contains('chat-external-edit-preview'),
					expandAria: deletePart.domNode.querySelector('.chat-external-edit-expand')?.getAttribute('aria-expanded'),
					body: !!deletePart.domNode.querySelector('.chat-external-edit-diff-body'),
					overflowFade: deletePart.domNode.querySelector('.chat-external-edit-diff-body')?.classList.contains('chat-external-edit-diff-overflow'),
					note: deletePart.domNode.querySelector('.chat-external-edit-diff-note')?.textContent,
					markers: deleteMarkers,
				},
				markdown: {
					identity: editRows[2]?.querySelector('.cursor-test-restored-markdown-artifact') === markdownRoot,
					card: markdownRoot.classList.contains('chat-external-edit-card'),
				},
			}, {
				outerCollapsed: true,
				materialized: ['create', 'delete', 'markdown'],
				rowCount: 3,
				create: {
					card: true,
					preview: true,
					expandAria: 'false',
					body: true,
					overflowFade: false,
					note: undefined,
					markers: ['+', '+'],
				},
				delete: {
					card: true,
					preview: true,
					expandAria: 'false',
					body: true,
					overflowFade: false,
					note: undefined,
					markers: ['-', '-'],
				},
				markdown: {
					identity: true,
					card: false,
				},
			});
		});

		test('non-Cursor external edit remains collapsed and leaves sibling tabs and composer untouched', () => {
			const shell = $('.cursor-test-non-cursor-shell');
			const tabs = $('div.chat-view-title-tabs', { 'data-test-state': 'tabs' }, $('span', {}, 'Agent'));
			const content = $('div.backboard-clean-chat');
			const composer = $('div.backboard-composer', { 'data-test-state': 'composer' }, $('textarea', { 'aria-label': 'Message' }));
			shell.append(tabs, content, composer);
			mainWindow.document.body.appendChild(shell);
			disposables.add(toDisposable(() => shell.remove()));
			const chromeBefore = { tabs: tabs.outerHTML, composer: composer.outerHTML };
			const edit: IChatExternalEdit = {
				kind: 'externalEdit',
				uri: URI.file('/project/src/chat.css'),
				editKind: 'edit',
				diff: { added: 4, removed: 1 },
				beforeContentUri: URI.parse('chat-edit://before/chat.css'),
				afterContentUri: URI.parse('chat-edit://after/chat.css'),
			};
			const editPart = disposables.add(instantiationService.createInstance(ChatExternalEditContentPart, edit));
			content.appendChild(editPart.domNode);

			assert.deepStrictEqual({
				card: editPart.domNode.classList.contains('chat-external-edit-card'),
				preview: editPart.domNode.classList.contains('chat-external-edit-preview'),
				expanded: editPart.domNode.classList.contains('chat-external-edit-expanded'),
				expandAria: editPart.domNode.querySelector('.chat-external-edit-expand')?.getAttribute('aria-expanded'),
				body: editPart.domNode.querySelector('.chat-external-edit-diff-body'),
				chromeAfter: { tabs: tabs.outerHTML, composer: composer.outerHTML },
				leakedCards: tabs.querySelectorAll('.chat-external-edit-card').length + composer.querySelectorAll('.chat-external-edit-card').length,
			}, {
				card: true,
				preview: false,
				expanded: false,
				expandAria: 'false',
				body: null,
				chromeAfter: chromeBefore,
				leakedCards: 0,
			});
		});
	});

	suite('ThinkingDisplayMode.FixedScrolling', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.FixedScrolling);
		});

		test('should have fixed mode class', () => {
			const content = createThinkingPart('**Scrolling content**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			assert.ok(part.domNode.classList.contains('chat-thinking-fixed-mode'),
				'Should have fixed mode class');
		});

		test('should init content early (eager rendering)', () => {
			const content = createThinkingPart('**Fixed scrolling content**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Fixed mode should initialize content immediately (eager rendering)
			// The scrollable element should be present
			const scrollableContent = part.domNode.querySelector('.monaco-scrollable-element');
			assert.ok(scrollableContent, 'Should have scrollable element in fixed mode (eager rendering)');
		});

		test('should create scrollable container', () => {
			const content = createThinkingPart('**Content with scrolling**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const scrollable = part.domNode.querySelector('.monaco-scrollable-element');
			assert.ok(scrollable, 'Should have scrollable container');
		});
	});

	suite('Thinking content updates', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('updateThinking should update content', () => {
			const content = createThinkingPart('**Initial**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// First expand to render content
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Update the thinking content
			const updatedContent = createThinkingPart('**Updated thinking**', content.id);
			part.updateThinking(updatedContent);

			// Verify the content was updated
			const thinkingItem = part.domNode.querySelector('.chat-thinking-item');
			assert.ok(thinkingItem, 'Should have thinking item');
		});

		test('should track multiple title extractions', () => {
			const content = createThinkingPart('**First title**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Expand first
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Update with new title
			part.updateThinking(createThinkingPart('**Second title**', content.id));
			part.updateThinking(createThinkingPart('**Third title**', content.id));

			// The part should track these titles for finalization
			assert.ok(part.domNode, 'Part should still be valid');
		});
	});

	suite('Tool invocation appending', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('appendItem should use lazy rendering when collapsed', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			let factoryCalled = false;
			const factory = () => {
				factoryCalled = true;
				return {
					domNode: $('div.test-tool-item'),
					disposable: undefined
				};
			};

			// Append item while collapsed
			part.appendItem(factory, 'test-tool-id');

			// Factory should NOT be called yet due to lazy rendering
			assert.strictEqual(factoryCalled, false, 'Factory should not be called when collapsed (lazy rendering)');
		});

		test('appendItem should render immediately when expanded', () => {
			const content = createThinkingPart('**Working**\nSome detailed analysis of the problem');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Expand first
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			let factoryCalled = false;
			const factory = () => {
				factoryCalled = true;
				const div = $('div.test-tool-item');
				div.textContent = 'Test tool content';
				return { domNode: div };
			};

			// Append item while expanded
			part.appendItem(factory, 'test-tool-id');

			// Factory should be called immediately when expanded
			assert.strictEqual(factoryCalled, true, 'Factory should be called immediately when expanded');
		});

		test('lazy items should materialize when first expanded', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			let factoryCalled = false;
			const factory = () => {
				factoryCalled = true;
				const div = $('div.test-tool-item');
				div.textContent = 'Lazy content';
				return { domNode: div };
			};

			// Append item while collapsed
			part.appendItem(factory, 'test-tool-id');
			assert.strictEqual(factoryCalled, false, 'Factory should not be called yet');

			// Now expand
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Factory should now be called
			assert.strictEqual(factoryCalled, true, 'Factory should be called after expanding');
		});

		test('removeLazyItem should remove pending lazy items', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			let factoryCalled = false;
			const factory = () => {
				factoryCalled = true;
				return { domNode: $('div.test-tool-item') };
			};

			// Append and then remove
			part.appendItem(factory, 'test-tool-to-remove');
			const removed = part.removeLazyItem('test-tool-to-remove');

			assert.strictEqual(removed, true, 'Should successfully remove the lazy item');
			assert.strictEqual(factoryCalled, false, 'Factory should never have been called');
		});

		test('lazy items should preserve append order when mixing tool and markdown items', () => {
			// This test verifies that when tool invocations and markdown items are appended
			// in a specific order while collapsed, the DOM order matches the append order
			// when expanded. This catches the bug where markdown items render before
			// tool items because markdown isn't lazy.
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const appendOrder: string[] = [];

			// Append in order: tool1, markdown, tool2
			// Tool 1
			part.appendItem(() => {
				appendOrder.push('tool1');
				const div = $('div.test-item');
				div.setAttribute('data-order', 'tool1');
				div.textContent = 'Tool 1';
				return { domNode: div };
			}, 'tool-1');

			// Markdown content (simulated - no toolInvocationId means it's markdown-like)
			const markdownItem: IChatMarkdownContent = {
				kind: 'markdownContent',
				content: { value: 'test markdown' }
			};
			part.appendItem(() => {
				appendOrder.push('markdown');
				const div = $('div.test-item');
				div.setAttribute('data-order', 'markdown');
				div.textContent = 'Markdown content';
				return { domNode: div };
			}, undefined, markdownItem);

			// Tool 2
			part.appendItem(() => {
				appendOrder.push('tool2');
				const div = $('div.test-item');
				div.setAttribute('data-order', 'tool2');
				div.textContent = 'Tool 2';
				return { domNode: div };
			}, 'tool-2');

			// Nothing should have rendered yet
			assert.strictEqual(appendOrder.length, 0, 'No items should be rendered while collapsed');

			// Now expand to trigger lazy rendering
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// All items should now be rendered
			assert.strictEqual(appendOrder.length, 3, 'All 3 items should be rendered after expanding');

			// Verify the render order matches append order
			assert.deepStrictEqual(appendOrder, ['tool1', 'markdown', 'tool2'],
				'Items should render in the same order they were appended (tool1, markdown, tool2)');

			// Also verify the DOM order
			const wrapper = part.domNode.querySelector('.chat-used-context-list');
			const toolWrappers = wrapper?.querySelectorAll('.chat-thinking-tool-wrapper');
			assert.ok(toolWrappers, 'Should have tool wrappers');
			assert.strictEqual(toolWrappers?.length, 3, 'Should have 3 tool wrappers');

			const domOrder = Array.from(toolWrappers!).map(el => {
				const testItem = el.querySelector('.test-item');
				return testItem?.getAttribute('data-order');
			});

			assert.deepStrictEqual(domOrder, ['tool1', 'markdown', 'tool2'],
				'DOM order should match append order (tool1, markdown, tool2)');
		});

		test('setupThinkingContainer should preserve order with lazy tool items', () => {
			// This test reproduces the bug where markdown parts added via setupThinkingContainer
			// render before tool parts because setupThinkingContainer doesn't use lazy rendering.
			// Expected behavior: tool1, thinking2, tool2 in DOM order
			// Bug behavior: thinking2 renders before tool1 because its not lazy
			const initialContent = createThinkingPart('**Initial thinking**', 'thinking-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				initialContent,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Append tool1 while collapsed (lazy)
			let tool1Rendered = false;
			part.appendItem(() => {
				tool1Rendered = true;
				const div = $('div.test-item');
				div.setAttribute('data-test-id', 'tool1');
				div.textContent = 'Tool 1';
				return { domNode: div };
			}, 'tool-1');

			// Now setupThinkingContainer is called for a new thinking section
			// This simulates what happens when a new thinking part arrives during streaming
			const newThinkingContent = createThinkingPart('**Second thinking section**', 'thinking-2');
			part.setupThinkingContainer(newThinkingContent);

			// Append tool2 while collapsed (lazy)
			let tool2Rendered = false;
			part.appendItem(() => {
				tool2Rendered = true;
				const div = $('div.test-item');
				div.setAttribute('data-test-id', 'tool2');
				div.textContent = 'Tool 2';
				return { domNode: div };
			}, 'tool-2');

			// Tools should not have rendered yet
			assert.strictEqual(tool1Rendered, false, 'Tool 1 should not render while collapsed');
			assert.strictEqual(tool2Rendered, false, 'Tool 2 should not render while collapsed');

			// Now expand
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Everything should render now
			assert.strictEqual(tool1Rendered, true, 'Tool 1 should render after expand');
			assert.strictEqual(tool2Rendered, true, 'Tool 2 should render after expand');

			// Get all rendered items and check their order
			const wrapper = part.domNode.querySelector('.chat-used-context-list');
			assert.ok(wrapper, 'Should have wrapper');

			// The children should be in order: initial-thinking, tool1-wrapper, thinking2, tool2-wrapper
			// Get all direct children to check order
			const children = Array.from(wrapper!.children);

			// Find indices of our items
			const tool1Index = children.findIndex(el =>
				el.classList.contains('chat-thinking-tool-wrapper') &&
				el.querySelector('[data-test-id="tool1"]')
			);
			const tool2Index = children.findIndex(el =>
				el.classList.contains('chat-thinking-tool-wrapper') &&
				el.querySelector('[data-test-id="tool2"]')
			);

			// Find thinking containers (they have class chat-thinking-item)
			const thinkingItems = children.filter(el => el.classList.contains('chat-thinking-item'));

			// We should have 2 thinking items (initial and the one from setupThinkingContainer)
			// and 2 tool wrappers
			assert.ok(thinkingItems.length >= 1, 'Should have at least one thinking item');
			assert.ok(tool1Index >= 0, 'Should find tool1');
			assert.ok(tool2Index >= 0, 'Should find tool2');

			// The key assertion: tool1 should come before tool2 in DOM order
			// and any thinking content between them should also be in order
			assert.ok(tool1Index < tool2Index,
				`Tool1 (index ${tool1Index}) should come before Tool2 (index ${tool2Index}) in DOM order`);
		});

		test('markdown via updateThinking should preserve order with lazy tool items (BUG: markdown renders before tools)', () => {
			// This test exposes the lazy rendering bug where markdown content from updateThinking/
			// setupThinkingContainer gets rendered immediately and placed in DOM before tool items.
			//
			// The bug flow:
			// 1. Tool1 arrives → appendItem() → stored in lazyItems (not rendered yet)
			// 2. Thinking/markdown arrives → setupThinkingContainer() → textContainer created,
			//    updateThinking() → renderMarkdown() renders IMMEDIATELY into textContainer
			// 3. Tool2 arrives → appendItem() → stored in lazyItems (not rendered yet)
			// 4. User expands → initContent() creates wrapper, adds textContainer FIRST,
			//    then materializes lazyItems (tools)
			//
			// Result: DOM order is [markdown, tool1, tool2] instead of [tool1, markdown, tool2]
			const initialContent = createThinkingPart('', 'thinking-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				initialContent,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Step 1: Tool1 arrives while collapsed - should be lazy
			part.appendItem(() => {
				const div = $('div.test-item');
				div.setAttribute('data-test-id', 'tool1');
				div.setAttribute('data-order', '1');
				div.textContent = 'Tool 1';
				return { domNode: div };
			}, 'tool-1');

			// Step 2: New thinking section arrives - this uses setupThinkingContainer + updateThinking
			// In the bug, this creates textContainer and renders markdown immediately
			const thinkingContent = createThinkingPart('**Analyzing the codebase**', 'thinking-2');
			part.setupThinkingContainer(thinkingContent);

			// Step 3: Tool2 arrives while collapsed - should be lazy
			part.appendItem(() => {
				const div = $('div.test-item');
				div.setAttribute('data-test-id', 'tool2');
				div.setAttribute('data-order', '3');
				div.textContent = 'Tool 2';
				return { domNode: div };
			}, 'tool-2');

			// Now expand to trigger lazy rendering
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Get the wrapper and check DOM order
			const wrapper = part.domNode.querySelector('.chat-used-context-list');
			assert.ok(wrapper, 'Should have wrapper after expanding');

			const children = Array.from(wrapper!.children);

			// Find indices
			const tool1Index = children.findIndex(el =>
				el.querySelector('[data-test-id="tool1"]')
			);
			const tool2Index = children.findIndex(el =>
				el.querySelector('[data-test-id="tool2"]')
			);
			const markdownIndex = children.findIndex(el =>
				el.classList.contains('chat-thinking-item') && el.classList.contains('markdown-content')
			);

			assert.ok(tool1Index >= 0, `Should find tool1 in DOM (found at index ${tool1Index})`);
			assert.ok(tool2Index >= 0, `Should find tool2 in DOM (found at index ${tool2Index})`);
			assert.ok(markdownIndex >= 0, `Should find markdown in DOM (found at index ${markdownIndex})`);

			// The key assertion: order should match arrival order (tool1, markdown, tool2)
			// BUG: Currently markdown is always first because it's not lazy
			assert.ok(tool1Index < markdownIndex,
				`BUG: Tool1 (index ${tool1Index}) should come BEFORE markdown (index ${markdownIndex}) ` +
				`because tool1 was appended first. Current DOM order indicates markdown is eagerly ` +
				`placed first regardless of arrival order.`);
			assert.ok(markdownIndex < tool2Index,
				`Markdown (index ${markdownIndex}) should come before Tool2 (index ${tool2Index})`);
		});

		test('lazy thinking items should show updated content after streaming updates', () => {
			// This test exposes the bug where streaming updates to thinking content are lost
			// when the thinking part is collapsed.
			//
			// Bug flow:
			// 1. setupThinkingContainer(content1) creates lazy item with content1
			// 2. updateThinking(content2) is called with updated streaming content
			//    - this.content is updated to content2
			//    - this.currentThinkingValue is updated
			//    - but the lazy item still stores content1
			// 3. User expands:
			//    - initContent creates a NEW textContainer with currentThinkingValue (latest)
			//    - materializeLazyItem appends ANOTHER container from lazy item with stale content
			//
			// Result: Duplicate thinking containers, one with correct content, one with stale
			const initialContent = createThinkingPart('', 'thinking-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				initialContent,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Step 1: New thinking section arrives while collapsed
			const thinkingContent1 = createThinkingPart('**Starting analysis**', 'thinking-2');
			part.setupThinkingContainer(thinkingContent1);

			// Step 2: Streaming continues - more content arrives via updateThinking
			const thinkingContent2 = createThinkingPart('**Starting analysis** Looking at the code structure...', 'thinking-2');
			part.updateThinking(thinkingContent2);

			// Step 3: Even more streaming content
			const thinkingContent3 = createThinkingPart('**Starting analysis** Looking at the code structure... Found the issue in the parser module.', 'thinking-2');
			part.updateThinking(thinkingContent3);

			// Now expand to trigger lazy rendering
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Get the rendered content
			const wrapper = part.domNode.querySelector('.chat-used-context-list');
			assert.ok(wrapper, 'Should have wrapper after expanding');

			// Get ALL thinking items - the bug creates duplicate containers
			const thinkingItems = wrapper!.querySelectorAll('.chat-thinking-item.markdown-content');

			// BUG: There should only be ONE thinking item, but the bug causes TWO:
			// 1. One from initContent with correct current content
			// 2. One from materializeLazyItem with stale content
			assert.strictEqual(thinkingItems.length, 1,
				`BUG: Should have exactly 1 thinking item, but got ${thinkingItems.length}. ` +
				`materializeLazyItem creates a duplicate container from the lazy item. ` +
				`Items: ${Array.from(thinkingItems).map(i => `"${i.textContent}"`).join(', ')}`);

			// Also verify the single item has the latest content
			if (thinkingItems.length === 1) {
				const renderedText = thinkingItems[0].textContent || '';
				assert.ok(
					renderedText.includes('Found the issue in the parser module'),
					`Content should show latest streaming update. Got: "${renderedText}"`
				);
			}
		});

		test('lazy thinking items should work without streaming updates after setupThinkingContainer', () => {
			// Edge case: setupThinkingContainer is called but no subsequent updateThinking arrives
			// In this case, the lazy item's content should be used when materializing
			const initialContent = createThinkingPart('', 'thinking-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				initialContent,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Only call setupThinkingContainer, no subsequent updateThinking
			const thinkingContent = createThinkingPart('**Analyzing files**', 'thinking-2');
			part.setupThinkingContainer(thinkingContent);

			// Expand to trigger lazy rendering
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			// Get the rendered content
			const wrapper = part.domNode.querySelector('.chat-used-context-list');
			assert.ok(wrapper, 'Should have wrapper after expanding');

			const thinkingItems = wrapper!.querySelectorAll('.chat-thinking-item.markdown-content');
			assert.strictEqual(thinkingItems.length, 1, 'Should have exactly 1 thinking item');

			// The content should be the one from setupThinkingContainer
			const renderedText = thinkingItems[0].textContent || '';
			assert.ok(
				renderedText.includes('Analyzing files'),
				`Content should show setupThinkingContainer content. Got: "${renderedText}"`
			);
		});
	});

	suite('State management', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('markAsInactive should update isActive state', () => {
			const content = createThinkingPart('**Active thinking**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			assert.strictEqual(part.getIsActive(), true, 'Should start as active');

			part.markAsInactive();

			assert.strictEqual(part.getIsActive(), false, 'Should be inactive after markAsInactive');
		});

		test('dispose should set isActive to false', () => {
			const content = createThinkingPart('**Active thinking**');
			const context = createMockRenderContext(false);

			const part = instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			);

			assert.strictEqual(part.getIsActive(), true, 'Should start as active');

			part.dispose();

			assert.strictEqual(part.getIsActive(), false, 'Should be inactive after dispose');
		});

		test('collapseContent should collapse the part', () => {
			const content = createThinkingPart('**Content**\nSome detailed reasoning that differs from the title');
			const context = createMockRenderContext(false);

			// Use CollapsedPreview to start expanded
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.CollapsedPreview);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Should be expanded initially
			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), false);

			part.collapseContent();

			assert.strictEqual(part.domNode.classList.contains('chat-used-context-collapsed'), true,
				'Should be collapsed after collapseContent');
		});

		test('finalizeTitleIfDefault should update button icon to check', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			part.finalizeTitleIfDefault();

			// The button should now show a check icon
			const iconElement = part.domNode.querySelector('.codicon-check');
			assert.ok(iconElement, 'Should have check icon after finalization');
		});

		test('finalizeTitleIfDefault should retain initial thinking title', () => {
			const content = createThinkingPart('**Reviewed renderer state**\nChecked completed response rendering');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			part.finalizeTitleIfDefault();

			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.deepStrictEqual({
				generatedTitle: content.generatedTitle,
				label: button.textContent,
				ariaLabel: button.ariaLabel,
			}, {
				generatedTitle: 'Reviewed renderer state',
				label: 'Reviewed renderer state',
				ariaLabel: 'Reviewed renderer state',
			});
		});

		test('finalizeTitleIfDefault should retain restored terminal title', () => {
			const content = createThinkingPart('');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const terminalTool: IChatToolInvocationSerialized = {
				kind: 'toolInvocationSerialized',
				toolId: 'run_in_terminal',
				toolCallId: 'terminal-call-1',
				invocationMessage: 'Running npm test',
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				isConfirmed: { type: 0 },
				isComplete: true,
				source: ToolDataSource.Internal,
				generatedTitle: 'Ran npm test',
				isAttachedToThinking: false,
				toolSpecificData: {
					kind: 'terminal',
					commandLine: { original: 'npm test' },
					language: 'shellscript',
				}
			};

			part.appendItem(() => ({ domNode: $('div.test-terminal-tool') }), terminalTool.toolId, terminalTool);
			part.finalizeTitleIfDefault();

			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.deepStrictEqual({
				contentGeneratedTitle: content.generatedTitle,
				toolGeneratedTitle: terminalTool.generatedTitle,
				label: button.textContent,
				ariaLabel: button.ariaLabel,
			}, {
				contentGeneratedTitle: 'Ran npm test',
				toolGeneratedTitle: 'Ran npm test',
				label: 'Ran npm test',
				ariaLabel: 'Ran npm test',
			});
		});
	});

	suite('hasSameContent', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('should return true for tool invocations', () => {
			const content = createThinkingPart('**Working**', 'id-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			const toolInvocation = {
				kind: 'toolInvocation' as const,
				toolId: 'test-tool',
				invocationMessage: 'Testing',
				resultDetails: [],
				isConfirmed: undefined,
				pastTenseMessage: undefined,
				isComplete: true,
				isCanceled: false
			} as unknown as IChatRendererContent;

			const result = part.hasSameContent(toolInvocation, [], context.element);
			assert.strictEqual(result, true, 'Should accept tool invocations as same content');
		});

		test('should return true for markdown content', () => {
			const content = createThinkingPart('**Working**', 'id-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			const markdownContent = {
				kind: 'markdownContent' as const,
				content: { value: 'test' }
			} as unknown as IChatRendererContent;

			const result = part.hasSameContent(markdownContent, [], context.element);
			assert.strictEqual(result, true, 'Should accept markdown content as same content');
		});

		test('should return false for different thinking part with same id', () => {
			const content = createThinkingPart('**Working**', 'id-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			const otherThinking: IChatRendererContent = createThinkingPart('**Different**', 'id-1');

			// When the id is the same, hasSameContent returns true (other.id !== this.id is false)
			const result = part.hasSameContent(otherThinking, [], context.element);
			assert.strictEqual(result, false, 'Should return false for thinking part with same id');
		});

		test('should return true for thinking part with different id', () => {
			const content = createThinkingPart('**Working**', 'id-1');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			const otherThinking: IChatRendererContent = createThinkingPart('**Different**', 'id-2');

			const result = part.hasSameContent(otherThinking, [], context.element);
			assert.strictEqual(result, true, 'Should return true for thinking part with different id');
		});
	});

	suite('DOM structure', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('should have proper aria-expanded attribute', () => {
			const content = createThinkingPart('**Content**\nSome detailed reasoning that differs from the title');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.ok(button, 'Button should exist');
			assert.strictEqual(button.getAttribute('aria-expanded'), 'false', 'Should have aria-expanded="false" when collapsed');

			// Expand
			button.click();

			assert.strictEqual(button.getAttribute('aria-expanded'), 'true', 'Should have aria-expanded="true" when expanded');
		});

		test('should show loading spinner while streaming', () => {
			const content = createThinkingPart('**Streaming content**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false // not streaming completed
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Should have circle-filled icon (not loading spinner) while streaming
			const circleIcon = part.domNode.querySelector('.codicon-circle-filled');
			assert.ok(circleIcon, 'Should have circle-filled icon while streaming');
		});

		function createMockStreamingToolInvocation(toolId: string, invocationMessage: string, toolCallId: string): IChatToolInvocation {
			return {
				kind: 'toolInvocation',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				source: ToolDataSource.Internal,
				isAttachedToThinking: false,
				generatedTitle: undefined,
				state: observableValue('state', {
					type: IChatToolInvocation.StateKind.Streaming,
					partialInput: observableValue('partialInput', undefined),
					streamingMessage: observableValue('streamingMessage', undefined),
				}),
				toolSpecificDataKind: observableValue('test', undefined),
				toJSON: () => ({} as IChatToolInvocationSerialized),
			} as IChatToolInvocation;
		}

		function createMockExecutingToolInvocation(toolId: string, invocationMessage: string, toolCallId: string): IChatToolInvocation {
			return {
				kind: 'toolInvocation',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				source: ToolDataSource.Internal,
				isAttachedToThinking: false,
				generatedTitle: undefined,
				state: observableValue('state', {
					type: IChatToolInvocation.StateKind.Executing,
					confirmed: { type: 0 },
					progress: observableValue('progress', { progress: 0 }),
					parameters: {},
					confirmationMessages: undefined,
				}),
				toolSpecificDataKind: observableValue('test', undefined),
				toJSON: () => ({} as IChatToolInvocationSerialized),
			} as IChatToolInvocation;
		}

		function createMockSerializedImageToolInvocation(toolId: string, invocationMessage: string, toolCallId: string): IChatToolInvocationSerialized {
			return {
				kind: 'toolInvocationSerialized',
				toolId,
				toolCallId,
				invocationMessage,
				originMessage: undefined,
				pastTenseMessage: undefined,
				presentation: undefined,
				resultDetails: {
					output: {
						type: 'data',
						mimeType: 'image/png',
						base64Data: 'AQID'
					}
				},
				isConfirmed: { type: 0 },
				isComplete: true,
				source: ToolDataSource.Internal,
				generatedTitle: undefined,
				isAttachedToThinking: false,
			};
		}

		test('should show "Editing files" for streaming edit tools instead of generic display name', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const streamingReplaceTool = createMockStreamingToolInvocation(
				'copilot_replaceString', 'Replace String in File', 'call-1'
			);

			part.appendItem(() => {
				const div = $('div.test-item');
				div.textContent = 'Replace tool';
				return { domNode: div };
			}, streamingReplaceTool.toolId, streamingReplaceTool);

			// The title should show "Editing files" instead of "Replace String in File"
			const button = part.domNode.querySelector('.chat-used-context-label .monaco-button');
			assert.ok(button, 'Should have collapse button');
			const labelText = button.querySelector('.icon-label')?.textContent ?? button.textContent ?? '';
			assert.ok(labelText.includes('Editing files'), `Title should contain "Editing files" but got "${labelText}"`);
		});

		test('should show original message for non-edit streaming tools', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const streamingReadTool = createMockStreamingToolInvocation(
				'copilot_readFile', 'Reading file.ts', 'call-2'
			);

			part.appendItem(() => {
				const div = $('div.test-item');
				div.textContent = 'Read tool';
				return { domNode: div };
			}, streamingReadTool.toolId, streamingReadTool);

			const button = part.domNode.querySelector('.chat-used-context-label .monaco-button');
			assert.ok(button, 'Should have collapse button');
			const labelText = button.querySelector('.icon-label')?.textContent ?? button.textContent ?? '';
			assert.ok(labelText.includes('Reading file.ts'), `Title should contain "Reading file.ts" but got "${labelText}"`);
		});

		test('should show original message for non-streaming edit tools', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			// Non-streaming (executing) edit tool should show its invocation message
			const executingReplaceTool = createMockExecutingToolInvocation(
				'copilot_replaceString', 'Replacing 5 lines in file.ts', 'call-3'
			);

			part.appendItem(() => {
				const div = $('div.test-item');
				div.textContent = 'Replace tool';
				return { domNode: div };
			}, executingReplaceTool.toolId, executingReplaceTool);

			const button = part.domNode.querySelector('.chat-used-context-label .monaco-button');
			assert.ok(button, 'Should have collapse button');
			const labelText = button.querySelector('.icon-label')?.textContent ?? button.textContent ?? '';
			assert.ok(labelText.includes('Replacing 5 lines in file.ts'), `Title should contain "Replacing 5 lines in file.ts" but got "${labelText}"`);
		});

		test('should keep original message for create_file tool even when streaming', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const streamingCreateTool = createMockStreamingToolInvocation(
				'copilot_createFile', 'Creating newFile.ts', 'call-4'
			);

			part.appendItem(() => {
				const div = $('div.test-item');
				div.textContent = 'Create tool';
				return { domNode: div };
			}, streamingCreateTool.toolId, streamingCreateTool);

			const button = part.domNode.querySelector('.chat-used-context-label .monaco-button');
			assert.ok(button, 'Should have collapse button');
			const labelText = button.querySelector('.icon-label')?.textContent ?? button.textContent ?? '';
			assert.ok(labelText.includes('Creating newFile.ts'), `Title should contain "Creating newFile.ts" but got "${labelText}"`);
		});

		test('should show external resources for serialized image tools when initially collapsed and hide them when expanded', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const serializedImageTool = createMockSerializedImageToolInvocation(
				'chat_screenshot', 'Captured screenshot', 'image-call-1'
			);

			part.appendItem(() => {
				const div = $('div.test-item');
				div.textContent = 'Image tool';
				return { domNode: div };
			}, serializedImageTool.toolId, serializedImageTool);

			const externalResources = part.domNode.querySelector('.chat-thinking-external-resources') as HTMLElement;
			assert.ok(externalResources, 'Should render external resources container');
			assert.notStrictEqual(externalResources.style.display, 'none', 'Should show external resources while initially collapsed');

			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.ok(button, 'Should have expand button');
			button.click();

			assert.strictEqual(externalResources.style.display, 'none', 'Should hide external resources when expanded');

			button.click();
			assert.notStrictEqual(externalResources.style.display, 'none', 'Should show external resources again after collapsing');
		});
	});

	suite('Diff aggregation in thinking header', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('should show diff stats in finalized title when onDidChangeDiff fires', () => {
			const content = createThinkingPart('**Editing files**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const diffEmitter = store.add(new Emitter<IEditSessionDiffStats>());

			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill') }),
				'edit-part-1',
				undefined,
				undefined,
				diffEmitter.event
			);

			part.finalizeTitleIfDefault();

			// Fire diff event
			diffEmitter.fire({ added: 10, removed: 3 });

			const addedEl = part.domNode.querySelector('.label-added');
			const removedEl = part.domNode.querySelector('.label-removed');
			assert.ok(addedEl, 'Should render +N element');
			assert.ok(removedEl, 'Should render -N element');
			assert.strictEqual(addedEl?.textContent, '+10');
			assert.strictEqual(removedEl?.textContent, '-3');
		});

		test('should aggregate diffs from multiple edit parts', () => {
			const content = createThinkingPart('**Editing files**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const diffEmitter1 = store.add(new Emitter<IEditSessionDiffStats>());
			const diffEmitter2 = store.add(new Emitter<IEditSessionDiffStats>());

			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill-1') }),
				'edit-part-1',
				undefined,
				undefined,
				diffEmitter1.event
			);

			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill-2') }),
				'edit-part-2',
				undefined,
				undefined,
				diffEmitter2.event
			);

			part.finalizeTitleIfDefault();

			diffEmitter1.fire({ added: 5, removed: 2 });
			diffEmitter2.fire({ added: 8, removed: 1 });

			const addedEl = part.domNode.querySelector('.label-added');
			const removedEl = part.domNode.querySelector('.label-removed');
			assert.strictEqual(addedEl?.textContent, '+13');
			assert.strictEqual(removedEl?.textContent, '-3');
		});

		test('should not show diff stats when diff parts exist but have no changes', () => {
			const content = createThinkingPart('**Editing files**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const diffEmitter = store.add(new Emitter<IEditSessionDiffStats>());

			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill') }),
				'edit-part-1',
				undefined,
				undefined,
				diffEmitter.event
			);

			part.finalizeTitleIfDefault();
			diffEmitter.fire({ added: 0, removed: 0 });

			const addedEl = part.domNode.querySelector('.label-added');
			const removedEl = part.domNode.querySelector('.label-removed');
			assert.strictEqual(addedEl, null);
			assert.strictEqual(removedEl, null);
		});

		test('should include diff stats in aria-label', () => {
			const content = createThinkingPart('**Editing files**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const diffEmitter = store.add(new Emitter<IEditSessionDiffStats>());

			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill') }),
				'edit-part-1',
				undefined,
				undefined,
				diffEmitter.event
			);

			part.finalizeTitleIfDefault();
			diffEmitter.fire({ added: 7, removed: 2 });

			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			assert.ok(button?.ariaLabel?.includes('7'), 'aria-label should include added count');
			assert.ok(button?.ariaLabel?.includes('2'), 'aria-label should include removed count');
		});

		test('should not show diff stats when no diff events fired', () => {
			const content = createThinkingPart('**Analyzing code**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			part.finalizeTitleIfDefault();

			const diffContainer = part.domNode.querySelector('.chat-thinking-title-diff');
			assert.strictEqual(diffContainer, null, 'Should not render diff container when no diffs exist');
		});

		test('removeEditPillByPartId cleans up lazy item and diff stats', () => {
			const content = createThinkingPart('**Editing files**');
			const context = createMockRenderContext(true);

			const part = store.add(instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				true
			));

			mainWindow.document.body.appendChild(part.domNode);
			disposables.add(toDisposable(() => part.domNode.remove()));

			const diffEmitter1 = store.add(new Emitter<IEditSessionDiffStats>());
			const diffEmitter2 = store.add(new Emitter<IEditSessionDiffStats>());

			// Append two edit pills
			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill-1') }),
				'edit-part-1',
				undefined,
				undefined,
				diffEmitter1.event
			);
			part.appendItem(
				() => ({ domNode: $('div.test-edit-pill-2') }),
				'edit-part-2',
				undefined,
				undefined,
				diffEmitter2.event
			);

			part.finalizeTitleIfDefault();

			// Fire diff events for both
			diffEmitter1.fire({ added: 5, removed: 2 });
			diffEmitter2.fire({ added: 8, removed: 1 });

			// Remove the first edit pill
			part.removeEditPillByPartId('edit-part-1');

			// Aggregated diff should only reflect the second pill now
			const addedEl = part.domNode.querySelector('.label-added');
			const removedEl = part.domNode.querySelector('.label-removed');
			assert.strictEqual(addedEl?.textContent, '+8');
			assert.strictEqual(removedEl?.textContent, '-1');
		});
	});

	suite('eagerDisposable lifecycle', () => {
		setup(() => {
			mockConfigurationService.setUserConfiguration('chat.agent.thinkingStyle', ThinkingDisplayMode.Collapsed);
		});

		test('eagerDisposable is disposed when thinking part is disposed even if factory was never called', () => {
			const content = createThinkingPart('**Working**');
			const context = createMockRenderContext(false);

			const part = instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			);

			mainWindow.document.body.appendChild(part.domNode);

			let disposed = false;
			const eagerDisposable = toDisposable(() => { disposed = true; });
			const factory = () => ({
				domNode: $('div.test-item'),
				disposable: eagerDisposable,
			});

			// Append while collapsed — factory is NOT called
			part.appendItem(factory, 'test-tool', undefined, undefined, undefined, eagerDisposable);

			assert.strictEqual(disposed, false, 'Should not be disposed yet');

			// Dispose the thinking part without ever expanding
			part.domNode.remove();
			part.dispose();

			assert.strictEqual(disposed, true, 'eagerDisposable should be disposed with the thinking part');
		});

		test('eagerDisposable is disposed when thinking part is disposed after factory was called', () => {
			const content = createThinkingPart('**Working**\nSome detailed analysis');
			const context = createMockRenderContext(false);

			const part = instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			);

			mainWindow.document.body.appendChild(part.domNode);

			let disposed = false;
			const eagerDisposable = toDisposable(() => { disposed = true; });
			const factory = () => ({
				domNode: $('div.test-item'),
				disposable: eagerDisposable,
			});

			// Append while collapsed
			part.appendItem(factory, 'test-tool', undefined, undefined, undefined, eagerDisposable);

			// Expand to trigger factory call
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			assert.strictEqual(disposed, false, 'Should not be disposed yet');

			// Dispose
			part.domNode.remove();
			part.dispose();

			assert.strictEqual(disposed, true, 'eagerDisposable should be disposed even after being materialized');
		});

		test('appendItem without eagerDisposable disposes factory result on thinking part disposal', () => {
			const content = createThinkingPart('**Working**\nSome detailed analysis');
			const context = createMockRenderContext(false);

			const part = instantiationService.createInstance(
				ChatThinkingContentPart,
				content,
				context,
				mockMarkdownRenderer,
				false
			);

			mainWindow.document.body.appendChild(part.domNode);

			// Expand first so factory is called immediately
			const button = part.domNode.querySelector('.monaco-button') as HTMLElement;
			button?.click();

			let disposed = false;
			const factory = () => ({
				domNode: $('div.test-item'),
				disposable: toDisposable(() => { disposed = true; }),
			});

			part.appendItem(factory, 'test-tool');

			assert.strictEqual(disposed, false, 'Should not be disposed yet');

			part.domNode.remove();
			part.dispose();

			assert.strictEqual(disposed, true, 'Factory disposable should be disposed with thinking part');
		});
	});
});
