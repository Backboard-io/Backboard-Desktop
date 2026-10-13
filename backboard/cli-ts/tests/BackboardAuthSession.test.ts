import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { logoutSavedCredentials } from "../src/core/auth/BackboardAuthSession.ts";

async function tempHome(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "backboard-auth-session-"));
}

describe("logoutSavedCredentials", () => {
	it("keeps connected subscriptions when signing out of Backboard", async () => {
		const homeDir = await tempHome();
		await saveBackboardConfig(
			{
				apiKey: "file-key",
				apiUrl: "https://app.backboard.io/api",
				chatgptSubscriptionAuthFile: path.join(homeDir, "auth.json"),
				claudeSubscriptionEnabled: true,
				model: { provider: "anthropic-subscription", model: "sonnet" },
			},
			homeDir,
		);

		await logoutSavedCredentials(homeDir);

		const config = readBackboardConfig(homeDir);
		expect({
			apiKey: config.apiKey,
			chatgpt: config.chatgptSubscriptionAuthFile,
			claude: config.claudeSubscriptionEnabled,
			model: config.model,
		}).toEqual({
			apiKey: undefined,
			chatgpt: path.join(homeDir, "auth.json"),
			claude: true,
			model: { provider: "anthropic-subscription", model: "sonnet" },
		});
	});

	it("removes the file when only Backboard credentials were saved", async () => {
		const homeDir = await tempHome();
		await saveBackboardConfig({ apiKey: "file-key" }, homeDir);

		await logoutSavedCredentials(homeDir);

		expect(await readdir(path.join(homeDir, ".backboard"))).toEqual([]);
	});
});

describe("saveBackboardConfig", () => {
	it("never exposes a partly written file to concurrent readers", async () => {
		const homeDir = await tempHome();
		const config = {
			claudeSubscriptionEnabled: true,
			successfulModels: Array.from({ length: 10 }, (_, index) => ({
				provider: "anthropic-subscription",
				model: `model-${index}-${"x".repeat(4_000)}`,
			})),
		};
		await saveBackboardConfig(config, homeDir);

		const writes = Array.from({ length: 25 }, () =>
			saveBackboardConfig(config, homeDir),
		);
		const reads: boolean[] = [];
		while (reads.length < 200) {
			reads.push(
				readBackboardConfig(homeDir).claudeSubscriptionEnabled === true,
			);
			await new Promise((resolve) => setImmediate(resolve));
		}
		await Promise.all(writes);

		expect({
			everyReadSawTheSubscription: reads.every(Boolean),
			leftovers: (await readdir(path.join(homeDir, ".backboard"))).filter(
				(name) => name !== "config.json",
			),
		}).toEqual({ everyReadSawTheSubscription: true, leftovers: [] });
	});
});
