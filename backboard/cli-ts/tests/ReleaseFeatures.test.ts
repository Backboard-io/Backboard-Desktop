import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuth } from "../src/config/auth.ts";
import { readBackboardConfig, saveBackboardConfig } from "../src/config/backboardConfig.ts";
import { supportsSubscriptions } from "../src/config/releaseFeatures.ts";

describe("release subscription availability", () => {
	it.skipIf(process.platform !== "win32")("rejects BYOS login commands before starting provider authentication", () => {
		for (const args of [["subscription", "login"], ["claude-subscription", "login"], ["claude-subscription", "enable"]]) {
			const result = Bun.spawnSync([process.execPath, "run", "src/entrypoints/cli.tsx", ...args]);
			expect({ code: result.exitCode, blocked: result.stderr.toString().includes("BYOS subscriptions are not supported on Windows") }).toEqual({ code: 1, blocked: true });
		}
	});
	it("ignores saved BYOS credentials on Windows without deleting them", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "backboard-windows-auth-"));
		try {
			await saveBackboardConfig({ chatgptSubscriptionAuthFile: join(homeDir, "auth.json"), claudeSubscriptionEnabled: true }, homeDir);
			const auth = resolveAuth({ homeDir, platform: "win32" });
			expect({ chatgpt: auth.chatgptSubscription, claude: auth.claudeSubscription, saved: readBackboardConfig(homeDir).claudeSubscriptionEnabled }).toEqual({ chatgpt: null, claude: null, saved: true });
		} finally {
			await rm(homeDir, { recursive: true });
		}
	});
	it("disables BYOS on Windows while preserving existing Mac support", () => {
		expect([supportsSubscriptions("win32"), supportsSubscriptions("darwin"), supportsSubscriptions("linux")]).toEqual([false, true, true]);
	});
});
