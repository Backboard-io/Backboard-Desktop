import { describe, expect, it } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readBackboardConfig } from "../src/config/backboardConfig.ts";
import { jsonSchemaToZodRawShape } from "../src/providers/subscription/ClaudeJsonSchemaToZod.ts";
import {
	assertRecentClaudeSubscriptionLogin,
	buildClaudeSubscriptionEnv,
	CLAUDE_LOGIN_TRUST_MS,
	enableClaudeSubscription,
	findClaudeCodeExecutable,
	forgetClaudeSubscriptionLogin,
	isClaudeAiSubscriptionStatus,
} from "../src/providers/subscription/ClaudeSubscriptionAuth.ts";

describe("Claude subscription authentication", () => {
	it("strips API, OAuth, proxy, and cloud-provider overrides from the Claude subprocess", () => {
		const source = {
			PATH: "/usr/bin",
			HOME: "/tmp/home",
			ANTHROPIC_API_KEY: "api-key",
			ANTHROPIC_AUTH_TOKEN: "auth-token",
			ANTHROPIC_BASE_URL: "https://proxy.invalid",
			ANTHROPIC_PROFILE: "paid-api-profile",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_USE_FOUNDRY: "1",
			CLAUDE_CODE_USE_VERTEX: "1",
			CLAUDE_CONFIG_DIR: "/tmp/alternate-credentials",
			AWS_ACCESS_KEY_ID: "aws-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_SESSION_TOKEN: "aws-session",
			AWS_PROFILE: "aws-profile",
			GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
		};

		const sanitized = buildClaudeSubscriptionEnv(source);

		expect(sanitized).toEqual({
			PATH: "/usr/bin",
			HOME: "/tmp/home",
			CLAUDE_CONFIG_DIR: "/tmp/alternate-credentials",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			CLAUDE_AGENT_SDK_CLIENT_APP: "backboard-r-cli/3.0.2",
			CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
		});
		expect(source.ANTHROPIC_API_KEY).toBe("api-key");
	});

	it("accepts only an active first-party Claude.ai login", () => {
		const executable = "/usr/local/bin/claude";
		const classifications = [
			{
				status: {
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					executable,
				},
				expected: true,
			},
			{
				status: {
					loggedIn: true,
					authMethod: "CLAUDE.AI",
					apiProvider: "FIRSTPARTY",
					executable,
				},
				expected: true,
			},
			{
				status: {
					loggedIn: false,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					executable,
				},
				expected: false,
			},
			{
				status: {
					loggedIn: true,
					authMethod: "apiKey",
					apiProvider: "firstParty",
					executable,
				},
				expected: false,
			},
			{
				status: {
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "bedrock",
					executable,
				},
				expected: false,
			},
		];

		expect(
			classifications.map(({ status }) => isClaudeAiSubscriptionStatus(status)),
		).toEqual(classifications.map(({ expected }) => expected));
	});

	it("enables an existing Claude.ai login without spawning OAuth", async () => {
		if (process.platform === "win32") return;
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-sub-enable-"));
		const executable = path.join(homeDir, "claude");
		try {
			await writeFile(
				executable,
				'#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'\n',
			);
			await chmod(executable, 0o755);

			const message = await enableClaudeSubscription({ homeDir, executable });

			expect(message).toContain(executable);
			expect(readBackboardConfig(homeDir).claudeSubscriptionEnabled).toBe(true);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("asks Claude Code for its status once while a verified login is trusted", async () => {
		if (process.platform === "win32") return;
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-sub-trust-"));
		const executable = path.join(homeDir, "claude");
		const asked = path.join(homeDir, "asked");
		try {
			await writeFile(
				executable,
				`#!/bin/sh\necho x >> '${asked}'\nprintf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'\n`,
			);
			await chmod(executable, 0o755);
			const timesAsked = async () =>
				(await readFile(asked, "utf8").catch(() => "")).length / 2;
			const options = { homeDir, executable };

			await assertRecentClaudeSubscriptionLogin(options);
			await assertRecentClaudeSubscriptionLogin(options);
			const whileTrusted = await timesAsked();
			await assertRecentClaudeSubscriptionLogin({
				...options,
				now: Date.now() + CLAUDE_LOGIN_TRUST_MS,
			});
			const afterExpiry = await timesAsked();
			await forgetClaudeSubscriptionLogin(options);
			await assertRecentClaudeSubscriptionLogin(options);

			expect({
				whileTrusted,
				afterExpiry,
				afterForget: await timesAsked(),
			}).toEqual({ whileTrusted: 1, afterExpiry: 2, afterForget: 3 });
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("skips npm's postinstall stub for a Claude Code that can be spawned", async () => {
		if (process.platform === "win32") return;
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-sub-find-"));
		const stubDir = path.join(homeDir, "npm-global", "bin");
		const nativeDir = path.join(homeDir, ".local", "bin");
		const saved = {
			PATH: process.env.PATH,
			BACKBOARD_CLAUDE_CODE_PATH: process.env.BACKBOARD_CLAUDE_CODE_PATH,
		};
		try {
			await mkdir(stubDir, { recursive: true });
			await mkdir(nativeDir, { recursive: true });
			// What `bin/claude.exe` holds until the package's postinstall runs.
			await writeFile(
				path.join(stubDir, "claude"),
				'echo "Error: claude native binary not installed." >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			await writeFile(
				path.join(nativeDir, "claude"),
				'#!/bin/sh\necho "2.1.308 (Claude Code)"\n',
				{ mode: 0o755 },
			);
			process.env.PATH = stubDir;
			delete process.env.BACKBOARD_CLAUDE_CODE_PATH;

			expect(await findClaudeCodeExecutable({ homeDir })).toBe(
				path.join(nativeDir, "claude"),
			);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("never records a login that is not a Claude.ai subscription", async () => {
		if (process.platform === "win32") return;
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-sub-trust-"));
		const executable = path.join(homeDir, "claude");
		try {
			await writeFile(
				executable,
				'#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}\'\n',
			);
			await chmod(executable, 0o755);
			const options = { homeDir, executable };

			const outcomes = [
				await assertRecentClaudeSubscriptionLogin(options).then(
					() => "accepted",
					() => "refused",
				),
				await assertRecentClaudeSubscriptionLogin(options).then(
					() => "accepted",
					() => "refused",
				),
			];

			expect(outcomes).toEqual(["refused", "refused"]);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("Claude subscription JSON Schema bridge", () => {
	it("keeps agent_wait numeric bounds as JSON Schema numbers", () => {
		const shape = jsonSchemaToZodRawShape({
			type: "object",
			properties: {
				yield_time_ms: {
					type: "integer",
					description: "Milliseconds to wait before yielding",
					exclusiveMinimum: 0,
					maximum: 60_000,
				},
			},
			required: ["yield_time_ms"],
		});
		const serialized = zodToJsonSchema(z.object(shape), {
			target: "jsonSchema7",
			$refStrategy: "none",
		}) as Record<string, unknown>;
		const properties = serialized.properties as Record<
			string,
			Record<string, unknown>
		>;
		const wait = properties.yield_time_ms;

		expect({
			type: wait?.type,
			exclusiveMinimum: wait?.exclusiveMinimum,
			exclusiveMinimumType: typeof wait?.exclusiveMinimum,
			maximum: wait?.maximum,
			maximumType: typeof wait?.maximum,
			acceptsNumber: shape.yield_time_ms?.safeParse(1_000).success,
			acceptsBoolean: shape.yield_time_ms?.safeParse(true).success,
			acceptsExclusiveBound: shape.yield_time_ms?.safeParse(0).success,
		}).toEqual({
			type: "integer",
			exclusiveMinimum: 0,
			exclusiveMinimumType: "number",
			maximum: 60_000,
			maximumType: "number",
			acceptsNumber: true,
			acceptsBoolean: false,
			acceptsExclusiveBound: false,
		});
	});
});
