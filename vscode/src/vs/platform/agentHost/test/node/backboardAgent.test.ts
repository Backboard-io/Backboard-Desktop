/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	backboardAttachmentToolResult,
	ensureBackboardAttachmentTool,
	isBackboardImageAttachment,
	promptWithBackboardImages,
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
});
