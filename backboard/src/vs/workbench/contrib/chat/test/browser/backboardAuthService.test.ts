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
import { BackboardAuthContextKeys, BackboardTitleBarSignInWhen } from '../../common/backboardAuth.js';

suite('Backboard auth state', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(initialConfig = '{}', alternative = false, options: { check?: () => Promise<boolean>; watcherFailure?: boolean; waitForInitial?: boolean } = {}) {
		// The memory provider emits uncorrelated events; adapt those events to
		// the same per-directory watcher contract supplied by the disk provider.
		const files = disposables.add(new class extends FileService {
			override createWatcher(resource: URI): IFileSystemWatcher {
				if (options.watcherFailure) { throw new Error('Watcher unavailable'); }
				return { onDidChange: Event.filter(this.onDidFilesChange, event => event.affects(resource)), dispose: () => {} };
			}
		}(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/home');
		const config = URI.joinPath(home, '.backboard_ide', 'config.json');
		await files.writeFile(config, VSBuffer.fromString(initialConfig));
		const context = disposables.add(new ContextKeyService(new TestConfigurationService()));
		const commandEvents = disposables.add(new Emitter<ICommandEvent>());
		let check = options.check ?? (async (): Promise<boolean> => alternative);
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
		if (options.waitForInitial !== false) {
			await service.refresh();
			await timeout(0);
		}
		const state = () => [BackboardAuthContextKeys.signedIn, BackboardAuthContextKeys.alternativeConfigured].map(key => context.getContextKeyValue<boolean>(key.key));
		return { service, context, files, config, commandEvents, state, setCheck: (value: () => Promise<boolean>) => { check = value; } };
	}

	test('keeps startup auth undetermined until the credential probe answers', async () => {
		const pending = new DeferredPromise<boolean>();
		const auth = await setup('{}', false, { check: () => pending.p, waitForInitial: false });
		assert.strictEqual(auth.context.getContextKeyValue(BackboardAuthContextKeys.resolved.key), false);
		await pending.complete(false);
		await auth.service.refresh();
		assert.strictEqual(auth.context.getContextKeyValue(BackboardAuthContextKeys.resolved.key), true);
		assert.deepStrictEqual(auth.state(), [false, false]);
	});

	test('restores sign-in even when filesystem watchers are unavailable', async () => {
		const auth = await setup('{"oauth":{"access_token":"test-token"}}', false, { watcherFailure: true });
		assert.deepStrictEqual(auth.state(), [true, false]);
		assert.strictEqual(auth.context.getContextKeyValue(BackboardAuthContextKeys.resolved.key), true);
	});

	test('preserves guest free-model access when the extension probe fails', async () => {
		const auth = await setup('{"guest":{"api_key":"guest-test-key"}}', false, {
			check: async () => { throw new Error('extension host starting'); },
		});
		assert.deepStrictEqual(auth.state(), [false, true]);
		assert.strictEqual(auth.context.getContextKeyValue(BackboardAuthContextKeys.resolved.key), true);
	});

	test('keeps a guest key apart from a connected subscription or provider key', async () => {
		const auth = await setup('{"guest":{"api_key":"guest-test-key"}}', false);
		const byo = () => auth.context.getContextKeyValue<boolean>(BackboardAuthContextKeys.byoConfigured.key);
		assert.deepStrictEqual([auth.state(), byo()], [[false, true], false]);
		auth.setCheck(async () => true);
		await auth.service.refresh();
		assert.deepStrictEqual([auth.state(), byo()], [[false, true], true]);
		auth.setCheck(async () => false);
		await auth.service.refresh();
		BackboardAuthContextKeys.providerKeyConfigured.bindTo(auth.context).set(true);
		assert.deepStrictEqual([auth.state(), byo()], [[false, true], true]);
	});

	test('keeps a connected subscription through a failed probe and drops it on verified sign-out', async () => {
		const auth = await setup('{}', true);
		const byo = () => auth.context.getContextKeyValue<boolean>(BackboardAuthContextKeys.byoConfigured.key);
		const connected = byo();
		auth.setCheck(async () => { throw new Error('extension host restarting'); });
		await auth.service.refresh();
		const duringFailure = byo();
		auth.setCheck(async () => false);
		await auth.service.refresh();
		assert.deepStrictEqual({ connected, duringFailure, afterSignOut: byo() }, { connected: true, duringFailure: true, afterSignOut: false });
	});

	test('offers the title bar Sign in only to someone with no credentials of their own', async () => {
		const shown = (auth: { context: ContextKeyService }) => auth.context.contextMatchesRules(BackboardTitleBarSignInWhen);
		const probe = new DeferredPromise<boolean>();
		const starting = await setup('{}', false, { check: () => probe.p, waitForInitial: false });
		const whileChecking = shown(starting);
		await probe.complete(false);
		await starting.service.refresh();
		const providerKey = await setup('{}', false);
		BackboardAuthContextKeys.providerKeyConfigured.bindTo(providerKey.context).set(true);
		assert.deepStrictEqual({
			whileChecking,
			signedOut: shown(starting),
			guest: shown(await setup('{"guest":{"api_key":"guest-test-key"}}', false)),
			subscription: shown(await setup('{}', true)),
			providerKey: shown(providerKey),
			signedIn: shown(await setup('{"oauth":{"access_token":"test-token"}}')),
		}, { whileChecking: false, signedOut: true, guest: true, subscription: false, providerKey: false, signedIn: false });
	});

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

	test('refreshes subscription sign-in and disconnect when CLI config changes', async () => {
		const auth = await setup();
		const subscriptionConfig = URI.file('/home/.backboard/config.json');
		auth.setCheck(async () => true);
		await auth.files.writeFile(subscriptionConfig, VSBuffer.fromString('{"claudeSubscriptionEnabled":true}'));
		await timeout(50);
		assert.deepStrictEqual(auth.state(), [false, true]);
		auth.setCheck(async () => false);
		await auth.files.del(subscriptionConfig);
		await timeout(50);
		assert.deepStrictEqual(auth.state(), [false, false]);
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

	test('treats a key in the IDE key store as a credential the CLI probe cannot see', async () => {
		const auth = await setup('{}', false);
		assert.deepStrictEqual(auth.state(), [false, false]);
		const providerKey = BackboardAuthContextKeys.providerKeyConfigured.bindTo(auth.context);
		providerKey.set(true);
		assert.deepStrictEqual(auth.state(), [false, true]);
		await auth.service.refresh();
		assert.deepStrictEqual(auth.state(), [false, true]);
		providerKey.set(false);
		assert.deepStrictEqual(auth.state(), [false, false]);
	});

	test('ignores runtime cache writes and coalesces bursts of credential writes', async () => {
		const auth = await setup();
		await timeout(50); // let setup's own config write settle
		let probes = 0;
		const pending = new DeferredPromise<boolean>();
		auth.setCheck(() => { probes++; return pending.p; });
		for (const cache of ['/home/.backboard_ide/cli-ts-sessions.json', '/home/.backboard_ide/models-cache.json', '/home/.backboard/assistants-cache.json']) {
			await auth.files.writeFile(URI.file(cache), VSBuffer.fromString('{}'));
		}
		await timeout(50);
		assert.strictEqual(probes, 0);
		const keys = URI.file('/home/.backboard/keys.json');
		for (let i = 0; i < 5; i++) {
			await auth.files.writeFile(keys, VSBuffer.fromString(`{"n":${i}}`));
			await timeout(10);
		}
		assert.strictEqual(probes, 1);
		await pending.complete(true);
		await timeout(50);
		assert.strictEqual(probes, 2);
		assert.deepStrictEqual(auth.state(), [false, true]);
	});
});
