/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { FileAccess } from '../../../../base/common/network.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableResourceMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GalleryMcpServerStatus, IGalleryMcpServer, IInstallableMcpServer, RegistryType, TransportType } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLocalMcpServer, IWorkbenchMcpManagementService, LocalMcpServerScope } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { cliMcpServerToWorkbenchConfig, parseBackboardCliMcpConfig, type IBackboardCliMcpServerConfig } from '../common/backboardCliMcpConfig.js';

const BACKBOARD_MCP_NAME = 'backboard';
const BACKBOARD_MCP_LEGACY_NAME = 'backboard-docs';
const BACKBOARD_MCP_SEEDED_STORAGE_KEY = 'backboard.mcp.seeded';
const BACKBOARD_MCP_LEGACY_SEEDED_STORAGE_KEY = 'backboard.docsMcp.seeded';
/** Application-wide: `~/.backboard/mcp.json` is shared by every profile. */
const BACKBOARD_MCP_CLI_SEEDED_STORAGE_KEY = 'backboard.mcp.cliSeeded';
const BACKBOARD_MCP_ICON = FileAccess.asBrowserUri('vs/workbench/contrib/chat/browser/media/backboard_icon.svg').toString(true);
const BACKBOARD_CLI_MCP_CONFIG_DIR = '.backboard';
const BACKBOARD_CLI_MCP_CONFIG_FILE = 'mcp.json';
/** Coalesces the burst of events an atomic (write + rename) save produces. */
const BACKBOARD_CLI_MCP_CONFIG_REFRESH_DELAY = 150;

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
 * The agent runtime is driven with the server set of the workbench's user
 * profile store, so that store has to be the complete, current truth. Servers
 * are also added straight to `~/.backboard/mcp.json` (the agent's `find_mcp`,
 * the CLI's `/mcp`, hand edits) and to `<folder>/.backboard/mcp.json`. This
 * contribution:
 *
 *  1. seeds the Backboard docs server into both stores exactly once, so a user
 *     who later removes or disables it keeps it that way,
 *  2. imports every CLI-configured server into the profile store at startup
 *     and whenever one of the CLI files changes, so a server the agent adds
 *     mid-chat shows up in every open window's MCP UI, and
 *  3. mirrors uninstalls from the profile store back into
 *     `~/.backboard/mcp.json`, so a removed server is not resurrected by the
 *     next import.
 *
 * All work runs through one queue, so the startup sync, watcher refreshes and
 * mirrored removals never interleave within a window. Every step is
 * idempotent: other windows run the same contribution against the same files.
 */
export class BackboardMcpContribution extends Disposable implements IWorkbenchContribution {

	private readonly queue = new Sequencer();
	/** Last server map read from each CLI config, to tell real edits from no-op events. */
	private readonly snapshots = new Map<string, Record<string, IBackboardCliMcpServerConfig>>();
	private readonly projectWatchers = this._register(new DisposableResourceMap());
	/** Servers this profile is uninstalling through `uninstall()`, i.e. from a UI. */
	private readonly pendingUninstalls = new Set<string>();
	private userConfigResource: Promise<URI> | undefined;

	constructor(
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.enqueue('startup sync', () => this.initialize());

		// `onUninstallMcpServer*` only fires for explicit `uninstall()` calls
		// (MCP views, marketplace, commands), never for a reload of the profile
		// file. Pairing it with the completion event keeps a transiently empty or
		// externally rewritten profile `mcp.json` from wiping the CLI config.
		this._register(this.mcpManagementService.onUninstallMcpServerInCurrentProfile(e => {
			if (e.scope === LocalMcpServerScope.User) {
				this.pendingUninstalls.add(e.name);
			}
		}));
		this._register(this.mcpManagementService.onDidUninstallMcpServerInCurrentProfile(e => {
			if (e.scope !== LocalMcpServerScope.User || !this.pendingUninstalls.delete(e.name) || e.error) {
				return;
			}
			this.enqueue(`mirror uninstall of '${e.name}'`, () => this.removeFromCliUserConfig(e.name));
		}));

		this._register(this.mcpManagementService.onDidChangeProfile(() => {
			this.enqueue('profile change import', () => this.importAll());
		}));

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			for (const folder of e.removed) {
				const resource = projectCliConfigResource(folder);
				this.projectWatchers.deleteAndDispose(resource);
				this.snapshots.delete(resource.toString());
			}
			for (const folder of e.added) {
				const resource = projectCliConfigResource(folder);
				this.projectWatchers.set(resource, this.watchCliConfig(resource));
				this.enqueue(`import ${resource.toString()}`, () => this.refreshCliConfig(resource));
			}
		}));
	}

	private enqueue(label: string, task: () => Promise<void>): void {
		this.queue.queue(async () => {
			if (this._store.isDisposed) {
				return;
			}
			try {
				await task();
			} catch (error) {
				this.logService.warn(`[Backboard MCP] ${label} failed:`, error);
			}
		});
	}

	private async initialize(): Promise<void> {
		// Watch before the first read so no write between the two is missed.
		const userResource = await this.getUserConfigResource();
		if (this._store.isDisposed) {
			return;
		}
		this._register(this.watchCliConfig(userResource));
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const resource = projectCliConfigResource(folder);
			this.projectWatchers.set(resource, this.watchCliConfig(resource));
		}

		await this.seedBackboardServer();
		await this.importAll();
	}

	// #region Seeding

	/**
	 * Installs the Backboard docs server into the profile store and the CLI
	 * user config the first time only. Once seeded it is never re-added or
	 * re-enabled: removing or disabling it is a user decision.
	 */
	private async seedBackboardServer(): Promise<void> {
		const profileSeeded = this.storageService.getBoolean(BACKBOARD_MCP_SEEDED_STORAGE_KEY, StorageScope.PROFILE, false)
			|| this.storageService.getBoolean(BACKBOARD_MCP_LEGACY_SEEDED_STORAGE_KEY, StorageScope.PROFILE, false);
		// Installs that seeded before the CLI flag existed already wrote the CLI entry.
		const cliSeeded = profileSeeded || this.storageService.getBoolean(BACKBOARD_MCP_CLI_SEEDED_STORAGE_KEY, StorageScope.APPLICATION, false);

		const installed = await this.mcpManagementService.getInstalled();
		const legacyBackboardDocs = installed.find(server => server.name === BACKBOARD_MCP_LEGACY_NAME);
		if (legacyBackboardDocs) {
			// Rename of a server the user kept: migrate it rather than drop it.
			await this.mcpManagementService.uninstall(legacyBackboardDocs);
		}

		if ((!profileSeeded || legacyBackboardDocs) && !installed.some(server => server.name === BACKBOARD_MCP_NAME)) {
			await this.mcpManagementService.installFromGallery(BACKBOARD_MCP_SERVER, { packageType: RegistryType.REMOTE });
		}
		this.storageService.store(BACKBOARD_MCP_SEEDED_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);

		if (!cliSeeded) {
			await this.seedCliServer();
		}
		this.storageService.store(BACKBOARD_MCP_CLI_SEEDED_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/**
	 * Adds the Backboard docs server to `~/.backboard/mcp.json` so the CLI
	 * runtime (and any CLI run outside the IDE) can connect to it. Leaves an
	 * existing entry alone, including a disabled one.
	 */
	private async seedCliServer(): Promise<void> {
		const resource = await this.getUserConfigResource();
		try {
			const root = await this.readCliConfigRoot(resource);
			if (!root) {
				this.logService.warn(`[Backboard MCP] Not seeding ${resource.toString()}: the file is not valid JSON.`);
				return;
			}
			const servers = rawServers(root);
			if (findKey(servers, BACKBOARD_MCP_NAME) !== undefined) {
				return;
			}
			await this.writeCliConfig(resource, { ...root, mcpServers: { ...servers, [BACKBOARD_MCP_NAME]: BACKBOARD_CLI_SERVER_CONFIG } });
		} catch (error) {
			this.logService.warn('[Backboard MCP] Failed to seed the CLI MCP config:', error);
		}
	}

	// #endregion

	// #region CLI → profile import

	/**
	 * Imports every CLI config from scratch. Project configs go first so they
	 * win over a same-named user entry, matching the CLI's own precedence.
	 */
	private async importAll(): Promise<void> {
		const resources = this.workspaceContextService.getWorkspace().folders.map(projectCliConfigResource);
		resources.push(await this.getUserConfigResource());
		for (const resource of resources) {
			this.snapshots.delete(resource.toString());
			await this.refreshCliConfig(resource);
		}
	}

	/**
	 * Re-reads one CLI config and imports the entries that changed since it was
	 * last read. With no previous read every entry counts as new, which adds
	 * the servers the profile store does not have yet.
	 */
	private async refreshCliConfig(resource: URI): Promise<void> {
		const root = await this.readCliConfigRoot(resource);
		if (!root) {
			// Unparseable, most likely a writer that is not atomic caught mid-write.
			// Keep the last good snapshot; the write's final event re-reads it.
			this.logService.trace(`[Backboard MCP] Skipped unreadable CLI config ${resource.toString()}`);
			return;
		}
		const key = resource.toString();
		const next = parseBackboardCliMcpConfig(root);
		const previous = this.snapshots.get(key) ?? {};
		this.snapshots.set(key, next);

		const changed = Object.keys(next).filter(name => !equals(previous[name], next[name]));
		if (!changed.length) {
			return;
		}
		const installed = await this.mcpManagementService.getInstalled();
		for (const name of changed) {
			try {
				await this.importCliServer(name, next[name], previous[name], installed);
			} catch (error) {
				this.logService.warn(`[Backboard MCP] Failed to import CLI MCP server '${name}':`, error);
			}
		}
	}

	/**
	 * Brings one new or edited CLI entry into the profile store. A server the
	 * profile already has is only rewritten when it still mirrors the entry's
	 * previous value: that keeps gallery and marketplace installs (whose
	 * profile config legitimately differs from their CLI form) untouched, and
	 * means an unchanged entry is never rewritten.
	 */
	private async importCliServer(name: string, entry: IBackboardCliMcpServerConfig, previous: IBackboardCliMcpServerConfig | undefined, installed: IWorkbenchLocalMcpServer[]): Promise<void> {
		if (entry.disabled) {
			return;
		}
		const config = cliMcpServerToWorkbenchConfig(entry);
		if (!config) {
			return;
		}

		const existing = installed.find(server => server.name.toLowerCase() === name.toLowerCase());
		if (!existing) {
			// The name must stay the CLI key: the agent host labels servers by
			// `displayName ?? name`, and an import carries no display name.
			const installable: IInstallableMcpServer = { name, config };
			installed.push(await this.mcpManagementService.install(installable));
			this.logService.info(`[Backboard MCP] Imported CLI MCP server '${name}'.`);
			return;
		}

		if (existing.scope !== LocalMcpServerScope.User || existing.source === 'gallery' || !previous || previous.disabled) {
			return;
		}
		const previousConfig = cliMcpServerToWorkbenchConfig(previous);
		if (!previousConfig || !sameLaunch(existing.config, previousConfig) || sameLaunch(existing.config, config)) {
			return;
		}
		// Keep profile-only settings (sandboxing, OAuth client, ...) for the same transport.
		let updated: IMcpServerConfiguration = config;
		if (existing.config.type === McpServerType.LOCAL && config.type === McpServerType.LOCAL) {
			updated = { ...existing.config, ...config };
		} else if (existing.config.type === McpServerType.REMOTE && config.type === McpServerType.REMOTE) {
			updated = { ...existing.config, ...config };
		}
		const index = installed.indexOf(existing);
		installed[index] = await this.mcpManagementService.install({ name: existing.name, config: updated });
		this.logService.info(`[Backboard MCP] Updated CLI MCP server '${existing.name}'.`);
	}

	/**
	 * Watches the folder that holds a CLI config rather than the file itself:
	 * the file may not exist yet, and atomic saves replace its inode.
	 */
	private watchCliConfig(resource: URI): IDisposable {
		const store = new DisposableStore();
		const scheduler = store.add(new RunOnceScheduler(() => this.enqueue(`refresh ${resource.toString()}`, () => this.refreshCliConfig(resource)), BACKBOARD_CLI_MCP_CONFIG_REFRESH_DELAY));
		const watcher = store.add(this.fileService.createWatcher(dirname(resource), { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(e => {
			if (e.contains(resource)) {
				scheduler.schedule();
			}
		}));
		return store;
	}

	// #endregion

	// #region Profile → CLI mirror

	/**
	 * Drops a server the user uninstalled from `~/.backboard/mcp.json`, so the
	 * next import does not bring it back and CLI runs stop using it too.
	 */
	private async removeFromCliUserConfig(name: string): Promise<void> {
		const resource = await this.getUserConfigResource();
		const root = await this.readCliConfigRoot(resource);
		if (!root) {
			return;
		}
		const servers = rawServers(root);
		const lower = name.toLowerCase();
		const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key.toLowerCase() !== lower));
		if (Object.keys(remaining).length === Object.keys(servers).length) {
			return;
		}
		await this.writeCliConfig(resource, { ...root, mcpServers: remaining });
		this.logService.info(`[Backboard MCP] Removed uninstalled MCP server '${name}' from ${resource.toString()}.`);
	}

	// #endregion

	private getUserConfigResource(): Promise<URI> {
		this.userConfigResource ??= this.pathService.userHome().then(home => URI.joinPath(home, BACKBOARD_CLI_MCP_CONFIG_DIR, BACKBOARD_CLI_MCP_CONFIG_FILE));
		return this.userConfigResource;
	}

	/**
	 * Reads a CLI config's root object: `{}` when the file does not exist,
	 * `undefined` when it exists but is not a JSON object, so callers never
	 * overwrite a file they could not parse.
	 */
	private async readCliConfigRoot(resource: URI): Promise<Record<string, unknown> | undefined> {
		if (!await this.fileService.exists(resource)) {
			return {};
		}
		try {
			const content = await this.fileService.readFile(resource);
			const text = content.value.toString();
			if (!text.trim()) {
				return {};
			}
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}

	private async writeCliConfig(resource: URI, root: Record<string, unknown>): Promise<void> {
		// Atomic, so the CLI runtime and other windows never read a partial file.
		const atomic = this.fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite) ? { postfix: '.vsctmp' } : false;
		await this.fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify(root, null, '\t')}\n`), { atomic });
	}
}

function projectCliConfigResource(folder: IWorkspaceFolder): URI {
	return URI.joinPath(folder.uri, BACKBOARD_CLI_MCP_CONFIG_DIR, BACKBOARD_CLI_MCP_CONFIG_FILE);
}

/** The raw `mcpServers` object of a CLI config root, preserving entries this file does not model. */
function rawServers(root: Record<string, unknown>): Record<string, unknown> {
	const servers = root.mcpServers;
	return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers as Record<string, unknown> : {};
}

/** Server names are matched case-insensitively, like the import's duplicate check. */
function findKey(servers: Record<string, unknown>, name: string): string | undefined {
	const keys = Object.keys(servers);
	const lower = name.toLowerCase();
	return keys.find(key => key === name) ?? keys.find(key => key.toLowerCase() === lower);
}

/** Whether two configs launch the same server, ignoring metadata and empty-vs-absent fields. */
function sameLaunch(a: IMcpServerConfiguration, b: IMcpServerConfiguration): boolean {
	return equals(launchShape(a), launchShape(b));
}

function launchShape(config: IMcpServerConfiguration): object {
	if (config.type === McpServerType.REMOTE) {
		return { type: config.type, url: config.url, headers: config.headers ?? {} };
	}
	return { type: config.type, command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? '' };
}
