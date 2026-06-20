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
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

type ImportHarnessObject = {
	fileService: IFileService;
	userDataProfileService: IUserDataProfileService;
	notificationService: { notify(notification: { severity: Severity; message: string; source?: string }): void };
	accessibilityService: { alert(message: string): void };
	_logAction(action: string, stepOverride?: unknown, argument?: string): void;
	_nextStep(): void;
	_importSettingsFromSource(source: unknown, button: HTMLButtonElement): Promise<void>;
};

suite('Backboard onboarding settings import', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: FileService;
	let sourceUserDataHome: URI;
	let profile: IUserDataProfile;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));

		sourceUserDataHome = URI.from({ scheme: Schemas.inMemory, path: '/External/Code/User' });
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
		let advanced = false;

		testObject.fileService = fileService;
		testObject.userDataProfileService = { currentProfile: profile } as Partial<IUserDataProfileService> as IUserDataProfileService;
		testObject.notificationService = { notify: (notification: { severity: Severity; message: string; source?: string }) => notifications.push(notification) };
		testObject.accessibilityService = { alert: () => undefined };
		testObject._logAction = () => undefined;
		testObject._nextStep = () => { advanced = true; };

		return {
			testObject,
			notifications,
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
		assert.ok(harness.notifications[0].message.includes('No Cursor settings were found'));
	});
});
