/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IChatExternalEdit, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { ToolDataSource } from '../../../../common/tools/languageModelToolsService.js';
import { CodexActivityKind, codexDisplayCommand, codexGroupSummary, describeCodexActivity, ICodexActivity } from '../../../../browser/widget/chatContentParts/codex/codexActivity.js';
import { CodexActivityGroup } from '../../../../browser/widget/chatContentParts/codex/codexActivityGroup.js';
import { CodexActivitySequence } from '../../../../browser/widget/chatContentParts/codex/codexActivitySequence.js';
import { CodexReasoningItem, formatCodexElapsed, stripCodexReasoningTitle } from '../../../../browser/widget/chatContentParts/codex/codexReasoning.js';

function serialized(toolId: string, toolSpecificData: IChatToolInvocationSerialized['toolSpecificData'], id = toolId): IChatToolInvocationSerialized {
	return {
		kind: 'toolInvocationSerialized',
		toolId,
		toolCallId: id,
		invocationMessage: toolId,
		originMessage: undefined,
		pastTenseMessage: undefined,
		presentation: undefined,
		resultDetails: undefined,
		toolSpecificData,
		isConfirmed: { type: 0 },
		isComplete: true,
		source: ToolDataSource.Internal,
		generatedTitle: undefined,
		isAttachedToThinking: false,
	} as IChatToolInvocationSerialized;
}

const command = (cmd: string, id?: string) => serialized('run_in_terminal', { kind: 'terminal', commandLine: { original: cmd }, language: 'sh' } as IChatToolInvocationSerialized['toolSpecificData'], id);
const read = (path: string, id?: string) => serialized('read', { kind: 'coreTool', toolKind: 'read', input: { file_path: path } }, id);
const activity = (kind: CodexActivityKind, icon: ICodexActivity['icon'] = 'wrench'): ICodexActivity => ({ kind, icon, running: false, failed: false, live: '', expandable: false });

suite('Codex transcript activity', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('labels finished work the way Codex does', () => {
		const edit: IChatExternalEdit = { kind: 'externalEdit', uri: URI.file('/repo/src/newChatWidget.ts'), editKind: 'edit', diff: { added: 3, removed: 6 } };
		assert.deepStrictEqual([
			describeCodexActivity(command(`bash -lc 'git status --short'`)),
			describeCodexActivity(read('/repo/README.md')),
			describeCodexActivity(edit),
		].map(a => a && { kind: a.kind, icon: a.icon, verb: a.verb, text: a.text, file: a.file?.label, added: a.added, removed: a.removed, expandable: a.expandable }), [
			{ kind: CodexActivityKind.Command, icon: 'terminal', verb: undefined, text: 'Ran git status --short', file: undefined, added: undefined, removed: undefined, expandable: true },
			{ kind: CodexActivityKind.Read, icon: 'book', verb: 'Read', text: undefined, file: 'README.md', added: undefined, removed: undefined, expandable: false },
			{ kind: CodexActivityKind.Edit, icon: 'pencil', verb: 'Edited', text: undefined, file: 'newChatWidget.ts', added: 3, removed: 6, expandable: true },
		]);
	});

	test('labels generic tools by their humanized name instead of raw arguments', () => {
		const tool = { ...serialized('OpenBrowserPage', undefined), pastTenseMessage: 'OpenBrowserPage: {"url":"https://example.com"}' } as IChatToolInvocationSerialized;
		const named = { ...serialized('open_page', undefined), pastTenseMessage: 'Opened the docs page' } as IChatToolInvocationSerialized;
		assert.deepStrictEqual([describeCodexActivity(tool)?.text, describeCodexActivity(named)?.text], ['Open browser page', 'Opened the docs page']);
	});

	test('treats image and video generation alike: a placeholder while running, no row once done', () => {
		const running = (toolId: string) => ({ ...serialized(toolId, undefined), isComplete: false } as IChatToolInvocationSerialized);
		assert.deepStrictEqual(['generate_image', 'generate_video', 'GenerateVideo'].map(toolId => {
			const activity = describeCodexActivity(serialized(toolId, undefined));
			return { toolId, media: activity?.generatedMedia, text: activity?.text, live: describeCodexActivity(running(toolId))?.live };
		}), [
			{ toolId: 'generate_image', media: 'image', text: 'Generated image', live: 'Generating image' },
			{ toolId: 'generate_video', media: 'video', text: 'Generated video', live: 'Generating video' },
			{ toolId: 'GenerateVideo', media: 'video', text: 'Generated video', live: 'Generating video' },
		]);
	});

	test('unwraps shell wrappers from displayed commands', () => {
		assert.deepStrictEqual([
			codexDisplayCommand(`/bin/zsh -lc 'npm test'`),
			codexDisplayCommand(`bash -c "echo hi"`),
			codexDisplayCommand('git log -1'),
		], ['npm test', 'echo hi', 'git log -1']);
	});

	test('summarizes a group in Codex part order with leading and following casing', () => {
		assert.deepStrictEqual([
			codexGroupSummary([activity(CodexActivityKind.Command, 'terminal'), activity(CodexActivityKind.Read, 'book')]).text,
			codexGroupSummary([activity(CodexActivityKind.Web, 'globe'), activity(CodexActivityKind.Command), activity(CodexActivityKind.Command), activity(CodexActivityKind.Edit, 'pencil'), activity(CodexActivityKind.Search, 'search')]).text,
			codexGroupSummary([activity(CodexActivityKind.Read, 'book'), activity(CodexActivityKind.List, 'folder')]).icon,
			codexGroupSummary([]).text,
		], [
			'Read files, ran a command',
			'Edited a file, read files, ran commands, searched the web',
			'book',
			'Worked',
		]);
	});

	test('an open edit row reads "Created file" and hides the link and counts', () => {
		const group = store.add(new CodexActivityGroup());
		group.addRow({ kind: 'externalEdit', uri: URI.file('/repo/notes.txt'), editKind: 'create', diff: { added: 4, removed: 0 } }, undefined);
		group.setComplete();
		mainWindow.document.body.append(group.element);
		try {
			const toggle = group.element.querySelector<HTMLButtonElement>('button[aria-label]')!;
			const header = () => (toggle.parentElement as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
			const collapsed = header();
			toggle.click();
			assert.deepStrictEqual({ label: toggle.getAttribute('aria-label'), collapsed, expanded: header() }, {
				label: 'Toggle diff for notes.txt',
				collapsed: 'Created notes.txt +4 -0',
				expanded: 'Created file',
			});
		} finally {
			group.element.remove();
		}
	});

	test('streams reasoning open as its own item and folds it closed as "Thought" when a tool runs', () => {
		const renderMarkdown = (markdown: string) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const sequence = store.add(new CodexActivitySequence(renderMarkdown));
		mainWindow.document.body.append(sequence.element);
		try {
			// Visible text only: the shimmer's highlight copy is aria-hidden, and a collapsed body shows nothing.
			const visibleText = (node: HTMLElement) => {
				const clone = node.cloneNode(true) as HTMLElement;
				clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach(hidden => hidden.remove());
				if (clone.querySelector('button[aria-expanded="false"]')) {
					clone.querySelectorAll('.cx-reasoning-scroll').forEach(body => body.remove());
				}
				return clone.textContent!.replace(/\s+/g, ' ').trim();
			};
			const units = () => Array.from(sequence.element.children as HTMLCollectionOf<HTMLElement>)
				.filter(unit => !unit.hidden && !unit.hasAttribute('data-empty'))
				.map(unit => unit.classList.contains('cx-reasoning')
					? `reasoning ${unit.querySelector('button')!.getAttribute('aria-expanded')}: ${visibleText(unit)}`
					: `group: ${visibleText(unit)}`);
			sequence.setThinking('Thinking');
			const waiting = units();
			sequence.setReasoning('0', '**Checking the sky**\nRayleigh scattering favors blue.', true);
			const streaming = units();
			sequence.addRow(read('/repo/sky.md'), undefined);
			sequence.setComplete();
			assert.deepStrictEqual({ waiting, streaming, done: units() }, {
				waiting: ['group: Thinking'],
				streaming: ['reasoning true: ThinkingRayleigh scattering favors blue.'],
				done: ['reasoning false: Thought', 'group: Read sky.md'],
			});
		} finally {
			sequence.element.remove();
		}
	});

	test('every reasoning section folds closed when its successor arrives', () => {
		const renderMarkdown = (markdown: string) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const sequence = store.add(new CodexActivitySequence(renderMarkdown));
		const reasoning = () => Array.from(sequence.element.querySelectorAll<HTMLElement>('.cx-reasoning'))
			.map(item => `${item.querySelector('button')!.getAttribute('aria-label')} ${item.querySelector('button')!.getAttribute('aria-expanded')}`);
		sequence.setReasoning('0', 'Look at the sky first.', true);
		const first = reasoning();
		sequence.setReasoning('1', 'Now explain the colour.', true);
		const second = reasoning();
		sequence.setComplete();
		assert.deepStrictEqual({ first, second, done: reasoning() }, {
			first: ['Thinking true'],
			second: ['Thought false', 'Thinking true'],
			done: ['Thought false', 'Thought false'],
		});
	});

	test('a finished section reads "Thought for Ns" and folds with the Codex motion unless it never really showed', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const renderMarkdown = (markdown: string) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const read = store.add(new CodexReasoningItem(renderMarkdown, true));
		mainWindow.document.body.append(read.element);
		let rebuilt: CodexReasoningItem | undefined;
		try {
			read.update('Blue light scatters more than red light.');
			clock.tick(12_300);
			read.finish();
			// A turn rebuilt in one pass opens and finishes each section at once.
			rebuilt = store.add(new CodexReasoningItem(renderMarkdown, true));
			mainWindow.document.body.append(rebuilt.element);
			rebuilt.update('Blue light scatters more than red light.');
			rebuilt.finish();
			const state = (item: CodexReasoningItem) => {
				const toggle = item.element.querySelector('button')!;
				const body = toggle.parentElement!.nextElementSibling as HTMLElement;
				return { label: toggle.getAttribute('aria-label'), expanded: toggle.getAttribute('aria-expanded'), animated: body.getAnimations().length > 0 };
			};
			assert.deepStrictEqual({ read: state(read), rebuilt: state(rebuilt) }, {
				read: { label: 'Thought for 12s', expanded: 'false', animated: true },
				rebuilt: { label: 'Thought', expanded: 'false', animated: false },
			});
		} finally {
			read.element.remove();
			rebuilt?.element.remove();
			clock.restore();
		}
	});

	test('a section the user opened or closed by hand stays that way when it finishes', () => {
		const renderMarkdown = (markdown: string) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const closedByHand = store.add(new CodexReasoningItem(renderMarkdown, true));
		const reopenedByHand = store.add(new CodexReasoningItem(renderMarkdown, true));
		const toggle = (item: CodexReasoningItem) => item.element.querySelector('button')!;
		for (const item of [closedByHand, reopenedByHand]) {
			item.update('Compare the wavelengths.');
		}
		toggle(closedByHand).click();
		toggle(reopenedByHand).click();
		toggle(reopenedByHand).click();
		closedByHand.finish();
		reopenedByHand.finish();
		assert.deepStrictEqual([toggle(closedByHand).getAttribute('aria-expanded'), toggle(reopenedByHand).getAttribute('aria-expanded')], ['false', 'true']);
	});

	test('a reasoning section re-sent after a tool row refreshes in place instead of starting a second item', () => {
		const renderMarkdown = (markdown: string) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const sequence = store.add(new CodexActivitySequence(renderMarkdown));
		const units = () => Array.from(sequence.element.children as HTMLCollectionOf<HTMLElement>)
			.filter(unit => !unit.hidden)
			.map(unit => unit.classList.contains('cx-reasoning') ? 'reasoning' : 'group');
		sequence.setReasoning('0', 'Read the sky notes first.', true);
		sequence.addRow(read('/repo/sky.md'), undefined);
		sequence.setReasoning('0', 'Read the sky notes first.', true);
		const afterResend = units();
		sequence.refreshReasoning('7', 'A section that never rendered.');
		sequence.setReasoning('1', 'Now summarize.', true);
		sequence.setComplete();
		assert.deepStrictEqual({ afterResend, done: units() }, {
			afterResend: ['reasoning', 'group'],
			done: ['reasoning', 'group', 'reasoning'],
		});
	});

	test('live reasoning types in word by word while finished reasoning appears at once', () => {
		const renderMarkdown = (markdown: string, target: HTMLElement | undefined) => {
			const element = target ?? mainWindow.document.createElement('p');
			element.textContent = markdown;
			return { element, dispose: () => { } };
		};
		const live = store.add(new CodexReasoningItem(renderMarkdown, true));
		live.update('Blue light scatters');
		live.update('Blue light scatters more than red light.');
		const history = store.add(new CodexReasoningItem(renderMarkdown, false));
		history.update('Blue light scatters more than red light.');
		(history.element.querySelector('button') as HTMLButtonElement).click();
		const words = (item: CodexReasoningItem) => item.element.querySelectorAll('.chat-stream-word').length;
		assert.deepStrictEqual({ live: words(live) > 0, history: words(history) }, { live: true, history: 0 });
	});

	test('formats reasoning durations and strips the leading heading the way Codex does', () => {
		assert.deepStrictEqual([
			formatCodexElapsed(400), formatCodexElapsed(12_300), formatCodexElapsed(696_000),
			stripCodexReasoningTitle('**Planning**\nFirst, read the file.'), stripCodexReasoningTitle('No heading here'),
		], [undefined, '12s', '11m 36s', 'First, read the file.', 'No heading here']);
	});

	test('renders a single finished item as its own row and several as a collapsed group', () => {
		const single = store.add(new CodexActivityGroup());
		single.addRow(read('/repo/README.md'), undefined);
		single.setComplete();

		const group = store.add(new CodexActivityGroup());
		group.addRow(command('git status --short', 'a'), undefined);
		group.addRow(read('/repo/package.json', 'b'), undefined);
		group.setComplete();
		mainWindow.document.body.append(single.element, group.element);
		try {
			const header = group.element.querySelector('button[aria-expanded]')!;
			const headerVisible = !header.parentElement!.hidden;
			const before = header.getAttribute('aria-expanded');
			(header as HTMLButtonElement).click();
			assert.deepStrictEqual({
				singleHeaderHidden: (single.element.querySelector('button[aria-expanded]')!.parentElement as HTMLElement).hidden,
				singleText: single.element.innerText.trim(),
				groupHeaderVisible: headerVisible,
				groupSummary: header.textContent,
				expandedBefore: before,
				expandedAfter: header.getAttribute('aria-expanded'),
			}, {
				singleHeaderHidden: true,
				singleText: 'Read README.md',
				groupHeaderVisible: true,
				groupSummary: 'Read files, ran a command',
				expandedBefore: 'false',
				expandedAfter: 'true',
			});
		} finally {
			single.element.remove();
			group.element.remove();
		}
	});
});
