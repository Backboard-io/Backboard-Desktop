/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { getEntryAddress, IRemoteAgentHostService, parseRemoteAgentHostInput, RemoteAgentHostConnectionStatus, RemoteAgentHostEntryType, RemoteAgentHostsEnabledSettingId } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { WorkspacePicker } from './sessionWorkspacePicker.js';

interface ILocationItem extends IQuickPickItem {
	readonly location: 'local' | 'remote' | 'add' | 'manage';
	readonly address?: string;
}

/** Selects a host and a folder together, so cancelling never retargets a draft. */
export class AgentLocationPicker extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private lastLocalFolder: URI | undefined;
	private busy = false;

	constructor(
		private readonly workspacePicker: WorkspacePicker,
		@IRemoteAgentHostService private readonly remoteService: IRemoteAgentHostService,
		@ISessionsProvidersService private readonly providersService: ISessionsProvidersService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this.renderDisposables.clear();
		const row = dom.append(container, dom.$('.agent-location-picker'));
		this.renderDisposables.add({ dispose: () => row.remove() });
		const location = dom.append(row, dom.$('button.agent-location-chip', { type: 'button', 'aria-haspopup': 'listbox' })) as HTMLButtonElement;
		const folder = dom.append(row, dom.$('button.agent-location-folder', { type: 'button' })) as HTMLButtonElement;
		const update = () => {
			const selected = this.workspacePicker.selectedResolved;
			const provider = selected && this.providersService.getProvider(selected.providerId);
			const remote = provider && isAgentHostProvider(provider) && provider.remoteAddress ? provider : undefined;
			if (selected && !remote && selected.workspace.folders[0]?.root.scheme === 'file') {
				this.lastLocalFolder = selected.workspace.folders[0].root;
			}
			const name = remote?.label ?? localize('agentLocation.local', "Local");
			const connectionStatus = remote?.connectionStatus?.get();
			const unavailable = !!connectionStatus && !RemoteAgentHostConnectionStatus.isConnected(connectionStatus);
			dom.reset(location, renderIcon(unavailable ? Codicon.warning : remote ? Codicon.cloud : Codicon.deviceDesktop), dom.$('span.agent-location-label', undefined, name));
			location.title = localize('agentLocation.switch', "Switch agent location");
			location.setAttribute('aria-label', localize('agentLocation.aria', "Switch agent location, currently {0}{1}", name, unavailable ? localize('agentLocation.unavailable', ", unavailable") : ''));
			location.classList.toggle('unavailable', unavailable);
			dom.reset(folder, renderIcon(Codicon.folderOpened), dom.$('span.agent-location-label', undefined, selected?.workspace.label ?? localize('agentLocation.folder', "Select a folder")));
			folder.title = selected?.workspace.folders[0]?.root.path ?? localize('agentLocation.selectFolder', "Select a folder on this host");
		};
		update();
		this.renderDisposables.add(this.workspacePicker.onDidChangeSelection(update));
		this.renderDisposables.add(this.remoteService.onDidChangeConnections(update));
		this.renderDisposables.add(this.providersService.onDidChangeProviders(update));
		this.renderDisposables.add(dom.addDisposableListener(location, dom.EventType.CLICK, () => { void this.run(() => this.showPicker()); }));
		this.renderDisposables.add(dom.addDisposableListener(folder, dom.EventType.CLICK, () => {
			const selected = this.workspacePicker.selectedResolved;
			const provider = selected && this.providersService.getProvider(selected.providerId);
			const address = provider && isAgentHostProvider(provider) ? provider.remoteAddress : undefined;
			void this.run(() => address ? this.selectRemoteFolder(address) : this.selectLocalFolder(false));
		}));
	}

	private async run(action: () => Promise<void>): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		try {
			await action();
		} catch (error) {
			this.notificationService.error(localize('agentLocation.failed', "Could not change agent location: {0}", toErrorMessage(error)));
		} finally {
			this.busy = false;
		}
	}

	private async showPicker(): Promise<void> {
		const items: ILocationItem[] = [{ location: 'local', label: localize('agentLocation.local', "Local"), description: localize('agentLocation.thisComputer', "This computer"), iconClass: 'codicon codicon-device-desktop' }];
		for (const entry of this.remoteService.configuredEntries) {
			const address = getEntryAddress(entry);
			const status = this.remoteService.connections.find(connection => connection.address === address)?.status;
			items.push({ location: 'remote', address, label: entry.name, description: status?.kind === 'connected' ? localize('agentLocation.connected', "Connected") : localize('agentLocation.notConnected', "Not connected"), iconClass: 'codicon codicon-cloud' });
		}
		items.push({ location: 'add', label: localize('agentLocation.add', "Connect EC2…"), description: localize('agentLocation.addDescription', "Connect a running Backboard agent server"), iconClass: 'codicon codicon-add' });
		if (this.remoteService.configuredEntries.length) {
			items.push({ location: 'manage', label: localize('agentLocation.manage', "Manage remote hosts…"), iconClass: 'codicon codicon-settings-gear' });
		}
		const pick = await this.quickInputService.pick(items, { title: localize('agentLocation.title', "Agent location"), placeHolder: localize('agentLocation.placeholder', "Choose where this task will run"), matchOnDescription: true });
		switch (pick?.location) {
			case 'local': await this.selectLocalFolder(true); break;
			case 'remote': await this.selectRemoteFolder(pick.address!); break;
			case 'add': await this.addHost(); break;
			case 'manage': await this.commandService.executeCommand('workbench.action.sessions.manageRemoteAgentHosts'); break;
		}
	}

	private async selectLocalFolder(restore: boolean): Promise<void> {
		const folder = restore && this.lastLocalFolder ? this.lastLocalFolder : (await this.fileDialogService.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, availableFileSystems: ['file'] }))?.[0];
		if (folder) {
			this.workspacePicker.setSelectedWorkspace(folder);
		}
	}

	private async selectRemoteFolder(address: string): Promise<void> {
		const provider = this.providersService.getProviders().find(candidate => isAgentHostProvider(candidate) && candidate.remoteAddress === address);
		const connection = this.remoteService.connections.find(connection => connection.address === address);
		if (connection?.status.kind === 'incompatible') {
			this.notificationService.warn(connection.status.message);
			return;
		}
		if (provider && isAgentHostProvider(provider) && provider.connect && !RemoteAgentHostConnectionStatus.isConnected(provider.connectionStatus?.get())) {
			await provider.connect();
		}
		if (!RemoteAgentHostConnectionStatus.isConnected(this.remoteService.connections.find(connection => connection.address === address)?.status)) {
			this.remoteService.reconnect(address);
			this.notificationService.info(localize('agentLocation.reconnecting', "Reconnecting to the remote host. Choose it again once connected; your current task location has not changed."));
			return;
		}
		if (!provider || !isAgentHostProvider(provider) || !RemoteAgentHostConnectionStatus.isConnected(provider.connectionStatus?.get())) {
			this.notificationService.info(localize('agentLocation.loading', "Connected. The remote agent is still loading; choose this host again in a moment to select a folder."));
			return;
		}
		if (!provider.sessionTypes.some(type => type.id === 'backboard')) {
			this.notificationService.warn(localize('agentLocation.noBackboard', "This host does not advertise a Backboard agent. Start the Backboard agent server on EC2, then reconnect."));
			return;
		}
		const action = provider.browseActions[0];
		if (!action) {
			this.notificationService.info(localize('agentLocation.notReady', "The remote host is still loading its folders. Try again once it is ready."));
			return;
		}
		const workspace = await action.run();
		const folder = workspace?.folders[0]?.root;
		if (folder) {
			this.workspacePicker.setSelectedWorkspace(folder, { providerId: provider.id });
		}
	}

	private async addHost(): Promise<void> {
		const address = await this.quickInputService.input({
			title: localize('agentLocation.connectTitle', "Connect EC2"),
			prompt: localize('agentLocation.addressPrompt', "Enter the Backboard agent-server URL. For an SSH or Session Manager tunnel, use its localhost port."),
			placeHolder: 'ws://127.0.0.1:8081',
			ignoreFocusLost: true,
			validateInput: async value => parseRemoteAgentHostInput(value).parsed ? undefined : localize('agentLocation.invalidAddress', "Enter a host:port or a valid WebSocket URL."),
		});
		if (address === undefined) { return; }
		const parsed = parseRemoteAgentHostInput(address).parsed;
		if (!parsed) { return; }
		const name = await this.quickInputService.input({ title: localize('agentLocation.connectTitle', "Connect EC2"), prompt: localize('agentLocation.namePrompt', "Give this host a name."), value: 'EC2', ignoreFocusLost: true, validateInput: async value => value.trim() ? undefined : localize('agentLocation.nameRequired', "Enter a host name.") });
		if (!name?.trim()) { return; }
		const token = parsed.connectionToken ?? await this.quickInputService.input({ title: localize('agentLocation.connectTitle', "Connect EC2"), prompt: localize('agentLocation.tokenPrompt', "Enter the agent server's connection token. Leave blank only if the server does not require one."), password: true, ignoreFocusLost: true });
		if (token === undefined) { return; }
		await this.configurationService.updateValue(RemoteAgentHostsEnabledSettingId, true, ConfigurationTarget.USER);
		await this.remoteService.addRemoteAgentHost({ name: name.trim(), connectionToken: token || undefined, connection: { type: RemoteAgentHostEntryType.WebSocket, address: parsed.address } });
		await this.selectRemoteFolder(parsed.address);
	}
}
