import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import { buildActivatedSkillsPrompt } from "../../prompts/system/skills.tsx";
import type { EventBus } from "../bus/EventBus.ts";
import { extractSkillInvocations } from "./activation.ts";
import { discoverSkills } from "./discovery.ts";
import type { Skill } from "./Skill.ts";
import { buildSkillCatalog, type SkillCatalog } from "./SkillCatalog.ts";
import {
	cloneSkillPickerTabs,
	SKILL_PICKER_CACHE_TTL_MS,
	SkillPickerCache,
	type SkillPickerState,
} from "./SkillPickerCache.ts";
import type {
	SkillPickerItem,
	SkillPickerSource,
	SkillPickerTab,
} from "./SkillPickerTypes.ts";
import { SkillsShClient, splitSkillsShId } from "./skillsSh.ts";

export interface SkillControllerDeps {
	cwd: string;
	bus: EventBus;
	skillsSh?: SkillsShClient;
}

export interface SkillLoadResult {
	selectedName: string;
	loadedNames: string[];
}

export interface SkillPromptContext {
	skillCatalog?: SkillCatalog;
	activatedSkillsPrompt?: string;
}

export type {
	SkillPickerItem,
	SkillPickerSource,
	SkillPickerTab,
} from "./SkillPickerTypes.ts";

/**
 * Owns skill discovery, picker state, remote import, selected-skill catalogs,
 * and per-turn activation prompt expansion.
 */
export class SkillController {
	private skillCatalog: SkillCatalog | undefined;
	private readonly selectedSkills = new Map<string, Skill>();
	private readonly pickerSkills = new Map<string, Skill>();
	private readonly skillsSh: SkillsShClient;
	private readonly pickerCache = new SkillPickerCache();

	constructor(private readonly deps: SkillControllerDeps) {
		this.skillsSh = deps.skillsSh ?? new SkillsShClient();
	}

	async buildPromptContext(text: string): Promise<SkillPromptContext> {
		return {
			skillCatalog: this.skillCatalog,
			activatedSkillsPrompt: await this.buildActivatedPrompt(text),
		};
	}

	async listSkillTabs(): Promise<SkillPickerTab[]> {
		const cached = this.pickerCache.get();
		if (cached) {
			this.restorePickerState(cached);
			this.emitPickerWarnings(cached);
			if (this.pickerCache.isStale(cached)) {
				void this.refreshPickerState().catch(() => undefined);
			}
			return cloneSkillPickerTabs(cached.tabs);
		}

		const state = await this.refreshPickerState();
		this.restorePickerState(state);
		this.emitPickerWarnings(state);
		return cloneSkillPickerTabs(state.tabs);
	}

	async preloadSkillTabs(): Promise<void> {
		try {
			await this.refreshPickerState();
		} catch {
			// User-triggered /skills will surface loading errors when needed.
		}
	}

	async selectSkill(
		item: SkillPickerItem,
		signal?: AbortSignal,
	): Promise<SkillLoadResult> {
		const skill =
			item.source === "skills-sh"
				? await this.importSkillsShSkill(item, signal)
				: this.pickerSkills.get(keyForItem(item));
		if (!skill) throw new Error(`Unknown skill: ${item.name}`);

		this.selectedSkills.set(skill.name, skill);
		const catalog = buildSkillCatalog([...this.selectedSkills.values()]);
		this.skillCatalog = catalog;
		for (const warning of catalog.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}
		return {
			selectedName: skill.name,
			loadedNames: catalog.skillNames,
		};
	}

	private itemsForSkills(
		source: Exclude<SkillPickerSource, "skills-sh">,
		skills: readonly Skill[],
		active = false,
		pickerSkills = this.pickerSkills,
	): SkillPickerItem[] {
		return skills.map((skill) => {
			const item: SkillPickerItem = {
				id: skill.name,
				name: skill.name,
				description: skill.description,
				source,
				active,
				detail: skill.path,
			};
			pickerSkills.set(keyForItem(item), skill);
			return item;
		});
	}

	private async refreshPickerState(): Promise<SkillPickerState> {
		return this.pickerCache.refresh(() => this.loadPickerState());
	}

	private async loadPickerState(): Promise<SkillPickerState> {
		const pickerSkills = new Map<string, Skill>();
		const [repo, personal] = await Promise.all([
			discoverSkills({
				cwd: this.deps.cwd,
				includeUserSkills: false,
			}),
			discoverSkills({
				cwd: this.deps.cwd,
				includeRepoSkills: false,
			}),
		]);

		const remote = await this.listSkillsShTab();
		const state: SkillPickerState = {
			expiresAt: Date.now() + SKILL_PICKER_CACHE_TTL_MS,
			pickerSkills,
			warnings: [...repo.warnings, ...personal.warnings],
			tabs: [
				{
					id: "repo",
					label: "Repo",
					items: this.itemsForSkills("repo", repo.skills, false, pickerSkills),
				},
				{
					id: "personal",
					label: "Personal",
					items: [
						...this.itemsForSkills(
							"personal",
							personal.skills,
							false,
							pickerSkills,
						),
						...this.itemsForSkills("repo", repo.skills, true, pickerSkills),
					],
				},
				remote,
			],
		};
		return state;
	}

	private restorePickerState(state: SkillPickerState): void {
		this.pickerSkills.clear();
		for (const [key, skill] of state.pickerSkills) {
			this.pickerSkills.set(key, skill);
		}
	}

	private emitPickerWarnings(state: SkillPickerState): void {
		for (const warning of state.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}
	}

	private async listSkillsShTab(): Promise<SkillPickerTab> {
		try {
			const skills = await this.skillsSh.refreshDirectory();
			return {
				id: "skills-sh",
				label: "skills.sh",
				items: skills.map((skill) => ({
					id: skill.id,
					name: skill.slug,
					description: skill.source,
					source: "skills-sh",
					detail: skill.url,
					installs: skill.installs,
				})),
			};
		} catch (err) {
			return {
				id: "skills-sh",
				label: "skills.sh",
				items: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async buildActivatedPrompt(text: string): Promise<string> {
		if (!this.skillCatalog) return "";
		const names = extractSkillInvocations(text, this.skillCatalog);
		return buildActivatedSkillsPrompt(this.skillCatalog, names);
	}

	private async importSkillsShSkill(
		item: SkillPickerItem,
		signal?: AbortSignal,
	): Promise<Skill> {
		const lockPath = path.join(this.deps.cwd, "skills-lock.json");
		const hadLockfile = existsSync(lockPath);
		await this.skillsSh.importSkill(item.id, this.deps.cwd, signal);
		await this.normalizeSkillsCliImport(item);
		if (!hadLockfile) await rm(lockPath, { force: true });

		const catalog = await discoverSkills({
			cwd: this.deps.cwd,
			includeUserSkills: false,
		});
		for (const warning of catalog.warnings) {
			this.deps.bus.emit({ type: "system:warning", message: warning });
		}

		const imported = catalog.get(item.name);
		if (!imported) {
			throw new Error(
				`Imported ${item.name}, but ${APP_DISPLAY_NAME} could not find it in this repo's .agents/skills.`,
			);
		}
		const pickerItem: SkillPickerItem = {
			id: imported.name,
			name: imported.name,
			description: imported.description,
			source: "repo",
			detail: imported.path,
		};
		this.pickerSkills.set(keyForItem(pickerItem), imported);
		return imported;
	}

	private async normalizeSkillsCliImport(item: SkillPickerItem): Promise<void> {
		const sourcePath = await skillsCliSkillPath(this.deps.cwd, item);
		if (!sourcePath || !existsSync(sourcePath)) return;

		const sourceDir = path.dirname(sourcePath);
		const targetDir = path.join(this.deps.cwd, ".agents", "skills", item.name);
		if (path.resolve(sourceDir) === path.resolve(targetDir)) return;
		if (existsSync(targetDir)) {
			await rm(sourceDir, { recursive: true, force: true });
			await removeEmptyDirectory(path.join(this.deps.cwd, "skills"));
			return;
		}

		await mkdir(path.dirname(targetDir), { recursive: true });
		await cp(sourceDir, targetDir, {
			recursive: true,
			errorOnExist: true,
			force: false,
		});
		await rm(sourceDir, { recursive: true, force: true });
		await removeEmptyDirectory(path.join(this.deps.cwd, "skills"));
	}
}

function keyForItem(item: SkillPickerItem): string {
	return `${item.source}:${item.id}`;
}

async function skillsCliSkillPath(
	cwd: string,
	item: SkillPickerItem,
): Promise<string | undefined> {
	const lockPath = path.join(cwd, "skills-lock.json");
	const fallback = insideCwd(cwd, path.join("skills", item.name, "SKILL.md"));
	if (!existsSync(lockPath)) return fallback;

	try {
		const raw = await readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.skills)) return fallback;

		const { source, slug } = splitSkillsShId(item.id);
		const entry = matchingLockEntry(parsed.skills, source, slug, item.name);
		const skillPath = isRecord(entry)
			? stringValue(entry.skillPath)
			: undefined;
		return skillPath ? insideCwd(cwd, skillPath) : fallback;
	} catch {
		return fallback;
	}
}

function matchingLockEntry(
	skills: Record<string, unknown>,
	source: string,
	slug: string,
	name: string,
): unknown {
	const direct = skills[name] ?? skills[slug];
	if (isRecord(direct) && stringValue(direct.source) === source) {
		return direct;
	}

	for (const [key, entry] of Object.entries(skills)) {
		if (!isRecord(entry)) continue;
		if (stringValue(entry.source) !== source) continue;
		const skillPath = stringValue(entry.skillPath);
		if (
			key === name ||
			key === slug ||
			pathSegments(skillPath).includes(name) ||
			pathSegments(skillPath).includes(slug)
		) {
			return entry;
		}
	}
	return undefined;
}

function insideCwd(cwd: string, relativePath: string): string | undefined {
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, relativePath);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathSegments(value: string | undefined): string[] {
	return value ? value.split(/[\\/]/).filter(Boolean) : [];
}

async function removeEmptyDirectory(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (err) {
		const code = isRecord(err) ? err.code : undefined;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
			throw err;
		}
	}
}
