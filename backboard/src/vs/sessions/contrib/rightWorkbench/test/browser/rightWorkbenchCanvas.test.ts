/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatRequestModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { extractCanvasImageGroups } from '../../browser/rightWorkbenchCanvas.js';

function turn(timestamp: number, ...markdown: string[]): IChatRequestModel {
	const value = markdown.map(text => ({ kind: 'markdownContent' as const, content: new MarkdownString(text) }));
	return { timestamp, response: { timestamp, response: { value } } } as unknown as IChatRequestModel;
}

suite('RightWorkbenchCanvas', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('groups generated images by turn with their saved copies', () => {
		const cwd = URI.file('/work');
		const first = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-image/a.png';
		const second = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-image/b.png';
		const groups = extractCanvasImageGroups([
			turn(1000, `Here you go.\n\n![Surf laptop](${first})\n\nSaved to \`generated-images/generated-aaa.png\`.`),
			turn(2000, `![](${second})`, `Again: ![Surf laptop](${first})`, '![clip](https://x.test/v.mp4) ![bad](javascript:alert(1))'),
			turn(3000, 'No images here.'),
		], cwd);

		assert.deepStrictEqual(groups.map(group => ({
			timestamp: group.timestamp,
			images: group.images.map(image => ({ label: image.label, src: image.src.toString(), localFile: image.localFile?.path })),
		})), [
			{ timestamp: 1000, images: [{ label: 'Surf laptop', src: first, localFile: '/work/generated-images/generated-aaa.png' }] },
			{ timestamp: 2000, images: [{ label: 'Generated image 2', src: second, localFile: undefined }] },
		]);
	});
});
