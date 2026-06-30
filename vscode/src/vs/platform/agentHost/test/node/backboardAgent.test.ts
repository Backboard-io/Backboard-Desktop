/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ResponsePartKind } from '../../common/state/sessionState.js';
import {
	backboardAttachmentToolResult,
	backboardTestPanelHistoryEntryToTurns,
	backboardTestPreferredPanelHistoryEntry,
	ensureBackboardAttachmentTool,
	isBackboardImageAttachment,
	promptWithBackboardImages,
	type BackboardPanelHistoryEntry,
	type BackboardFileAttachment,
} from '../../node/backboard/backboardAgent.js';

suite('BackboardAgent attachments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const image: BackboardFileAttachment = {
		data: [0x89, 0x50, 0x4e, 0x47],
		fileName: 'screenshot.png',
		mimeType: 'image/png',
	};

	test('detects supported image attachments by MIME type', () => {
		assert.strictEqual(isBackboardImageAttachment(image), true);
		assert.strictEqual(isBackboardImageAttachment({ ...image, mimeType: 'image/jpeg' }), true);
		assert.strictEqual(isBackboardImageAttachment({ ...image, mimeType: 'image/webp' }), true);
		assert.strictEqual(isBackboardImageAttachment({ ...image, mimeType: 'application/pdf' }), false);
	});

	test('adds attachment tool when image inspection is needed', () => {
		const tools = ensureBackboardAttachmentTool(undefined, true);
		assert.ok(Array.isArray(tools));
		assert.strictEqual(tools.length, 1);
		assert.strictEqual((tools[0] as { function?: { name?: string } }).function?.name, 'backboard_read_attachment');
		assert.strictEqual(ensureBackboardAttachmentTool(tools, true), tools);
		assert.strictEqual(ensureBackboardAttachmentTool(undefined, false), undefined);
	});

	test('prompts model to inspect images through attachment tool', () => {
		const prompt = promptWithBackboardImages('what does this say', [image]);
		assert.ok(prompt.includes('backboard_read_attachment'));
		assert.ok(prompt.includes('Do not rely on Backboard document search'));
		assert.ok(prompt.includes('screenshot.png'));
	});

	test('returns image attachment as multimodal tool output payload', () => {
		const result = backboardAttachmentToolResult([image], { index: 1 });
		assert.deepStrictEqual(result, {
			success: true,
			content: 'Attached image: screenshot.png. The continuation turn receives this image as visual input. Inspect the image directly and answer the user. Do not mention base64 or attempt to decode it with tools.',
			file_name: 'screenshot.png',
			mime_type: 'image/png',
			__image_base64: Buffer.from(image.data).toString('base64'),
			__image_media_type: 'image/png',
		});
	});

	test('prefers restored entries with a real workspace over default duplicates', () => {
		const defaultEntry: BackboardPanelHistoryEntry = {
			id: 'chat-1',
			title: 'what folder are you in',
			updatedAt: 20,
			currentWorkspace: undefined,
			messages: [
				{ role: 'user', content: 'what folder are you in' },
				{ role: 'assistant', content: 'No workspace folder is attached.' },
			],
		};
		const workspaceEntry: BackboardPanelHistoryEntry = {
			id: 'chat-1',
			title: 'write me a short story',
			updatedAt: 10,
			currentWorkspace: '/Users/test/project',
			messages: [
				{ role: 'user', content: 'write me a short story' },
				{ role: 'assistant', content: 'Once upon a time.' },
			],
		};
		assert.strictEqual(backboardTestPreferredPanelHistoryEntry(defaultEntry, workspaceEntry), workspaceEntry);
		assert.strictEqual(backboardTestPreferredPanelHistoryEntry(workspaceEntry, defaultEntry), workspaceEntry);
	});

	test('restores multi-turn panel history as multiple chat turns', () => {
		const entry: BackboardPanelHistoryEntry = {
			id: 'chat-2',
			title: 'story',
			currentWorkspace: '/Users/test/project',
			messages: [
				{ role: 'user', content: 'write a short story' },
				{ role: 'assistant', content: 'A first story.' },
				{ role: 'user', content: 'now about cats' },
				{ role: 'assistant', content: 'A cat story.' },
			],
		};
		const turns = backboardTestPanelHistoryEntryToTurns(entry);
		assert.strictEqual(turns.length, 2);
		assert.strictEqual(turns[0].message.text, 'write a short story');
		assert.strictEqual(turns[1].message.text, 'now about cats');
		const response = turns[1].responseParts[0];
		assert.strictEqual(response?.kind, ResponsePartKind.Markdown);
		assert.strictEqual(response?.kind === ResponsePartKind.Markdown ? response.content : undefined, 'A cat story.');
	});
});
