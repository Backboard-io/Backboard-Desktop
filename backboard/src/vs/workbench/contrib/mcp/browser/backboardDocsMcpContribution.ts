/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../base/common/network.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GalleryMcpServerStatus, IGalleryMcpServer, RegistryType, TransportType } from '../../../../platform/mcp/common/mcpManagement.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';

const BACKBOARD_MCP_NAME = 'backboard';
const BACKBOARD_MCP_LEGACY_NAME = 'backboard-docs';
const BACKBOARD_MCP_SEEDED_STORAGE_KEY = 'backboard.mcp.seeded';
const BACKBOARD_MCP_LEGACY_SEEDED_STORAGE_KEY = 'backboard.docsMcp.seeded';
const BACKBOARD_MCP_ICON = FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/media/backboard_icon.svg').toString(true);

const BACKBOARD_MCP_SERVER: IGalleryMcpServer = {
	name: BACKBOARD_MCP_NAME,
	displayName: 'Backboard',
	description: 'Backboard product documentation and workspace context.',
	version: '1.0.0',
	isLatest: true,
	status: GalleryMcpServerStatus.Active,
	icon: {
		dark: BACKBOARD_MCP_ICON,
		light: BACKBOARD_MCP_ICON,
	},
	configuration: {
		remotes: [{
			type: TransportType.STREAMABLE_HTTP,
			url: 'https://backboard-docs.docsalot.dev/api/mcp',
		}]
	},
	publisher: 'backboard',
	publisherDisplayName: 'Backboard',
};

export class BackboardMcpContribution implements IWorkbenchContribution {

	constructor(
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		this.seed().catch(error => this.logService.warn('Backboard MCP seed failed', error));
	}

	private async seed(): Promise<void> {
		const seeded = this.storageService.getBoolean(BACKBOARD_MCP_SEEDED_STORAGE_KEY, StorageScope.PROFILE, false);
		const legacySeeded = this.storageService.getBoolean(BACKBOARD_MCP_LEGACY_SEEDED_STORAGE_KEY, StorageScope.PROFILE, false);

		const installed = await this.mcpManagementService.getInstalled();
		const backboard = installed.find(server => server.name === BACKBOARD_MCP_NAME);
		const legacyBackboardDocs = installed.find(server => server.name === BACKBOARD_MCP_LEGACY_NAME);
		const shouldMigrateLegacy = Boolean(legacyBackboardDocs);

		if (legacyBackboardDocs) {
			await this.mcpManagementService.uninstall(legacyBackboardDocs);
		}

		if (backboard || (!shouldMigrateLegacy && (seeded || legacySeeded))) {
			this.markSeeded();
			return;
		}

		await this.mcpManagementService.installFromGallery(BACKBOARD_MCP_SERVER, { packageType: RegistryType.REMOTE });
		this.markSeeded();
	}

	private markSeeded(): void {
		this.storageService.store(BACKBOARD_MCP_SEEDED_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
	}
}
