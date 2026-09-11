/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { backboardConfigApiKey, clearBackboardCredentials, hasBackboardCredentials, readBackboardConfigJson } from '../../common/backboardAuth.js';

suite('Backboard credentials', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let files: FileService;
	const config = URI.parse('test:/home/reviewer/.backboard_ide/config.json');

	setup(() => {
		files = store.add(new FileService(new NullLogService()));
		const provider = store.add(new class extends InMemoryFileSystemProvider {
			override get capabilities(): FileSystemProviderCapabilities {
				return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
			}
		}());
		store.add(files.registerProvider('test', provider));
	});

	test('sign out removes every environment key and SSO token while preserving preferences and chats', async () => {
		await files.writeFile(config, VSBuffer.fromString(JSON.stringify({
			env: 'prod', api_key: 'test-key', apiKey: 'legacy-key', env_keys: { prod: 'test-prod', dev: 'test-dev' },
			oauth: { access_token: 'test-access', refresh_token: 'test-refresh', personal_api_key: 'test-personal', user_name: 'Reviewer' },
			model: 'test-model', theme: 'dark',
		})));
		const history = URI.joinPath(config, '..', 'history.json');
		await files.writeFile(history, VSBuffer.fromString('["existing chat"]'));
		assert.strictEqual(await hasBackboardCredentials(files, config), true);
		await clearBackboardCredentials(files, config);
		assert.strictEqual(await hasBackboardCredentials(files, config), false);
		assert.deepStrictEqual(await readBackboardConfigJson(files, config), { env: 'prod', model: 'test-model', theme: 'dark' });
		assert.strictEqual((await files.readFile(history)).value.toString(), '["existing chat"]');
		await clearBackboardCredentials(files, config);
		assert.strictEqual(await hasBackboardCredentials(files, config), false);
	});

	test('sign out before the first sign in does not create a config', async () => {
		await clearBackboardCredentials(files, config);
		assert.strictEqual(await files.exists(config), false);
	});

	test('environment aliases resolve credentials and sign out removes them', async () => {
		await files.writeFile(config, VSBuffer.fromString(JSON.stringify({ env: 'production', env_keys: { production: 'test-key' } })));
		assert.strictEqual(backboardConfigApiKey(await readBackboardConfigJson(files, config)), 'test-key');
		await clearBackboardCredentials(files, config);
		assert.strictEqual(await hasBackboardCredentials(files, config), false);
	});

	test('SSO-only accounts become signed out', async () => {
		await files.writeFile(config, VSBuffer.fromString(JSON.stringify({ oauth: { access_token: 'test-access' } })));
		assert.strictEqual(await hasBackboardCredentials(files, config), true);
		await clearBackboardCredentials(files, config);
		assert.strictEqual(await hasBackboardCredentials(files, config), false);
	});
});
