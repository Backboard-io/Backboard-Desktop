import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	buildSkillCatalog,
	discoverSkills,
	extractSkillInvocations,
	loadSkillFromMarkdown,
	parseSkillsShHtml,
	SkillsShClient,
	type SkillsShListItem,
	splitSkillsShId,
} from "../src/core/skills/index.ts";
import { SkillCatalog } from "../src/core/skills/SkillCatalog.ts";
import { SkillController } from "../src/core/skills/SkillController.ts";
import { npxCommand } from "../src/core/skills/skillsSh.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";
import { buildActivatedSkillsPrompt } from "../src/prompts/system/skills.tsx";
import {
	installedSkillCount,
	orderSkillTabs,
} from "../src/ui/components/SkillsSelector.tsx";

describe("skills", () => {
	it("discovers repo skills from cwd up to repo root before user skills", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		const nested = path.join(root, "packages", "app");
		await mkdir(nested, { recursive: true });
		await writeSkill(root, "shared", "repo shared", "root body");
		await writeSkill(nested, "local", "local skill", "local body");

		const home = await tempDir();
		await writeSkill(
			home,
			"shared",
			"user shared",
			"user body",
			".agents/skills",
		);

		const catalog = await discoverSkills({ cwd: nested, homeDir: home });

		expect(catalog.get("local")?.body).toBe("local body");
		expect(catalog.get("shared")?.body).toBe("root body");
		expect(catalog.warnings.some((w) => w.includes("duplicate skill"))).toBe(
			true,
		);
	});

	it("skips malformed skills and name/directory mismatches with warnings", () => {
		const malformed = loadSkillFromMarkdown(
			"no frontmatter",
			"bad",
			"/tmp/bad/SKILL.md",
			"repo",
		);
		const mismatch = loadSkillFromMarkdown(
			skillMarkdown("other", "desc", "body"),
			"actual",
			"/tmp/actual/SKILL.md",
			"repo",
		);

		expect(malformed.skill).toBeUndefined();
		expect(malformed.warning).toContain("missing YAML frontmatter");
		expect(mismatch.skill).toBeUndefined();
		expect(mismatch.warning).toContain("name must match directory");
	});

	it("shortens descriptions before omitting skills from a small catalog budget", () => {
		const skills = Array.from({ length: 10 }, (_, index) =>
			expectSkill(
				loadSkillFromMarkdown(
					skillMarkdown(
						`skill-${index}`,
						`${"long ".repeat(80)}${index}`,
						"body",
					),
					`skill-${index}`,
					`/tmp/skill-${index}/SKILL.md`,
					"repo",
				),
			),
		);

		const catalog = buildSkillCatalog(skills, { budget: 260 });

		expect(catalog.promptCatalog.length).toBeLessThanOrEqual(260);
		expect(catalog.promptCatalog).toContain("...");
		expect(catalog.omittedFromPrompt.length).toBeGreaterThan(0);
		expect(catalog.warnings.some((w) => w.includes("omitted"))).toBe(true);
	});

	it("builds activated skill prompt with its body and bundled file list only", async () => {
		const root = await tempDir();
		await writeSkill(root, "docs", "doc skill", "Read references as needed.");
		await mkdir(path.join(root, ".agents", "skills", "docs", "references"), {
			recursive: true,
		});
		await writeFile(
			path.join(root, ".agents", "skills", "docs", "references", "api.md"),
			"secret reference body",
		);

		const catalog = await discoverSkills({
			cwd: root,
			homeDir: await tempDir(),
		});
		const prompt = await buildActivatedSkillsPrompt(catalog, ["docs"]);

		expect(prompt).toContain("Read references");
		expect(prompt).toContain("references/api.md");
		expect(prompt).toContain(
			`Bundled files (relative to ${path.join(root, ".agents", "skills", "docs")})`,
		);
		expect(prompt).not.toContain("secret reference body");
	});

	it("extracts explicit known skill invocations", () => {
		const catalog = new SkillCatalog(
			[skill("react", "react skill"), skill("docs", "docs skill")],
			"- react: react skill\n- docs: docs skill",
			[],
			[],
		);

		expect(
			extractSkillInvocations(
				"Use $react, ignore $missing, then $docs.",
				catalog,
			),
		).toEqual(["react", "docs"]);
		expect(extractSkillInvocations("$react then $react", catalog)).toEqual([
			"react",
		]);
	});

	it("parses public skills.sh listing links", () => {
		const items = parseSkillsShHtml(`
			<a href="/vercel-labs/agent-skills/frontend-design">
				1 frontend-design vercel-labs/agent-skills 535.9K
			</a>
			<a href="/docs">Docs</a>
			<a href="/agent/claude-code">Claude Code</a>
			<a href="/open.feishu.cn/lark-approval">
				69 lark-approval open.feishu.cn 217.0K
			</a>
		`);

		expect(items).toEqual([
			{
				id: "vercel-labs/agent-skills/frontend-design",
				slug: "frontend-design",
				name: "frontend-design",
				source: "vercel-labs/agent-skills",
				installs: "535.9K",
				url: "https://skills.sh/vercel-labs/agent-skills/frontend-design",
			},
			{
				id: "open.feishu.cn/lark-approval",
				slug: "lark-approval",
				name: "lark-approval",
				source: "open.feishu.cn",
				installs: "217.0K",
				url: "https://skills.sh/open.feishu.cn/lark-approval",
			},
		]);
		expect(splitSkillsShId("owner/repo/react-helper")).toEqual({
			source: "owner/repo",
			slug: "react-helper",
		});
	});

	it("orders skills.sh first only when no local skills are installed", () => {
		const remote = {
			id: "skills-sh" as const,
			label: "skills.sh",
			items: [
				{
					id: "owner/repo/find-skills",
					name: "find-skills",
					description: "owner/repo",
					source: "skills-sh" as const,
					installs: "2.2M",
				},
			],
		};
		const repo = {
			id: "repo" as const,
			label: "Repo",
			items: [],
		};
		const personal = {
			id: "personal" as const,
			label: "Personal",
			items: [],
		};

		expect(
			orderSkillTabs([repo, personal, remote]).map((tab) => tab.id),
		).toEqual(["skills-sh", "repo", "personal"]);
		expect(installedSkillCount([repo, personal, remote])).toBe(0);

		const installedRepo = {
			...repo,
			items: [
				{
					id: "local",
					name: "local",
					description: "local skill",
					source: "repo" as const,
				},
			],
		};
		expect(
			orderSkillTabs([installedRepo, personal, remote]).map((tab) => tab.id),
		).toEqual(["repo", "personal", "skills-sh"]);
		expect(installedSkillCount([installedRepo, personal, remote])).toBe(1);

		const activeRepoInPersonal = {
			...personal,
			items: [
				{
					id: "local",
					name: "local",
					description: "local skill",
					source: "repo" as const,
					active: true,
				},
			],
		};
		expect(
			installedSkillCount([installedRepo, activeRepoInPersonal, remote]),
		).toBe(1);
	});

	it("caches skills.sh directory responses", async () => {
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = (async (input) => {
			urls.push(String(input));
			return new Response(
				'<a href="/vercel-labs/agent-skills/frontend-design">frontend-design 1K</a>',
			);
		}) as typeof fetch;
		try {
			const client = new SkillsShClient();
			const first = await client.listDirectory();
			const second = await client.listDirectory();

			expect(first).toEqual(second);
			expect(urls.length).toBe(4);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("preloads skill tabs and reuses the picker cache", async () => {
		const root = await tempDir();
		await writeSkill(root, "preloaded", "cached skill", "body");
		const skillsSh = new CountingSkillsShClient();
		const controller = new SkillController({
			cwd: root,
			bus: new EventBus(),
			skillsSh,
		});

		await controller.preloadSkillTabs();
		await writeSkill(root, "newer", "new skill", "body");
		const tabs = await controller.listSkillTabs();

		const repoNames = tabs
			.find((tab) => tab.id === "repo")
			?.items.map((item) => item.name);
		expect(repoNames).toEqual(["preloaded"]);
		expect(skillsSh.refreshCalls).toBe(1);
	});

	it("times out hanging skills.sh directory requests", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			});
		}) as typeof fetch;
		try {
			const client = new SkillsShClient({ listTimeoutMs: 10 });

			await expect(client.listDirectory()).rejects.toThrow(
				"skills.sh request timed out",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("times out hanging skills.sh imports", async () => {
		const root = await tempDir();
		const bin = path.join(root, "bin");
		await mkdir(bin);
		await writeFakeNpx(bin, "setTimeout(() => {}, 10_000);\n");

		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
		try {
			const client = new SkillsShClient({ importTimeoutMs: 10 });

			await expect(
				client.importSkill("owner/repo/example", root),
			).rejects.toThrow("skills import timed out");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("launches npx.cmd through cmd.exe on Windows", () => {
		const args = ["-y", "skills", "add", "owner/repo"];

		expect(npxCommand(args, "win32")).toEqual({
			file: "cmd.exe",
			args: ["/d", "/c", "npx.cmd -y skills add owner/repo"],
		});
		expect(npxCommand(args, "linux")).toEqual({
			file: "npx",
			args,
		});
		expect(() => npxCommand(["bad&calc"], "win32")).toThrow(
			"Unsafe npx argument",
		);
	});

	it("rejects unsafe skills.sh ids", () => {
		expect(
			parseSkillsShHtml(
				'<a href="/owner/repo/good-skill">good-skill 1K</a><a href="/owner/repo/bad%26calc">bad 1K</a>',
			).map((item) => item.id),
		).toEqual(["owner/repo/good-skill"]);
		expect(() => splitSkillsShId("owner/repo/bad&calc")).toThrow(
			"Invalid skills.sh skill id",
		);
		expect(() => splitSkillsShId("../outside/good")).toThrow(
			"Invalid skills.sh skill id",
		);
		expect(
			parseSkillsShHtml(
				'<a href="/%2E%2E/outside/good">good 1K</a><a href="/owner/repo/%2E">dot 1K</a>',
			),
		).toEqual([]);
	});

	it("normalizes skills.sh imports into the repo skill root", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		const bin = path.join(root, "bin");
		await mkdir(bin);
		await writeFakeNpx(
			bin,
			`
const { mkdirSync, writeFileSync } = require("node:fs");
mkdirSync("skills/remote-path", { recursive: true });
writeFileSync("skills/remote-path/SKILL.md", \`---
name: remote-skill
description: remote desc
---
remote body
\`);
writeFileSync("skills-lock.json", \`{
	"version": 1,
	"skills": {
		"remote-skill": {
			"source": "owner/repo",
			"sourceType": "github",
			"skillPath": "skills/remote-path/SKILL.md",
			"computedHash": "hash"
		}
	}
}
\`);
`,
		);

		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
		try {
			const controller = new SkillController({
				cwd: root,
				bus: new EventBus(),
			});

			const result = await controller.selectSkill({
				id: "owner/repo/remote-skill",
				name: "remote-skill",
				description: "owner/repo",
				source: "skills-sh",
			});

			expect(result.selectedName).toBe("remote-skill");
			const promptContext =
				await controller.buildPromptContext("$remote-skill");
			expect(promptContext.activatedSkillsPrompt).toContain("remote body");
			expect(
				existsSync(
					path.join(root, ".agents", "skills", "remote-skill", "SKILL.md"),
				),
			).toBe(true);
			expect(existsSync(path.join(root, "skills-lock.json"))).toBe(false);
			expect(existsSync(path.join(root, "skills"))).toBe(false);

			await controller.selectSkill({
				id: "owner/repo/remote-skill",
				name: "remote-skill",
				description: "owner/repo",
				source: "skills-sh",
			});

			expect(existsSync(path.join(root, "skills-lock.json"))).toBe(false);
			expect(existsSync(path.join(root, "skills"))).toBe(false);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("follows symlinked skill directories", async () => {
		const root = await tempDir();
		const target = path.join(root, "target-skill");
		await mkdir(target, { recursive: true });
		await writeFile(
			path.join(target, "SKILL.md"),
			skillMarkdown("linked", "linked desc", "linked body"),
		);
		const skillsRoot = path.join(root, ".agents", "skills");
		await mkdir(skillsRoot, { recursive: true });
		try {
			await symlink(target, path.join(skillsRoot, "linked"), "dir");
		} catch {
			return;
		}

		const catalog = await discoverSkills({
			cwd: root,
			homeDir: await tempDir(),
		});

		expect(catalog.get("linked")?.body).toBe("linked body");
	});

	it("changes the system prompt when the skill catalog changes", () => {
		const first = getSystemPrompt({
			skillCatalog: new SkillCatalog(
				[skill("one", "first")],
				"- one: first",
				[],
				[],
			),
		});
		const second = getSystemPrompt({
			skillCatalog: new SkillCatalog(
				[skill("two", "second")],
				"- two: second",
				[],
				[],
			),
		});

		expect(first).not.toBe(second);
	});
});

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "q-cli-skills-"));
}

class CountingSkillsShClient extends SkillsShClient {
	refreshCalls = 0;

	override async refreshDirectory(
		_signal?: AbortSignal,
	): Promise<SkillsShListItem[]> {
		this.refreshCalls += 1;
		return [];
	}
}

async function writeFakeNpx(bin: string, script: string): Promise<void> {
	const scriptPath = path.join(bin, "fake-npx.js");
	await writeFile(scriptPath, script);
	if (process.platform === "win32") {
		await writeFile(
			path.join(bin, "npx.cmd"),
			`@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
		);
		return;
	}

	const shim = path.join(bin, "npx");
	await writeFile(
		shim,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
	);
	await chmod(shim, 0o755);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeSkill(
	root: string,
	name: string,
	description: string,
	body: string,
	skillsPath = ".agents/skills",
): Promise<void> {
	const dir = path.join(root, skillsPath, name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "SKILL.md"),
		skillMarkdown(name, description, body),
	);
}

function skillMarkdown(
	name: string,
	description: string,
	body: string,
	extra = "",
): string {
	const extraBlock = extra ? `${extra}\n` : "";
	return `---
name: ${name}
description: ${description}
${extraBlock}---
${body}
`;
}

function expectSkill(result: ReturnType<typeof loadSkillFromMarkdown>) {
	if (!result.skill) throw new Error(result.warning ?? "missing skill");
	return result.skill;
}

function skill(name: string, description: string) {
	return expectSkill(
		loadSkillFromMarkdown(
			skillMarkdown(name, description, "body"),
			name,
			`/tmp/${name}/SKILL.md`,
			"repo",
		),
	);
}
