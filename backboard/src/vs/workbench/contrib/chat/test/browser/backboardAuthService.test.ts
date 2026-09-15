/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentSessionsWelcomePage } from '../../../welcomeAgentSessions/browser/agentSessionsWelcome.js';
import { BackboardRefreshAuthStateAction } from '../../electron-browser/actions/backboardSsoActions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { FileSystemProviderCapabilities, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { OnboardingVariationA } from '../../../welcomeOnboarding/browser/onboardingVariationA.js';
import { renderBackboardAuthGate } from '../../browser/backboardAuthSetup.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { BackboardAuthService } from '../../browser/backboardAuthService.js';
import { BackboardAuthContextKeys, IBackboardAuthService } from '../../common/backboardAuth.js';

suite('Backboard auth state', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(initialConfig = '{}', alternative = false, watchEvents = true) {
		// The memory provider emits uncorrelated events; adapt those events to
		// the same per-directory watcher contract supplied by the disk provider.
		const files = disposables.add(new class extends FileService {
			override createWatcher(resource: URI): IFileSystemWatcher {
				return { onDidChange: watchEvents ? Event.filter(this.onDidFilesChange, event => event.affects(resource)) : Event.None, dispose: () => {} };
			}
		}(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new class extends InMemoryFileSystemProvider {
			// Memory writes replace the complete buffer synchronously.
			override get capabilities(): FileSystemProviderCapabilities { return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite; }
		}())));
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
		return { service, context, files, config, commands, paths, commandEvents, state, setCheck: (value: () => Promise<boolean>) => { check = value; } };
	}

	test('onboarding key save hides every auth gate without a file-watcher event', async () => {
		const auth = await setup('{}', false, false);
		const hosts = [document.createElement('div'), document.createElement('div')];
		const scoped = disposables.add(auth.context.createScoped(hosts[1]));
		for (const [index, host] of hosts.entries()) {
			document.body.appendChild(host);
			disposables.add(toDisposable(() => host.remove()));
			disposables.add(renderBackboardAuthGate(host, auth.commands, index === 0 ? auth.context : scoped, auth.service));
			assert.strictEqual(host.querySelector<HTMLElement>('.backboard-auth-gate-overlay')!.hidden, false);
		}
		const onboarding = Object.create(OnboardingVariationA.prototype) as {
			fileService: FileService;
			pathService: IPathService;
			configurationService: TestConfigurationService;
			backboardAuthService: BackboardAuthService;
			_saveBackboardApiKey(key: string): Promise<void>;
		};
		onboarding.fileService = auth.files;
		onboarding.pathService = auth.paths;
		onboarding.configurationService = new TestConfigurationService();
		onboarding.backboardAuthService = auth.service;
		await onboarding._saveBackboardApiKey('test-reviewer-key');
		assert.deepStrictEqual(auth.state(), [true, false]);
		for (const host of hosts) {
			const overlay = host.querySelector<HTMLElement>('.backboard-auth-gate-overlay')!;
			assert.strictEqual(overlay.hidden, true);
			assert.strictEqual(getComputedStyle(overlay).display, 'none');
			assert.strictEqual(host.classList.contains('backboard-auth-gate-active'), false);
		}
		await auth.files.del(auth.config);
		await auth.service.refresh();
		assert.ok(hosts.every(host => !host.querySelector<HTMLElement>('.backboard-auth-gate-overlay')!.hidden));
	});

	test('SSO completion hides the Simple welcome popup after its credential folder is recreated', async () => {
		const auth = await setup('{}', false, false);
		await auth.files.del(URI.file('/home/.backboard_ide'), { recursive: true });
		const host = document.createElement('div');
		host.className = 'agentSessionsWelcome';
		document.body.appendChild(host);
		disposables.add(toDisposable(() => host.remove()));
		const context = disposables.add(auth.context.createScoped(host));
		const welcome = Object.assign(Object.create(AgentSessionsWelcomePage.prototype), {
			container: host, contextService: context, commandService: auth.commands, backboardAuthService: auth.service,
			_register: <T extends IDisposable>(value: T): T => disposables.add(value),
		}) as { createBackboardAuthGate(): void; updateBackboardAuthGate(): void };
		disposables.add(context.onDidChangeContext(() => welcome.updateBackboardAuthGate()));
		welcome.createBackboardAuthGate();
		welcome.updateBackboardAuthGate();
		const overlay = host.querySelector<HTMLElement>('.backboard-auth-gate-overlay')!;
		assert.notStrictEqual(getComputedStyle(overlay).display, 'none');
		// Command-start notifications happen before browser approval and cannot
		// observe the token. The completion callback must work without a watcher.
		auth.commandEvents.fire({ commandId: 'backboard.extension.signIn', args: [] });
		await timeout(0);
		await auth.files.writeFile(auth.config, VSBuffer.fromString('{"oauth":{"access_token":"test-token"}}'));
		const instantiation = disposables.add(new InstantiationService(new ServiceCollection([IBackboardAuthService, auth.service])));
		await instantiation.invokeFunction(accessor => new BackboardRefreshAuthStateAction().run(accessor));
		assert.deepStrictEqual([getComputedStyle(overlay).display, host.classList.contains('backboard-auth-gate-active')], ['none', false]);
		await auth.files.del(auth.config);
		await auth.service.refresh();
		assert.notStrictEqual(getComputedStyle(overlay).display, 'none');
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
});
