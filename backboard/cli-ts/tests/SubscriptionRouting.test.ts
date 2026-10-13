import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBackboardConfig } from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import { createAgentClient } from "../src/providers/createAgentClient.ts";

describe.skipIf(process.platform === "win32")(
	"Subscription routing lifecycle",
	() => {
		for (const provider of ["openai-subscription", "anthropic-subscription"]) {
			it(`connects, disconnects and reconnects ${provider} in an existing client`, async () => {
				const homeDir = await mkdtemp(join(tmpdir(), "subscription-routing-"));
				try {
					const config = new Config({
						homeDir,
						argv: ["--cwd", homeDir],
						env: { apiKey: "test-key", apiUrl: "https://example.invalid" },
					});
					config.auth.chatgptSubscription = null;
					config.auth.claudeSubscription = null;
					config.setModel({ provider, model: "default" });
					const client = createAgentClient(config);
					await expect(
						Promise.resolve().then(() => client.listAssistants()),
					).rejects.toThrow("No backend can serve");
					const login =
						provider === "openai-subscription"
							? { chatgptSubscriptionAuthFile: join(homeDir, "auth.json") }
							: { claudeSubscriptionEnabled: true };
					for (const connected of [true, false, true]) {
						await saveBackboardConfig(connected ? login : {}, homeDir);
						config.refreshAuth();
						if (connected) {
							expect(await client.listAssistants()).toEqual([]);
						} else {
							await expect(
								Promise.resolve().then(() => client.listAssistants()),
							).rejects.toThrow("No backend can serve");
						}
					}
				} finally {
					await rm(homeDir, { recursive: true, force: true });
				}
			});
		}
	},
);
