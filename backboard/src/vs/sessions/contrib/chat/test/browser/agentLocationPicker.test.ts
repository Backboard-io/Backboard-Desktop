/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus, RemoteAgentHostEntryType } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { AgentLocationPicker } from '../../browser/agentLocationPicker.js';
import { IResolvedFolderWorkspace, WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';

suite('AgentLocationPicker', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const localFolder = URI.file('/local/project');
	const remoteFolder = URI.parse('vscode-agent-host://ec2/workspace/project');
	const address = 'ws://127.0.0.1:8081';

	function setup(options: { cancelBrowse?: boolean; disconnected?: boolean; noBackboard?: boolean; pick?: 'local' | 'remote' | 'add'; cancelInput?: boolean } = {}) {
		const instantiation = disposables.add(new TestInstantiationService());
		const changed = disposables.add(new Emitter<void>());
		let selected = { providerId: 'local-agent-host', workspace: { label: 'project', folders: [{ root: localFolder }] } } as IResolvedFolderWorkspace;
		const selections: { uri: URI; providerId?: string }[] = [];
		const messages: string[] = [];
		let reconnects = 0;
		let adds = 0;
		let configWrites = 0;
		const workspacePicker = {
			get selectedResolved() { return selected; },
			onDidChangeSelection: changed.event,
			setSelectedWorkspace(uri: URI, opts?: { providerId?: string }) {
				selections.push({ uri, providerId: opts?.providerId });
				selected = { providerId: opts?.providerId ?? 'local-agent-host', workspace: { label: 'project', folders: [{ root: uri }] } } as IResolvedFolderWorkspace;
				changed.fire();
			},
		} as unknown as WorkspacePicker;
		const remoteProvider = {
			id: 'agenthost-ec2', label: 'EC2 dev', remoteAddress: address,
			connectionStatus: constObservable(options.disconnected ? RemoteAgentHostConnectionStatus.disconnected : RemoteAgentHostConnectionStatus.connected),
			sessionTypes: options.noBackboard ? [{ id: 'copilot' }] : [{ id: 'backboard' }],
			browseActions: [{ run: async () => options.cancelBrowse ? undefined : { folders: [{ root: remoteFolder }] } }],
		} as unknown as ISessionsProvider;
		instantiation.stub(ISessionsProvidersService, {
			getProvider: <T extends ISessionsProvider>(id: string) => id === remoteProvider.id ? remoteProvider as T : undefined,
			getProviders: () => [remoteProvider], onDidChangeProviders: Event.None,
		});
		const connection = { address, name: 'EC2 dev', clientId: 'test-client', status: options.disconnected ? RemoteAgentHostConnectionStatus.disconnected : RemoteAgentHostConnectionStatus.connected };
		instantiation.stub(IRemoteAgentHostService, {
			configuredEntries: [{ name: 'EC2 dev', connection: { type: RemoteAgentHostEntryType.WebSocket, address } }],
			connections: [connection],
			onDidChangeConnections: Event.None,
			reconnect: () => { reconnects++; },
			addRemoteAgentHost: async () => { adds++; return connection; },
		});
		instantiation.stub(IQuickInputService, {
			pick: (async (items: { location: string }[]) => items.find(item => item.location === (options.pick ?? 'remote'))) as IQuickInputService['pick'],
			input: async () => options.cancelInput ? undefined : '',
		});
		instantiation.stub(IConfigurationService, { updateValue: async () => { configWrites++; } });
		instantiation.stub(IFileDialogService, { showOpenDialog: async () => undefined });
		instantiation.stub(INotificationService, { info: (message: string) => messages.push(message), warn: (message: string) => messages.push(message), error: (message: string) => messages.push(message) });
		instantiation.stub(ICommandService, { executeCommand: async () => undefined });
		const picker = disposables.add(instantiation.createInstance(AgentLocationPicker, workspacePicker));
		const container = document.createElement('div');
		picker.render(container);
		return {
			container, selections, messages,
			get reconnects() { return reconnects; }, get adds() { return adds; }, get configWrites() { return configWrites; },
			async click() {
				container.querySelector<HTMLButtonElement>('.agent-location-chip')!.click();
				// Flush the event handler's async picker and browse continuations.
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			},
		};
	}

	test('selecting a remote folder routes the draft to its provider and updates the chip', async () => {
		const ui = setup();
		assert.strictEqual(ui.container.querySelector('.agent-location-chip')?.textContent, 'Local');
		await ui.click();
		assert.strictEqual(ui.selections.length, 1);
		assert.strictEqual(ui.selections[0].uri.toString(), remoteFolder.toString());
		assert.strictEqual(ui.selections[0].providerId, 'agenthost-ec2');
		assert.strictEqual(ui.container.querySelector('.agent-location-chip')?.textContent, 'EC2 dev');
	});

	test('cancelling remote folder selection preserves the local draft', async () => {
		const ui = setup({ cancelBrowse: true });
		await ui.click();
		assert.strictEqual(ui.selections.length, 0);
		assert.strictEqual(ui.container.querySelector('.agent-location-chip')?.textContent, 'Local');
	});

	test('a disconnected host reconnects without silently changing the draft', async () => {
		const ui = setup({ disconnected: true });
		await ui.click();
		assert.strictEqual(ui.reconnects, 1);
		assert.strictEqual(ui.selections.length, 0);
		assert.match(ui.messages[0], /Reconnecting/);
	});

	test('a host without Backboard cannot become the draft location', async () => {
		const ui = setup({ noBackboard: true });
		await ui.click();
		assert.strictEqual(ui.selections.length, 0);
		assert.match(ui.messages[0], /does not advertise a Backboard agent/);
	});

	test('cancelling Connect EC2 does not enable remotes or save a host', async () => {
		const ui = setup({ pick: 'add', cancelInput: true });
		await ui.click();
		assert.strictEqual(ui.adds, 0);
		assert.strictEqual(ui.configWrites, 0);
		assert.strictEqual(ui.selections.length, 0);
	});
});
