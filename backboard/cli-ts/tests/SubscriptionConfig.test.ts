/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackboardConfig, saveBackboardConfig } from "../src/config/backboardConfig.ts";
import { subscriptionAuthPath, subscriptionConfigPath } from "../src/config/subscriptionConfig.ts";
import { defaultSubscriptionAuthFile, logoutChatGptSubscription } from "../src/providers/subscription/SubscriptionAuth.ts";
import { disconnectClaudeSubscription } from "../src/providers/subscription/ClaudeSubscriptionAuth.ts";

describe("Subscription config location", () => {
	it("stores connections beside IDE auth and clears each provider independently", async () => {
		const home = await mkdtemp(join(tmpdir(), "subscription-location-"));
		try {
			const sso = join(home, ".backboard_ide", "config.json");
			await mkdir(join(home, ".backboard_ide"));
			await writeFile(sso, '{"oauth":{"access_token":"sso-fixture"}}');
			const authFile = defaultSubscriptionAuthFile(home);
			await writeFile(authFile, '{"managed_by":"backboard"}');
			await saveBackboardConfig({ model: { provider: "openai-subscription", model: "auto" }, chatgptSubscriptionAuthFile: authFile, claudeSubscriptionEnabled: true }, home);
			expect({ path: authFile, subscriptions: JSON.parse(await readFile(subscriptionConfigPath(home), "utf8")), cli: JSON.parse(await readFile(join(home, ".backboard", "config.json"), "utf8")) }).toEqual({
				path: join(home, ".backboard_ide", "chatgpt-auth.json"), subscriptions: { chatgptSubscriptionAuthFile: authFile, claudeSubscriptionEnabled: true }, cli: { model: { provider: "openai-subscription", model: "auto" } },
			});
			await logoutChatGptSubscription(home);
			expect(readBackboardConfig(home).claudeSubscriptionEnabled).toBe(true);
			await disconnectClaudeSubscription({ homeDir: home });
			expect(JSON.parse(await readFile(subscriptionConfigPath(home), "utf8"))).toEqual({});
			expect(await readFile(sso, "utf8")).toBe('{"oauth":{"access_token":"sso-fixture"}}');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("moves legacy owned credentials and does not resurrect connections after the IDE folder is deleted", async () => {
		const home = await mkdtemp(join(tmpdir(), "subscription-migration-"));
		try {
			const oldConfig = join(home, ".backboard", "config.json");
			const oldAuth = join(home, ".backboard", "chatgpt-auth.json");
			await mkdir(join(home, ".backboard"));
			const credential = { managed_by: "backboard", tokens: { access_token: "fixture", refresh_token: "renewable", account_id: "account" } };
			await writeFile(oldAuth, JSON.stringify(credential));
			await writeFile(oldConfig, JSON.stringify({ chatgptSubscriptionAuthFile: oldAuth, claudeSubscriptionEnabled: true, verbose: true, customSetting: "preserved" }));
			expect(readBackboardConfig(home)).toMatchObject({ chatgptSubscriptionAuthFile: subscriptionAuthPath(home), claudeSubscriptionEnabled: true, verbose: true });
			expect(JSON.parse(await readFile(subscriptionAuthPath(home), "utf8"))).toEqual(credential);
			expect((await stat(subscriptionAuthPath(home))).mode & 0o777).toBe(0o600);
			await expect(stat(oldAuth)).rejects.toMatchObject({ code: "ENOENT" });
			expect(JSON.parse(await readFile(oldConfig, "utf8"))).toEqual({ verbose: true, customSetting: "preserved" });
			await rm(join(home, ".backboard_ide"), { recursive: true });
			expect({ chatgpt: readBackboardConfig(home).chatgptSubscriptionAuthFile, claude: readBackboardConfig(home).claudeSubscriptionEnabled }).toEqual({ chatgpt: undefined, claude: undefined });
			await expect(stat(join(home, ".backboard_ide"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("honors an explicit disconnect over legacy settings and leaves imported credentials alone", async () => {
		const home = await mkdtemp(join(tmpdir(), "subscription-import-"));
		try {
			const imported = join(home, "vendor-auth.json");
			await writeFile(imported, '{"tokens":{"access_token":"external-fixture"}}');
			await mkdir(join(home, ".backboard"));
			const oldConfig = join(home, ".backboard", "config.json");
			await writeFile(oldConfig, JSON.stringify({ chatgptSubscriptionAuthFile: imported }));
			expect(readBackboardConfig(home).chatgptSubscriptionAuthFile).toBe(imported);
			await logoutChatGptSubscription(home);
			await writeFile(oldConfig, JSON.stringify({ chatgptSubscriptionAuthFile: imported, claudeSubscriptionEnabled: true }));
			expect(readBackboardConfig(home).chatgptSubscriptionAuthFile).toBeUndefined();
			expect(readBackboardConfig(home).claudeSubscriptionEnabled).toBeUndefined();
			expect(await readFile(imported, "utf8")).toContain("external-fixture");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
