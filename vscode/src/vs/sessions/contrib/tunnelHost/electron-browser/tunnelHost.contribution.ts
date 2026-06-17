/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IOutputService } from '../../../../workbench/services/output/common/output.js';
import { ITunnelHostService } from '../common/tunnelHost.js';
import { TUNNEL_HOST_LOG_ID } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { CONFIGURATION_KEY_MICROSOFT_AUTH, SHOW_TUNNEL_HOST_OUTPUT_ID, TunnelHostService } from './tunnelHostService.js';

const TOGGLE_SHARING_ID = 'sessions.tunnelHost.toggleSharing';

const CATEGORY = localize2('tunnelHost.category', 'Remote Connections');

// Register the renderer-side service
registerSingleton(ITunnelHostService, TunnelHostService, InstantiationType.Delayed);

// Register the toggle action
registerAction2(class ToggleRemoteConnectionsAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_SHARING_ID,
			title: localize2("toggleSharing", "Allow Remote Connections"),
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const tunnelHostService = accessor.get(ITunnelHostService);
		const notificationService = accessor.get(INotificationService);

		try {
			if (tunnelHostService.isSharing) {
				await tunnelHostService.stopSharing();
			} else {
				await tunnelHostService.startSharing();
			}
		} catch (err) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('tunnelHost.error', "Failed to toggle remote connections: {0}", String(err)),
			});
		}
	}
});

// Register the show output action
registerAction2(class ShowTunnelHostOutputAction extends Action2 {
	constructor() {
		super({
			id: SHOW_TUNNEL_HOST_OUTPUT_ID,
			title: localize2('showTunnelHostOutput', "Show Remote Connections Output"),
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const outputService = accessor.get(IOutputService);
		await outputService.showChannel(TUNNEL_HOST_LOG_ID);
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	type: 'object',
	properties: {
		[CONFIGURATION_KEY_MICROSOFT_AUTH]: {
			description: localize('tunnelHost.enableMicrosoftAuth', "Enable Microsoft account authentication for agent host tunnels. When disabled, only GitHub authentication is used."),
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			tags: ['usesOnlineServices'],
		},
	}
});
