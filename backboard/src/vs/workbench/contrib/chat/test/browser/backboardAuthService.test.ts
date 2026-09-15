/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { BackboardAuthService } from '../../browser/backboardAuthService.js';
import { BackboardAuthContextKeys } from '../../common/backboardAuth.js';

suite('Backboard auth state', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(initialConfig = '{}', alternative = false) {
		// The memory provider emits uncorrelated events; adapt those events to
		// the same per-directory watcher contract supplied by the disk provider.
		const files = disposables.add(new class extends FileService {
			override createWatcher(resource: URI): IFileSystemWatcher {
				return { onDidChange: Event.filter(this.onDidFilesChange, event => event.affects(resource)), dispose: () => {} };
			}
		}(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/home');
		const config = URI.joinPath(home, '.backboard_ide', 'config.json');
		await files.writeFile(config, VSBuffer.fromString(initialConfig));
		const context = disposables.add(new ContextKeyService(new TestConfigurationService()));
		const commandEvents = disposables.add(new Emitter<ICommandEvent>());
		let check = async (): Promise<boolean> => alternative;
		const commands = new class extends mock<ICommandService>() {
			override readonly onDidExecuteCommand = commandEvents.event;
			override async executeCommand<T>(id: string): Promise<T> {
				assert.strictEqual(id, 'backboard.hasAlternativeCredentials');
				return await check() as T;
			}
		};
		const paths = new class extends mock<IPathService>() {
			override userHome(options: { preferLocal: true }): URI;
			override userHome(options?: { preferLocal: boolean }): Promise<URI>;
			override userHome(options?: { preferLocal: boolean }): URI | Promise<URI> {
				return options?.preferLocal ? home : Promise.resolve(home);
			}
		};
		const service = disposables.add(new BackboardAuthService(context, files, paths, commands, new NullLogService()));
		await service.refresh();
		await timeout(0);
		const state = () => [BackboardAuthContextKeys.signedIn, BackboardAuthContextKeys.alternativeConfigured].map(key => context.getContextKeyValue<boolean>(key.key));
		return { service, context, files, config, commandEvents, state, setCheck: (value: () => Promise<boolean>) => { check = value; } };
	}

	test('restores saved SSO credentials on window startup', async () => {
		const auth = await setup('{"oauth":{"access_token":"test-token"}}');
		assert.deepStrictEqual(auth.state(), [true, false]);
	});

	test('keeps existing subscription credentials when another view opens', async () => {
		const auth = await setup('{}', true);
		const view = disposables.add(auth.context.createScoped(document.createElement('div')));
		await auth.service.refresh();
		assert.deepStrictEqual([auth.state(), view.getContextKeyValue(BackboardAuthContextKeys.alternativeConfigured.key)], [[false, true], true]);
	});

	test('discards an older check that finishes after subscription setup', async () => {
		const auth = await setup();
		const stale = new DeferredPromise<boolean>();
		auth.setCheck(() => stale.p);
		const olderRefresh = auth.service.refresh();
		await timeout(0);
		auth.setCheck(async () => true);
		await auth.service.refresh();
		await stale.complete(false);
		await olderRefresh;
		assert.deepStrictEqual(auth.state(), [false, true]);
	});

	test('retains connection during a failed probe and clears it on verified sign-out', async () => {
		const auth = await setup('{}', true);
		auth.setCheck(async () => { throw new Error('extension host restarting'); });
		await auth.service.refresh();
		assert.deepStrictEqual(auth.state(), [false, true]);
		auth.setCheck(async () => false);
		await auth.service.refresh();
		assert.deepStrictEqual(auth.state(), [false, false]);
	});

	test('refreshes after setup completes outside the auth gate', async () => {
		const auth = await setup();
		auth.setCheck(async () => true);
		auth.commandEvents.fire({ commandId: 'backboard.setupSubscription', args: [] });
		await timeout(0);
		assert.deepStrictEqual(auth.state(), [false, true]);
	});

	test('unblocks SSO while the subscription probe is still pending', async () => {
		const auth = await setup();
		const pending = new DeferredPromise<boolean>();
		auth.setCheck(() => pending.p);
		await auth.files.writeFile(auth.config, VSBuffer.fromString('{"api_key":"test-key"}'));
		const refresh = auth.service.refresh();
		await timeout(0);
		assert.deepStrictEqual(auth.state(), [true, false]);
		await pending.complete(false);
		await refresh;
	});

	test('picks up first sign-in and credential removal from disk', async () => {
		const auth = await setup();
		await auth.files.writeFile(auth.config, VSBuffer.fromString('{"oauth":{"access_token":"test-token"}}'));
		await timeout(50);
		assert.deepStrictEqual(auth.state(), [true, false]);
		await auth.files.del(auth.config);
		await timeout(50);
		assert.deepStrictEqual(auth.state(), [false, false]);
	});
});
