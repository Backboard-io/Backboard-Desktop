/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { getBackboardCoreToolKind, getCoreToolSpecificData } from '../../../../browser/agentSessions/agentHost/stateToProgressAdapter.js';
import { ChatCoreToolProgressPart, createCoreToolCardViewModel } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatCoreToolProgressPart.js';
import { shouldRerenderToolInvocationSubPart } from '../../../../browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import { IChatCoreToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { ToolDataSource } from '../../../../common/tools/languageModelToolsService.js';
import '../../../../browser/widget/media/chat.css';
import '../../../../browser/widget/media/chatPanelCursorLook.css';

suite('ChatCoreToolProgressPart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('read locations use one-based lines and stop at the end of the file', () => {
		const location = (offset: number, limit: number, totalLines: number) => createCoreToolCardViewModel({
			kind: 'coreTool', toolKind: 'read', input: { path: '/workspace/example.ts', offset, limit }, output: { totalLines, content: 'example' },
		}).locationLabel;
		assert.strictEqual(location(0, 20, 295), '#L1-20');
		assert.strictEqual(location(10, 20, 15), '#L11-15');
		assert.strictEqual(location(20, 10, 15), undefined);
	});

	test('actual tool headers keep their icon rail and fit narrow transcripts', () => {
		const host = document.createElement('div');
		host.className = 'monaco-workbench';
		const panel = host.appendChild(document.createElement('div'));
		panel.className = 'backboard-clean-chat';
		const transcript = panel.appendChild(document.createElement('div'));
		transcript.className = 'interactive-list backboard-cursor-transcript';
		document.body.appendChild(host);
		try {
			const tools: IChatCoreToolInvocationData[] = [
				{ kind: 'coreTool', toolKind: 'grep', input: { pattern: 'a long search expression that must not push the icon or count outside the row' }, output: { matches: 'example' } },
				{ kind: 'coreTool', toolKind: 'webSearch', input: { query: 'long browser search query with several words and extra details' }, output: { results: [] } },
				{ kind: 'coreTool', toolKind: 'fetchUrl', input: { url: 'https://example.com/a/very/long/path/that/continues/across/the/header' }, output: { text: 'page content' } },
				{ kind: 'coreTool', toolKind: 'read', input: { path: '/workspace/long/directory/name/example.ts' }, output: { content: 'export const value = 1;' } },
				{ kind: 'coreTool', toolKind: 'todo', input: { todos: [] }, output: { todos: [] } },
			];
			for (const width of [280, 480, 760]) {
				host.style.width = `${width}px`;
				for (const data of tools) {
					const part = createPart(data);
					transcript.replaceChildren(part.domNode);
					const header = part.domNode.querySelector<HTMLElement>('.chat-core-tool-card-header')!;
					const icon = header.querySelector<HTMLElement>('.chat-core-tool-card-icon')!;
					const row = header.getBoundingClientRect();
					const glyph = icon.getBoundingClientRect();
					assert.deepStrictEqual({
						height: row.height,
						iconWidth: glyph.width,
						iconInset: glyph.x - row.x,
						centerOffset: glyph.y + glyph.height / 2 - row.y - row.height / 2,
						fits: header.scrollWidth <= header.clientWidth + 1,
					}, { height: 24, iconWidth: 16, iconInset: 0, centerOffset: 0, fits: true }, `${data.toolKind} at ${width}px`);
				}
			}
		} finally {
			host.remove();
		}
	});

	test('editor-panel disclosures align and reveal their real body with the complete style cascade', () => {
		const host = document.createElement('div');
		host.className = 'monaco-workbench vs-dark';
		host.innerHTML = '<div class="part auxiliarybar"><div class="chat-viewpane"><div class="backboard-clean-chat"><div class="interactive-list backboard-cursor-transcript"></div></div></div></div>';
		document.body.appendChild(host);
		const transcript = host.querySelector<HTMLElement>('.interactive-list')!;
		try {
			for (const width of [280, 414, 760]) {
				host.style.width = `${width}px`;
				for (const data of [
					{ kind: 'coreTool', toolKind: 'read', input: { path: '/workspace/a-long-filename-to-check-truncation.ts' }, output: { content: 'export const greeting = "Hello";' } },
					{ kind: 'coreTool', toolKind: 'grep', input: { pattern: 'a long pattern with enough words to fill a narrow sidebar' }, output: { matches: 'a matching line' } },
					{ kind: 'coreTool', toolKind: 'fetchUrl', input: { url: 'https://example.com/long/path' }, output: { text: 'page content' } },
				] satisfies IChatCoreToolInvocationData[]) {
					const part = createPart(data);
					transcript.replaceChildren(part.domNode);
					const header = part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header')!;
					const icon = header.querySelector<HTMLElement>('.chat-core-tool-card-icon')!;
					const arrow = header.querySelector<HTMLElement>('.chat-core-tool-card-disclosure')!;
					const details = part.domNode.querySelector<HTMLElement>('.chat-core-tool-card-details')!;
					const row = header.getBoundingClientRect();
					assert.strictEqual(row.height, 16, `${data.toolKind}: reference row height`);
					assert.strictEqual(icon.getBoundingClientRect().x, row.x);
					assert.strictEqual(arrow.getBoundingClientRect().x, row.x);
					assert.strictEqual(arrow.getBoundingClientRect().y, row.y);
					assert.ok(header.scrollWidth <= header.clientWidth + 1, `${data.toolKind}: no horizontal overflow at ${width}`);
					for (let repeat = 0; repeat < 3; repeat++) {
						arrow.click();
						assert.strictEqual(header.ariaExpanded, 'true');
						assert.ok(details.getBoundingClientRect().height > 0, 'opening must expose actual content');
						assert.ok(details.getBoundingClientRect().right <= row.right + 1, 'details stay inside the transcript');
						assert.strictEqual(details.getBoundingClientRect().x - row.x, 24, 'details follow the label rail');
						arrow.click();
						assert.strictEqual(header.ariaExpanded, 'false');
						assert.strictEqual(details.getBoundingClientRect().height, 0, 'closed content takes no space');
					}
				}
			}
		} finally {
			host.remove();
		}
	});

	test('web and search chevrons toggle repeatedly without triggering parent disclosures', () => {
		const data: IChatCoreToolInvocationData[] = [
			{ kind: 'coreTool', toolKind: 'grep', input: { pattern: 'hello' }, output: { matches: 'hello world' } },
			{ kind: 'coreTool', toolKind: 'fetchUrl', input: { url: 'https://example.com' }, output: { text: 'page content' } },
			{ kind: 'coreTool', toolKind: 'webSearch', input: { query: 'example' }, output: { results: [{ title: 'Example', url: 'https://example.com' }] } },
		];
		assert.deepStrictEqual(data.map(input => {
			const part = createPart(input);
			let parentClicks = 0;
			part.domNode.addEventListener('click', () => parentClicks++);
			const header = part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header')!;
			const arrow = header.querySelector<HTMLElement>('.chat-core-tool-card-disclosure')!;
			const details = part.domNode.querySelector<HTMLElement>('.chat-core-tool-card-details')!;
			arrow.click();
			const open = header.ariaExpanded === 'true' && !details.hidden;
			arrow.click();
			return { open, closed: header.ariaExpanded === 'false' && details.hidden, parentClicks };
		}), data.map(() => ({ open: true, closed: true, parentClicks: 0 })));
	});

	test('shows capped searches as partial results, with the returned record count', () => {
		const part = createPart({ kind: 'coreTool', toolKind: 'grep', input: { pattern: 'needle' }, output: {
			matches: 'before\nneedle\nafter', matchCount: 1, returnedCount: 3, countUnit: 'lines', truncated: true, totalKnown: false,
		} });
		part.domNode.querySelector<HTMLButtonElement>('button')?.click();
		assert.deepStrictEqual({
			count: part.domNode.querySelector('.chat-core-tool-card-count')?.textContent,
			partial: part.domNode.classList.contains('chat-core-tool-card-partial'),
			note: part.domNode.querySelector('.chat-core-tool-card-partial-note')?.textContent,
		}, { count: '3 shown', partial: true, note: 'Partial results — the search reached its limit. Narrow the search to see more.' });
	});

	test('does not treat a successful output message as a tool error', () => {
		const view = createCoreToolCardViewModel({ kind: 'coreTool', toolKind: 'glob', input: {}, output: { success: true, message: 'No matches', files: [], count: 0 } });
		assert.deepStrictEqual({ failed: view.failed, error: view.errorMessage }, { failed: false, error: undefined });
	});

	function createPart(data: IChatCoreToolInvocationData, options: {
		isComplete?: boolean;
		isConfirmed?: IChatToolInvocationSerialized['isConfirmed'];
		pastTenseMessage?: string;
		resultDetails?: IChatToolInvocationSerialized['resultDetails'];
	} = {}): ChatCoreToolProgressPart {
		const serializedInvocation: IChatToolInvocationSerialized = {
			presentation: undefined,
			toolSpecificData: data,
			originMessage: undefined,
			invocationMessage: `Running ${data.toolKind}`,
			pastTenseMessage: options.pastTenseMessage ?? `Ran ${data.toolKind}`,
			resultDetails: options.resultDetails,
			isConfirmed: options.isConfirmed ?? { type: ToolConfirmKind.ConfirmationNotNeeded },
			isComplete: options.isComplete ?? true,
			toolCallId: `call-${data.toolKind}`,
			toolId: data.toolKind,
			source: ToolDataSource.Internal,
			kind: 'toolInvocationSerialized',
		};
		const invocation: IChatToolInvocation | IChatToolInvocationSerialized = options.isComplete === false ? {
			presentation: undefined,
			toolSpecificData: data,
			toolSpecificDataKind: observableValue('toolSpecificDataKind', data.kind),
			originMessage: undefined,
			invocationMessage: `Running ${data.toolKind}`,
			pastTenseMessage: options.pastTenseMessage,
			state: observableValue('state', {
				type: IChatToolInvocation.StateKind.Executing,
				parameters: data.input,
				confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
				progress: observableValue('progress', { progress: undefined }),
			}),
			toolCallId: `call-${data.toolKind}`,
			toolId: data.toolKind,
			source: ToolDataSource.Internal,
			isAttachedToThinking: false,
			kind: 'toolInvocation',
			toJSON: () => serializedInvocation,
		} : serializedInvocation;
		return store.add(new ChatCoreToolProgressPart(invocation, data));
	}

	test('recognizes the explicit cli-ts core-tool kind table', () => {
		const toolKinds = [
			'read',
			'grep',
			'glob',
			'fetchUrl',
			'webSearch',
			'todo',
			'computer',
			'browser',
			'findSkill',
			'findMcp',
			'generateVideo',
		] as const;

		assert.deepStrictEqual(
			toolKinds.map(backboardToolKind => getBackboardCoreToolKind({ _meta: { source: 'cli-ts', backboardToolKind } })),
			toolKinds,
		);

		const viewModels = toolKinds.map(toolKind => createCoreToolCardViewModel({
			kind: 'coreTool',
			toolKind,
			input: 42,
			output: ['malformed'],
		}));
		assert.deepStrictEqual({
			toolKinds: viewModels.map(viewModel => viewModel.toolKind),
			haveTitles: viewModels.every(viewModel => viewModel.title.length > 0),
			haveIcons: viewModels.every(viewModel => viewModel.icon.id.length > 0),
			failed: viewModels.map(viewModel => viewModel.failed),
		}, {
			toolKinds,
			haveTitles: true,
			haveIcons: true,
			failed: toolKinds.map(() => false),
		});
	});

	test('requires the cli-ts source marker and a recognized string kind', () => {
		assert.deepStrictEqual([
			getBackboardCoreToolKind({}),
			getBackboardCoreToolKind({ _meta: { backboardToolKind: 'read' } }),
			getBackboardCoreToolKind({ _meta: { source: 'mcp', backboardToolKind: 'read' } }),
			getBackboardCoreToolKind({ _meta: { source: 'cli-ts' } }),
			getBackboardCoreToolKind({ _meta: { source: 'cli-ts', backboardToolKind: 1 } }),
			getBackboardCoreToolKind({ _meta: { source: 'cli-ts', backboardToolKind: 'unknown' } }),
		], [undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('builds reload-safe data and tolerates malformed JSON input', () => {
		assert.deepStrictEqual(getCoreToolSpecificData({
			_meta: { source: 'cli-ts', backboardToolKind: 'read' },
			toolInput: '{not-json',
			structuredContent: {
				backboardTool: { text: 'contents', uiTruncated: true },
			},
		}), {
			kind: 'coreTool',
			toolKind: 'read',
			input: '{not-json',
			output: { text: 'contents', uiTruncated: true },
			uiTruncated: true,
		});
	});

	test('normalizes malformed card fields without exposing unsafe links', () => {
		const viewModel = createCoreToolCardViewModel({
			kind: 'coreTool',
			toolKind: 'webSearch',
			input: ['unexpected'],
			output: {
				results: [null, 'unexpected', { title: 'Safe result', url: 'javascript:alert(1)' }],
				success: 'not-a-boolean',
			},
		});

		assert.deepStrictEqual({
			toolKind: viewModel.toolKind,
			items: viewModel.items?.map(item => ({ title: item.title, href: item.href })),
			failed: viewModel.failed,
			uiTruncated: viewModel.uiTruncated,
		}, {
			toolKind: 'webSearch',
			items: [{ title: 'Safe result', href: undefined }],
			failed: false,
			uiTruncated: false,
		});
	});

	test('gives every core tool a distinct compact summary and useful detail shape', () => {
		const cards: IChatCoreToolInvocationData[] = [
			{ kind: 'coreTool', toolKind: 'read', input: { path: '/workspace/read.ts' }, output: { content: 'read body' } },
			{ kind: 'coreTool', toolKind: 'grep', input: { pattern: 'TODO' }, output: { matches: '/workspace/read.ts:1: TODO' } },
			{ kind: 'coreTool', toolKind: 'glob', input: { patterns: ['**/*.ts'] }, output: { files: ['a.ts', 'b.ts'] } },
			{ kind: 'coreTool', toolKind: 'fetchUrl', input: { url: 'https://example.com/api' }, output: { text: 'response body' } },
			{ kind: 'coreTool', toolKind: 'webSearch', input: { query: 'native tool cards' }, output: { results: [{ title: 'First result', url: 'https://example.com/result' }] } },
			{ kind: 'coreTool', toolKind: 'todo', output: { todos: [{ content: 'Done', status: 'completed' }, { content: 'Next', status: 'in_progress' }] } },
			{ kind: 'coreTool', toolKind: 'computer', input: { actions: [{ action: 'click' }] }, output: { results: [{ success: true }] } },
			{ kind: 'coreTool', toolKind: 'browser', input: { actions: [{ action: 'navigate', url: 'https://example.com/docs' }] }, output: { results: [{ success: true }] } },
			{ kind: 'coreTool', toolKind: 'findSkill', input: { skill: 'testing' }, output: { candidates: [{ name: 'test-helper' }] } },
			{ kind: 'coreTool', toolKind: 'findMcp', input: { server: 'issues' }, output: { candidates: [{ title: 'GitHub' }] } },
			{ kind: 'coreTool', toolKind: 'generateVideo', input: { prompt: 'A cat singing', duration: 30, resolution: '480p', generate_audio: true, model_label: 'Seedance 2.5' }, output: { url: 'https://example.com/clip.mp4' } },
		];

		assert.deepStrictEqual(cards.map(data => {
			const viewModel = createCoreToolCardViewModel(data);
			return {
				toolKind: viewModel.toolKind,
				title: viewModel.title,
				summary: viewModel.summary,
				detail: viewModel.preview?.text ?? viewModel.items?.map(item => item.title).join('|'),
			};
		}), [
			{ toolKind: 'read', title: 'Read', summary: '/workspace/read.ts', detail: 'read body' },
			{ toolKind: 'grep', title: 'Search', summary: 'TODO', detail: '/workspace/read.ts:1: TODO' },
			{ toolKind: 'glob', title: 'Find files', summary: '**/*.ts', detail: 'a.ts|b.ts' },
			{ toolKind: 'fetchUrl', title: 'Fetch', summary: 'example.com/api', detail: 'response body' },
			{ toolKind: 'webSearch', title: 'Web search', summary: 'native tool cards', detail: 'First result' },
			{ toolKind: 'todo', title: 'Task progress', summary: '1 / 2 tasks done', detail: 'Done|Next' },
			{ toolKind: 'computer', title: 'Computer actions', summary: '1 action', detail: 'Click' },
			{ toolKind: 'browser', title: 'Browser actions', summary: 'example.com/docs', detail: 'Navigate' },
			{ toolKind: 'findSkill', title: 'Find a skill', summary: 'testing', detail: 'test-helper' },
			{ toolKind: 'findMcp', title: 'Find an MCP server', summary: 'issues', detail: 'GitHub' },
			{ toolKind: 'generateVideo', title: 'Generate Video', summary: 'A cat singing', detail: 'A cat singing' },
		]);
	});

	test('keeps verbose results behind one compact native disclosure without a metric grid', () => {
		const verboseMarker = 'VERBOSE_RESULT_ONLY';
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/read.ts', offset: 5, limit: 100 },
			output: { content: `${verboseMarker}\nconst answer = 42;`, totalLines: 240 },
		});
		const disclosure = part.domNode.querySelector<HTMLButtonElement>(':scope > button.chat-core-tool-card-header');
		const controlledId = disclosure?.getAttribute('aria-controls');
		const details = controlledId ? part.domNode.querySelector<HTMLElement>(`#${controlledId}`) : undefined;

		assert.deepStrictEqual({
			root: part.domNode.classList.contains('chat-core-tool-card'),
			type: disclosure?.type,
			expanded: disclosure?.getAttribute('aria-expanded'),
			hasControlledId: !!controlledId,
			controlsDetails: details?.classList.contains('chat-core-tool-card-details'),
			detailsHidden: details?.hidden,
			summary: disclosure?.querySelector('.chat-core-tool-card-summary')?.textContent,
			fullPathInTooltip: disclosure?.title.includes('/workspace/read.ts'),
			subtitle: disclosure?.querySelector('.chat-core-tool-card-subtitle')?.textContent,
			verboseInSummary: disclosure?.textContent?.includes(verboseMarker),
			verboseInDetails: details?.textContent?.includes(verboseMarker),
			metricGrids: part.domNode.querySelectorAll('dl').length,
		}, {
			root: true,
			type: 'button',
			expanded: 'false',
			hasControlledId: true,
			controlsDetails: true,
			detailsHidden: true,
			summary: 'read.ts#L6-105',
			fullPathInTooltip: true,
			subtitle: 'Starts at: 5 · Limit: 100',
			verboseInSummary: false,
			verboseInDetails: true,
			metricGrids: 0,
		});

		disclosure?.click();
		assert.deepStrictEqual({ expanded: disclosure?.getAttribute('aria-expanded'), detailsHidden: details?.hidden }, { expanded: 'true', detailsHidden: false });
		disclosure?.click();
		assert.deepStrictEqual({ expanded: disclosure?.getAttribute('aria-expanded'), detailsHidden: details?.hidden }, { expanded: 'false', detailsHidden: true });
	});

	test('shows empty-result copy and counts only after a successful completion', () => {
		const running = createPart({
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/running.ts' },
			output: { totalLines: 240 },
		}, { isComplete: false });
		const errored = createPart({
			kind: 'coreTool',
			toolKind: 'grep',
			input: { pattern: 'needle' },
			output: { matchCount: 8 },
		}, {
			resultDetails: {
				input: '{"pattern":"needle"}',
				output: [{ type: 'embed', value: 'Search failed', isText: true }],
				isError: true,
			},
		});
		const cancelled = createPart({
			kind: 'coreTool',
			toolKind: 'glob',
			input: { patterns: ['**/*.ts'] },
			output: { count: 4, files: [] },
		}, { isConfirmed: { type: ToolConfirmKind.Denied } });

		assert.deepStrictEqual([running, errored, cancelled].map(part => ({
			outcome: ['running', 'error', 'cancelled'].find(outcome => part.domNode.classList.contains(`chat-core-tool-card-${outcome}`)),
			subtitle: part.domNode.querySelector('.chat-core-tool-card-subtitle')?.textContent,
			count: part.domNode.querySelector('.chat-core-tool-card-count')?.textContent,
			alert: part.domNode.querySelector('[role="alert"]')?.textContent,
		})), [
			{ outcome: 'running', subtitle: undefined, count: undefined, alert: undefined },
			{ outcome: 'error', subtitle: undefined, count: undefined, alert: 'Search failed' },
			{ outcome: 'cancelled', subtitle: undefined, count: undefined, alert: undefined },
		]);
		assert.strictEqual([running, errored, cancelled].some(part => /read successfully|no matching lines|no files matched/i.test(part.domNode.textContent ?? '')), false);
		assert.strictEqual(errored.domNode.querySelector('[role="alert"]')?.classList.contains('chat-core-tool-card-error-message'), true);
		assert.strictEqual(errored.domNode.classList.contains('chat-core-tool-card-error-message'), false, 'Error message styling must not apply to the whole card');
	});

	test('keeps failed reads to one compact row while preserving the full diagnostic', () => {
		const rawError = "Error: ENOENT: no such file or directory, stat '/workspace/missing.html'";
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/missing.html' },
			output: { success: false, error: rawError },
		});
		const alert = part.domNode.querySelector<HTMLElement>('[role="alert"]');

		assert.deepStrictEqual({
			subtitle: part.domNode.querySelector('.chat-core-tool-card-subtitle')?.textContent,
			subtitleIsError: part.domNode.querySelector('.chat-core-tool-card-subtitle')?.classList.contains('chat-core-tool-card-subtitle-error'),
			statusTitle: part.domNode.querySelector('.chat-core-tool-card-status')?.getAttribute('title'),
			alert: alert?.textContent,
			alertIsVisuallyHidden: alert?.classList.contains('chat-core-tool-card-visually-hidden'),
		}, {
			subtitle: 'File not found',
			subtitleIsError: true,
			statusTitle: rawError,
			alert: rawError,
			alertIsVisuallyHidden: true,
		});
	});

	test('uses the provider completion message for unsuccessful discovery outcomes', () => {
		const findSkill = createPart({
			kind: 'coreTool',
			toolKind: 'findSkill',
			input: { skill: 'release helper' },
			output: { candidates: [] },
		}, { pastTenseMessage: 'Skill activation was declined' });
		const findMcp = createPart({
			kind: 'coreTool',
			toolKind: 'findMcp',
			input: { server: 'issue tracker' },
			output: { candidates: [] },
		}, { pastTenseMessage: 'MCP server is unavailable' });

		assert.deepStrictEqual([findSkill, findMcp].map(part => part.domNode.querySelector('.chat-core-tool-card-subtitle')?.textContent), [
			'Skill activation was declined',
			'MCP server is unavailable',
		]);
		assert.strictEqual(findSkill.domNode.textContent?.includes('No matching skill was found.'), false);
		assert.strictEqual(findMcp.domNode.textContent?.includes('No matching MCP server was found.'), false);
	});

	test('renders redacted image reads as useful metadata without requiring image bytes', () => {
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'read',
			input: { path: '/workspace/screenshot.png' },
			output: {
				filePath: '/workspace/screenshot.png',
				contentType: 'image',
				mimeType: 'image/png',
				sizeBytes: 2_048,
			},
		});
		const viewModel = createCoreToolCardViewModel({
			kind: 'coreTool',
			toolKind: 'read',
			output: { contentType: 'image', mimeType: 'image/png', sizeBytes: 2_048 },
		});

		assert.deepStrictEqual({
			metrics: viewModel.metrics?.map(metric => ({ label: metric.label, value: metric.value })),
			subtitle: part.domNode.querySelector('.chat-core-tool-card-subtitle')?.textContent,
			images: part.domNode.querySelectorAll('img').length,
			hasDisclosure: !!part.domNode.querySelector('[aria-expanded]'),
		}, {
			metrics: [{ label: 'Type', value: 'PNG image' }, { label: 'Size', value: '2 KB' }],
			subtitle: 'Type: PNG image · Size: 2 KB',
			images: 0,
			hasDisclosure: false,
		});
	});

	test('renders a completed computer screenshot as only an image', () => {
		const part = createPart({
			kind: 'coreTool', toolKind: 'computer', input: { actions: [{ action: 'screenshot' }] },
			output: { results: [{ action: 'screenshot', success: true, screenshotPath: '/tmp/capture with spaces.png', imageSize: { width: 1280, height: 832 }, windowTitle: 'Backboard Studio' }] },
		});
		const image = part.domNode.querySelector('img')!;
		assert.ok(image);
		assert.ok(image.src.includes('/tmp/capture'));
		assert.strictEqual(image.alt, 'Backboard Studio');
		assert.strictEqual(image.width, 1280);
		assert.strictEqual(image.height, 832);
		assert.strictEqual(part.domNode.textContent, '');
		assert.strictEqual(part.domNode.querySelector('.chat-core-tool-card, button, [aria-expanded]'), null);
	});

	test('keeps other actions while rendering screenshots outside their disclosure', () => {
		const part = createPart({
			kind: 'coreTool', toolKind: 'computer', input: { actions: [{ action: 'click' }, { action: 'screenshot' }] },
			output: { results: [{ success: true }, { success: true, observation: { screenshotPath: '/tmp/capture.png' } }] },
		});
		assert.strictEqual(part.domNode.querySelectorAll('img').length, 1);
		assert.strictEqual(part.domNode.querySelector('.chat-core-tool-card-details img'), null);
		assert.strictEqual(part.domNode.querySelector('.chat-core-tool-card-summary')?.textContent, '1 action');
		const header = part.domNode.querySelector<HTMLButtonElement>('button')!;
		header.click();
		assert.strictEqual(header.ariaExpanded, 'true');
		assert.strictEqual(part.domNode.querySelectorAll('.chat-core-tool-card-item').length, 1);
	});

	test('retains screenshot failure and missing-path feedback', () => {
		for (const result of [{ success: false, error: 'Capture denied' }, { success: true }, { success: true, screenshotPath: 'https://example.com/image.png' }]) {
			const part = createPart({ kind: 'coreTool', toolKind: 'computer', input: { actions: [{ action: 'screenshot' }] }, output: { results: [result] } });
			assert.strictEqual(part.domNode.querySelector('img'), null);
			assert.ok(part.domNode.querySelector('.chat-core-tool-card-header'));
		}
	});

	test('shows redacted automation metadata and marks an unexecuted final action skipped', () => {
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'computer',
			input: {
				actions: [
					{ action: 'click', target: { elementId: 'submit' }, button: 'left' },
					{ action: 'type', target: { x: 12, y: 34 }, textLength: 8, mode: 'replace' },
				],
			},
			output: {
				results: [{
					success: true,
					verification: 'passed',
					observation: {
						appName: 'Backboard',
						windowTitle: 'Agent task',
						imageSize: { width: 1_280, height: 720 },
						elementCount: 17,
						imageMediaType: 'image/png',
						screenshotPath: '/redacted/screenshot.png',
					},
				}],
			},
		});
		part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header')?.click();
		const rows = [...part.domNode.querySelectorAll('.chat-core-tool-card-item')];

		assert.deepStrictEqual(rows.map(row => ({
			title: row.querySelector('.chat-core-tool-card-item-title')?.textContent,
			detail: row.querySelector('.chat-core-tool-card-item-detail')?.textContent,
			state: row.querySelector('.chat-core-tool-card-visually-hidden')?.textContent,
			markerHidden: row.querySelector('.chat-core-tool-card-item-marker')?.getAttribute('aria-hidden'),
		})), [
			{
				title: 'Click',
				detail: 'Element submit · left · Verified · Backboard · Agent task · 1280×720 · 17 elements · PNG image · /redacted/screenshot.png',
				state: 'Completed',
				markerHidden: 'true',
			},
			{
				title: 'Type text',
				detail: '(12, 34) · 8 characters · replace',
				state: 'Skipped',
				markerHidden: 'true',
			},
		]);
		assert.strictEqual(part.domNode.querySelectorAll('img').length, 0);
	});

	test('uses descriptive compact count labels without redundant group semantics', () => {
		const parts = [
			createPart({ kind: 'coreTool', toolKind: 'read', output: { totalLines: 240 } }),
			createPart({ kind: 'coreTool', toolKind: 'grep', output: { matchCount: 8 } }),
			createPart({ kind: 'coreTool', toolKind: 'glob', output: { files: ['a.ts', 'b.ts'] } }),
			createPart({ kind: 'coreTool', toolKind: 'fetchUrl', input: { url: 'https://example.com' }, output: { status: 200 } }),
			createPart({ kind: 'coreTool', toolKind: 'webSearch', output: { results: [{ title: 'One' }] } }),
			createPart({ kind: 'coreTool', toolKind: 'findMcp', output: { toolNames: ['read', 'write', 'search'] } }),
		];

		assert.deepStrictEqual(parts.map(part => ({
			count: part.domNode.querySelector('.chat-core-tool-card-count')?.textContent,
			countLabel: part.domNode.querySelector('.chat-core-tool-card-count')?.getAttribute('aria-label'),
			groupRoles: part.domNode.querySelectorAll('[role="group"]').length,
		})), [
			{ count: '240 lines', countLabel: 'Lines: 240', groupRoles: 0 },
			{ count: '8 matches', countLabel: 'Matches: 8', groupRoles: 0 },
			{ count: '2 files', countLabel: 'Files: 2', groupRoles: 0 },
			{ count: 'HTTP 200', countLabel: 'HTTP status: 200', groupRoles: 0 },
			{ count: '1 result', countLabel: 'Results: 1', groupRoles: 0 },
			{ count: '3 tools', countLabel: 'Tools: 3', groupRoles: 0 },
		]);
	});

	test('provides accessible text for task item states', () => {
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'todo',
			output: {
				todos: [
					{ content: 'Queued', status: 'pending' },
					{ content: 'Working', status: 'in_progress' },
					{ content: 'Finished', status: 'completed' },
				],
			},
		});
		part.domNode.querySelector<HTMLButtonElement>('.chat-core-tool-card-header')?.click();

		assert.deepStrictEqual([...part.domNode.querySelectorAll('.chat-core-tool-card-item')].map(row => ({
			title: row.querySelector('.chat-core-tool-card-item-title')?.textContent,
			state: row.querySelector('.chat-core-tool-card-visually-hidden')?.textContent,
			markerHidden: row.querySelector('.chat-core-tool-card-item-marker')?.getAttribute('aria-hidden'),
		})), [
			{ title: 'Queued', state: 'Pending', markerHidden: 'true' },
			{ title: 'Working', state: 'In progress', markerHidden: 'true' },
			{ title: 'Finished', state: 'Completed', markerHidden: 'true' },
		]);
	});

	test('prefers reconciled todo output over the requested input state', () => {
		const viewModel = createCoreToolCardViewModel({
			kind: 'coreTool',
			toolKind: 'todo',
			input: { todos: [{ content: 'Inspect renderer', status: 'pending' }] },
			output: { todos: [{ content: 'Inspect renderer', status: 'completed' }] },
		});

		assert.strictEqual(viewModel.items?.[0]?.state, 'complete');
		assert.strictEqual(viewModel.summary, '1 / 1 tasks done');
	});

	test('exposes the task completion ratio as the header progress track', () => {
		const part = createPart({
			kind: 'coreTool',
			toolKind: 'todo',
			output: {
				todos: [
					{ content: 'Queued', status: 'pending' },
					{ content: 'Working', status: 'in_progress' },
					{ content: 'Finished', status: 'completed' },
				],
			},
		});
		const card = part.domNode;

		assert.strictEqual(card.classList.contains('chat-core-tool-card-progress'), true);
		assert.strictEqual(card.style.getPropertyValue('--bb-core-tool-progress'), '33%');

		const emptyList = createPart({ kind: 'coreTool', toolKind: 'todo', output: { todos: [] } });
		assert.strictEqual(emptyList.domNode.classList.contains('chat-core-tool-card-progress'), false);
	});

	test('animates a film-frame shell while generate_video is running', () => {
		const running = createPart({
			kind: 'coreTool',
			toolKind: 'generateVideo',
			input: { prompt: 'A cat and a dog singing', duration: 8, resolution: '720p', generate_audio: true, model_label: 'Seedance 2.5' },
		}, { isComplete: false });
		const complete = createPart({
			kind: 'coreTool',
			toolKind: 'generateVideo',
			input: { prompt: 'A cat and a dog singing', duration: 8, resolution: '720p', generate_audio: true, model_label: 'Seedance 2.5' },
			output: { url: 'https://example.com/clip.mp4' },
		});

		assert.deepStrictEqual({
			running: running.domNode.classList.contains('chat-core-tool-card-running'),
			shell: !!running.domNode.querySelector('.chat-core-tool-card-generating'),
			rails: running.domNode.querySelectorAll('.chat-core-tool-card-generating-rail').length,
			frames: running.domNode.querySelectorAll('.chat-core-tool-card-generating-frame').length,
			sweep: !!running.domNode.querySelector('.chat-core-tool-card-generating-sweep'),
			bar: !!running.domNode.querySelector('.chat-core-tool-card-generating-bar'),
			decorative: running.domNode.querySelector('.chat-core-tool-card-generating')?.getAttribute('aria-hidden'),
			// The header is the live status line while the clip renders, and the
			// prompt appears once, as the shell caption.
			title: running.domNode.querySelector('.chat-core-tool-card-title')?.textContent,
			liveTitle: !!running.domNode.querySelector('.chat-core-tool-card-title-live'),
			headerSummaries: running.domNode.querySelectorAll('.chat-core-tool-card-summary').length,
			caption: running.domNode.querySelector('.chat-core-tool-card-generating-caption')?.textContent,
			complete: complete.domNode.classList.contains('chat-core-tool-card-complete'),
			completeShell: !!complete.domNode.querySelector('.chat-core-tool-card-generating'),
			completeTitle: complete.domNode.querySelector('.chat-core-tool-card-title')?.textContent,
		}, {
			running: true,
			shell: true,
			rails: 2,
			frames: 3,
			sweep: true,
			bar: true,
			decorative: 'true',
			title: 'Generating video',
			liveTitle: true,
			headerSummaries: 0,
			caption: 'A cat and a dog singing',
			complete: true,
			completeShell: false,
			completeTitle: 'Generate Video',
		});
	});

	test('does not claim the existing terminal or Write render paths', () => {
		assert.deepStrictEqual([
			getCoreToolSpecificData({
				_meta: { source: 'cli-ts', toolKind: 'terminal', backboardToolKind: 'terminal' },
				toolInput: '{"command":"pwd"}',
			}),
			getCoreToolSpecificData({
				_meta: { source: 'cli-ts', toolKind: 'edit', backboardToolKind: 'write' },
				toolInput: '{"path":"notes.md"}',
			}),
		], [undefined, undefined]);
	});

	test('rerenders live core-tool and terminal payload replacements only', () => {
		const state = { type: IChatToolInvocation.StateKind.Executing } as IChatToolInvocation.State;
		const rerendersForReplacement = (dataKind: string, previousData: object, nextData: object) => shouldRerenderToolInvocationSubPart({
			state,
			dataKind,
			data: previousData,
		}, {
			state,
			dataKind,
			data: nextData,
		});

		assert.deepStrictEqual({
			coreTool: rerendersForReplacement('coreTool', { output: 'before' }, { output: 'after' }),
			terminal: rerendersForReplacement('terminal', { output: 'before' }, { output: 'after' }),
			generic: rerendersForReplacement('generic', { output: 'before' }, { output: 'after' }),
		}, {
			coreTool: true,
			terminal: true,
			generic: false,
		});
	});
});
