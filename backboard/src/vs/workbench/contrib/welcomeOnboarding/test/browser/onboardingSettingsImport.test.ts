/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import type { IUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import type { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { IExtensionGalleryService, IExtensionInfo, IExtensionManagementService, IGalleryExtension, ILocalExtension, InstallOptions } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { TargetPlatform } from '../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

type ImportHarnessObject = {
	fileService: IFileService;
	userDataProfileService: IUserDataProfileService;
	extensionManagementService: IExtensionManagementService;
	extensionGalleryService: IExtensionGalleryService;
	notificationService: { notify(notification: { severity: Severity; message: string; source?: string }): void };
	accessibilityService: { alert(message: string): void };
	_logAction(action: string, stepOverride?: unknown, argument?: string): void;
	_nextStep(): void;
	_importSettingsFromSource(source: unknown, button: HTMLButtonElement, selection?: { settings: boolean; keybindings: boolean; extensions: boolean }): Promise<void>;
};

suite('Backboard onboarding settings import', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: FileService;
	let sourceUserDataHome: URI;
	let sourceExtensionsHome: URI;
	let profile: IUserDataProfile;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));

		sourceUserDataHome = URI.from({ scheme: Schemas.inMemory, path: '/External/Code/User' });
		sourceExtensionsHome = URI.from({ scheme: Schemas.inMemory, path: '/External/.vscode/extensions' });
		const profileLocation = URI.from({ scheme: Schemas.inMemory, path: '/Backboard/User' });
		profile = {
			id: 'default',
			isDefault: true,
			name: 'Default',
			location: profileLocation,
			globalStorageHome: joinPath(profileLocation, 'globalStorage'),
			settingsResource: joinPath(profileLocation, 'settings.json'),
			keybindingsResource: joinPath(profileLocation, 'keybindings.json'),
			tasksResource: joinPath(profileLocation, 'tasks.json'),
			snippetsHome: joinPath(profileLocation, 'snippets'),
			promptsHome: joinPath(profileLocation, 'prompts'),
			extensionsResource: joinPath(profileLocation, 'extensions'),
			mcpResource: joinPath(profileLocation, 'mcp.json'),
			languageModelsResource: joinPath(profileLocation, 'languageModels.json'),
			agentPluginsHome: joinPath(profileLocation, 'agentPlugins'),
			cacheHome: joinPath(profileLocation, 'cache'),
		};
	});

	function createImportHarness() {
		const testObject = Object.create(OnboardingVariationA.prototype) as ImportHarnessObject;

		const notifications: Array<{ severity: Severity; message: string; source?: string }> = [];
		const installedExtensions: Array<{ extension: IGalleryExtension; options: InstallOptions | undefined }> = [];
		let advanced = false;

		testObject.fileService = fileService;
		testObject.userDataProfileService = { currentProfile: profile } as Partial<IUserDataProfileService> as IUserDataProfileService;
		testObject.extensionGalleryService = {
			isEnabled: () => true,
			getExtensions: async (extensionInfos: ReadonlyArray<IExtensionInfo>) => extensionInfos.map(extensionInfo => ({
				type: 'gallery',
				identifier: { id: extensionInfo.id, uuid: extensionInfo.uuid ?? `${extensionInfo.id}-uuid` },
				version: '1.0.0',
			} as Partial<IGalleryExtension> as IGalleryExtension)),
		} as Partial<IExtensionGalleryService> as IExtensionGalleryService;
		testObject.extensionManagementService = {
			getInstalled: async () => [],
			getTargetPlatform: async () => TargetPlatform.UNIVERSAL,
			canInstall: async () => true,
			installFromGallery: async (extension: IGalleryExtension, options?: InstallOptions) => {
				installedExtensions.push({ extension, options });
				return { identifier: extension.identifier } as Partial<ILocalExtension> as ILocalExtension;
			},
		} as Partial<IExtensionManagementService> as IExtensionManagementService;
		testObject.notificationService = { notify: (notification: { severity: Severity; message: string; source?: string }) => notifications.push(notification) };
		testObject.accessibilityService = { alert: () => undefined };
		testObject._logAction = () => undefined;
		testObject._nextStep = () => { advanced = true; };

		return {
			testObject,
			notifications,
			installedExtensions,
			get advanced() { return advanced; },
		};
	}

	function source(label = 'Visual Studio Code') {
		return {
			id: 'vscode',
			label,
			description: 'Import test source',
			icon: 'onboarding-vscode.png',
			userDataHome: sourceUserDataHome,
			extensionsHome: sourceExtensionsHome,
		};
	}

	async function read(resource: URI): Promise<string> {
		return (await fileService.readFile(resource)).value.toString();
	}

	test('imports settings, keybindings, and snippets into the current profile when a source is chosen', async () => {
		const settings = '{ "editor.fontSize": 17 }\n';
		const keybindings = '[{ "key": "cmd+k cmd+i", "command": "editor.action.showHover" }]\n';
		const languageSnippet = '{ "Print": { "prefix": "pp", "body": "print($1)" } }\n';
		const globalSnippet = '{ "Console": { "prefix": "cl", "body": "console.log($1)" } }\n';

		await fileService.createFolder(sourceUserDataHome);
		await fileService.writeFile(joinPath(sourceUserDataHome, 'settings.json'), VSBuffer.fromString(settings));
		await fileService.writeFile(joinPath(sourceUserDataHome, 'keybindings.json'), VSBuffer.fromString(keybindings));
		await fileService.createFolder(joinPath(sourceUserDataHome, 'snippets'));
		await fileService.writeFile(joinPath(sourceUserDataHome, 'snippets', 'python.json'), VSBuffer.fromString(languageSnippet));
		await fileService.writeFile(joinPath(sourceUserDataHome, 'snippets', 'global.code-snippets'), VSBuffer.fromString(globalSnippet));
		await fileService.writeFile(joinPath(sourceUserDataHome, 'snippets', 'README.md'), VSBuffer.fromString('not a snippet'));

		const harness = createImportHarness();
		const button = document.createElement('button');

		await harness.testObject._importSettingsFromSource(source(), button);

		assert.strictEqual(harness.advanced, true, JSON.stringify(harness.notifications));
		assert.strictEqual(button.disabled, false);
		assert.strictEqual(button.hasAttribute('aria-busy'), false);
		assert.strictEqual(await read(profile.settingsResource), settings);
		assert.strictEqual(await read(profile.keybindingsResource), keybindings);
		assert.strictEqual(await read(joinPath(profile.snippetsHome, 'python.json')), languageSnippet);
		assert.strictEqual(await read(joinPath(profile.snippetsHome, 'global.code-snippets')), globalSnippet);
		assert.strictEqual(await fileService.exists(joinPath(profile.snippetsHome, 'README.md')), false);
		assert.strictEqual(harness.notifications.length, 1);
		assert.strictEqual(harness.notifications[0].severity, Severity.Info);
		assert.ok(harness.notifications[0].message.includes('Settings'));
		assert.ok(harness.notifications[0].message.includes('Keyboard Shortcuts'));
		assert.ok(harness.notifications[0].message.includes('Snippets'));
		assert.strictEqual(harness.installedExtensions.length, 0);
	});

	test('imports only the selected settings buckets from the selected source', async () => {
		const settings = '{ "editor.fontSize": 17 }\n';
		const keybindings = '[{ "key": "cmd+k cmd+i", "command": "editor.action.showHover" }]\n';

		await fileService.createFolder(sourceUserDataHome);
		await fileService.writeFile(joinPath(sourceUserDataHome, 'settings.json'), VSBuffer.fromString(settings));
		await fileService.writeFile(joinPath(sourceUserDataHome, 'keybindings.json'), VSBuffer.fromString(keybindings));

		const harness = createImportHarness();
		const button = document.createElement('button');

		await harness.testObject._importSettingsFromSource(source(), button, { settings: false, keybindings: true, extensions: false });

		assert.strictEqual(harness.advanced, true, JSON.stringify(harness.notifications));
		assert.strictEqual(await fileService.exists(profile.settingsResource), false);
		assert.strictEqual(await read(profile.keybindingsResource), keybindings);
		assert.strictEqual(harness.installedExtensions.length, 0);
		assert.strictEqual(harness.notifications.length, 1);
		assert.strictEqual(harness.notifications[0].severity, Severity.Info);
		assert.ok(!harness.notifications[0].message.includes('Settings'));
		assert.ok(harness.notifications[0].message.includes('Keyboard Shortcuts'));
		assert.ok(!harness.notifications[0].message.includes('Extensions'));
	});

	test('imports selected extensions from the selected source when marketplace install is available', async () => {
		await fileService.createFolder(sourceExtensionsHome);
		await fileService.writeFile(joinPath(sourceExtensionsHome, 'extensions.json'), VSBuffer.fromString(JSON.stringify([
			{
				identifier: { id: 'Example.Theme', uuid: 'theme-uuid' },
				metadata: { isPreReleaseVersion: true },
			},
			{
				identifier: { id: 'anysphere.remote-ssh', uuid: 'cursor-remote-ssh-uuid' },
			},
			{
				identifier: { id: 'anthropic.claude-code' },
			},
			{
				identifier: { id: 'publisher.extension' },
				isBuiltin: true,
			},
		])));

		const harness = createImportHarness();
		const button = document.createElement('button');

		await harness.testObject._importSettingsFromSource(source(), button, { settings: false, keybindings: false, extensions: true });

		assert.deepStrictEqual(harness.installedExtensions.map(({ extension, options }) => ({
			id: extension.identifier.id,
			profileLocation: options?.profileLocation?.toString(),
			installPreReleaseVersion: options?.installPreReleaseVersion,
			skipWalkthrough: options?.context?.skipWalkthrough,
			skipPublisherTrust: options?.context?.skipPublisherTrust,
		})), [
			{
				id: 'Example.Theme',
				profileLocation: profile.extensionsResource.toString(),
				installPreReleaseVersion: true,
				skipWalkthrough: true,
				skipPublisherTrust: true,
			},
			{
				id: 'ms-vscode-remote.remote-ssh',
				profileLocation: profile.extensionsResource.toString(),
				installPreReleaseVersion: false,
				skipWalkthrough: true,
				skipPublisherTrust: true,
			},
			{
				id: 'anthropic.claude-code',
				profileLocation: profile.extensionsResource.toString(),
				installPreReleaseVersion: false,
				skipWalkthrough: true,
				skipPublisherTrust: true,
			},
		]);
		assert.strictEqual(harness.advanced, true, JSON.stringify(harness.notifications));
		assert.strictEqual(harness.notifications.length, 1);
		assert.strictEqual(harness.notifications[0].severity, Severity.Info);
		assert.ok(harness.notifications[0].message.includes('Extensions'));
	});

	test('falls back to scanning extension folders when source metadata is missing', async () => {
		await fileService.createFolder(joinPath(sourceExtensionsHome, 'sample.extension-1.0.0'));
		await fileService.writeFile(joinPath(sourceExtensionsHome, 'sample.extension-1.0.0', 'package.json'), VSBuffer.fromString(JSON.stringify({
			publisher: 'sample',
			name: 'extension',
			__metadata: { preRelease: true },
		})));

		const harness = createImportHarness();
		const button = document.createElement('button');

		await harness.testObject._importSettingsFromSource(source(), button, { settings: false, keybindings: false, extensions: true });

		assert.deepStrictEqual(harness.installedExtensions.map(({ extension, options }) => ({
			id: extension.identifier.id,
			installPreReleaseVersion: options?.installPreReleaseVersion,
		})), [
			{
				id: 'sample.extension',
				installPreReleaseVersion: true,
			},
		]);
		assert.strictEqual(harness.advanced, true, JSON.stringify(harness.notifications));
		assert.ok(harness.notifications[0].message.includes('Extensions'));
	});

	test('warns and stays on the import step when the selected source has nothing to import', async () => {
		await fileService.createFolder(sourceUserDataHome);

		const harness = createImportHarness();
		const button = document.createElement('button');

		await harness.testObject._importSettingsFromSource(source('Cursor'), button);

		assert.strictEqual(harness.advanced, false);
		assert.strictEqual(button.disabled, false);
		assert.strictEqual(await fileService.exists(profile.settingsResource), false);
		assert.strictEqual(await fileService.exists(profile.keybindingsResource), false);
		assert.strictEqual(await fileService.exists(profile.snippetsHome), false);
		assert.strictEqual(harness.notifications.length, 1);
		assert.strictEqual(harness.notifications[0].severity, Severity.Warning);
		assert.ok(harness.notifications[0].message.includes('No selected Cursor items were found'));
	});
});
