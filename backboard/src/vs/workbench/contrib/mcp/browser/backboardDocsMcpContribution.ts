/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../base/common/network.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GalleryMcpServerStatus, IGalleryMcpServer, IInstallableMcpServer, RegistryType, TransportType } from '../../../../platform/mcp/common/mcpManagement.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { cliMcpServerToWorkbenchConfig, parseBackboardCliMcpConfig, type IBackboardCliMcpServerConfig } from '../common/backboardCliMcpConfig.js';

const BACKBOARD_MCP_NAME = 'backboard';
const BACKBOARD_MCP_LEGACY_NAME = 'backboard-docs';
const BACKBOARD_MCP_SEEDED_STORAGE_KEY = 'backboard.mcp.seeded';
const BACKBOARD_MCP_LEGACY_SEEDED_STORAGE_KEY = 'backboard.docsMcp.seeded';
const BACKBOARD_MCP_ICON = FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/media/backboard_icon.svg').toString(true);
const BACKBOARD_CLI_MCP_CONFIG_DIR = '.backboard';
const BACKBOARD_CLI_MCP_CONFIG_FILE = 'mcp.json';

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

/** The `mcpServers` entry the Backboard CLI needs for the product docs server. */
const BACKBOARD_CLI_SERVER_CONFIG: IBackboardCliMcpServerConfig = {
	type: 'streamable-http',
	url: 'https://backboard-docs.docsalot.dev/api/mcp',
};

/**
 * Keeps the IDE's MCP surfaces aligned with the Backboard CLI.
 *
 * Backboard sessions run on the CLI runtime, which reads its servers from
 * `~/.backboard/mcp.json` (user) and `<folder>/.backboard/mcp.json` (project)
 * and never from the workbench's own `mcp.json`. This contribution:
 *
 *  1. seeds the Backboard docs server into both the workbench store and the
 *     CLI user config, so "Backboard + CLI" is the full server set, and
 *  2. imports every CLI-configured server into the workbench store, so the
 *     server lists in Simple, Editor and Advanced mode show — and can remove —
 *     the same servers the agent actually connects to.
 *
 * Servers installed from the IDE are mirrored into the CLI config by the
 * marketplace; this is the reverse direction.
 */
export class BackboardMcpContribution implements IWorkbenchContribution {

	constructor(
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		this.sync().catch(error => this.logService.warn('Backboard MCP sync failed', error));
	}

	private async sync(): Promise<void> {
		await this.seedWorkbenchServer();
		await this.seedCliServer();
		await this.importCliServers();
	}

	/** Installs the Backboard docs server into the workbench MCP store. */
	private async seedWorkbenchServer(): Promise<void> {
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

	/**
	 * Ensures `~/.backboard/mcp.json` carries the Backboard docs server so the
	 * CLI runtime (and any CLI run outside the IDE) can connect to it without
	 * the IDE having to inject it.
	 */
	private async seedCliServer(): Promise<void> {
		const resource = await this.backboardCliUserConfigResource();
		try {
			const root = await this.readCliConfigRoot(resource);
			const servers = { ...parseBackboardCliMcpConfig(root) };
			const existing = servers[BACKBOARD_MCP_NAME];
			if (existing && !existing.disabled) {
				return;
			}
			servers[BACKBOARD_MCP_NAME] = BACKBOARD_CLI_SERVER_CONFIG;
			await this.writeCliConfig(resource, { ...root, mcpServers: servers });
		} catch (error) {
			this.logService.warn('[Backboard MCP] Failed to seed the CLI MCP config:', error);
		}
	}

	/** Brings CLI-configured servers into the workbench MCP store. */
	private async importCliServers(): Promise<void> {
		const cliConfigs = await this.readAllCliServerConfigs();
		if (cliConfigs.size === 0) {
			return;
		}
		const installed = await this.mcpManagementService.getInstalled();
		const known = new Set(installed.map(server => server.name.toLowerCase()));
		for (const [name, cliConfig] of cliConfigs) {
			if (known.has(name.toLowerCase()) || cliConfig.disabled) {
				continue;
			}
			const config = cliMcpServerToWorkbenchConfig(cliConfig);
			if (!config) {
				continue;
			}
			const installable: IInstallableMcpServer = { name, config };
			try {
				await this.mcpManagementService.install(installable);
			} catch (error) {
				this.logService.warn(`[Backboard MCP] Failed to import CLI MCP server '${name}':`, error);
			}
		}
	}

	/** User config plus every workspace folder's project config, project winning. */
	private async readAllCliServerConfigs(): Promise<Map<string, IBackboardCliMcpServerConfig>> {
		const servers = new Map<string, IBackboardCliMcpServerConfig>();
		const resources = [await this.backboardCliUserConfigResource()];
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			resources.push(URI.joinPath(folder.uri, BACKBOARD_CLI_MCP_CONFIG_DIR, BACKBOARD_CLI_MCP_CONFIG_FILE));
		}
		for (const resource of resources) {
			try {
				if (!await this.fileService.exists(resource)) {
					continue;
				}
				const parsed = parseBackboardCliMcpConfig(await this.readCliConfigRoot(resource));
				for (const [name, entry] of Object.entries(parsed)) {
					servers.set(name, entry);
				}
			} catch (error) {
				this.logService.trace(`[Backboard MCP] Skipped unreadable CLI config ${resource.toString()}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return servers;
	}

	private async backboardCliUserConfigResource(): Promise<URI> {
		const home = await this.pathService.userHome();
		return URI.joinPath(home, BACKBOARD_CLI_MCP_CONFIG_DIR, BACKBOARD_CLI_MCP_CONFIG_FILE);
	}

	private async readCliConfigRoot(resource: URI): Promise<Record<string, unknown>> {
		if (!await this.fileService.exists(resource)) {
			return {};
		}
		const content = await this.fileService.readFile(resource);
		try {
			const parsed: unknown = JSON.parse(content.value.toString());
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}

	private async writeCliConfig(resource: URI, root: Record<string, unknown>): Promise<void> {
		await this.fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify(root, null, '\t')}\n`));
	}

	private markSeeded(): void {
		this.storageService.store(BACKBOARD_MCP_SEEDED_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
	}
}
