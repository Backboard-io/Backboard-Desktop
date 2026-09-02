import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackboardConfig } from "../src/config/backboardConfig.ts";
import {
	defaultSubscriptionAuthFile,
	loginWithChatGptSubscription,
	SubscriptionAuthManager,
} from "../src/providers/subscription/SubscriptionAuth.ts";

function jwt(payload: Record<string, unknown>): string {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"signature",
	].join(".");
}

describe("SubscriptionAuth", () => {
	it("refreshes an expiring token and atomically persists rotated tokens", async () => {
		const root = await mkdtemp(join(tmpdir(), "subscription-auth-"));
		const authFile = join(root, "auth.json");
		await writeFile(
			authFile,
			JSON.stringify({
				tokens: {
					access_token: jwt({ exp: 1, chatgpt_account_id: "account" }),
					refresh_token: "old-refresh",
					account_id: "account",
				},
			}),
		);
		const freshAccess = jwt({
			exp: 4_000_000_000,
			chatgpt_account_id: "account",
		});
		let refreshBody: Record<string, unknown> | undefined;
		const manager = new SubscriptionAuthManager({
			authFile,
			now: () => 2_000,
			fetchImpl: (async (_input, init) => {
				refreshBody = JSON.parse(String(init?.body));
				return Response.json({
					access_token: freshAccess,
					refresh_token: "new-refresh",
				});
			}) as typeof fetch,
		});

		expect((await manager.credentials()).accessToken).toBe(freshAccess);
		expect(refreshBody).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "old-refresh",
		});
		const saved = JSON.parse(await readFile(authFile, "utf8"));
		expect(saved.tokens.refresh_token).toBe("new-refresh");
		await rm(root, { recursive: true, force: true });
	});

	it("completes Backboard-native PKCE login without a Codex process", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "subscription-login-"));
		const accessToken = jwt({
			exp: 4_000_000_000,
			chatgpt_account_id: "native-account",
		});
		const fetchImpl = (async (input) => {
			if (String(input).includes("/oauth/token")) {
				return Response.json({
					access_token: accessToken,
					id_token: jwt({ chatgpt_account_id: "native-account" }),
					refresh_token: "native-refresh",
				});
			}
			return Response.json({
				models: [{ slug: "gpt-native", priority: 1 }],
			});
		}) as typeof fetch;
		let callbackResponse:
			| {
					body: string;
					cacheControl: string | null;
					referrerPolicy: string | null;
			  }
			| undefined;

		await loginWithChatGptSubscription({
			homeDir,
			fetchImpl,
			openBrowser: async (value) => {
				const authUrl = new URL(value);
				const callback = new URL(
					authUrl.searchParams.get("redirect_uri") ?? "",
				);
				callback.searchParams.set("code", "authorization-code");
				callback.searchParams.set(
					"state",
					authUrl.searchParams.get("state") ?? "",
				);
				const response = await fetch(callback);
				callbackResponse = {
					body: await response.text(),
					cacheControl: response.headers.get("cache-control"),
					referrerPolicy: response.headers.get("referrer-policy"),
				};
			},
		});

		const authFile = defaultSubscriptionAuthFile(homeDir);
		const saved = JSON.parse(await readFile(authFile, "utf8"));
		expect(saved.managed_by).toBe("backboard");
		expect(saved.tokens.account_id).toBe("native-account");
		expect(readBackboardConfig(homeDir)).toMatchObject({
			chatgptSubscriptionAuthFile: authFile,
			model: { provider: "openai-subscription", model: "gpt-native" },
		});
		expect(callbackResponse?.cacheControl).toBe("no-store");
		expect(callbackResponse?.referrerPolicy).toBe("no-referrer");
		expect(callbackResponse?.body).toContain(
			'history.replaceState(null, "", "/auth/complete")',
		);
		expect(callbackResponse?.body).toContain("window.close()");
		expect(callbackResponse?.body).toContain(
			'window.location.replace("https://backboard.io")',
		);
		expect(callbackResponse?.body).not.toContain("authorization-code");
		await rm(homeDir, { recursive: true, force: true });
	});
});
