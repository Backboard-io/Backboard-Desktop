import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config/Config.ts";
import { createAgentClient } from "../src/providers/createAgentClient.ts";
import { fetchModels } from "../src/providers/backboard/models.ts";
import { resolveAuth } from "../src/config/auth.ts";
import { readBackboardConfig, saveBackboardConfig } from "../src/config/backboardConfig.ts";
import { supportsSubscriptions } from "../src/config/releaseFeatures.ts";

describe("release subscription availability", () => {
	for (const args of [["subscription", "login"], ["subscription", "logout"], ["claude-subscription", "login"], ["claude-subscription", "enable"], ["claude-subscription", "logout"], ["claude-subscription", "status"]]) {
		it(`rejects ${args.join(" ")} before starting provider authentication`, () => {
			const result = Bun.spawnSync([process.execPath, "run", "src/entrypoints/cli.tsx", ...args], { timeout: 20_000 });
			expect({ code: result.exitCode, blocked: result.stderr.toString().includes("Subscriptions are currently unavailable") }).toEqual({ code: 1, blocked: true });
		}, 30_000);
	}

	it("ignores saved BYOS credentials without deleting history", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "backboard-windows-auth-"));
		try {
			await saveBackboardConfig({ chatgptSubscriptionAuthFile: join(homeDir, "auth.json"), claudeSubscriptionEnabled: true }, homeDir);
			const auth = resolveAuth({ homeDir, platform: "win32" });
			expect({ chatgpt: auth.chatgptSubscription, claude: auth.claudeSubscription, saved: readBackboardConfig(homeDir).claudeSubscriptionEnabled }).toEqual({ chatgpt: null, claude: null, saved: true });
		} finally {
			await rm(homeDir, { recursive: true });
		}
	});
	it("does not wire subscription transports even when live auth contains stale subscriptions", () => {
		const config = new Config({ argv: [], env: { apiKey: "test", apiUrl: "https://example.invalid" } });
		config.auth.chatgptSubscription = { authFile: "/never-read-this-credential-file" };
		config.auth.claudeSubscription = { enabled: true };
		const client = createAgentClient(config);
		for (const provider of ["openai-subscription", "anthropic-subscription"]) {
			expect(() => client.getModelThinkingMetadata(provider, "default")).toThrow("No backend can serve");
		}
	});

	it("omits subscription options from CLI help", () => {
		const result = Bun.spawnSync([process.execPath, "run", "src/entrypoints/cli.tsx", "--help"], { timeout: 20_000 });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().toLowerCase()).not.toContain("subscription");
	}, 30_000);
	it("ignores corrupt disabled subscription storage", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "backboard-disabled-subs-"));
		try {
			await mkdir(join(homeDir, ".backboard_ide"));
			await writeFile(join(homeDir, ".backboard_ide", "subscriptions.json"), "invalid json");
			for (const platform of ["win32", "darwin", "linux"] as const) {
				const auth = resolveAuth({ homeDir, platform });
				expect([auth.chatgptSubscription, auth.claudeSubscription]).toEqual([null, null]);
			}
		} finally { await rm(homeDir, { recursive: true }); }
	});
	it("filters subscriptions from fresh and cached catalogs", async () => {
		let calls = 0;
		const client = { listModels: async () => {
			calls++;
			return { total: 3, models: [
				{ provider: "openai-subscription", name: "auto", model_type: "llm" },
				{ provider: "anthropic-subscription", name: "default", model_type: "llm" },
				{ provider: "openai", name: "gpt-5.5", model_type: "llm" },
			] };
		} };
		for (let i = 0; i < 2; i++) {
			expect((await fetchModels(client)).map(model => model.provider)).toEqual(["openai"]);
		}
		expect(calls).toBe(1);
	});

	it("disables BYOS on every platform", () => {
		expect([supportsSubscriptions("win32"), supportsSubscriptions("darwin"), supportsSubscriptions("linux")]).toEqual([false, false, false]);
	});
});
