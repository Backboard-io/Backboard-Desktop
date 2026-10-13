/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { marked } from '../../../../../../base/common/marked/marked.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { ChatRequestQueueKind } from '../../../common/chatService/chatService.js';
import { IChatProgressResponseContent, IResponse } from '../../../common/model/chatModel.js';
import { IChatPendingDividerViewModel, IChatRequestViewModel, IChatResponseViewModel } from '../../../common/model/chatViewModel.js';
import { ChatAccessibilityProvider } from '../../../browser/accessibility/chatAccessibilityProvider.js';

suite('ChatAccessibilityProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const provider = new ChatAccessibilityProvider(undefined!, undefined!);

	function request(overrides: Partial<IChatRequestViewModel>): IChatRequestViewModel {
		return {
			message: {} as IChatRequestViewModel['message'],
			messageText: '',
			variables: [],
			...overrides,
		} as IChatRequestViewModel;
	}

	test('announces a queued request as queued', () => {
		assert.strictEqual(provider.getAriaLabel(request({
			messageText: 'Run the checks',
			pendingKind: ChatRequestQueueKind.Queued,
		})), 'Queued: Run the checks');
	});

	test('announces the visible system label instead of the queued provider prompt', () => {
		assert.strictEqual(provider.getAriaLabel(request({
			messageText: 'opaque provider instruction',
			pendingKind: ChatRequestQueueKind.Steering,
			isSystemInitiated: true,
			systemInitiatedLabel: 'Compacting conversation',
		})), 'Compacting conversation');
	});

	test('includes the visible count in a queued divider label', () => {
		assert.strictEqual(provider.getAriaLabel({
			kind: 'pendingDivider',
			id: 'pending-divider-queued',
			sessionResource: undefined!,
			isComplete: true,
			dividerKind: ChatRequestQueueKind.Queued,
			pendingCount: 3,
			currentRenderedHeight: undefined,
		} satisfies IChatPendingDividerViewModel), 'Queued messages: 3');
	});

	function responseHarness(initialText: string) {
		let version = 0;
		let isComplete = false;
		let responseText = initialText;
		let stringifyCount = 0;
		const parts: IChatProgressResponseContent[] = [{ kind: 'markdownContent', content: new MarkdownString(initialText) }];
		const response = {
			value: parts,
			toString: () => {
				stringifyCount++;
				return responseText;
			},
		} as unknown as IResponse;
		const viewModel = {
			id: 'response-1',
			setVote: () => { },
			get dataId() { return `response-1_${version}`; },
			get isComplete() { return isComplete; },
			response,
			codeCitations: [],
		} as unknown as IChatResponseViewModel;

		return {
			viewModel,
			get stringifyCount() { return stringifyCount; },
			append(text: string) {
				responseText += text;
				const markdown = parts[0];
				assert.strictEqual(markdown.kind, 'markdownContent');
				parts[0] = { ...markdown, content: new MarkdownString(responseText) };
				version++;
			},
			addPart(part: IChatProgressResponseContent) {
				parts.push(part);
				version++;
			},
			complete() {
				isComplete = true;
				version++;
			},
		};
	}

	function responseProvider(): ChatAccessibilityProvider {
		return new ChatAccessibilityProvider({
			getOpenAriaHint: () => undefined,
		} as unknown as IAccessibleViewService, undefined!);
	}

	test('builds rich response metadata with one stringify and one markdown lex', () => {
		const harness = responseHarness('| A |\n| --- |\n| B |\n\n```ts\nconst value = 1;\n```');
		const lexerSpy = sinon.spy(marked, 'lexer');
		try {
			const label = responseProvider().getAriaLabel(harness.viewModel);
			assert.ok(label.includes('1 table'));
			assert.ok(label.includes('1 code block'));
			assert.strictEqual(harness.stringifyCount, 1);
			assert.strictEqual(lexerSpy.callCount, 1);
		} finally {
			lexerSpy.restore();
		}
	});

	test('caches a response version and bounds rich work while markdown streams', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const harness = responseHarness('hello');
		const provider = responseProvider();
		const lexerSpy = sinon.spy(marked, 'lexer');
		try {
			const initialLabel = provider.getAriaLabel(harness.viewModel);
			assert.strictEqual(provider.getAriaLabel(harness.viewModel), initialLabel);

			harness.append(' world');
			clock.tick(100);
			assert.strictEqual(provider.getAriaLabel(harness.viewModel), initialLabel);
			assert.strictEqual(harness.stringifyCount, 1);
			assert.strictEqual(lexerSpy.callCount, 1);

			clock.tick(500);
			harness.append(' again');
			const refreshedLabel = provider.getAriaLabel(harness.viewModel);
			assert.ok(refreshedLabel.includes('hello world again'));
			assert.strictEqual(harness.stringifyCount, 2);
			assert.strictEqual(lexerSpy.callCount, 2);

			harness.append(' done');
			harness.complete();
			const completedLabel = provider.getAriaLabel(harness.viewModel);
			assert.ok(completedLabel.includes('hello world again done'));
			assert.strictEqual(harness.stringifyCount, 3, 'completion should bypass the streaming cadence');
			assert.strictEqual(lexerSpy.callCount, 3);
		} finally {
			lexerSpy.restore();
			clock.restore();
		}
	});

	test('does not throttle structural response changes', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const harness = responseHarness('hello');
		const provider = responseProvider();
		try {
			provider.getAriaLabel(harness.viewModel);
			harness.addPart({ kind: 'treeData' } as IChatProgressResponseContent);
			clock.tick(100);
			const label = provider.getAriaLabel(harness.viewModel);
			assert.ok(label.includes('1 file tree'));
			assert.strictEqual(harness.stringifyCount, 2);
		} finally {
			clock.restore();
		}
	});
});
