/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/skillsLibrary.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, toAction } from '../../../../../../base/common/actions.js';
import { timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { basename, dirname, joinPath } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetDropdownAction } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { GalleryMcpServerStatus, IGalleryMcpServer, IGalleryMcpServerConfiguration, IInstallableMcpServer, ILocalMcpServer, IMcpGalleryService, RegistryType, TransportType } from '../../../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, IMcpServerVariable } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { INotificationService, Severity } from '../../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { TerminalCapability, type ITerminalCommand } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { ISharedWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalInstance, ITerminalService } from '../../../../../contrib/terminal/browser/terminal.js';
import { McpCommandIds } from '../../../../mcp/common/mcpCommandIds.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { IWorkbenchLocalMcpServer, IWorkbenchMcpManagementService, LocalMcpServerScope } from '../../../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { getSkillFolderName, SKILL_FILENAME } from '../../../common/promptSyntax/config/promptFileLocations.js';
import { IPromptsService, PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';

const BASE_URL = 'https://www.skills.sh';
const MASTRA_REGISTRY_URL = 'https://raw.githubusercontent.com/mastra-ai/skills-api/main/src/registry/scraped-skills.json';
const PUBLIC_OFFICIAL_PATH = '/official';
const FAVORITES_STORAGE_KEY = 'chat.skillsLibrary.favorites';
const MCP_FAVORITES_STORAGE_KEY = 'chat.skillsLibrary.mcpFavorites';
const API_SEARCH_RESULT_LIMIT = 200;
const LEGACY_SEARCH_RESULT_LIMIT = 10_000;
const ALL_SKILLS_PAGE_SIZE = 100;
const NON_INSTALLABLE_ANTHROPIC_SESSION_SKILLS = new Set([
	'act-on-feedback',
	'code-review',
	'commit',
	'create-draft-pr',
	'create-pr',
	'fix-ci',
	'generate-run-commands',
	'merge',
	'sync',
	'sync-upstream',
	'update-pr',
	'update-skills',
]);

export type SkillsLibraryCategory = 'pinned' | 'installed' | 'official' | 'all';
type SkillsMarketplacePage = 'skills' | 'mcp';

const SKILLS_LIBRARY_CATEGORIES: readonly { readonly id: SkillsLibraryCategory; readonly label: string; readonly gapBefore?: boolean }[] = [
	{ id: 'pinned', label: localize('chat.skillsLibrary.category.pinned', "Pinned") },
	{ id: 'installed', label: localize('chat.skillsLibrary.category.installed', "Installed") },
	{ id: 'official', label: localize('chat.skillsLibrary.category.official', "Official"), gapBefore: true },
	{ id: 'all', label: localize('chat.skillsLibrary.category.all', "All") },
];

const SKILLS_MARKETPLACE_PAGES: readonly { readonly id: SkillsMarketplacePage; readonly label: string }[] = [
	{ id: 'skills', label: localize('chat.skillsLibrary.page.skills', "Skills") },
	{ id: 'mcp', label: localize('chat.skillsLibrary.page.mcp', "MCP") },
];

import { IMcpCliServerConfig, IMcpMarketplaceCatalogEntry, MCP_MARKETPLACE_CATALOG, McpCatalogInstallability, McpMarketplaceCategory } from './mcpMarketplaceCatalog.js';

export { MCP_MARKETPLACE_CATALOG } from './mcpMarketplaceCatalog.js';
export type { IMcpMarketplaceCatalogEntry, McpCatalogInstallability, McpMarketplaceCategory } from './mcpMarketplaceCatalog.js';

export interface IMcpMarketplaceItem {
	readonly kind: 'marketplaceMcp';
	readonly id: string;
	readonly label: string;
	readonly category: Exclude<McpMarketplaceCategory, 'pinned' | 'installed' | 'all'>;
	readonly registryName: string;
	readonly expectedNames: readonly string[];
	readonly officialPublisherHints: readonly string[];
	readonly description: string;
	readonly publisher: string;
	readonly source: string;
	readonly installConfiguration?: IGalleryMcpServerConfiguration;
	readonly repositoryUrl?: string;
	readonly trustedSource?: 'github.com/mcp';
	readonly logoUrl?: string;
	readonly verified: boolean;
	readonly preferredPackageType?: RegistryType;
	readonly installServerConfig?: IMcpServerConfiguration;
	readonly installInputs?: readonly IMcpServerVariable[];
	readonly cliConfig?: IMcpCliServerConfig;
}

export interface IMcpMarketplaceState {
	readonly items: readonly IMcpMarketplaceItem[];
	readonly installed: readonly IWorkbenchLocalMcpServer[];
	readonly favoriteIds: readonly string[];
	readonly loading?: boolean;
	readonly error?: string;
}

export interface IMcpMarketplaceBuildOptions {
	readonly category?: McpMarketplaceCategory;
	readonly query?: string;
	readonly recentlyRemovedIds?: readonly string[];
}

const MCP_MARKETPLACE_CATEGORIES: readonly { readonly id: McpMarketplaceCategory; readonly label: string; readonly gapBefore?: boolean }[] = [
	{ id: 'pinned', label: localize('chat.skillsLibrary.mcpCategory.pinned', "Pinned") },
	{ id: 'installed', label: localize('chat.skillsLibrary.mcpCategory.installed', "Installed") },
	{ id: 'development-testing', label: localize('chat.skillsLibrary.mcpCategory.development', "Development"), gapBefore: true },
	{ id: 'project-management-docs', label: localize('chat.skillsLibrary.mcpCategory.projectManagement', "Projects & Docs") },
	{ id: 'payments-commerce', label: localize('chat.skillsLibrary.mcpCategory.payments', "Payments") },
	{ id: 'design-media', label: localize('chat.skillsLibrary.mcpCategory.design', "Design & Media") },
	{ id: 'infrastructure-devops', label: localize('chat.skillsLibrary.mcpCategory.infrastructure', "Infrastructure") },
	{ id: 'stdio-utilities', label: localize('chat.skillsLibrary.mcpCategory.utilities', "Utilities") },
	{ id: 'remote-servers', label: localize('chat.skillsLibrary.mcpCategory.integrations', "Integrations") },
	{ id: 'all', label: localize('chat.skillsLibrary.mcpCategory.all', "All MCPs"), gapBefore: true },
];

const EMBEDDED_MCP_MARKETPLACE_CATEGORIES: readonly { readonly id: McpMarketplaceCategory; readonly label: string }[] = [
	{ id: 'pinned', label: localize('chat.skillsLibrary.mcpCategory.pinned', "Pinned") },
	{ id: 'installed', label: localize('chat.skillsLibrary.mcpCategory.installed', "Installed") },
	{ id: 'all', label: localize('chat.skillsLibrary.mcpCategory.all', "All MCPs") },
	{ id: 'development-testing', label: localize('chat.skillsLibrary.mcpCategory.development', "Development") },
	{ id: 'project-management-docs', label: localize('chat.skillsLibrary.mcpCategory.projectManagement', "Projects & Docs") },
	{ id: 'payments-commerce', label: localize('chat.skillsLibrary.mcpCategory.payments', "Payments") },
	{ id: 'design-media', label: localize('chat.skillsLibrary.mcpCategory.design', "Design & Media") },
	{ id: 'infrastructure-devops', label: localize('chat.skillsLibrary.mcpCategory.infrastructure', "Infrastructure") },
	{ id: 'stdio-utilities', label: localize('chat.skillsLibrary.mcpCategory.utilities', "Utilities") },
	{ id: 'remote-servers', label: localize('chat.skillsLibrary.mcpCategory.integrations', "Integrations") },
];

export interface ISkillsShListItem {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly source: string;
	readonly installs?: string;
	readonly isOfficial?: boolean;
	readonly url: string;
}

export type SkillsLibraryInstallTarget = 'repo' | 'personal';

export interface ISkillsLibraryInstalledSkill {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly storage: PromptsStorage;
	readonly uri?: URI;
}

export interface ISkillsLibraryOfficialOwner {
	readonly owner: string;
	readonly featuredRepo?: string;
	readonly totalInstalls?: number;
	readonly repoCount: number;
	readonly skillCount: number;
	readonly skills: readonly ISkillsShListItem[];
}

export interface ISkillsLibraryState {
	readonly remote: readonly ISkillsShListItem[];
	readonly remoteByCategory?: Partial<Record<Exclude<SkillsLibraryCategory, 'pinned' | 'installed' | 'all'>, readonly ISkillsShListItem[]>>;
	readonly allRemote?: readonly ISkillsShListItem[];
	readonly allLoading?: boolean;
	readonly allError?: string;
	readonly remoteSearch?: readonly ISkillsShListItem[];
	readonly remoteTotal?: number;
	readonly officialOwners?: readonly ISkillsLibraryOfficialOwner[];
	readonly searchLoading?: boolean;
	readonly searchError?: string;
	readonly installed: readonly ISkillsLibraryInstalledSkill[];
	readonly favoriteIds: readonly string[];
	readonly loading?: boolean;
	readonly error?: string;
}

export interface ISkillsLibraryBuildOptions {
	readonly query?: string;
	readonly onToggleFavorite?: (id: string, favorite: boolean) => void;
	readonly onInstall?: (item: ISkillsShListItem) => void | Promise<void>;
}

interface ISkillsShApiSkill {
	readonly id?: string;
	readonly slug?: string;
	readonly name?: string;
	readonly source?: string;
	readonly installs?: number;
	readonly sourceType?: string;
	readonly installUrl?: string;
	readonly url?: string;
}

interface ISkillsShApiCuratedResponse {
	readonly data?: readonly {
		readonly owner?: string;
		readonly totalInstalls?: number;
		readonly featuredRepo?: string;
		readonly featuredSkill?: string;
		readonly skills?: readonly ISkillsShApiSkill[];
	}[];
	readonly totalOwners?: number;
	readonly totalSkills?: number;
}

interface IMastraSkillsRegistryResponse {
	readonly skills?: readonly unknown[];
}

type SkillsShDirectory = {
	readonly all: ISkillsShListItem[];
	readonly byCategory: Partial<Record<Exclude<SkillsLibraryCategory, 'pinned' | 'installed' | 'all'>, ISkillsShListItem[]>>;
	readonly officialOwners?: readonly ISkillsLibraryOfficialOwner[];
	readonly total?: number;
};

let directoryCache: Promise<SkillsShDirectory> | undefined;
let mastraDirectoryCache: Promise<ISkillsShListItem[]> | undefined;
const searchCache = new Map<string, Promise<ISkillsShListItem[]>>();

export function resetSkillsShDirectoryCache(): void {
	directoryCache = undefined;
	mastraDirectoryCache = undefined;
	searchCache.clear();
}

export async function listSkillsShDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<SkillsShDirectory> {
	if (!directoryCache) {
		directoryCache = fetchSkillsShDirectory(webContentExtractorService, token).catch(err => {
			directoryCache = undefined;
			throw err;
		});
	}
	return directoryCache;
}

export async function listMastraSkillsDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	if (!mastraDirectoryCache) {
		mastraDirectoryCache = fetchMastraSkillsDirectory(webContentExtractorService, token).catch(err => {
			mastraDirectoryCache = undefined;
			throw err;
		});
	}
	return mastraDirectoryCache;
}

export async function searchSkillsShDirectory(webContentExtractorService: ISharedWebContentExtractorService, query: string, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	const normalizedQuery = query.trim();
	if (normalizedQuery.length < 2) {
		return [];
	}
	const cacheKey = normalizedQuery.toLowerCase();
	let search = searchCache.get(cacheKey);
	if (!search) {
		search = fetchSkillsShSearch(webContentExtractorService, normalizedQuery, token).catch(err => {
			searchCache.delete(cacheKey);
			throw err;
		});
		searchCache.set(cacheKey, search);
	}
	return search;
}

async function fetchSkillsShDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<SkillsShDirectory> {
	try {
		return await fetchSkillsShApiDirectory(webContentExtractorService, token);
	} catch {
		try {
			return await fetchSkillsShPublicDirectory(webContentExtractorService, token);
		} catch {
			return fetchSkillsShOpenSourceDirectory(webContentExtractorService, token);
		}
	}
}

async function fetchSkillsShApiDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<SkillsShDirectory> {
	const officialPage = await fetchSkillsShApiOfficial(webContentExtractorService, token);
	return {
		all: officialPage.items,
		byCategory: {
			official: officialPage.items,
		},
		officialOwners: officialPage.owners,
		total: officialPage.total ?? officialPage.items.length,
	};
}

async function fetchSkillsShApiOfficial(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<{ readonly items: ISkillsShListItem[]; readonly owners: readonly ISkillsLibraryOfficialOwner[]; readonly total?: number }> {
	const text = await fetchSkillsPage(webContentExtractorService, '/api/v1/skills/curated', token);
	const parsed = JSON.parse(text) as ISkillsShApiCuratedResponse;
	if (!Array.isArray(parsed.data)) {
		throw new Error(localize('chat.skillsLibrary.apiUnavailable', "skills.sh API response did not include data."));
	}
	const owners: ISkillsLibraryOfficialOwner[] = [];
	for (const owner of parsed.data ?? []) {
		const skills = dedupeItems((owner.skills ?? [])
			.map((item: ISkillsShApiSkill) => mapSkillsShApiSkill(item, true))
			.filter((item: ISkillsShListItem | undefined): item is ISkillsShListItem => !!item));
		if (!owner.owner || !skills.length) {
			continue;
		}
		owners.push({
			owner: owner.owner,
			featuredRepo: owner.featuredRepo,
			totalInstalls: owner.totalInstalls,
			repoCount: countRepos(skills),
			skillCount: skills.length,
			skills,
		});
	}
	owners.sort(compareOfficialOwners);
	return { items: dedupeItems(owners.flatMap(owner => owner.skills)), owners, total: parsed.totalSkills };
}

async function fetchSkillsShPublicDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<SkillsShDirectory> {
	const html = await fetchSkillsPage(webContentExtractorService, PUBLIC_OFFICIAL_PATH, token);
	const parsedItems = parseSkillsShHtml(html);
	const official = dedupeItems((parsedItems.length ? parsedItems : parseSkillsShOfficialHtml(html))
		.map(item => ({ ...item, isOfficial: true })));
	const officialOwners = createOfficialOwnersFromSkills(official);
	return {
		all: official,
		byCategory: { official },
		officialOwners,
		total: parseSkillsShTotal(html) ?? official.length,
	};
}

async function fetchSkillsShSearch(webContentExtractorService: ISharedWebContentExtractorService, query: string, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	try {
		const params = new URLSearchParams({ q: query, limit: String(API_SEARCH_RESULT_LIMIT) });
		const text = await fetchSkillsPage(webContentExtractorService, `/api/v1/skills/search?${params.toString()}`, token);
		const parsed = JSON.parse(text) as { readonly data?: readonly ISkillsShApiSkill[] };
		if (!Array.isArray(parsed.data)) {
			throw new Error(localize('chat.skillsLibrary.apiUnavailable', "skills.sh API response did not include data."));
		}
		return dedupeItems(parsed.data.map(item => mapSkillsShApiSkill(item)).filter((item): item is ISkillsShListItem => !!item));
	} catch {
		try {
			return await fetchSkillsShLegacySearch(webContentExtractorService, query, token);
		} catch {
			return searchOpenSourceSkillsDirectory(webContentExtractorService, query, token);
		}
	}
}

async function fetchSkillsShLegacySearch(webContentExtractorService: ISharedWebContentExtractorService, query: string, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	const params = new URLSearchParams({ q: query, limit: String(LEGACY_SEARCH_RESULT_LIMIT) });
	const text = await fetchSkillsPage(webContentExtractorService, `/api/search?${params.toString()}`, token);
	const parsed = JSON.parse(text) as { readonly skills?: readonly unknown[] };
	if (!Array.isArray(parsed.skills)) {
		return [];
	}
	return dedupeItems(parsed.skills.map(parseSkillsShSearchItem).filter((item): item is ISkillsShListItem => !!item));
}

async function fetchMastraSkillsDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	const text = await webContentExtractorService.readText(URI.parse(MASTRA_REGISTRY_URL), token ?? CancellationToken.None);
	if (text === undefined) {
		throw new Error(localize('chat.skillsLibrary.fetchFailed', "Failed to fetch {0}", MASTRA_REGISTRY_URL));
	}
	const parsed = JSON.parse(text) as IMastraSkillsRegistryResponse;
	if (!Array.isArray(parsed.skills)) {
		return [];
	}
	return dedupeItems(parsed.skills.map(parseMastraSkillItem).filter((item): item is ISkillsShListItem => !!item));
}

async function fetchSkillsShOpenSourceDirectory(webContentExtractorService: ISharedWebContentExtractorService, token?: CancellationToken): Promise<SkillsShDirectory> {
	const items = (await listMastraSkillsDirectory(webContentExtractorService, token))
		.map(item => ({ ...item, isOfficial: true }));
	const officialOwners = createOfficialOwnersFromSkills(items);
	return {
		// When both skills.sh endpoints are unavailable, keep the marketplace usable by
		// surfacing the open-source registry in the same catalog slot.
		all: items,
		byCategory: { official: items },
		officialOwners,
		total: items.length,
	};
}

async function searchOpenSourceSkillsDirectory(webContentExtractorService: ISharedWebContentExtractorService, query: string, token?: CancellationToken): Promise<ISkillsShListItem[]> {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [];
	}
	const items = await listMastraSkillsDirectory(webContentExtractorService, token);
	return dedupeItems(items.filter(item =>
		item.name.toLowerCase().includes(normalizedQuery)
		|| item.source.toLowerCase().includes(normalizedQuery)
		|| item.id.toLowerCase().includes(normalizedQuery)
		|| item.slug.toLowerCase().includes(normalizedQuery)
	));
}

function parseMastraSkillItem(value: unknown): ISkillsShListItem | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const source = stringValue(record.source);
	const slug = stringValue(record.skillId) ?? stringValue(record.name);
	if (!source || !slug) {
		return undefined;
	}
	const id = `${source}/${slug}`;
	const installsValue = typeof record.installs === 'number' || typeof record.installs === 'string' ? record.installs : undefined;
	return {
		id,
		slug,
		name: stringValue(record.displayName) ?? stringValue(record.name) ?? slug,
		source,
		installs: formatInstallCount(installsValue),
		url: `${BASE_URL}/${id}`,
	};
}

function mapSkillsShApiSkill(item: ISkillsShApiSkill, isOfficial = false): ISkillsShListItem | undefined {
	const source = stringValue(item.source);
	const slug = stringValue(item.slug) ?? lastPathSegment(stringValue(item.id));
	if (!source || !slug) {
		return undefined;
	}
	const id = stringValue(item.id) ?? `${source}/${slug}`;
	return {
		id,
		slug,
		name: stringValue(item.name) ?? slug,
		source,
		installs: formatInstallCount(item.installs),
		isOfficial,
		url: stringValue(item.url) ?? `${BASE_URL}/${id}`,
	};
}

function createOfficialOwnersFromSkills(skills: readonly ISkillsShListItem[]): ISkillsLibraryOfficialOwner[] {
	const byOwner = new Map<string, ISkillsShListItem[]>();
	for (const skill of skills) {
		const owner = skill.source.split('/')[0];
		if (!owner) {
			continue;
		}
		const existing = byOwner.get(owner) ?? [];
		existing.push({ ...skill, isOfficial: true });
		byOwner.set(owner, existing);
	}
	return Array.from(byOwner.entries()).map(([owner, ownerSkills]) => ({
		owner,
		featuredRepo: ownerSkills[0]?.source.split('/')[1],
		repoCount: countRepos(ownerSkills),
		skillCount: ownerSkills.length,
		skills: dedupeItems(ownerSkills),
	})).sort(compareOfficialOwners);
}

export function parseSkillsShHtml(html: string): ISkillsShListItem[] {
	const items: ISkillsShListItem[] = [];
	const seen = new Set<string>();
	const normalizedHtml = html
		.replace(/\\u002[fF]/g, '/')
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\');
	const dataPattern = /"source"\s*:\s*"([^"]+)"[\s\S]{0,240}?"skillId"\s*:\s*"([^"]+)"[\s\S]{0,160}?"name"\s*:\s*"([^"]+)"[\s\S]{0,160}?"installs"\s*:\s*(\d+)/g;

	for (const match of normalizedHtml.matchAll(dataPattern)) {
		const source = decodeSkillsShDataString(match[1] ?? '');
		const slug = decodeSkillsShDataString(match[2] ?? '');
		const name = decodeSkillsShDataString(match[3] ?? '') || slug;
		const installs = formatInstallCount(match[4]);
		if (!source || !slug || !installs) {
			continue;
		}

		const id = `${source}/${slug}`;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);

		items.push({
			id,
			slug,
			name,
			source,
			installs,
			isOfficial: /"isOfficial"\s*:\s*true/.test(match[0]),
			url: `${BASE_URL}/${id}`,
		});
	}

	const anchorPattern = /<a\b[^>]*href=["']\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(anchorPattern)) {
		const rawPath = match[1];
		if (!rawPath) {
			continue;
		}
		const parts = rawPath.split('/').filter(Boolean);
		if (parts.length < 2) {
			continue;
		}

		const slug = decodeURIComponent(parts[parts.length - 1] ?? '');
		const source = parts.slice(0, -1).map(decodeURIComponent).join('/');
		if (!slug || !source) {
			continue;
		}

		const text = stripTags(match[2] ?? '');
		const installs = installCount(text);
		if (!installs) {
			continue;
		}

		const id = `${source}/${slug}`;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);

		items.push({
			id,
			slug,
			name: displayName(text, slug),
			source,
			installs,
			url: `${BASE_URL}/${id}`,
		});
	}

	return items;
}

function parseSkillsShOfficialHtml(html: string): ISkillsShListItem[] {
	const items: ISkillsShListItem[] = [];
	const normalizedHtml = html
		.replace(/\\u002[fF]/g, '/')
		.replace(/\\u0026/g, '&')
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\');
	const repoPattern = /"repo"\s*:\s*"([^"]+)"\s*,\s*"totalInstalls"\s*:\s*\d+\s*,\s*"skills"\s*:\s*\[([\s\S]*?)\]/g;
	for (const repoMatch of normalizedHtml.matchAll(repoPattern)) {
		const source = decodeSkillsShDataString(repoMatch[1] ?? '');
		const skillsJson = repoMatch[2] ?? '';
		if (!source) {
			continue;
		}
		const skillPattern = /"name"\s*:\s*"([^"]+)"\s*,\s*"installs"\s*:\s*(\d+)/g;
		for (const skillMatch of skillsJson.matchAll(skillPattern)) {
			const slug = decodeSkillsShDataString(skillMatch[1] ?? '');
			if (!slug) {
				continue;
			}
			const id = `${source}/${slug}`;
			items.push({
				id,
				slug,
				name: slug,
				source,
				installs: formatInstallCount(skillMatch[2]),
				isOfficial: true,
				url: `${BASE_URL}/${id}`,
			});
		}
	}
	return dedupeItems(items);
}

function parseSkillsShSearchItem(value: unknown): ISkillsShListItem | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const source = stringValue(record.source);
	const slug = stringValue(record.skillId) ?? lastPathSegment(stringValue(record.id));
	if (!source || !slug) {
		return undefined;
	}
	const id = stringValue(record.id) ?? `${source}/${slug}`;
	const name = stringValue(record.name) ?? slug;
	const installsValue = typeof record.installs === 'number' || typeof record.installs === 'string' ? record.installs : undefined;
	return {
		id,
		slug,
		name,
		source,
		installs: formatInstallCount(installsValue),
		isOfficial: record.isOfficial === true,
		url: `${BASE_URL}/${id}`,
	};
}

function parseSkillsShTotal(html: string): number | undefined {
	const normalizedHtml = html
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\');
	const match = /"totalSkills"\s*:\s*(\d+)/.exec(normalizedHtml);
	if (!match?.[1]) {
		return undefined;
	}
	const total = Number(match[1]);
	return Number.isFinite(total) ? total : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function lastPathSegment(value: string | undefined): string | undefined {
	const parts = value?.split('/').filter(Boolean);
	return parts?.[parts.length - 1];
}

function decodeSkillsShDataString(value: string): string {
	return value
		.replace(/\\u002[fF]/g, '/')
		.replace(/\\\//g, '/')
		.replace(/\\"/g, '"')
		.trim();
}

function formatSkillsLibraryError(error: string): string {
	return error
		.replace(/https?:\/\/skills\.sh\/\S*/gi, 'Marketplace')
		.replace(/skills\.sh/gi, 'Skills');
}

export function splitSkillsShId(id: string): { source: string; slug: string } {
	const parts = id.split('/').filter(Boolean);
	if (parts.length < 2) {
		throw new Error(`Invalid skills.sh skill id: ${id}`);
	}
	const slug = parts[parts.length - 1];
	const source = parts.slice(0, -1).join('/');
	if (!slug || !source) {
		throw new Error(`Invalid skills.sh skill id: ${id}`);
	}
	return { source, slug };
}

export function buildSkillsLibraryItems(
	state: ISkillsLibraryState,
	options: ISkillsLibraryBuildOptions = {},
): IActionListItem<IActionWidgetDropdownAction>[] {
	const query = (options.query ?? '').trim().toLowerCase();
	const installedKeys = new Set<string>();
	for (const skill of state.installed) {
		installedKeys.add(skill.id.toLowerCase());
		installedKeys.add(skill.name.toLowerCase());
	}
	const favoriteSet = new Set(state.favoriteIds);
	const items: IActionListItem<IActionWidgetDropdownAction>[] = [];
	const matches = (value: string | undefined) => !query || (value ?? '').toLowerCase().includes(query);
	const matchesRemote = (item: ISkillsShListItem) => matches(item.name) || matches(item.source) || matches(item.id);
	const matchesInstalled = (item: ISkillsLibraryInstalledSkill) => matches(item.name) || matches(item.description) || matches(item.id);

	if (state.loading) {
		items.push(createStatusItem('skills.loading', localize('chat.skillsLibrary.loading', "Loading skills..."), Codicon.loading, true));
		return items;
	}

	if (state.error) {
		items.push(createStatusItem('skills.error', localize('chat.skillsLibrary.error', "Unable to load skills"), Codicon.error, true, formatSkillsLibraryError(state.error)));
	}

	const favoriteRemote = state.remote.filter(item => favoriteSet.has(item.id) && matchesRemote(item));
	if (favoriteRemote.length) {
		items.push({ kind: ActionListItemKind.Separator, label: localize('chat.skillsLibrary.pinned', "Pinned") });
		for (const item of favoriteRemote) {
			items.push(createRemoteSkillItem(item, installedKeys, favoriteSet, options));
		}
	}

	const installed = state.installed.filter(matchesInstalled).sort(compareByName);
	if (installed.length) {
		items.push({ kind: ActionListItemKind.Separator, label: localize('chat.skillsLibrary.installed', "Installed") });
		for (const skill of installed) {
			items.push(createInstalledSkillItem(skill));
		}
	}

	const remote = state.remote
		.filter(item => !favoriteSet.has(item.id) && matchesRemote(item))
		.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
	if (remote.length) {
		items.push({ kind: ActionListItemKind.Separator, label: localize('chat.skillsLibrary.directory', "skills.sh") });
		for (const item of remote) {
			items.push(createRemoteSkillItem(item, installedKeys, favoriteSet, options));
		}
	}

	if (!items.length) {
		items.push(createStatusItem('skills.empty', localize('chat.skillsLibrary.empty', "No skills found"), Codicon.search, true));
	}

	return items;
}

interface IRecentlyRemovedSkill {
	readonly kind: 'recentlyRemoved';
	readonly skill: ISkillsLibraryInstalledSkill;
	readonly remote?: ISkillsShListItem;
	readonly index: number;
}

type SkillsLibraryModalItem = ISkillsShListItem | ISkillsLibraryInstalledSkill | IRecentlyRemovedSkill;
type InstalledSkillFilter = 'all' | 'personal' | 'repo';

interface IRecentlyRemovedMcp {
	readonly kind: 'recentlyRemovedMcp';
	readonly server: IWorkbenchLocalMcpServer;
	readonly item?: IMcpMarketplaceItem;
	readonly index: number;
}

export type McpMarketplaceModalItem = IMcpMarketplaceItem | IWorkbenchLocalMcpServer | IRecentlyRemovedMcp;

function isRecentlyRemovedSkillItem(item: SkillsLibraryModalItem): item is IRecentlyRemovedSkill {
	return (item as IRecentlyRemovedSkill).kind === 'recentlyRemoved';
}

function isInstalledSkillItem(item: SkillsLibraryModalItem): item is ISkillsLibraryInstalledSkill {
	return 'storage' in item;
}

function isRecentlyRemovedMcpItem(item: McpMarketplaceModalItem): item is IRecentlyRemovedMcp {
	return (item as IRecentlyRemovedMcp).kind === 'recentlyRemovedMcp';
}

function isMcpMarketplaceItem(item: McpMarketplaceModalItem): item is IMcpMarketplaceItem {
	return (item as IMcpMarketplaceItem).kind === 'marketplaceMcp';
}

const INSTALLED_SKILL_FILTERS: readonly { readonly id: InstalledSkillFilter; readonly label: string }[] = [
	{ id: 'all', label: localize('chat.skillsLibrary.installedFilter.all', "All") },
	{ id: 'personal', label: localize('chat.skillsLibrary.installedFilter.personal', "Personal") },
	{ id: 'repo', label: localize('chat.skillsLibrary.installedFilter.repo', "Repository") },
];

export function resolveMcpMarketplaceItems(
	catalog: readonly IMcpMarketplaceCatalogEntry[],
	gallery: readonly IGalleryMcpServer[],
): IMcpMarketplaceItem[] {
	const galleryByName = new Map<string, IGalleryMcpServer[]>();
	for (const server of gallery) {
		const key = server.name.toLowerCase();
		const existing = galleryByName.get(key) ?? [];
		existing.push(server);
		galleryByName.set(key, existing);
	}

	const resolved: IMcpMarketplaceItem[] = [];
	const usedNames = new Set<string>();
	for (const entry of catalog) {
		if (!isMcpCatalogEntryInstallable(entry)) {
			continue;
		}

		const candidates = [
			...entry.expectedNames.flatMap(name => galleryByName.get(name.toLowerCase()) ?? []),
			...gallery.filter(server => mcpServerMatchesCatalogEntry(server, entry)),
		];
		const server = candidates.find(candidate => !usedNames.has(candidate.name.toLowerCase()) && isVerifiedLatestMcpServer(candidate, entry));
		if (!server) {
			continue;
		}

		usedNames.add(server.name.toLowerCase());
		resolved.push(createMcpMarketplaceItem(entry, server));
	}
	return resolved.sort(compareMcpMarketplaceItems);
}

export function createMcpMarketplaceItemsFromCatalog(
	catalog: readonly IMcpMarketplaceCatalogEntry[] = MCP_MARKETPLACE_CATALOG,
): IMcpMarketplaceItem[] {
	return catalog
		.filter(isMcpCatalogEntryInstallable)
		.map(entry => createMcpMarketplaceItem(entry))
		.sort(compareMcpMarketplaceItems);
}

export function getHiddenMcpMarketplaceCatalogEntries(
	catalog: readonly IMcpMarketplaceCatalogEntry[] = MCP_MARKETPLACE_CATALOG,
): IMcpMarketplaceCatalogEntry[] {
	return catalog.filter(entry => !isMcpCatalogEntryInstallable(entry));
}

function isMcpCatalogEntryInstallable(entry: Pick<IMcpMarketplaceCatalogEntry, 'installability'>): boolean {
	return entry.installability === 'installable';
}

function getMcpInstallabilityReason(installability: McpCatalogInstallability): string {
	switch (installability) {
		case 'installable':
			return localize('chat.skillsLibrary.mcpInstallable', "Installable");
		case 'missing':
			return localize('chat.skillsLibrary.mcpInstallabilityMissing', "the registry entry is not available.");
		case 'unsupportedAuth':
			return localize('chat.skillsLibrary.mcpInstallabilityUnsupportedAuth', "the server requires OAuth client registration that Backboard does not support yet.");
		case 'brokenRuntime':
			return localize('chat.skillsLibrary.mcpInstallabilityBrokenRuntime', "the server requires a runtime command that Backboard cannot start yet.");
		case 'disabled':
			return localize('chat.skillsLibrary.mcpInstallabilityDisabled', "the server is disabled in the catalog.");
	}
}

function getMcpInstallFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes('registry') || normalized.includes('gallery') || normalized.includes('not available') || normalized.includes('unavailable')) {
		return localize('chat.skillsLibrary.mcpInstallFailureMissing', "registry entry unavailable. {0}", message);
	}
	if (normalized.includes('invalid_client') || normalized.includes('client not found') || normalized.includes('oauth')) {
		return localize('chat.skillsLibrary.mcpInstallFailureAuth', "unsupported OAuth setup. {0}", message);
	}
	if (normalized.includes('enoent') || normalized.includes('command not found') || normalized.includes('cannot start')) {
		return localize('chat.skillsLibrary.mcpInstallFailureRuntime', "missing local runtime command. {0}", message);
	}
	return localize('chat.skillsLibrary.mcpInstallFailureStartup', "server startup or installation error. {0}", message);
}

export function buildMcpMarketplaceItems(
	state: IMcpMarketplaceState,
	options: IMcpMarketplaceBuildOptions = {},
): McpMarketplaceModalItem[] {
	const category = options.category ?? 'development-testing';
	const query = (options.query ?? '').trim().toLowerCase();
	const recentlyRemovedSet = new Set(options.recentlyRemovedIds ?? []);
	const installed = state.installed.filter(server => !recentlyRemovedSet.has(getMcpServerKey(server)));
	const matchesItem = (item: IMcpMarketplaceItem): boolean => !query
		|| item.label.toLowerCase().includes(query)
		|| item.registryName.toLowerCase().includes(query)
		|| item.expectedNames.some(name => name.toLowerCase().includes(query))
		|| item.publisher.toLowerCase().includes(query)
		|| item.source.toLowerCase().includes(query)
		|| item.description.toLowerCase().includes(query)
		|| MCP_MARKETPLACE_CATEGORIES.find(category => category.id === item.category)?.label.toLowerCase().includes(query) === true;
	const matchesInstalled = (server: IWorkbenchLocalMcpServer): boolean => !query
		|| server.name.toLowerCase().includes(query)
		|| (server.displayName ?? '').toLowerCase().includes(query)
		|| (server.description ?? '').toLowerCase().includes(query)
		|| (server.publisherDisplayName ?? server.publisher ?? '').toLowerCase().includes(query);

	if (category === 'pinned') {
		const itemsById = new Map(state.items.map(item => [item.id, item]));
		const installedById = new Map(installed.map(server => [getMcpServerKey(server), server]));
		const pinned: Array<IMcpMarketplaceItem | IWorkbenchLocalMcpServer | undefined> = state.favoriteIds
			.map(id => itemsById.get(id) ?? installedById.get(id))
			.filter(item => !!item && (isMcpMarketplaceItem(item) ? matchesItem(item) : matchesInstalled(item)));
		return pinned.filter((item): item is IMcpMarketplaceItem | IWorkbenchLocalMcpServer => !!item);
	}

	if (category === 'installed') {
		return installed.filter(matchesInstalled).sort(compareInstalledMcpServers);
	}

	// A search query spans the whole catalog: with ~270 entries across seven
	// categories, scoping search to the active category makes most queries
	// come back empty and look like missing servers.
	if (category === 'all' || query) {
		return state.items
			.filter(matchesItem)
			.sort(compareMcpMarketplaceItems);
	}

	return state.items
		.filter(item => item.category === category && matchesItem(item))
		.sort(compareMcpMarketplaceItems);
}

function isVerifiedLatestMcpServer(server: IGalleryMcpServer, entry: Pick<IMcpMarketplaceCatalogEntry, 'officialPublisherHints' | 'trustedSource'>): boolean {
	return server.status === GalleryMcpServerStatus.Active
		&& server.isLatest
		&& (entry.trustedSource === 'github.com/mcp' || isOfficialPublisherForCatalogEntry(server, entry));
}

function isOfficialPublisherForCatalogEntry(server: IGalleryMcpServer, entry: Pick<IMcpMarketplaceCatalogEntry, 'officialPublisherHints'>): boolean {
	const publisherText = [
		server.publisher,
		server.publisherDisplayName,
	].filter((value): value is string => !!value).join(' ').toLowerCase();
	const urlText = [
		server.publisherUrl,
		server.publisherDomain?.link,
		server.repositoryUrl,
		server.webUrl,
	].filter((value): value is string => !!value).join(' ').toLowerCase();
	return entry.officialPublisherHints.some(hint => {
			const normalizedHint = hint.toLowerCase();
			if (normalizedHint.includes('.')) {
				return urlText.includes(normalizedHint);
			}
			return publisherText.split(/[^a-z0-9]+/).includes(normalizedHint)
				|| publisherText === normalizedHint
				|| urlText.includes(`github.com/${normalizedHint}/`);
		});
}

function mcpServerMatchesCatalogEntry(server: IGalleryMcpServer, entry: IMcpMarketplaceCatalogEntry): boolean {
	const haystack = [
		server.name,
		server.displayName,
		server.description,
		server.publisher,
		server.publisherDisplayName,
		server.repositoryUrl,
		...(server.topics ?? []),
	].join(' ').toLowerCase();
	return (entry.searchTerms ?? [entry.label]).some(term => haystack.includes(term.toLowerCase()));
}

function createMcpMarketplaceItem(entry: IMcpMarketplaceCatalogEntry, gallery?: IGalleryMcpServer): IMcpMarketplaceItem {
	const registryName = gallery?.name ?? entry.expectedNames[0] ?? entry.id;
	return {
		kind: 'marketplaceMcp',
		id: entry.id,
		label: entry.label,
		category: entry.category,
		registryName,
		expectedNames: entry.expectedNames,
		officialPublisherHints: entry.officialPublisherHints,
		description: gallery?.description ?? entry.description ?? localize('chat.skillsLibrary.mcpDefaultDescription', "{0} MCP server", entry.label),
		publisher: gallery?.publisherDisplayName ?? gallery?.publisher ?? entry.publisher ?? entry.label,
		source: entry.id,
		installConfiguration: entry.installConfiguration,
		repositoryUrl: entry.repositoryUrl,
		trustedSource: entry.trustedSource,
		logoUrl: gallery?.icon?.dark ?? gallery?.icon?.light ?? getMcpCatalogLogoUrl(entry),
		verified: true,
		preferredPackageType: entry.preferredPackageType,
		installServerConfig: entry.installServerConfig,
		installInputs: entry.installInputs,
		cliConfig: entry.cliConfig,
	};
}

function getMcpCatalogLogoUrl(entry: IMcpMarketplaceCatalogEntry): string | undefined {
	if (entry.logoUrl) {
		return entry.logoUrl;
	}
	const domain = entry.officialPublisherHints.find(hint => hint.includes('.'));
	if (!domain) {
		return undefined;
	}
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function getMcpServerKey(server: ILocalMcpServer): string {
	return (server.galleryId ?? server.name).toLowerCase();
}

function getMcpCollectionIdForWorkbenchServer(server: IWorkbenchLocalMcpServer): string | undefined {
	const suffix = `.${server.name}`;
	return server.id.endsWith(suffix) ? server.id.slice(0, -suffix.length) : undefined;
}

function getMcpDefinitionIdForWorkbenchServer(server: IWorkbenchLocalMcpServer): string {
	return `${getMcpCollectionIdForWorkbenchServer(server) ?? 'mcp.config.unknown'}.${server.name}`;
}

function getMcpItemInstallKeys(item: IMcpMarketplaceItem): string[] {
	return [
		item.registryName,
		...item.expectedNames,
	].map(value => value.trim().toLowerCase()).filter(Boolean);
}

export function mcpItemMatchesInstalledServer(item: IMcpMarketplaceItem, server: ILocalMcpServer): boolean {
	const itemKeys = new Set(getMcpItemInstallKeys(item));
	const serverKeys = [
		server.name,
		server.galleryId ?? '',
	].map(value => value.trim().toLowerCase()).filter(Boolean);
	return serverKeys.some(key => itemKeys.has(key));
}

function createTrustedGithubMcpGalleryServer(item: IMcpMarketplaceItem): IGalleryMcpServer | undefined {
	const configuration = item.installConfiguration ?? createReferenceMcpConfiguration(item);
	if (!configuration) {
		return undefined;
	}
	return {
		name: item.registryName,
		displayName: item.label,
		description: item.description,
		version: 'latest',
		isLatest: true,
		status: GalleryMcpServerStatus.Active,
		configuration,
		publisher: 'github.com/mcp',
		publisherDisplayName: 'GitHub MCP',
		publisherUrl: 'https://github.com/mcp',
		repositoryUrl: item.repositoryUrl ?? 'https://github.com/mcp',
		icon: item.logoUrl ? { dark: item.logoUrl, light: item.logoUrl } : undefined,
	};
}

function createReferenceMcpConfiguration(item: IMcpMarketplaceItem): IGalleryMcpServerConfiguration | undefined {
	const name = item.expectedNames.find(name => name.startsWith('io.github.modelcontextprotocol/server-'));
	if (!name) {
		return undefined;
	}
	const packageName = name.replace('io.github.modelcontextprotocol/server-', '');
	if (packageName === 'fetch' || packageName === 'git' || packageName === 'time') {
		return {
			packages: [{
				registryType: RegistryType.PYTHON,
				identifier: `mcp-server-${packageName}`,
				transport: { type: TransportType.STDIO },
			}],
		};
	}
	const npmPackage = packageName === 'sequentialthinking'
		? '@modelcontextprotocol/server-sequential-thinking'
		: `@modelcontextprotocol/server-${packageName}`;
	return {
		packages: [{
			registryType: RegistryType.NODE,
			identifier: npmPackage,
			transport: { type: TransportType.STDIO },
		}],
	};
}

function findInstalledMcp(installed: readonly IWorkbenchLocalMcpServer[], item: IMcpMarketplaceItem): IWorkbenchLocalMcpServer | undefined {
	return installed.find(server => mcpItemMatchesInstalledServer(item, server));
}

function findMcpItemForInstalledServer(items: readonly IMcpMarketplaceItem[], server: ILocalMcpServer): IMcpMarketplaceItem | undefined {
	return items.find(item => mcpItemMatchesInstalledServer(item, server));
}

function compareMcpMarketplaceItems(a: IMcpMarketplaceItem, b: IMcpMarketplaceItem): number {
	return getMcpCategoryIndex(a.category) - getMcpCategoryIndex(b.category) || a.label.localeCompare(b.label) || a.source.localeCompare(b.source);
}

function compareInstalledMcpServers(a: IWorkbenchLocalMcpServer, b: IWorkbenchLocalMcpServer): number {
	return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name) || a.name.localeCompare(b.name);
}

function getMcpCategoryIndex(category: McpMarketplaceCategory): number {
	const index = MCP_MARKETPLACE_CATEGORIES.findIndex(item => item.id === category);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getCategoryItems(state: ISkillsLibraryState, category: SkillsLibraryCategory, query: string): SkillsLibraryModalItem[] {
	const normalizedQuery = query.trim().toLowerCase();
	const matches = (value: string | undefined) => !normalizedQuery || (value ?? '').toLowerCase().includes(normalizedQuery);
	const matchesRemote = (item: ISkillsShListItem) => matches(item.name) || matches(item.source) || matches(item.id);
	const matchesInstalled = (item: ISkillsLibraryInstalledSkill) => matches(item.name) || matches(item.description) || matches(item.id);

	if (category === 'pinned') {
		const remoteById = new Map([
			...state.remote,
			...(state.allRemote ?? []),
			...(state.remoteSearch ?? []),
		].map(item => [item.id, item]));
		const installedById = new Map(state.installed.map(item => [item.id, item]));
		const pinned: Array<ISkillsShListItem | ISkillsLibraryInstalledSkill | undefined> = state.favoriteIds
			.map(id => remoteById.get(id) ?? installedById.get(id))
			.filter(item => !!item && ('storage' in item ? matchesInstalled(item) : matchesRemote(item)));
		return pinned.filter((item): item is ISkillsShListItem | ISkillsLibraryInstalledSkill => !!item);
	}

	if (category === 'installed') {
		return state.installed
			.filter(matchesInstalled)
			.sort(compareByName);
	}

	if (category === 'all') {
		return (state.allRemote ?? []).filter(matchesRemote);
	}

	const remote = state.remoteByCategory?.[category] ?? [];
	return remote.filter(matchesRemote);
}

function findInstalledSkill(installed: readonly ISkillsLibraryInstalledSkill[], item: ISkillsShListItem): ISkillsLibraryInstalledSkill | undefined {
	return installed.find(skill => remoteMatchesInstalledSkill(skill, item));
}

function findRemoteForInstalledSkill(state: ISkillsLibraryState, skill: ISkillsLibraryInstalledSkill): ISkillsShListItem | undefined {
	const candidates = [
		...(state.remoteSearch ?? []),
		...state.remote,
		...(state.allRemote ?? []),
	];
	return candidates.find(item => remoteMatchesInstalledSkill(skill, item));
}

function remoteMatchesInstalledSkill(skill: ISkillsLibraryInstalledSkill, item: ISkillsShListItem): boolean {
	const installedKeys = new Set([
		skill.id.toLowerCase(),
		skill.name.toLowerCase(),
	]);
	return installedKeys.has(item.slug.toLowerCase()) || installedKeys.has(item.name.toLowerCase()) || installedKeys.has(item.id.toLowerCase());
}

function isSameRemoteSkillSlug(left: ISkillsShListItem, right: ISkillsShListItem): boolean {
	const leftSlug = left.slug.toLowerCase();
	const rightSlug = right.slug.toLowerCase();
	return leftSlug === rightSlug || left.name.toLowerCase() === rightSlug || right.name.toLowerCase() === leftSlug;
}

function getRemoteSkillCandidateKey(item: ISkillsShListItem): string {
	return `${item.source}/${item.slug}`.toLowerCase();
}

function createInstalledSkillItem(skill: ISkillsLibraryInstalledSkill): IActionListItem<IActionWidgetDropdownAction> {
	const description = skill.description ?? (skill.storage === PromptsStorage.user
		? localize('chat.skillsLibrary.personal', "Personal")
		: localize('chat.skillsLibrary.repo', "Repository"));
	return {
		kind: ActionListItemKind.Action,
		item: {
			id: `installed.${skill.id}`,
			label: skill.name,
			enabled: false,
			checked: false,
			class: undefined,
			tooltip: description,
			run: () => { },
		},
		label: skill.name,
		description: localize('chat.skillsLibrary.installedDescription', "Installed"),
		detail: description,
		group: undefined,
		hideIcon: true,
		disabled: true,
	};
}

function createRemoteSkillItem(
	item: ISkillsShListItem,
	installedKeys: Set<string>,
	favoriteSet: Set<string>,
	options: ISkillsLibraryBuildOptions,
): IActionListItem<IActionWidgetDropdownAction> {
	const installed = installedKeys.has(item.slug.toLowerCase()) || installedKeys.has(item.name.toLowerCase()) || installedKeys.has(item.id.toLowerCase());
	const favorite = favoriteSet.has(item.id);
	const pinAction = options.onToggleFavorite ? createFavoriteAction(item.id, favorite, options.onToggleFavorite) : undefined;
	const description = installed
		? localize('chat.skillsLibrary.installedDescription', "Installed")
		: item.installs
			? localize('chat.skillsLibrary.installs', "{0} installs", item.installs)
			: undefined;
	return {
		kind: ActionListItemKind.Action,
		item: {
			id: `remote.${item.id}`,
			label: item.name,
			description,
			enabled: !installed,
			checked: false,
			class: ThemeIcon.asClassName(installed ? Codicon.check : Codicon.add),
			tooltip: item.source,
			run: () => installed ? undefined : options.onInstall?.(item),
		},
		label: item.name,
		description,
		detail: item.source,
		group: { title: '', icon: ThemeIcon.fromId(installed ? Codicon.check.id : Codicon.add.id) },
		hideIcon: false,
		disabled: installed,
		toolbarActions: pinAction ? [pinAction] : undefined,
	};
}

function createFavoriteAction(id: string, favorite: boolean, onToggleFavorite: (id: string, favorite: boolean) => void): IAction {
	return toAction({
		id: `skills.favorite.${id}`,
		label: favorite
			? localize('chat.skillsLibrary.unfavorite', "Unpin skill")
			: localize('chat.skillsLibrary.favorite', "Pin skill"),
		class: ThemeIcon.asClassName(favorite ? Codicon.pinned : Codicon.pin),
		run: () => onToggleFavorite(id, !favorite),
	});
}

function createStatusItem(id: string, label: string, icon: ThemeIcon, disabled: boolean, detail?: string): IActionListItem<IActionWidgetDropdownAction> {
	return {
		kind: ActionListItemKind.Action,
		item: {
			id,
			label,
			enabled: false,
			checked: false,
			class: ThemeIcon.asClassName(icon),
			tooltip: detail ?? label,
			run: () => { },
		},
		label,
		detail,
		group: { title: '', icon: ThemeIcon.fromId(icon.id) },
		hideIcon: false,
		disabled,
		showAlways: true,
	};
}

function compareByName(a: ISkillsLibraryInstalledSkill, b: ISkillsLibraryInstalledSkill): number {
	return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function compareOfficialOwners(a: ISkillsLibraryOfficialOwner, b: ISkillsLibraryOfficialOwner): number {
	return b.skillCount - a.skillCount || a.owner.localeCompare(b.owner);
}

function countRepos(skills: readonly ISkillsShListItem[]): number {
	return new Set(skills.map(skill => skill.source).filter(Boolean)).size;
}

function displayName(text: string, fallback: string): string {
	const compact = text.replace(/\s+/g, ' ').trim();
	if (!compact) {
		return fallback;
	}
	const withoutRank = compact.replace(/^\d+\s+/, '');
	const first = withoutRank.split(/\s+/)[0];
	return first && !looksLikeCount(first) ? first : fallback;
}

function installCount(text: string): string | undefined {
	const compact = text.replace(/\s+/g, ' ').trim();
	const match = /(\d+(?:\.\d+)?[KMB]?)$/.exec(compact);
	return match?.[1];
}

function formatInstallCount(value: string | number | undefined): string | undefined {
	if (value === undefined || value === '') {
		return undefined;
	}
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return String(value);
	}
	if (numeric >= 1_000_000_000) {
		return `${trimTrailingDecimal(numeric / 1_000_000_000)}B`;
	}
	if (numeric >= 1_000_000) {
		return `${trimTrailingDecimal(numeric / 1_000_000)}M`;
	}
	if (numeric >= 1_000) {
		return `${trimTrailingDecimal(numeric / 1_000)}K`;
	}
	return String(numeric);
}

function trimTrailingDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, '');
}

function looksLikeCount(value: string): boolean {
	return /^\d+(?:\.\d+)?[KMB]?$/.test(value);
}

function dedupeItems(items: readonly ISkillsShListItem[]): ISkillsShListItem[] {
	const seen = new Set<string>();
	const deduped: ISkillsShListItem[] = [];
	for (const item of items) {
		if (!isInstallableRemoteSkill(item)) {
			continue;
		}
		if (seen.has(item.id)) {
			continue;
		}
		seen.add(item.id);
		deduped.push(item);
	}
	return deduped;
}

function isInstallableRemoteSkill(item: ISkillsShListItem): boolean {
	return item.source !== 'anthropics/skills' || !NON_INSTALLABLE_ANTHROPIC_SESSION_SKILLS.has(item.slug);
}

function stripTags(value: string): string {
	return value
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

async function fetchSkillsPage(webContentExtractorService: ISharedWebContentExtractorService, path: string, token: CancellationToken | undefined): Promise<string> {
	const text = await webContentExtractorService.readText(URI.parse(`${BASE_URL}${path}`), token ?? CancellationToken.None);
	if (text === undefined) {
		throw new Error(localize('chat.skillsLibrary.fetchFailed', "Failed to fetch {0}", `${BASE_URL}${path}`));
	}
	return text;
}

function shellEscapeArg(value: string): string {
	if (isWindows) {
		return `"${value.replace(/[`$"]/g, '`$&')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatShellCommand(args: readonly string[]): string {
	const [command, ...rest] = args;
	return [command, ...rest.map(arg => shellEscapeArg(arg))].join(' ');
}

function sanitizeSkillFolderName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

export class SkillsLibraryController {

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IMcpGalleryService private readonly _mcpGalleryService: IMcpGalleryService,
		@IMcpService private readonly _mcpService: IMcpService,
		@IWorkbenchMcpManagementService private readonly _mcpManagementService: IWorkbenchMcpManagementService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IPathService private readonly _pathService: IPathService,
		@IPromptsService private readonly _promptsService: IPromptsService,
		@IProgressService private readonly _progressService: IProgressService,
		@ISharedWebContentExtractorService private readonly _sharedWebContentExtractorService: ISharedWebContentExtractorService,
	@IStorageService private readonly _storageService: IStorageService,
	@ITerminalService private readonly _terminalService: ITerminalService,
	@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	renderEmbeddedMarketplace(container: HTMLElement): DisposableStore {
		dom.clearNode(container);
		return this.createMarketplaceSession({
			host: container,
			ownerDocument: container.ownerDocument,
			embedded: true,
		});
	}

	showMarketplace(anchor?: HTMLElement): void {
		const ownerDocument = anchor?.ownerDocument ?? dom.getActiveWindow().document;
		const existingOverlay = ownerDocument.querySelector('.skills-library-overlay');
		if (dom.isHTMLElement(existingOverlay)) {
			const existingSearch = existingOverlay.querySelector('.skills-library-search');
			if (existingSearch instanceof ownerDocument.defaultView!.HTMLInputElement) {
				existingSearch.focus();
			}
			return;
		}

		const workbenchContainer = ownerDocument.querySelector('.monaco-workbench');
		const overlayParent = dom.isHTMLElement(workbenchContainer) ? workbenchContainer : ownerDocument.body;
		this.createMarketplaceSession({
			host: overlayParent,
			ownerDocument,
			embedded: false,
		});
	}

	private createMarketplaceSession(options: { readonly host: HTMLElement; readonly ownerDocument: Document; readonly embedded: boolean }): DisposableStore {
		const { embedded, host, ownerDocument } = options;
		const store = new DisposableStore();
		let activeMarketplacePage: SkillsMarketplacePage = 'skills';
		let activeCategory: SkillsLibraryCategory = 'official';
		let activeMcpCategory: McpMarketplaceCategory = 'development-testing';
		let installedFilter: InstalledSkillFilter = 'all';
		let recentlyRemovedInstalled: IRecentlyRemovedSkill[] = [];
		let recentlyRemovedMcps: IRecentlyRemovedMcp[] = [];
		const removingSkillKeys = new Set<string>();
		const installingSkillKeys = new Set<string>();
		const locallyRemovedSkillKeys = new Set<string>();
		const removingMcpKeys = new Set<string>();
		const installingMcpKeys = new Set<string>();
		const locallyRemovedMcpKeys = new Set<string>();
		let activeOfficialOwner: string | undefined;
		let allPage = 0;
		let query = '';
		let searchRevision = 0;
		let mcpLoaded = false;
		let state: ISkillsLibraryState = {
			remote: [],
			installed: [],
			favoriteIds: this.getFavoriteIds(),
			loading: true,
		};
		let mcpState: IMcpMarketplaceState = {
			items: [],
			installed: [],
			favoriteIds: this.getMcpFavoriteIds(),
			loading: true,
		};

		const root = embedded
			? dom.append(host, dom.$('.skills-library-embedded'))
			: dom.append(host, dom.$('.skills-library-overlay'));
		const modal = dom.append(root, dom.$(embedded ? '.skills-library-modal.skills-library-modal-embedded' : '.skills-library-modal'));
		const header = dom.append(modal, dom.$('.skills-library-header'));
		header.classList.toggle('skills-library-header-embedded', embedded);
		const pageTabs = dom.append(header, dom.$('.skills-library-page-tabs'));
		const titleBlock = dom.append(header, dom.$('.skills-library-title-block'));
		const title = dom.append(titleBlock, dom.$('h2'));
		const subtitle = dom.append(titleBlock, dom.$('p'));
		const searchRow = dom.append(header, dom.$('.skills-library-search-row'));
		const searchBox = dom.append(searchRow, dom.$('.skills-library-search-box'));
		dom.append(searchBox, dom.$('span.skills-library-search-icon', undefined, renderIcon(Codicon.search)));
		const search = dom.append(searchBox, dom.$('input.skills-library-search', {
			type: 'search',
			placeholder: localize('chat.skillsLibrary.searchPlaceholder', "Search Marketplace"),
			'aria-label': localize('chat.skillsLibrary.searchAria', "Search Marketplace"),
		})) as HTMLInputElement;
		const closeButton = embedded ? undefined : dom.append(header, dom.$('button.skills-library-close', { type: 'button', 'aria-label': localize('chat.skillsLibrary.close', "Close") }, renderIcon(Codicon.close)));
		const body = dom.append(modal, dom.$('.skills-library-body'));
		body.classList.toggle('skills-library-body-embedded', embedded);
		const sidebar = dom.append(body, dom.$('.skills-library-sidebar'));
		const content = dom.append(body, dom.$('.skills-library-content'));

		const getInstalledRemovalKeys = (skill: ISkillsLibraryInstalledSkill): string[] => [
			skill.id,
			skill.name,
			skill.uri?.toString() ?? '',
		].map(value => value.trim().toLowerCase()).filter(Boolean);

		const getRemoteRemovalKeys = (item: ISkillsShListItem): string[] => [
			item.id,
			item.slug,
			item.name,
		].map(value => value.trim().toLowerCase()).filter(Boolean);

		const getPrimarySkillKey = (skill: ISkillsLibraryInstalledSkill): string => getInstalledRemovalKeys(skill)[0] ?? skill.name.toLowerCase();

		const installedStorageMatches = (skill: ISkillsLibraryInstalledSkill): boolean => {
			if (installedFilter === 'personal') {
				return skill.storage === PromptsStorage.user;
			}
			if (installedFilter === 'repo') {
				return skill.storage !== PromptsStorage.user;
			}
			return true;
		};

		const installedSearchMatches = (skill: ISkillsLibraryInstalledSkill): boolean => {
			const normalizedQuery = query.trim().toLowerCase();
			return !normalizedQuery
				|| skill.name.toLowerCase().includes(normalizedQuery)
				|| (skill.description ?? '').toLowerCase().includes(normalizedQuery)
				|| skill.id.toLowerCase().includes(normalizedQuery);
		};

		const getVisibleInstalledSkills = (): ISkillsLibraryInstalledSkill[] => state.installed
			.filter(skill => installedStorageMatches(skill) && installedSearchMatches(skill))
			.sort(compareByName);

		const getVisibleInstalledIndex = (skill: ISkillsLibraryInstalledSkill): number => {
			const index = getVisibleInstalledSkills().findIndex(existing => existing.id === skill.id || existing.uri?.toString() === skill.uri?.toString());
			return Math.max(0, index);
		};

		const isLocallyRemoved = (skill: ISkillsLibraryInstalledSkill): boolean => getInstalledRemovalKeys(skill).some(key => locallyRemovedSkillKeys.has(key));

		const isRemovingSkill = (skill: ISkillsLibraryInstalledSkill): boolean => getInstalledRemovalKeys(skill).some(key => removingSkillKeys.has(key));

		const isInstallingSkill = (item: ISkillsShListItem): boolean => getRemoteRemovalKeys(item).some(key => installingSkillKeys.has(key));

		const markLocallyRemoved = (skill: ISkillsLibraryInstalledSkill, remote?: ISkillsShListItem): void => {
			for (const key of getInstalledRemovalKeys(skill)) {
				locallyRemovedSkillKeys.add(key);
			}
			if (remote) {
				for (const key of getRemoteRemovalKeys(remote)) {
					locallyRemovedSkillKeys.add(key);
				}
			}
		};

		const clearLocalRemoval = (item: ISkillsShListItem): void => {
			for (const removed of recentlyRemovedInstalled) {
				if (removed.remote?.id === item.id) {
					for (const key of getInstalledRemovalKeys(removed.skill)) {
						locallyRemovedSkillKeys.delete(key);
					}
				}
			}
			for (const key of getRemoteRemovalKeys(item)) {
				locallyRemovedSkillKeys.delete(key);
			}
			recentlyRemovedInstalled = recentlyRemovedInstalled.filter(removed => removed.remote?.id !== item.id);
		};

		const filterLocallyRemovedInstalled = (installed: readonly ISkillsLibraryInstalledSkill[]): ISkillsLibraryInstalledSkill[] => installed.filter(skill => !isLocallyRemoved(skill));

		const clearRecentlyRemovedInstalled = (): void => {
			recentlyRemovedInstalled = [];
		};

		const getMcpRemovalKeys = (server: IWorkbenchLocalMcpServer): string[] => [
			server.id,
			server.name,
			server.galleryId ?? '',
			server.galleryUrl ?? '',
			server.displayName ?? '',
		].map(value => value.trim().toLowerCase()).filter(Boolean);

		const isLocallyRemovedMcp = (server: IWorkbenchLocalMcpServer): boolean => getMcpRemovalKeys(server).some(key => locallyRemovedMcpKeys.has(key));

		const filterLocallyRemovedMcps = (installed: readonly IWorkbenchLocalMcpServer[]): IWorkbenchLocalMcpServer[] => installed.filter(server => !isLocallyRemovedMcp(server));

		const getPrimaryMcpKey = (server: IWorkbenchLocalMcpServer): string => getMcpRemovalKeys(server)[0] ?? server.name.toLowerCase();

		const isInstallingMcp = (item: IMcpMarketplaceItem): boolean => installingMcpKeys.has(item.id);

		const isRemovingMcp = (server: IWorkbenchLocalMcpServer): boolean => getMcpRemovalKeys(server).some(key => removingMcpKeys.has(key));

		const markLocallyRemovedMcp = (server: IWorkbenchLocalMcpServer, item?: IMcpMarketplaceItem): void => {
			for (const key of getMcpRemovalKeys(server)) {
				locallyRemovedMcpKeys.add(key);
			}
			if (item) {
				locallyRemovedMcpKeys.add(item.id);
			}
		};

		const clearLocalMcpRemoval = (item: IMcpMarketplaceItem): void => {
			for (const removed of recentlyRemovedMcps) {
				if (removed.item?.id === item.id) {
					for (const key of getMcpRemovalKeys(removed.server)) {
						locallyRemovedMcpKeys.delete(key);
					}
				}
			}
			locallyRemovedMcpKeys.delete(item.id);
			recentlyRemovedMcps = recentlyRemovedMcps.filter(removed => removed.item?.id !== item.id);
		};

		const clearRecentlyRemovedMcps = (): void => {
			recentlyRemovedMcps = [];
		};

		const installedMcpSearchMatches = (server: IWorkbenchLocalMcpServer): boolean => {
			const normalizedQuery = query.trim().toLowerCase();
			return !normalizedQuery
				|| server.name.toLowerCase().includes(normalizedQuery)
				|| (server.displayName ?? '').toLowerCase().includes(normalizedQuery)
				|| (server.description ?? '').toLowerCase().includes(normalizedQuery)
				|| (server.publisherDisplayName ?? server.publisher ?? '').toLowerCase().includes(normalizedQuery);
		};

		const getVisibleInstalledMcps = (): IWorkbenchLocalMcpServer[] => mcpState.installed
			.filter(server => installedMcpSearchMatches(server))
			.sort(compareInstalledMcpServers);

		const getVisibleInstalledMcpIndex = (server: IWorkbenchLocalMcpServer): number => {
			const index = getVisibleInstalledMcps().findIndex(existing => existing.id === server.id || existing.name === server.name);
			return Math.max(0, index);
		};

		const close = (): void => {
			resetSkillsShDirectoryCache();
			store.dispose();
		};
		store.add(toDisposable(() => root.remove()));
		if (closeButton) {
			store.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, close));
		}
		if (!embedded) {
			store.add(dom.addDisposableListener(root, dom.EventType.MOUSE_DOWN, e => {
				if (e.target === root) {
					close();
				}
			}));
			store.add(dom.addDisposableListener(ownerDocument, dom.EventType.KEY_DOWN, e => {
				if (e.key === 'Escape') {
					close();
				}
			}));
		}
		store.add(dom.addDisposableListener(search, dom.EventType.INPUT, () => {
			query = search.value;
			void refreshActiveView();
		}));

		const openMcpServerOptionsFromMarketplace = (server: IWorkbenchLocalMcpServer): void => {
			close();
			setTimeout(() => void this.openMcpServerOptions(server), 0);
		};

		const openMcpServerOutputFromMarketplace = (server: IWorkbenchLocalMcpServer): void => {
			close();
			setTimeout(() => void this.openMcpServerOutput(server), 0);
		};

		const openMcpServerConfigurationFromMarketplace = (server: IWorkbenchLocalMcpServer): void => {
			close();
			setTimeout(() => void this.openMcpServerConfiguration(server), 0);
		};

		const renderPageTabs = (): void => {
			dom.clearNode(pageTabs);
			for (const page of SKILLS_MARKETPLACE_PAGES) {
				const button = dom.append(pageTabs, dom.$('button.skills-library-page-tab', {
					type: 'button',
					'aria-pressed': String(activeMarketplacePage === page.id),
				}, page.label));
				button.classList.toggle('active', activeMarketplacePage === page.id);
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
					if (activeMarketplacePage === page.id) {
						return;
					}
					activeMarketplacePage = page.id;
					clearRecentlyRemovedInstalled();
					clearRecentlyRemovedMcps();
					activeOfficialOwner = undefined;
					void refreshActiveView();
				}));
			}
		};

		const renderEmbeddedCategorySelect = <TCategory extends string>(
			options: readonly { readonly id: TCategory; readonly label: string }[],
			value: TCategory,
			labelText: string,
			onChange: (value: TCategory) => void,
		): void => {
			const group = dom.append(sidebar, dom.$('.skills-library-embedded-filter-group'));
			dom.append(group, dom.$('label.skills-library-embedded-filter-label', undefined, labelText));
			const currentLabel = options.find(option => option.id === value)?.label ?? labelText;
			const button = dom.append(group, dom.$('button.skills-library-embedded-filter-button', {
				type: 'button',
				'aria-haspopup': 'menu',
				'aria-label': labelText,
			}));
			dom.append(button, dom.$('span.skills-library-embedded-filter-button-label', undefined, currentLabel));
			dom.append(button, dom.$('span.skills-library-embedded-filter-button-icon', undefined, renderIcon(Codicon.chevronDown)));
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this._contextMenuService.showContextMenu({
					getAnchor: () => button,
					getActions: () => options.map(option => toAction({
						id: `skillsLibrary.embeddedFilter.${String(option.id)}`,
						label: option.label,
						checked: option.id === value,
						run: () => onChange(option.id),
					})),
				});
			}));
		};

		const renderSidebar = (): void => {
			dom.clearNode(sidebar);
			sidebar.classList.toggle('skills-library-sidebar-embedded', embedded);
			if (embedded) {
				if (activeMarketplacePage === 'mcp') {
					renderEmbeddedCategorySelect(EMBEDDED_MCP_MARKETPLACE_CATEGORIES, activeMcpCategory, localize('chat.skillsLibrary.mcpFilterLabel', "MCP category"), value => {
						activeMcpCategory = value;
						if (activeMcpCategory !== 'installed') {
							clearRecentlyRemovedMcps();
						}
						void refreshActiveView();
					});
					return;
				}
				renderEmbeddedCategorySelect(SKILLS_LIBRARY_CATEGORIES, activeCategory, localize('chat.skillsLibrary.skillsFilterLabel', "Skill category"), value => {
					activeCategory = value;
					if (activeCategory !== 'installed') {
						clearRecentlyRemovedInstalled();
					}
					activeOfficialOwner = undefined;
					void refreshActiveView();
				});
				return;
			}
			if (activeMarketplacePage === 'mcp') {
				for (const category of MCP_MARKETPLACE_CATEGORIES) {
					const button = dom.append(sidebar, dom.$('button.skills-library-filter', {
						type: 'button',
						'aria-pressed': String(activeMcpCategory === category.id),
					}));
					button.classList.toggle('active', activeMcpCategory === category.id);
					button.classList.toggle('gap-before', !!category.gapBefore);
					const label = dom.append(button, dom.$('span.skills-library-filter-label'));
					dom.append(label, dom.$('span', undefined, category.label));
					store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
						activeMcpCategory = category.id;
						if (activeMcpCategory !== 'installed') {
							clearRecentlyRemovedMcps();
						}
						void refreshActiveView();
					}));
				}
				return;
			}
			for (const category of SKILLS_LIBRARY_CATEGORIES) {
				const button = dom.append(sidebar, dom.$('button.skills-library-filter', {
					type: 'button',
					'aria-pressed': String(activeCategory === category.id),
				}));
				button.classList.toggle('active', activeCategory === category.id);
				button.classList.toggle('gap-before', !!category.gapBefore);
				const label = dom.append(button, dom.$('span.skills-library-filter-label'));
				dom.append(label, dom.$('span', undefined, category.label));
				if (category.id === 'official') {
					dom.append(label, dom.$('span.skills-library-verified', {
						title: localize('chat.skillsLibrary.verified', "Verified"),
					}, renderIcon(Codicon.verifiedFilled)));
				}
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
					activeCategory = category.id;
					if (activeCategory !== 'installed') {
						clearRecentlyRemovedInstalled();
					}
					activeOfficialOwner = undefined;
					void refreshActiveView();
				}));
			}
		};

		const render = (): void => {
			renderPageTabs();
			renderHeading();
			renderSidebar();
			dom.clearNode(content);
			body.classList.toggle('skills-library-body-mcp', activeMarketplacePage === 'mcp');
			if (activeMarketplacePage === 'mcp') {
				renderMcpContent();
				return;
			}
			if (state.loading) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.loading', "Loading skills...")));
				return;
			}
			content.classList.remove('skills-library-content-centered');
			if (state.error && activeCategory !== 'installed') {
				dom.append(content, dom.$('.skills-library-error', undefined, localize('chat.skillsLibrary.errorDetail', "Unable to load skills: {0}", formatSkillsLibraryError(state.error))));
			}
			const normalizedQuery = query.trim();
			if (state.searchError) {
				dom.append(content, dom.$('.skills-library-error', undefined, localize('chat.skillsLibrary.searchErrorDetail', "Unable to search skills: {0}", formatSkillsLibraryError(state.searchError))));
			}
			if (state.searchLoading) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.searching', "Searching skills...")));
				return;
			}
			if (normalizedQuery.length > 0 && normalizedQuery.length < 2) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.searchMinLength', "Type at least 2 characters to search Marketplace.")));
				return;
			}
			if (normalizedQuery.length >= 2) {
				renderRemoteGrid(state.remoteSearch ?? []);
				return;
			}
			if (state.allError && activeCategory === 'all') {
				dom.append(content, dom.$('.skills-library-error', undefined, localize('chat.skillsLibrary.allErrorDetail', "Unable to load all skills: {0}", state.allError)));
			}
			if (state.allLoading && activeCategory === 'all') {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.loadingAll', "Loading all skills...")));
				return;
			}
			if (activeCategory === 'official') {
				renderOfficialContent();
				return;
			}
			if (activeCategory === 'all') {
				renderAllContent();
				return;
			}
			if (activeCategory === 'installed') {
				renderInstalledContent();
				return;
			}
			const items = getCategoryItems(state, activeCategory, query);
			renderItems(items);
		};

		const renderHeading = (): void => {
			if (activeMarketplacePage === 'mcp') {
				title.textContent = localize('chat.skillsLibrary.mcpTitle', "MCP");
				subtitle.textContent = localize('chat.skillsLibrary.mcpSubtitle', "Browse and install MCP servers.");
				search.placeholder = localize('chat.skillsLibrary.searchMcpPlaceholder', "Search MCPs");
				search.setAttribute('aria-label', localize('chat.skillsLibrary.searchMcpAria', "Search MCPs"));
				return;
			}
			title.textContent = localize('chat.skillsLibrary.skillsTitle', "Skills");
			subtitle.textContent = localize('chat.skillsLibrary.skillsSubtitle', "Browse, pin, and install reusable skills.");
			search.placeholder = localize('chat.skillsLibrary.searchSkillsPlaceholder', "Search skills");
			search.setAttribute('aria-label', localize('chat.skillsLibrary.searchSkillsAria', "Search skills"));
		};

		const renderMcpContent = (): void => {
			if (mcpState.loading) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.mcpLoading', "Loading MCP servers...")));
				return;
			}
			content.classList.remove('skills-library-content-centered');
			if (mcpState.error && activeMcpCategory !== 'installed') {
				dom.append(content, dom.$('.skills-library-error', undefined, localize('chat.skillsLibrary.mcpErrorDetail', "Unable to load MCP registry: {0}", mcpState.error)));
			}
			if (activeMcpCategory === 'installed') {
				renderInstalledMcpContent();
				return;
			}
			const items = buildMcpMarketplaceItems(mcpState, {
				category: activeMcpCategory,
				query,
				recentlyRemovedIds: recentlyRemovedMcps.map(removed => getMcpServerKey(removed.server)),
			});
			renderMcpItems(items);
		};

		const renderMcpItems = (items: readonly McpMarketplaceModalItem[]): void => {
			if (!items.length) {
				content.classList.add('skills-library-content-centered');
				const normalizedQuery = query.trim();
				let emptyMessage: string;
				if (normalizedQuery) {
					emptyMessage = localize('chat.skillsLibrary.noMcpSearchResults', "No MCP servers found");
				} else if (activeMcpCategory === 'pinned') {
					emptyMessage = localize('chat.skillsLibrary.noPinnedMcps', "You don't have any pinned MCP servers yet. Explore MCPs and pin the ones you want quick access to.");
				} else if (activeMcpCategory === 'installed') {
					emptyMessage = localize('chat.skillsLibrary.noInstalledMcps', "You don't have any installed MCP servers yet. Explore MCPs to add one.");
				} else {
					emptyMessage = localize('chat.skillsLibrary.noMcpResults', "More MCP servers are coming soon");
				}
				dom.append(content, dom.$('.skills-library-status', undefined, emptyMessage));
				return;
			}
			content.classList.remove('skills-library-content-centered');
			const grid = dom.append(content, dom.$('.skills-library-grid.skills-library-mcp-grid'));
			for (const item of items) {
				if (isRecentlyRemovedMcpItem(item)) {
					renderRecentlyRemovedMcpCard(grid, item);
				} else if (isMcpMarketplaceItem(item)) {
					renderMcpCard(grid, item);
				} else {
					renderInstalledMcpCard(grid, item);
				}
			}
		};

		const renderInstalledMcpContent = (): void => {
			const normalizedQuery = query.trim().toLowerCase();
			const removedMatches = (item: IRecentlyRemovedMcp): boolean => !normalizedQuery
				|| item.server.name.toLowerCase().includes(normalizedQuery)
				|| (item.server.displayName ?? '').toLowerCase().includes(normalizedQuery)
				|| (item.server.description ?? '').toLowerCase().includes(normalizedQuery)
				|| (item.item?.publisher ?? '').toLowerCase().includes(normalizedQuery);
			const items: McpMarketplaceModalItem[] = getVisibleInstalledMcps();
			for (const removed of recentlyRemovedMcps.filter(item => removedMatches(item)).sort((a, b) => a.index - b.index)) {
				items.splice(Math.min(Math.max(removed.index, 0), items.length), 0, removed);
			}
			renderMcpItems(items);
		};

		const renderMcpLogo = (parent: HTMLElement, item: IMcpMarketplaceItem | IWorkbenchLocalMcpServer): void => {
			const iconUrl = isMcpMarketplaceItem(item)
				? item.logoUrl
				: item.icon?.dark ?? item.icon?.light;
			if (iconUrl) {
				dom.append(parent, dom.$('img.skills-library-mcp-logo', { src: iconUrl, alt: '' }));
				return;
			}
			dom.append(parent, dom.$('span.skills-library-mcp-logo.fallback', undefined, renderIcon(Codicon.package)));
		};

		const renderMcpCardShell = (parent: HTMLElement, item: IMcpMarketplaceItem | IWorkbenchLocalMcpServer, removed = false): { card: HTMLElement; header: HTMLElement; footer: HTMLElement } => {
			const card = dom.append(parent, dom.$(`.skills-library-card.skills-library-mcp-card${removed ? '.removed' : ''}`));
			renderMcpLogo(card, item);
			const header = dom.append(card, dom.$('.skills-library-card-header'));
			const title = dom.append(header, dom.$('.skills-library-card-title'));
			dom.append(title, dom.$('span.skills-library-card-title-text', undefined, isMcpMarketplaceItem(item) ? item.label : item.displayName ?? item.name));
			const description = isMcpMarketplaceItem(item) ? item.description : item.description ?? localize('chat.skillsLibrary.installedDescription', "Installed");
			dom.append(card, dom.$('.skills-library-card-detail', undefined, description));
			const meta = dom.append(card, dom.$('.skills-library-card-meta'));
			if (isMcpMarketplaceItem(item)) {
				dom.append(meta, dom.$('span', undefined, item.publisher));
				dom.append(meta, dom.$('span', undefined, item.source));
			} else {
				dom.append(meta, dom.$('span', undefined, item.scope === LocalMcpServerScope.Workspace ? localize('chat.skillsLibrary.repo', "Repository") : localize('chat.skillsLibrary.personal', "Personal")));
				const publisher = item.publisherDisplayName ?? item.publisher;
				if (publisher) {
					dom.append(meta, dom.$('span', undefined, publisher));
				}
			}
			const footer = dom.append(card, dom.$('.skills-library-card-footer'));
			return { card, header, footer };
		};

		const renderMcpCard = (parent: HTMLElement, item: IMcpMarketplaceItem): void => {
			const installedServer = findInstalledMcp(mcpState.installed, item);
			const installed = !!installedServer;
			const favorite = mcpState.favoriteIds.includes(item.id);
			const { footer } = renderMcpCardShell(parent, item);
			const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
				type: 'button',
				'aria-label': favorite ? localize('chat.skillsLibrary.unfavoriteMcp', "Unpin MCP server") : localize('chat.skillsLibrary.favoriteMcp', "Pin MCP server"),
			}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
			store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
				this.setMcpFavorite(item.id, !favorite);
				mcpState = { ...mcpState, favoriteIds: this.getMcpFavoriteIds() };
				render();
			}));
			const removing = !!installedServer && isRemovingMcp(installedServer);
			const installing = isInstallingMcp(item);
			const installButton = dom.append(footer, dom.$('button.skills-library-primary-button', { type: 'button' }, installing ? localize('chat.skillsLibrary.installingShort', "Installing...") : removing ? localize('chat.skillsLibrary.removing', "Removing...") : installed ? localize('chat.skillsLibrary.installedDescription', "Installed") : localize('chat.skillsLibrary.get', "Get"))) as HTMLButtonElement;
			installButton.classList.toggle('installed-toggle', installed);
			installButton.disabled = installing || removing;
			store.add(dom.addDisposableListener(installButton, dom.EventType.CLICK, () => installedServer ? void runRemoveMcp(installedServer) : void runInstallMcp(item)));
			if (installedServer) {
				const setupButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-setup-button', {
					type: 'button',
					'aria-label': localize('chat.skillsLibrary.mcpStartServer', "Start server"),
					title: localize('chat.skillsLibrary.mcpStartServer', "Start server"),
				}, renderIcon(Codicon.play))) as HTMLButtonElement;
				setupButton.disabled = installing || removing;
				store.add(dom.addDisposableListener(setupButton, dom.EventType.CLICK, () => openMcpServerOptionsFromMarketplace(installedServer)));
				const outputButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-output-button', {
					type: 'button',
					'aria-label': localize('chat.skillsLibrary.mcpShowOutput', "Show Output"),
					title: localize('chat.skillsLibrary.mcpShowOutput', "Show Output"),
				}, renderIcon(Codicon.output))) as HTMLButtonElement;
				outputButton.disabled = installing || removing;
				store.add(dom.addDisposableListener(outputButton, dom.EventType.CLICK, () => openMcpServerOutputFromMarketplace(installedServer)));
				const configButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-config-button', {
					type: 'button',
					'aria-label': localize('chat.skillsLibrary.mcpShowConfiguration', "Show Configuration"),
					title: localize('chat.skillsLibrary.mcpShowConfiguration', "Show Configuration"),
				}, renderIcon(Codicon.gear))) as HTMLButtonElement;
				configButton.disabled = installing || removing;
				store.add(dom.addDisposableListener(configButton, dom.EventType.CLICK, () => openMcpServerConfigurationFromMarketplace(installedServer)));
			}
		};

		const renderInstalledMcpCard = (parent: HTMLElement, server: IWorkbenchLocalMcpServer): void => {
			const item = findMcpItemForInstalledServer(mcpState.items, server);
			const favoriteId = item?.id ?? getMcpServerKey(server);
			const favorite = mcpState.favoriteIds.includes(favoriteId);
			const { footer } = renderMcpCardShell(parent, item ?? server);
			const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
				type: 'button',
				'aria-label': favorite ? localize('chat.skillsLibrary.unfavoriteMcp', "Unpin MCP server") : localize('chat.skillsLibrary.favoriteMcp', "Pin MCP server"),
			}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
			store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
				this.setMcpFavorite(favoriteId, !favorite);
				mcpState = { ...mcpState, favoriteIds: this.getMcpFavoriteIds() };
				render();
			}));
			const removing = isRemovingMcp(server);
			const installedButton = dom.append(footer, dom.$('button.skills-library-primary-button.installed-toggle', { type: 'button' }, removing ? localize('chat.skillsLibrary.removing', "Removing...") : localize('chat.skillsLibrary.installedDescription', "Installed"))) as HTMLButtonElement;
			installedButton.disabled = removing;
			store.add(dom.addDisposableListener(installedButton, dom.EventType.CLICK, () => void runRemoveMcp(server)));
			const setupButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-setup-button', {
				type: 'button',
				'aria-label': localize('chat.skillsLibrary.mcpStartServer', "Start server"),
				title: localize('chat.skillsLibrary.mcpStartServer', "Start server"),
			}, renderIcon(Codicon.play))) as HTMLButtonElement;
			setupButton.disabled = removing;
			store.add(dom.addDisposableListener(setupButton, dom.EventType.CLICK, () => openMcpServerOptionsFromMarketplace(server)));
			const outputButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-output-button', {
				type: 'button',
				'aria-label': localize('chat.skillsLibrary.mcpShowOutput', "Show Output"),
				title: localize('chat.skillsLibrary.mcpShowOutput', "Show Output"),
			}, renderIcon(Codicon.output))) as HTMLButtonElement;
			outputButton.disabled = removing;
			store.add(dom.addDisposableListener(outputButton, dom.EventType.CLICK, () => openMcpServerOutputFromMarketplace(server)));
			const configButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-mcp-config-button', {
				type: 'button',
				'aria-label': localize('chat.skillsLibrary.mcpShowConfiguration', "Show Configuration"),
				title: localize('chat.skillsLibrary.mcpShowConfiguration', "Show Configuration"),
			}, renderIcon(Codicon.gear))) as HTMLButtonElement;
			configButton.disabled = removing;
			store.add(dom.addDisposableListener(configButton, dom.EventType.CLICK, () => openMcpServerConfigurationFromMarketplace(server)));
		};

		const renderRecentlyRemovedMcpCard = (parent: HTMLElement, removed: IRecentlyRemovedMcp): void => {
			const item = removed.item;
			const favoriteId = item?.id ?? getMcpServerKey(removed.server);
			const favorite = mcpState.favoriteIds.includes(favoriteId);
			const { footer } = renderMcpCardShell(parent, item ?? removed.server, true);
			const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
				type: 'button',
				'aria-label': favorite ? localize('chat.skillsLibrary.unfavoriteMcp', "Unpin MCP server") : localize('chat.skillsLibrary.favoriteMcp', "Pin MCP server"),
			}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
			store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
				this.setMcpFavorite(favoriteId, !favorite);
				mcpState = { ...mcpState, favoriteIds: this.getMcpFavoriteIds() };
				render();
			}));
			const installing = !!item && isInstallingMcp(item);
			const addButton = dom.append(footer, dom.$('button.skills-library-primary-button', { type: 'button' }, installing ? localize('chat.skillsLibrary.installingShort', "Installing...") : item ? localize('chat.skillsLibrary.get', "Get") : localize('chat.skillsLibrary.removedDescription', "Removed"))) as HTMLButtonElement;
			addButton.classList.add('removed-toggle');
			addButton.disabled = installing || !item;
			if (item) {
				store.add(dom.addDisposableListener(addButton, dom.EventType.CLICK, () => void runInstallMcp(item)));
			}
		};

		const renderItems = (items: readonly SkillsLibraryModalItem[]): void => {
			if (!items.length) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.noResults', "No skills found")));
				return;
			}
			content.classList.remove('skills-library-content-centered');
			const grid = dom.append(content, dom.$('.skills-library-grid'));
			for (const item of items) {
				if (isRecentlyRemovedSkillItem(item)) {
					renderRecentlyRemovedCard(grid, item);
				} else if (isInstalledSkillItem(item)) {
					renderInstalledCard(grid, item);
				} else {
					renderRemoteCard(grid, item);
				}
			}
		};

		const renderRemoteGrid = (items: readonly ISkillsShListItem[]): void => {
			renderItems(items);
		};

		const renderInstalledContent = (): void => {
			const filters = dom.append(content, dom.$('.skills-library-installed-filters'));
			for (const filter of INSTALLED_SKILL_FILTERS) {
				const button = dom.append(filters, dom.$('button.skills-library-installed-filter', {
					type: 'button',
					'aria-pressed': String(installedFilter === filter.id),
				}, filter.label));
				button.classList.toggle('active', installedFilter === filter.id);
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
					installedFilter = filter.id;
					render();
				}));
			}

			const normalizedQuery = query.trim().toLowerCase();
			const removedMatches = (item: IRecentlyRemovedSkill): boolean => !normalizedQuery
				|| item.skill.name.toLowerCase().includes(normalizedQuery)
				|| (item.skill.description ?? '').toLowerCase().includes(normalizedQuery)
				|| item.skill.id.toLowerCase().includes(normalizedQuery)
				|| (item.remote?.source ?? '').toLowerCase().includes(normalizedQuery);
			const items: SkillsLibraryModalItem[] = getVisibleInstalledSkills();
			for (const removed of recentlyRemovedInstalled.filter(item => installedStorageMatches(item.skill) && removedMatches(item)).sort((a, b) => a.index - b.index)) {
				items.splice(Math.min(Math.max(removed.index, 0), items.length), 0, removed);
			}
			if (!items.length) {
				content.classList.remove('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.noResults', "No skills found")));
				return;
			}
			renderItems(items);
		};

		const renderAllContent = (): void => {
			const allItems = (state.allRemote ?? []).filter(item => !findInstalledSkill(state.installed, item));
			if (!allItems.length) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.noResults', "No skills found")));
				return;
			}
			const totalPages = Math.max(1, Math.ceil(allItems.length / ALL_SKILLS_PAGE_SIZE));
			allPage = Math.min(Math.max(allPage, 0), totalPages - 1);
			const start = allPage * ALL_SKILLS_PAGE_SIZE;
			const pageItems = allItems.slice(start, start + ALL_SKILLS_PAGE_SIZE);

			const pager = dom.append(content, dom.$('.skills-library-pagination'));
			dom.append(pager, dom.$('span.skills-library-pagination-label', undefined, localize('chat.skillsLibrary.pageLabel', "{0}-{1} of {2}", start + 1, Math.min(start + pageItems.length, allItems.length), allItems.length)));
			const controls = dom.append(pager, dom.$('span.skills-library-pagination-controls'));
			const previousButton = dom.append(controls, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.previous', "Previous"))) as HTMLButtonElement;
			previousButton.disabled = allPage === 0;
			const nextButton = dom.append(controls, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.next', "Next"))) as HTMLButtonElement;
			nextButton.disabled = allPage >= totalPages - 1;
			store.add(dom.addDisposableListener(previousButton, dom.EventType.CLICK, () => {
				allPage = Math.max(0, allPage - 1);
				render();
			}));
			store.add(dom.addDisposableListener(nextButton, dom.EventType.CLICK, () => {
				allPage = Math.min(totalPages - 1, allPage + 1);
				render();
			}));

			renderItems(pageItems);
		};

		const renderOfficialContent = (): void => {
			const officialOwners = state.officialOwners ?? createOfficialOwnersFromSkills(state.remoteByCategory?.official ?? []);
			const selectedOwner = activeOfficialOwner ? officialOwners.find(owner => owner.owner === activeOfficialOwner) : undefined;
			if (selectedOwner) {
				renderOfficialOwnerSkills(selectedOwner);
				return;
			}

			const normalizedQuery = query.trim().toLowerCase();
			const owners = officialOwners.filter(owner => !normalizedQuery
				|| owner.owner.toLowerCase().includes(normalizedQuery)
				|| (owner.featuredRepo ?? '').toLowerCase().includes(normalizedQuery));
			if (!owners.length) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.noResults', "No skills found")));
				return;
			}

			const table = dom.append(content, dom.$('.skills-library-official-table'));
			const header = dom.append(table, dom.$('.skills-library-official-row.skills-library-official-header'));
			dom.append(header, dom.$('span', undefined, localize('chat.skillsLibrary.creator', "Creator")));
			dom.append(header, dom.$('span', undefined, localize('chat.skillsLibrary.repos', "Repos")));
			dom.append(header, dom.$('span', undefined, localize('chat.skillsLibrary.skills', "Skills")));
			for (const owner of owners) {
				const row = dom.append(table, dom.$('button.skills-library-official-row', { type: 'button' }));
				const creator = dom.append(row, dom.$('span.skills-library-official-creator'));
				dom.append(creator, dom.$('span.skills-library-official-name', undefined, owner.owner));
				if (owner.featuredRepo) {
					dom.append(creator, dom.$('span.skills-library-official-repo', undefined, owner.featuredRepo));
				}
				dom.append(row, dom.$('span.skills-library-official-count', undefined, String(owner.repoCount)));
				dom.append(row, dom.$('span.skills-library-official-count', undefined, String(owner.skillCount)));
				store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
					activeOfficialOwner = owner.owner;
					render();
				}));
			}
		};

		const renderOfficialOwnerSkills = (owner: ISkillsLibraryOfficialOwner): void => {
			const heading = dom.append(content, dom.$('.skills-library-official-owner-heading'));
			const backButton = dom.append(heading, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.back', "Back")));
			const title = dom.append(heading, dom.$('.skills-library-official-owner-title'));
			dom.append(title, dom.$('span', undefined, owner.owner));
			dom.append(title, dom.$('small', undefined, localize('chat.skillsLibrary.officialCounts', "{0} repos · {1} skills", owner.repoCount, owner.skillCount)));
			store.add(dom.addDisposableListener(backButton, dom.EventType.CLICK, () => {
				activeOfficialOwner = undefined;
				render();
			}));

			const normalizedQuery = query.trim().toLowerCase();
			const skills = owner.skills.filter(item => !normalizedQuery
				|| item.name.toLowerCase().includes(normalizedQuery)
				|| item.source.toLowerCase().includes(normalizedQuery)
				|| item.id.toLowerCase().includes(normalizedQuery));
			if (!skills.length) {
				content.classList.add('skills-library-content-centered');
				dom.append(content, dom.$('.skills-library-status', undefined, localize('chat.skillsLibrary.noResults', "No skills found")));
				return;
			}
			const grid = dom.append(content, dom.$('.skills-library-grid'));
			for (const skill of skills) {
				renderRemoteCard(grid, skill);
			}
		};

		const runInstallMcp = async (item: IMcpMarketplaceItem): Promise<void> => {
			if (isInstallingMcp(item)) {
				return;
			}
			installingMcpKeys.add(item.id);
			render();
			try {
				await this.installMcp(item);
				clearLocalMcpRemoval(item);
				await refreshMcp();
			} catch {
				// installMcp already reports the failure.
			} finally {
				installingMcpKeys.delete(item.id);
				render();
			}
		};

		const runRemoveMcp = async (server: IWorkbenchLocalMcpServer): Promise<void> => {
			if (isRemovingMcp(server)) {
				return;
			}
			const removingKeys = getMcpRemovalKeys(server);
			const previousInstalled = mcpState.installed;
			const previousRecentlyRemoved = recentlyRemovedMcps;
			const removedIndex = getVisibleInstalledMcpIndex(server);
			const item = findMcpItemForInstalledServer(mcpState.items, server);
			for (const key of removingKeys) {
				removingMcpKeys.add(key);
			}
			render();
			try {
				await this.removeMcp(server);
				markLocallyRemovedMcp(server, item);
				mcpState = {
					...mcpState,
					installed: filterLocallyRemovedMcps(mcpState.installed.filter(existing => existing.id !== server.id && existing.name !== server.name)),
				};
				if (activeMcpCategory === 'installed' && !recentlyRemovedMcps.some(removed => getPrimaryMcpKey(removed.server) === getPrimaryMcpKey(server))) {
					recentlyRemovedMcps = [{ kind: 'recentlyRemovedMcp', server, item, index: removedIndex }, ...recentlyRemovedMcps];
				}
				const installed = await this.getInstalledMcps().catch(() => mcpState.installed);
				mcpState = { ...mcpState, installed: filterLocallyRemovedMcps(installed) };
			} catch {
				recentlyRemovedMcps = previousRecentlyRemoved;
				mcpState = { ...mcpState, installed: previousInstalled };
			} finally {
				for (const key of removingKeys) {
					removingMcpKeys.delete(key);
				}
			}
			render();
		};

		const runInstallSkill = async (item: ISkillsShListItem, target: SkillsLibraryInstallTarget): Promise<void> => {
			if (isInstallingSkill(item)) {
				return;
			}
			const installingKeys = getRemoteRemovalKeys(item);
			for (const key of installingKeys) {
				installingSkillKeys.add(key);
			}
			render();
			try {
				await this.installSkill(item, target);
				clearLocalRemoval(item);
				await refresh();
			} catch {
				// installSkill already reports the failure. Keep the removed/add state visible.
			} finally {
				for (const key of installingKeys) {
					installingSkillKeys.delete(key);
				}
				render();
			}
		};

		const renderInstallTargetPicker = (item: ISkillsShListItem, footer: HTMLElement, onCancel: () => void): void => {
			dom.clearNode(footer);
			const targetPicker = dom.append(footer, dom.$('.skills-library-install-targets'));
			const workspaceFolder = this._workspaceService.getWorkspace().folders[0];
			if (workspaceFolder) {
				const repoButton = dom.append(targetPicker, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.installRepo', "Repository")));
				store.add(dom.addDisposableListener(repoButton, dom.EventType.CLICK, () => void runInstallSkill(item, 'repo')));
			}
			const personalButton = dom.append(targetPicker, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.installPersonal', "Personal")));
			const cancelButton = dom.append(targetPicker, dom.$('button.skills-library-secondary-button', { type: 'button' }, localize('chat.skillsLibrary.cancel', "Cancel")));
			store.add(dom.addDisposableListener(personalButton, dom.EventType.CLICK, () => void runInstallSkill(item, 'personal')));
			store.add(dom.addDisposableListener(cancelButton, dom.EventType.CLICK, onCancel));
		};

		const renderInstalledCard = (parent: HTMLElement, skill: ISkillsLibraryInstalledSkill): void => {
			const card = dom.append(parent, dom.$('.skills-library-card.installed'));
			const cardHeader = dom.append(card, dom.$('.skills-library-card-header'));
			dom.append(cardHeader, dom.$('.skills-library-card-title', undefined, skill.name));
			dom.append(card, dom.$('.skills-library-card-detail', undefined, skill.description ?? localize('chat.skillsLibrary.installedDescription', "Installed")));
			const meta = dom.append(card, dom.$('.skills-library-card-meta'));
			dom.append(meta, dom.$('span', undefined, skill.storage === PromptsStorage.user ? localize('chat.skillsLibrary.personal', "Personal") : localize('chat.skillsLibrary.repo', "Repository")));
			const footer = dom.append(card, dom.$('.skills-library-card-footer'));
			const renderInstalledActions = (): void => {
				dom.clearNode(footer);
				const favorite = state.favoriteIds.includes(skill.id);
				const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
					type: 'button',
					'aria-label': favorite ? localize('chat.skillsLibrary.unfavorite', "Unpin skill") : localize('chat.skillsLibrary.favorite', "Pin skill"),
				}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
				store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
					this.setFavorite(skill.id, !favorite);
					state = { ...state, favoriteIds: this.getFavoriteIds() };
					render();
				}));
				const removing = isRemovingSkill(skill);
				const installedButton = dom.append(footer, dom.$('button.skills-library-primary-button', { type: 'button' }, removing ? localize('chat.skillsLibrary.removing', "Removing...") : localize('chat.skillsLibrary.installedDescription', "Installed"))) as HTMLButtonElement;
				installedButton.classList.add('installed-toggle');
				installedButton.disabled = removing;
				if (skill.uri) {
					store.add(dom.addDisposableListener(installedButton, dom.EventType.CLICK, () => void runRemoveSkill(skill)));
				} else {
					installedButton.disabled = true;
				}
			};
			renderInstalledActions();
		};

		const renderRecentlyRemovedCard = (parent: HTMLElement, item: IRecentlyRemovedSkill): void => {
			const card = dom.append(parent, dom.$('.skills-library-card.removed'));
			const cardHeader = dom.append(card, dom.$('.skills-library-card-header'));
			dom.append(cardHeader, dom.$('.skills-library-card-title', undefined, item.skill.name));
			dom.append(card, dom.$('.skills-library-card-detail', undefined, item.skill.description ?? localize('chat.skillsLibrary.removedDescription', "Removed")));
			const meta = dom.append(card, dom.$('.skills-library-card-meta'));
			dom.append(meta, dom.$('span', undefined, localize('chat.skillsLibrary.removedDescription', "Removed")));
			dom.append(meta, dom.$('span', undefined, item.skill.storage === PromptsStorage.user ? localize('chat.skillsLibrary.personal', "Personal") : localize('chat.skillsLibrary.repo', "Repository")));
			const footer = dom.append(card, dom.$('.skills-library-card-footer'));
			const favoriteId = item.remote?.id ?? item.skill.id;
			const favorite = state.favoriteIds.includes(favoriteId);
			const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
				type: 'button',
				'aria-label': favorite ? localize('chat.skillsLibrary.unfavorite', "Unpin skill") : localize('chat.skillsLibrary.favorite', "Pin skill"),
			}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
			store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
				this.setFavorite(favoriteId, !favorite);
				state = { ...state, favoriteIds: this.getFavoriteIds() };
				render();
			}));
			const installing = !!item.remote && isInstallingSkill(item.remote);
			const addButton = dom.append(footer, dom.$('button.skills-library-primary-button', { type: 'button' }, installing ? localize('chat.skillsLibrary.installingShort', "Installing...") : item.remote ? localize('chat.skillsLibrary.add', "Add") : localize('chat.skillsLibrary.removedDescription', "Removed"))) as HTMLButtonElement;
			addButton.classList.add('removed-toggle');
			addButton.disabled = installing;
			if (item.remote) {
				store.add(dom.addDisposableListener(addButton, dom.EventType.CLICK, () => renderInstallTargetPicker(item.remote!, footer, () => render())));
			} else {
				addButton.disabled = true;
			}
		};

		const renderRemoteCard = (parent: HTMLElement, item: ISkillsShListItem): void => {
			const installedSkill = findInstalledSkill(state.installed, item);
			const installed = !!installedSkill;
			const favorite = state.favoriteIds.includes(item.id);
			const card = dom.append(parent, dom.$('.skills-library-card'));
			const cardHeader = dom.append(card, dom.$('.skills-library-card-header'));
			const title = dom.append(cardHeader, dom.$('.skills-library-card-title'));
			dom.append(title, dom.$('span.skills-library-card-title-text', undefined, item.name));
			if (item.isOfficial) {
				dom.append(title, dom.$('span.skills-library-verified', {
					title: localize('chat.skillsLibrary.verified', "Verified"),
				}, renderIcon(Codicon.verifiedFilled)));
			}
			dom.append(card, dom.$('.skills-library-card-detail', undefined, item.source));
			const meta = dom.append(card, dom.$('.skills-library-card-meta'));
			if (item.installs) {
				dom.append(meta, dom.$('span', undefined, localize('chat.skillsLibrary.installs', "{0} installs", item.installs)));
			}
			const footer = dom.append(card, dom.$('.skills-library-card-footer'));
			const renderInstallActions = (): void => {
				dom.clearNode(footer);
				const favoriteButton = dom.append(footer, dom.$('button.skills-library-icon-button.skills-library-pin-button', {
					type: 'button',
					'aria-label': favorite ? localize('chat.skillsLibrary.unfavorite', "Unpin skill") : localize('chat.skillsLibrary.favorite', "Pin skill"),
				}, renderIcon(favorite ? Codicon.pinned : Codicon.pin)));
				store.add(dom.addDisposableListener(favoriteButton, dom.EventType.CLICK, () => {
					this.setFavorite(item.id, !favorite);
					state = { ...state, favoriteIds: this.getFavoriteIds() };
					render();
				}));
				const removing = !!installedSkill && isRemovingSkill(installedSkill);
				const installing = isInstallingSkill(item);
		const installButton = dom.append(footer, dom.$('button.skills-library-primary-button', { type: 'button' }, installing ? localize('chat.skillsLibrary.installingShort', "Installing...") : removing ? localize('chat.skillsLibrary.removing', "Removing...") : installed ? localize('chat.skillsLibrary.installedDescription', "Installed") : localize('chat.skillsLibrary.add', "Add"))) as HTMLButtonElement;
				installButton.classList.toggle('installed-toggle', installed);
				installButton.disabled = removing || installing;
				store.add(dom.addDisposableListener(installButton, dom.EventType.CLICK, () => installedSkill?.uri ? void runRemoveSkill(installedSkill) : renderInstallTargetPicker(item, footer, renderInstallActions)));
			};
			renderInstallActions();
		};

		const runRemoveSkill = async (skill: ISkillsLibraryInstalledSkill): Promise<void> => {
			if (isRemovingSkill(skill)) {
				return;
			}
			const removingKeys = getInstalledRemovalKeys(skill);
			const previousInstalled = state.installed;
			const previousRecentlyRemoved = recentlyRemovedInstalled;
			const removedIndex = getVisibleInstalledIndex(skill);
			for (const key of removingKeys) {
				removingSkillKeys.add(key);
			}
			render();
			try {
				const removedRemote = await this._resolveRemoteForInstalledSkill(state, skill);
				await this.removeSkill(skill);
				markLocallyRemoved(skill, removedRemote);
				state = {
					...state,
					installed: filterLocallyRemovedInstalled(state.installed.filter(existing => existing.id !== skill.id && existing.uri?.toString() !== skill.uri?.toString())),
				};
				if (activeCategory === 'installed' && !recentlyRemovedInstalled.some(item => getPrimarySkillKey(item.skill) === getPrimarySkillKey(skill))) {
					recentlyRemovedInstalled = [{ kind: 'recentlyRemoved', skill, remote: removedRemote, index: removedIndex }, ...recentlyRemovedInstalled];
				}
				const installed = await this.getInstalledSkills(CancellationToken.None).catch(() => state.installed);
				state = { ...state, installed: filterLocallyRemovedInstalled(installed) };
			} catch {
				recentlyRemovedInstalled = previousRecentlyRemoved;
				state = { ...state, installed: previousInstalled };
			} finally {
				for (const key of removingKeys) {
					removingSkillKeys.delete(key);
				}
			}
			render();
		};

		const updateSearch = async (): Promise<void> => {
			const normalizedQuery = query.trim();
			if (normalizedQuery.length < 2) {
				searchRevision++;
				state = { ...state, remoteSearch: undefined, searchLoading: false, searchError: undefined };
				render();
				return;
			}

			const revision = ++searchRevision;
			state = { ...state, remoteSearch: undefined, searchLoading: true, searchError: undefined };
			render();
			try {
				const remoteSearch = await searchSkillsShDirectory(this._sharedWebContentExtractorService, normalizedQuery, CancellationToken.None);
				if (revision !== searchRevision) {
					return;
				}
				state = { ...state, remoteSearch, searchLoading: false };
			} catch (err) {
				if (revision !== searchRevision) {
					return;
				}
				state = { ...state, remoteSearch: [], searchLoading: false, searchError: err?.message ?? String(err) };
			}
			render();
		};

		const loadAllSkills = async (): Promise<void> => {
			if (state.allRemote || state.allLoading) {
				render();
				return;
			}
			state = { ...state, allLoading: true, allError: undefined };
			render();
			try {
				const allRemote = await listMastraSkillsDirectory(this._sharedWebContentExtractorService, CancellationToken.None);
				allPage = 0;
				state = { ...state, allRemote, allLoading: false };
			} catch (err) {
				try {
					const remote = await listSkillsShDirectory(this._sharedWebContentExtractorService, CancellationToken.None);
					allPage = 0;
					state = { ...state, allRemote: remote.all, allLoading: false, allError: undefined };
				} catch {
					state = { ...state, allRemote: state.allRemote ?? [], allLoading: false, allError: err?.message ?? String(err) };
				}
			}
			render();
		};

		const refreshActiveView = async (): Promise<void> => {
			if (activeMarketplacePage === 'mcp') {
				searchRevision++;
				state = { ...state, remoteSearch: undefined, searchLoading: false, searchError: undefined };
				if (!mcpLoaded) {
					await refreshMcp();
					return;
				}
				render();
				return;
			}
			if (query.trim().length >= 2) {
				await updateSearch();
				return;
			}
			if (activeCategory === 'all') {
				await loadAllSkills();
				return;
			}
			await updateSearch();
		};

		const refreshMcp = async (): Promise<void> => {
			mcpLoaded = true;
			mcpState = { ...mcpState, loading: true, error: undefined, favoriteIds: this.getMcpFavoriteIds() };
			render();
			try {
				const [items, installed] = await Promise.all([
					this.getCuratedMcpMarketplaceItems(CancellationToken.None),
					this.getInstalledMcps(),
				]);
				mcpState = {
					items,
					installed: filterLocallyRemovedMcps(installed),
					favoriteIds: this.getMcpFavoriteIds(),
					loading: false,
				};
			} catch (err) {
				const installed = await this.getInstalledMcps().catch(() => []);
				mcpState = {
					items: [],
					installed: filterLocallyRemovedMcps(installed),
					favoriteIds: this.getMcpFavoriteIds(),
					loading: false,
					error: err?.message ?? String(err),
				};
			}
			if (activeMcpCategory === 'pinned' && !buildMcpMarketplaceItems(mcpState, { category: 'pinned' }).length) {
				activeMcpCategory = 'development-testing';
			}
			render();
		};

		const refresh = async (): Promise<void> => {
			try {
				const [remote, installed] = await Promise.all([
					listSkillsShDirectory(this._sharedWebContentExtractorService, CancellationToken.None),
					this.getInstalledSkills(CancellationToken.None),
				]);
				state = {
					remote: remote.all,
					remoteByCategory: remote.byCategory,
					remoteTotal: remote.total,
					officialOwners: remote.officialOwners,
					installed: filterLocallyRemovedInstalled(installed),
					favoriteIds: this.getFavoriteIds(),
				};
			} catch (err) {
				const installed = await this.getInstalledSkills(CancellationToken.None).catch(() => []);
				state = {
					remote: [],
					installed: filterLocallyRemovedInstalled(installed),
					favoriteIds: this.getFavoriteIds(),
					error: err?.message ?? String(err),
				};
			}
			if (activeCategory === 'pinned' && !getCategoryItems(state, 'pinned', '').length) {
				activeCategory = 'official';
			}
			await refreshActiveView();
		};

		render();
		search.focus();
		void refresh();
		return store;
	}

	getMcpFavoriteIds(): string[] {
		const raw = this._storageService.get(MCP_FAVORITES_STORAGE_KEY, StorageScope.APPLICATION, '[]');
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
		} catch {
			return [];
		}
	}

	setMcpFavorite(id: string, favorite: boolean): void {
		const ids = this.getMcpFavoriteIds().filter(existing => existing !== id);
		if (favorite) {
			ids.unshift(id);
		}
		this._storageService.store(MCP_FAVORITES_STORAGE_KEY, JSON.stringify(ids), StorageScope.APPLICATION, StorageTarget.USER);
	}

	async getCuratedMcpMarketplaceItems(token: CancellationToken): Promise<IMcpMarketplaceItem[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		const items = createMcpMarketplaceItemsFromCatalog(MCP_MARKETPLACE_CATALOG);
		const hidden = getHiddenMcpMarketplaceCatalogEntries(MCP_MARKETPLACE_CATALOG);
		if (hidden.length) {
			this._logService.trace('[SkillsLibrary] MCP catalog entries tracked but hidden: {0}', hidden.map(entry => `${entry.label} (${getMcpInstallabilityReason(entry.installability)})`).join(', '));
		}
		return items;
	}

	async getInstalledMcps(): Promise<IWorkbenchLocalMcpServer[]> {
		return this._mcpManagementService.getInstalled();
	}

	async installMcp(item: IMcpMarketplaceItem): Promise<void> {
		try {
			const catalogEntry = MCP_MARKETPLACE_CATALOG.find(entry => entry.id === item.id);
			if (catalogEntry && !isMcpCatalogEntryInstallable(catalogEntry)) {
				throw new Error(getMcpInstallabilityReason(catalogEntry.installability));
			}
			await this._progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('chat.skillsLibrary.mcpInstalling', "Installing MCP server '{0}'...", item.label),
					cancellable: false,
				},
				async () => {
					if (item.installServerConfig) {
						// Catalog entries ship a concrete configuration; install it
						// directly without consulting the MCP registry.
						const installable: IInstallableMcpServer = {
							name: item.registryName,
							config: item.installServerConfig,
							inputs: item.installInputs ? [...item.installInputs] : undefined,
						};
						await this._mcpManagementService.install(installable);
					} else {
						const galleryServer = this._mcpGalleryService.isEnabled()
							? await this.resolveGalleryMcpForInstall(item)
							: createTrustedGithubMcpGalleryServer(item);
						if (!galleryServer) {
							throw new Error(localize('chat.skillsLibrary.mcpGalleryUnavailable', "MCP registry is unavailable."));
						}
						await this._mcpManagementService.installFromGallery(galleryServer, item.preferredPackageType ? { packageType: item.preferredPackageType } : undefined);
					}
					// Mirror into the Backboard CLI config so chat sessions can use the
					// server too; workbench and cli-ts read different config files.
					await this.addToBackboardCliConfig(item);
				}
			);
			this._notificationService.info(localize('chat.skillsLibrary.mcpInstallSuccess', "Installed MCP server '{0}'.", item.label));
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to install MCP server:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.mcpInstallFailed', "Failed to install MCP server '{0}': {1}", item.label, getMcpInstallFailureMessage(err)),
			});
			throw err;
		}
	}

	async openMcpServerOptions(server: IWorkbenchLocalMcpServer): Promise<void> {
		try {
			await this._commandService.executeCommand(McpCommandIds.ServerOptions, server.id);
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to open MCP server options:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.mcpOptionsFailed', "Failed to open setup for MCP server '{0}': {1}", server.displayName ?? server.name, err?.message ?? String(err)),
			});
		}
	}

	async openMcpServerOutput(server: IWorkbenchLocalMcpServer): Promise<void> {
		try {
			const definitionId = getMcpDefinitionIdForWorkbenchServer(server);
			const runtimeServer = this._mcpService.servers.get().find(candidate => candidate.definition.id === definitionId);
			if (!runtimeServer) {
				this._notificationService.info(localize('chat.skillsLibrary.mcpOutputUnavailable', "No output is available for MCP server '{0}' yet. Start the server first.", server.displayName ?? server.name));
				await this.openMcpServerOptions(server);
				return;
			}
			await this._commandService.executeCommand(McpCommandIds.ShowOutput, runtimeServer.definition.id);
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to open MCP server output:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.mcpOutputFailed', "Failed to open output for MCP server '{0}': {1}", server.displayName ?? server.name, err instanceof Error ? err.message : String(err)),
			});
		}
	}

	async openMcpServerConfiguration(server: IWorkbenchLocalMcpServer): Promise<void> {
		try {
			const collectionId = getMcpCollectionIdForWorkbenchServer(server);
			if (!collectionId) {
				await this._commandService.executeCommand(McpCommandIds.ServerOptions, server.id);
				return;
			}
			await this._commandService.executeCommand(McpCommandIds.ShowConfiguration, collectionId, server.id);
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to open MCP server configuration:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.mcpConfigurationFailed', "Failed to open configuration for MCP server '{0}': {1}", server.displayName ?? server.name, err instanceof Error ? err.message : String(err)),
			});
		}
	}

	private async resolveGalleryMcpForInstall(item: IMcpMarketplaceItem): Promise<IGalleryMcpServer> {
		const catalogEntry = MCP_MARKETPLACE_CATALOG.find(entry => entry.id === item.id);
		if (catalogEntry && !isMcpCatalogEntryInstallable(catalogEntry)) {
			throw new Error(getMcpInstallabilityReason(catalogEntry.installability));
		}
		const gallery = await this._mcpGalleryService.getMcpServersFromGallery(item.expectedNames.map(name => ({ name })));
		const expectedNames = new Set(item.expectedNames.map(name => name.toLowerCase()));
		const server = gallery.find(candidate => expectedNames.has(candidate.name.toLowerCase()) && isVerifiedLatestMcpServer(candidate, item));
		if (!server) {
			const trustedServer = createTrustedGithubMcpGalleryServer(item);
			if (trustedServer) {
				return trustedServer;
			}
			throw new Error(localize('chat.skillsLibrary.mcpRegistryEntryUnavailable', "The official registry entry for '{0}' is unavailable.", item.label));
		}
		return server;
	}

	private async backboardCliMcpConfigResource(): Promise<URI> {
		const home = await this._pathService.userHome();
		return URI.joinPath(home, '.backboard', 'mcp.json');
	}

	private async addToBackboardCliConfig(item: IMcpMarketplaceItem): Promise<void> {
		if (!item.cliConfig) {
			return;
		}
		try {
			const resource = await this.backboardCliMcpConfigResource();
			let root: { mcpServers?: Record<string, unknown> } = {};
			try {
				const content = await this._fileService.readFile(resource);
				const parsed: unknown = JSON.parse(content.value.toString());
				if (parsed && typeof parsed === 'object') {
					root = parsed as { mcpServers?: Record<string, unknown> };
				}
			} catch {
				// Missing or unparseable file: start a fresh config.
			}
			const servers: Record<string, unknown> = (root.mcpServers && typeof root.mcpServers === 'object') ? root.mcpServers : {};
			servers[item.registryName] = item.cliConfig;
			root.mcpServers = servers;
			await this._fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify(root, null, '\t')}\n`));
		} catch (err) {
			this._logService.warn('[SkillsLibrary] Failed to sync MCP server into the Backboard CLI config:', err);
		}
	}

	private async removeFromBackboardCliConfig(serverName: string): Promise<void> {
		try {
			const resource = await this.backboardCliMcpConfigResource();
			const content = await this._fileService.readFile(resource);
			const root: unknown = JSON.parse(content.value.toString());
			const servers = (root && typeof root === 'object') ? (root as { mcpServers?: Record<string, unknown> }).mcpServers : undefined;
			if (servers && serverName in servers) {
				delete servers[serverName];
				await this._fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify(root, null, '\t')}\n`));
			}
		} catch (err) {
			this._logService.warn('[SkillsLibrary] Failed to remove MCP server from the Backboard CLI config:', err);
		}
	}

	async removeMcp(server: IWorkbenchLocalMcpServer): Promise<void> {
		try {
			await this._mcpManagementService.uninstall(server);
			await this.removeFromBackboardCliConfig(server.name);
			this._notificationService.info(localize('chat.skillsLibrary.mcpRemoveSuccess', "Removed MCP server '{0}'.", server.displayName ?? server.name));
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to remove MCP server:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.mcpRemoveFailed', "Failed to remove MCP server '{0}': {1}", server.displayName ?? server.name, err?.message ?? String(err)),
			});
			throw err;
		}
	}

	getFavoriteIds(): string[] {
		const raw = this._storageService.get(FAVORITES_STORAGE_KEY, StorageScope.APPLICATION, '[]');
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
		} catch {
			return [];
		}
	}

	setFavorite(id: string, favorite: boolean): void {
		const ids = this.getFavoriteIds().filter(existing => existing !== id);
		if (favorite) {
			ids.unshift(id);
		}
		this._storageService.store(FAVORITES_STORAGE_KEY, JSON.stringify(ids), StorageScope.APPLICATION, StorageTarget.USER);
	}

	async getInstalledSkills(token: CancellationToken): Promise<ISkillsLibraryInstalledSkill[]> {
		const skills = await this._promptsService.findAgentSkills(token) ?? [];
		return skills
			.filter(skill => skill.storage === PromptsStorage.local || skill.storage === PromptsStorage.user)
			.map(skill => ({
				id: getSkillFolderName(skill.uri),
				name: skill.name,
				description: skill.description,
				storage: skill.storage,
				uri: skill.uri,
			}));
	}

	async removeSkill(skill: ISkillsLibraryInstalledSkill): Promise<void> {
		if (!skill.uri) {
			this._notificationService.warn(localize('chat.skillsLibrary.removeMissingUri', "Unable to locate skill '{0}'.", skill.name));
			return;
		}

		const skillFolder = dirname(skill.uri);
		try {
			if (!await this._fileService.exists(skillFolder)) {
				this._notificationService.info(localize('chat.skillsLibrary.removeAlreadyGone', "Skill '{0}' is already removed.", skill.name));
				await this._promptsService.findAgentSkills(CancellationToken.None);
				return;
			}
			const useTrash = this._fileService.hasCapability(skillFolder, FileSystemProviderCapabilities.Trash);
			await this._fileService.del(skillFolder, { recursive: true, useTrash });
			this._notificationService.info(localize('chat.skillsLibrary.removeSuccess', "Removed skill '{0}'.", skill.name));
			await this._promptsService.findAgentSkills(CancellationToken.None);
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to remove skill:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.removeFailed', "Failed to remove skill '{0}': {1}", skill.name, err?.message ?? String(err)),
			});
			throw err;
		}
	}

	async chooseInstallTarget(item: ISkillsShListItem): Promise<SkillsLibraryInstallTarget | undefined> {
		const workspaceFolder = this._workspaceService.getWorkspace().folders[0];
		const buttons = [
			...(workspaceFolder ? [{
				label: localize('chat.skillsLibrary.installRepo', "Repository"),
				run: () => 'repo' as const,
			}] : []),
			{
				label: localize('chat.skillsLibrary.installPersonal', "Personal"),
				run: () => 'personal' as const,
			},
		];
		const result = await this._dialogService.prompt<SkillsLibraryInstallTarget>({
			type: 'question',
			message: localize('chat.skillsLibrary.installPrompt', "Add skill '{0}'?", item.name),
			detail: localize('chat.skillsLibrary.installPromptDetail', "Choose where to install this skill."),
			buttons,
			cancelButton: true,
		});
		return result.result;
	}

	async installSkill(item: ISkillsShListItem, target: SkillsLibraryInstallTarget): Promise<void> {
		const targetRoot = await this._getTargetRoot(target);
		if (!targetRoot) {
			return;
		}
		const folderName = sanitizeSkillFolderName(item.slug);
		const finalSkillDir = joinPath(targetRoot, folderName);
		if (await this._fileService.exists(finalSkillDir)) {
			this._notificationService.info(localize('chat.skillsLibrary.alreadyInstalled', "Skill '{0}' is already installed.", folderName));
			return;
		}

		const tempRoot = joinPath(targetRoot, `.tmp-skills-import-${Date.now().toString(36)}`);
		try {
			await this._fileService.createFolder(tempRoot);
			const candidates = await this._getInstallCandidates(item);
			let importedSkillDir: URI | undefined;
			let installedCandidate: ISkillsShListItem | undefined;
			for (let index = 0; index < candidates.length; index++) {
				const candidate = candidates[index];
				const attemptRoot = joinPath(tempRoot, `attempt-${index}-${sanitizeSkillFolderName(candidate.id)}`);
				await this._fileService.createFolder(attemptRoot);
				await this._runSkillsAddCommand(candidate, attemptRoot);
				importedSkillDir = await this._findImportedSkillDir(attemptRoot);
				if (importedSkillDir) {
					installedCandidate = candidate;
					break;
				}
				this._logService.warn('[SkillsLibrary] No SKILL.md found after installing {0}; trying next candidate if available', candidate.id);
			}
			if (!importedSkillDir || !installedCandidate) {
				throw new Error(localize('chat.skillsLibrary.noImportedSkill', "The skills command completed but no SKILL.md was found."));
			}
			await this._fileService.createFolder(targetRoot);
			await this._fileService.move(importedSkillDir, finalSkillDir, false);
			await this._fileService.del(joinPath(tempRoot, 'skills-lock.json'), { useTrash: false }).catch(() => undefined);
			this._notificationService.info(localize('chat.skillsLibrary.installSuccess', "Installed skill '{0}'.", folderName));
			await this._promptsService.findAgentSkills(CancellationToken.None);
		} catch (err) {
			this._logService.error('[SkillsLibrary] Failed to install skill:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: localize('chat.skillsLibrary.installFailed', "Failed to install skill '{0}': {1}", item.name, err?.message ?? String(err)),
			});
			throw err;
		} finally {
			await this._fileService.del(tempRoot, { recursive: true, useTrash: false }).catch(() => undefined);
		}
	}

	private async _resolveRemoteForInstalledSkill(state: ISkillsLibraryState, skill: ISkillsLibraryInstalledSkill): Promise<ISkillsShListItem | undefined> {
		const localCandidate = findRemoteForInstalledSkill(state, skill);
		const query = (skill.id || skill.name).trim();
		if (query.length < 2) {
			return localCandidate;
		}
		try {
			const searchResults = await searchSkillsShDirectory(this._sharedWebContentExtractorService, query, CancellationToken.None);
			const exactCandidate = searchResults.find(item => remoteMatchesInstalledSkill(skill, item));
			if (exactCandidate) {
				return exactCandidate;
			}
		} catch (err) {
			this._logService.warn('[SkillsLibrary] Failed to resolve install source for removed skill {0}: {1}', skill.id, err?.message ?? String(err));
		}
		return localCandidate;
	}

	private async _getInstallCandidates(item: ISkillsShListItem): Promise<ISkillsShListItem[]> {
		const candidates: ISkillsShListItem[] = [item];
		const seen = new Set<string>([getRemoteSkillCandidateKey(item)]);
		try {
			const searchResults = await searchSkillsShDirectory(this._sharedWebContentExtractorService, item.slug, CancellationToken.None);
			for (const candidate of searchResults) {
				if (!isSameRemoteSkillSlug(item, candidate)) {
					continue;
				}
				const key = getRemoteSkillCandidateKey(candidate);
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				candidates.push(candidate);
				if (candidates.length >= 6) {
					break;
				}
			}
		} catch (err) {
			this._logService.warn('[SkillsLibrary] Failed to load fallback install candidates for {0}: {1}', item.id, err?.message ?? String(err));
		}
		return candidates;
	}

	private async _getTargetRoot(target: SkillsLibraryInstallTarget): Promise<URI | undefined> {
		if (target === 'repo') {
			const workspaceFolder = this._workspaceService.getWorkspace().folders[0];
			if (!workspaceFolder) {
				this._notificationService.warn(localize('chat.skillsLibrary.noWorkspace', "Open a workspace to install repository skills."));
				return undefined;
			}
			return joinPath(workspaceFolder.uri, '.agents', 'skills');
		}
		return joinPath(await this._pathService.userHome(), '.agents', 'skills');
	}

	private async _runSkillsAddCommand(item: ISkillsShListItem, cwd: URI): Promise<void> {
		const { source, slug } = splitSkillsShId(item.id);
		const command = formatShellCommand(['npx', '-y', 'skills', 'add', source, '--skill', slug, '-a', 'universal', '-y']);
		await this._progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: localize('chat.skillsLibrary.installing', "Installing skill '{0}'...", item.name),
				cancellable: false,
			},
			async () => {
				const terminal = await this._terminalService.createTerminal({
					config: {
						name: localize('chat.skillsLibrary.terminalName', "Skill Install"),
						forceShellIntegration: true,
						isTransient: true,
						isFeatureTerminal: true,
					},
					cwd,
				});
				try {
					await terminal.processReady;
					this._terminalService.setActiveInstance(terminal);
					const commandResultPromise = this._waitForTerminalCommandCompletion(terminal);
					await terminal.runCommand(command, true);
					const exitCode = await commandResultPromise;
					if (exitCode === undefined) {
						this._logService.warn('[SkillsLibrary] Command completion timed out; checking imported files before failing');
						return;
					}
					if (exitCode !== 0) {
						this._logService.warn('[SkillsLibrary] Command reported exit code {0}; checking imported files before failing', exitCode);
					}
				} finally {
					terminal.dispose();
				}
			}
		);
	}

	private _waitForTerminalCommandCompletion(terminal: ITerminalInstance): Promise<number | undefined> {
		return new Promise<number | undefined>(resolve => {
			const disposables = new DisposableStore();
			let isResolved = false;
			const resolveAndDispose = (exitCode: number | undefined): void => {
				if (isResolved) {
					return;
				}
				isResolved = true;
				disposables.dispose();
				resolve(exitCode);
			};
			const attachCommandFinishedListener = (): void => {
				const commandDetection = terminal.capabilities.get(TerminalCapability.CommandDetection);
				if (!commandDetection) {
					return;
				}
				disposables.add(commandDetection.onCommandFinished((command: ITerminalCommand) => {
					resolveAndDispose(command.exitCode ?? 0);
				}));
			};
			attachCommandFinishedListener();
			disposables.add(terminal.capabilities.onDidAddCommandDetectionCapability(() => attachCommandFinishedListener()));

			const timeoutHandle = timeout(120_000);
			disposables.add(toDisposable(() => timeoutHandle.cancel()));
			void timeoutHandle.then(() => {
				if (!isResolved) {
					this._logService.warn('[SkillsLibrary] Terminal command completion timed out');
					resolveAndDispose(undefined);
				}
			});
		});
	}

	private async _findImportedSkillDir(root: URI): Promise<URI | undefined> {
		const stat = await this._fileService.resolve(root);
		const queue = [...(stat.children ?? [])];
		while (queue.length) {
			const entry = queue.shift()!;
			if (!entry.isDirectory && basename(entry.resource).toLowerCase() === SKILL_FILENAME.toLowerCase()) {
				return dirname(entry.resource);
			}
			if (entry.isDirectory) {
				const child = await this._fileService.resolve(entry.resource).catch(() => undefined);
				if (child?.children) {
					queue.push(...child.children);
				}
			}
		}
		return undefined;
	}
}
