/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { resolveBackboardUserInfo } from '../../browser/backboardUserInfo.js';

suite('Backboard user info', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not refresh stale OAuth tokens when a cached identity is available', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/home');
		const configFolder = URI.joinPath(home, '.backboard_ide');
		await fileService.createFolder(configFolder);
		await fileService.writeFile(URI.joinPath(configFolder, 'config.json'), VSBuffer.fromString(JSON.stringify({
			api_key: 'working-api-key',
			oauth: {
				user_name: 'Erin Test',
				access_token: 'stale-access-token',
				refresh_token: 'stale-refresh-token',
			},
		})));

		let requestCount = 0;
		const requestService = new class extends mock<IRequestService>() {
			override async request(): Promise<never> {
				requestCount++;
				throw new Error('userinfo should not be requested');
			}
		};
		const pathService = new class extends mock<IPathService>() {
			override userHome(options: { preferLocal: true }): URI;
			override userHome(options?: { preferLocal: boolean }): Promise<URI>;
			override userHome(options?: { preferLocal: boolean }): URI | Promise<URI> {
				return options?.preferLocal ? home : Promise.resolve(home);
			}
		};

		const info = await resolveBackboardUserInfo(fileService, pathService, requestService, new NullLogService());
		assert.deepStrictEqual(info, { name: 'Erin Test', email: undefined, plan: undefined });
		assert.strictEqual(requestCount, 0);
	});
});
