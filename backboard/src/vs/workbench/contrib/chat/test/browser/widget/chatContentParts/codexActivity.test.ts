/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IChatExternalEdit, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { ToolDataSource } from '../../../../common/tools/languageModelToolsService.js';
import { CodexActivityKind, codexDisplayCommand, codexGroupSummary, describeCodexActivity, ICodexActivity } from '../../../../browser/widget/chatContentParts/codex/codexActivity.js';
import { CodexActivityGroup } from '../../../../browser/widget/chatContentParts/codex/codexActivityGroup.js';

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
