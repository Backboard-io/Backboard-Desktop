import { describe, expect, it } from "bun:test";
import {
	runKeysValidateCommand,
	validateProviderKey,
} from "../src/entrypoints/keysValidate.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { ByokError } from "../src/providers/byok/ByokError.ts";
import type { ProviderAdapter } from "../src/providers/byok/ByokTypes.ts";
import { scrubSecret } from "../src/providers/byok/scrubSecret.ts";

const KEY = "sk-test-1234567890abcdefghij";

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
	return {
		id: "openai",
		label: "OpenAI",
		consoleUrl: "https://example.test/keys",
		keyHint: "sk-...",
		looksLikeKey: (key) => key.startsWith("sk-"),
		validateKey: async () => undefined,
		listModels: async () => [
			{ name: "gpt-5.5", provider: "openai", model_type: "llm" },
		],
		supportsThinking: () => true,
		stream(): AsyncIterable<ProviderEvent> {
			throw new Error("not used");
		},
		...overrides,
	};
}

describe("validateProviderKey", () => {
	it("verifies the key and returns the reachable catalog", async () => {
		expect(
			await validateProviderKey({
				provider: "openai",
				key: ` ${KEY} `,
				adapter: adapter(),
			}),
		).toEqual({
			ok: true,
			provider: "openai",
			models: [{ name: "gpt-5.5", provider: "openai", model_type: "llm" }],
		});
	});

	it("rejects a malformed key before any network call", async () => {
		let called = false;
		const result = await validateProviderKey({
			provider: "openai",
			key: "nope",
			adapter: adapter({
				validateKey: async () => {
					called = true;
				},
			}),
		});
		expect(result).toMatchObject({ ok: false, category: "invalid-key" });
		expect(called).toBe(false);
	});

	it("categorizes vendor rejections and scrubs the key from the message", async () => {
		const rejected = await validateProviderKey({
			provider: "openai",
			key: KEY,
			adapter: adapter({
				validateKey: async () => {
					throw new ByokError(
						`OpenAI request failed (HTTP 401): Incorrect API key provided: ${KEY}`,
						"openai",
						401,
						null,
					);
				},
			}),
		});
		expect(rejected).toMatchObject({
			ok: false,
			category: "invalid-key",
			status: 401,
		});
		expect(JSON.stringify(rejected)).not.toContain(KEY);

		const forbidden = await validateProviderKey({
			provider: "openai",
			key: KEY,
			adapter: adapter({
				validateKey: async () => {
					throw new ByokError("forbidden", "openai", 403, null);
				},
			}),
		});
		expect(forbidden).toMatchObject({ category: "insufficient-permissions" });

		const limited = await validateProviderKey({
			provider: "openai",
			key: KEY,
			adapter: adapter({
				listModels: async () => {
					throw new ByokError("slow down", "openai", 429, null);
				},
			}),
		});
		expect(limited).toMatchObject({ category: "rate-limited", status: 429 });
	});

	it("treats a vendor that never answers as unreachable", async () => {
		const result = await validateProviderKey({
			provider: "openai",
			key: KEY,
			timeoutMs: 5,
			adapter: adapter({
				validateKey: (_key, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					}),
			}),
		});
		expect(result).toMatchObject({ ok: false, category: "offline-or-timeout" });
	});

	it("treats DNS and connection failures as unreachable", async () => {
		const result = await validateProviderKey({
			provider: "openai",
			key: KEY,
			adapter: adapter({
				validateKey: async () => {
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error("getaddrinfo"), {
							code: "ENOTFOUND",
						}),
					});
				},
			}),
		});
		expect(result).toMatchObject({ category: "offline-or-timeout" });
	});
});

describe("runKeysValidateCommand", () => {
	it("exits 2 for a usage error without reading the key", async () => {
		const errors: string[] = [];
		let read = false;
		const code = await runKeysValidateCommand(
			"cohere",
			async () => {
				read = true;
				return KEY;
			},
			() => undefined,
			(line) => errors.push(line),
		);
		expect(code).toBe(2);
		expect(read).toBe(false);
		expect(errors.join("")).toContain("--provider");
	});
});

describe("scrubSecret", () => {
	it("removes the known secret and anything shaped like a key", () => {
		expect(
			scrubSecret(`bad key ${KEY} and sk-ant-abcdefghijklmnopqrstuvwxyz0123`, KEY),
		).toBe("bad key <redacted> and <redacted>");
		expect(scrubSecret("AIzaSyA1234567890abcdefghijklmnop", undefined)).toBe(
			"<redacted>",
		);
		expect(scrubSecret("nothing to see", "abc")).toBe("nothing to see");
	});
});
