// tests/PermissionResolve.test.ts
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	ALLOW_ALWAYS,
	ALLOW_ONCE,
	DENY,
	suggestRule,
} from "../src/core/permissions/PermissionPrompter.ts";
import {
	findMatch,
	type PermissionRule,
	parseRule,
	parseRuleSet,
} from "../src/core/permissions/PermissionRules.ts";
import {
	resolveToolPermission,
	resolveToolPermissions,
} from "../src/core/permissions/resolveToolPermission.ts";
import { loadPermissionSettings } from "../src/core/permissions/settings.ts";
import type { PermissionContext } from "../src/core/permissions/types.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";

const schema = z.object({ command: z.string() });
type Input = z.infer<typeof schema>;

class MutatingTool extends Tool<Input, null> {
	readonly name = "Mutate";
	readonly inputSchema = schema;
	override isReadOnly(): boolean {
		return false;
	}
	override permissionContent(input: Input): string {
		return input.command;
	}
	override async execute(
		_i: Input,
		_c: ToolContext,
	): Promise<ToolResult<null>> {
		return ok(null, "done", "done");
	}
}

async function tempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "perm-resolve-"));
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

function makeCtx(opts: {
	cwd: string;
	permissions: PermissionContext;
	answer?: string;
}): ToolContext {
	return {
		sessionId: "sess_test",
		cwd: opts.cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => opts.answer ?? DENY,
		permissions: opts.permissions,
	};
}

describe("suggestRule", () => {
	it("builds a two-token prefix rule for commands", () => {
		expect(suggestRule("execute", "cargo build --release")).toBe(
			"execute(cargo build:*)",
		);
		expect(suggestRule("execute", "tsc --noEmit")).toBe(
			"execute(tsc --noEmit:*)",
		);
	});
	it("persists interpreter invocations exactly, not as a prefix", () => {
		for (const command of [
			"bash -c ls",
			"sh -c ls",
			"python3 -c print(1)",
			"node -e 1",
			"bun test --watch",
			"npx cowsay hi",
			"env FOO=1 ls",
			"xargs rm",
			"make",
		]) {
			expect(suggestRule("execute", command)).toBe(`execute(${command})`);
		}
	});
	it("falls back to a bare tool rule without content", () => {
		expect(suggestRule("write", undefined)).toBe("write");
	});
	it("persists destructive commands exactly, not as a prefix", () => {
		expect(suggestRule("execute", "rm -rf ./build")).toBe(
			"execute(rm -rf ./build)",
		);
		expect(suggestRule("execute", "git push origin main")).toBe(
			"execute(git push origin main)",
		);
	});
	it("scopes file-tool grants to the exact path", () => {
		expect(suggestRule("write", "src/a.ts", true)).toBe("write(=src/a.ts)");
		expect(suggestRule("edit", "./x.txt", true)).toBe("edit(=./x.txt)");
	});
	it("scopes a multi-file patch to exactly those paths, not a prefix", () => {
		expect(suggestRule("apply_patch", "src/a.ts src/b.ts", true)).toBe(
			"apply_patch(=src/a.ts src/b.ts)",
		);
	});
	it("does not let a spaced path grant authorize a second path", () => {
		// The single path "src/file ../secret" arrives escaped; the two-path
		// list "src/file" + "../secret" does not. The grant must not cross over.
		const rule = parseRule(
			suggestRule("apply_patch", "src/file\\ ../secret", true),
			"allow",
		);
		expect(
			findMatch([rule as PermissionRule], "apply_patch", "src/file ../secret"),
		).toBeNull();
		expect(
			findMatch(
				[rule as PermissionRule],
				"apply_patch",
				"src/file\\ ../secret",
			),
		).not.toBeNull();
	});
	it("keeps extensionless paths exact, so a later path cannot ride along", () => {
		const rule = suggestRule("apply_patch", "src/a.ts README", true);
		expect(rule).toBe("apply_patch(=src/a.ts README)");
		expect(rule.endsWith(":*")).toBe(false);
		const parsed = parseRule(rule, "allow");
		expect(parsed?.pattern).toBe("=src/a.ts README");
		expect(
			findMatch([parsed as PermissionRule], "apply_patch", "src/a.ts README"),
		).not.toBeNull();
		expect(
			findMatch(
				[parsed as PermissionRule],
				"apply_patch",
				"src/a.ts README ../../outside",
			),
		).toBeNull();
	});
	it("keeps matcher metacharacters literal in path grants", () => {
		const rule = suggestRule("apply_patch", "src/a:*", true);
		expect(rule).toBe("apply_patch(=src/a:*)");
		const parsed = parseRule(rule, "allow");
		expect(
			findMatch([parsed as PermissionRule], "apply_patch", "src/a:*"),
		).not.toBeNull();
		expect(
			findMatch(
				[parsed as PermissionRule],
				"apply_patch",
				"src/a ../../outside",
			),
		).toBeNull();
	});
});

describe("resolveToolPermission", () => {
	const tool = new MutatingTool();

	it("allows when the engine allows (bypass)", async () => {
		const cwd = await tempProject();
		const ctx = makeCtx({
			cwd,
			permissions: {
				mode: "bypass",
				rules: parseRuleSet({}),
				interactive: true,
			},
		});
		const result = await resolveToolPermission(tool, { command: "rm x" }, ctx);
		expect(result.allowed).toBe(true);
	});

	it("auto-denies asks when not interactive (headless)", async () => {
		const cwd = await tempProject();
		const ctx = makeCtx({
			cwd,
			permissions: {
				mode: "manual",
				rules: parseRuleSet({}),
				interactive: false,
			},
		});
		const result = await resolveToolPermission(tool, { command: "rm x" }, ctx);
		expect(result.allowed).toBe(false);
		expect(result.denialReason).toContain("unavailable");
	});

	it("allow-once permits without persisting", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		const ctx = makeCtx({ cwd, permissions, answer: ALLOW_ONCE });
		const result = await resolveToolPermission(tool, { command: "bun x" }, ctx);
		expect(result.allowed).toBe(true);
		expect(permissions.rules.allow).toHaveLength(0);
		expect(loadPermissionSettings(cwd).allow).toEqual([]);
	});

	it("allow-always persists the rule and updates in-memory rules", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		const ctx = makeCtx({ cwd, permissions, answer: ALLOW_ALWAYS });
		const result = await resolveToolPermission(
			tool,
			{ command: "cargo build --release" },
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(permissions.rules.allow).toHaveLength(1);
		expect(loadPermissionSettings(cwd).allow).toEqual([
			"mutate(cargo build:*)",
		]);
	});

	it("prompts once for a batch and persists each exact always-rule scope", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		let prompts = 0;
		let question = "";
		const ctx = {
			...makeCtx({ cwd, permissions }),
			askUser: async (value: string) => {
				prompts++;
				question = value;
				return ALLOW_ALWAYS;
			},
		};

		const results = await resolveToolPermissions(
			[
				{ tool, input: { command: "cargo build --release" } },
				{ tool, input: { command: "cargo test --workspace" } },
				{ tool, input: { command: "rm generated.txt" } },
			],
			ctx,
		);

		expect({
			prompts,
			question,
			results,
			inMemory: permissions.rules.allow.map((rule) => rule.raw),
			persisted: loadPermissionSettings(cwd).allow,
		}).toEqual({
			prompts: 1,
			question: [
				"Allow these 3 actions?",
				"1. Mutate: cargo build --release",
				"2. Mutate: cargo test --workspace",
				"3. Mutate: rm generated.txt",
			].join("\n"),
			results: [{ allowed: true }, { allowed: true }, { allowed: true }],
			inMemory: [
				"mutate(cargo build:*)",
				"mutate(cargo test:*)",
				"mutate(rm generated.txt)",
			],
			persisted: [
				"mutate(cargo build:*)",
				"mutate(cargo test:*)",
				"mutate(rm generated.txt)",
			],
		});
	});

	it("deny answer reports the user's decision", async () => {
		const cwd = await tempProject();
		const ctx = makeCtx({
			cwd,
			permissions: {
				mode: "manual",
				rules: parseRuleSet({}),
				interactive: true,
			},
			answer: DENY,
		});
		const result = await resolveToolPermission(tool, { command: "rm x" }, ctx);
		expect(result.allowed).toBe(false);
		expect(result.denialReason).toBe("User denied permission for this action.");
	});

	it("serializes concurrent permission prompts", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		const pending: Array<(answer: string) => void> = [];
		let active = 0;
		let maxActive = 0;
		const ctx = {
			...makeCtx({ cwd, permissions }),
			askUser: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				const answer = await new Promise<string>((resolve) => {
					pending.push(resolve);
				});
				active--;
				return answer;
			},
		};

		const first = resolveToolPermission(tool, { command: "bun one" }, ctx);
		const second = resolveToolPermission(tool, { command: "bun two" }, ctx);
		await Bun.sleep(0);
		expect(pending).toHaveLength(1);
		pending.shift()?.(ALLOW_ONCE);
		await Bun.sleep(0);
		expect(pending).toHaveLength(1);
		pending.shift()?.(ALLOW_ONCE);

		expect(await Promise.all([first, second])).toEqual([
			{ allowed: true },
			{ allowed: true },
		]);
		expect(maxActive).toBe(1);
	});

	it("does not prompt queued calls after cancellation", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		const abort = new AbortController();
		const pending: Array<(answer: string) => void> = [];
		let promptCount = 0;
		const ctx = {
			...makeCtx({ cwd, permissions }),
			signal: abort.signal,
			askUser: async () => {
				promptCount++;
				return await new Promise<string>((resolve) => {
					pending.push(resolve);
				});
			},
		};

		const first = resolveToolPermission(tool, { command: "bun one" }, ctx);
		const second = resolveToolPermission(tool, { command: "bun two" }, ctx);
		await Bun.sleep(0);
		expect(promptCount).toBe(1);
		abort.abort();
		pending.shift()?.(ALLOW_ONCE);

		expect(await first).toEqual({ allowed: true });
		await expect(second).rejects.toThrow("aborted");
		expect(promptCount).toBe(1);
	});

	it("passes the tool signal to the active prompt", async () => {
		const cwd = await tempProject();
		const permissions: PermissionContext = {
			mode: "manual",
			rules: parseRuleSet({}),
			interactive: true,
		};
		const abort = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const ctx = {
			...makeCtx({ cwd, permissions }),
			signal: abort.signal,
			askUser: async (
				_question: string,
				_options: string[],
				signal?: AbortSignal,
			) => {
				receivedSignal = signal;
				return await new Promise<string>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				});
			},
		};

		const pending = resolveToolPermission(tool, { command: "bun one" }, ctx);
		await Bun.sleep(0);
		expect(receivedSignal).toBe(abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	it("allows everything when ctx.permissions is absent (gate disabled)", async () => {
		const cwd = await tempProject();
		const ctx = makeCtx({
			cwd,
			permissions: undefined as unknown as PermissionContext,
		});
		ctx.permissions = undefined;
		const result = await resolveToolPermission(tool, { command: "rm x" }, ctx);
		expect(result.allowed).toBe(true);
	});
});
