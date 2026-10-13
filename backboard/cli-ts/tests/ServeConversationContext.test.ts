// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServeConversationContext } from "../src/entrypoints/serveConversationContext.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";

const directories: string[] = [];
async function temporarySession(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "serve-handoff-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Studio conversation handoff", () => {
	it("preserves small handoffs and independent system context without archiving", async () => {
		const root = await temporarySession();
		expect(
			await buildServeConversationContext(undefined, undefined, root),
		).toBeUndefined();
		expect(
			await buildServeConversationContext(undefined, "Plan mode", root),
		).toBe("Plan mode");
		expect(
			await buildServeConversationContext(
				"x".repeat(64_000),
				"Plan mode",
				root,
			),
		).toBe(`${"x".repeat(64_000)}\n\nPlan mode`);
		expect(await readdir(root)).toEqual([]);
	});

	it("bounds a long Backboard chat when switching to Codex with a tiny new prompt", async () => {
		const root = await temporarySession();
		const transcript = [
			"The user changed model providers while keeping this chat.",
			"<prior_conversation_json>",
			JSON.stringify([
				{
					user: "Build a dashboard. Keep the original requirements.",
					assistant: "Starting the dashboard.",
				},
				{
					user: "Inspect the build output",
					assistant: "Inspected",
					tools: [{ output: "x".repeat(2_524_125) }],
				},
				{
					user: "Use a blue header",
					assistant: "The header is blue; next add a footer.",
				},
			]),
			"</prior_conversation_json>",
		].join("\n");
		const context = await buildServeConversationContext(
			transcript,
			"Keep plan mode enabled.",
			root,
		);
		expect(context!.length).toBeLessThan(64_000);
		expect(context).toContain("original requirements");
		expect(context).toContain("next add a footer");
		expect(context).toContain("middle was omitted");
		expect(context).toEndWith("Keep plan mode enabled.");
		const archiveDirectory = join(root, "conversation-handoffs");
		const archives = await readdir(archiveDirectory);
		expect(archives).toHaveLength(1);
		const archive = join(archiveDirectory, archives[0]!);
		expect(await readFile(archive, "utf8")).toBe(transcript);
		expect(context).toContain(archive);
		if (process.platform !== "win32")
			expect((await stat(archive)).mode & 0o777).toBe(0o600);
		// Repeat the IDE's persistent handoff after a restart/later turn.
		expect(
			await buildServeConversationContext(
				transcript,
				"Keep plan mode enabled.",
				root,
			),
		).toBe(context);
		expect(await readdir(archiveDirectory)).toEqual(archives);

		const authFile = join(root, "auth.json");
		await writeFile(
			authFile,
			JSON.stringify({
				tokens: { access_token: "test-token", account_id: "test-account" },
			}),
		);
		const requests: {
			instructions: string;
			input: {
				type: string;
				role?: string;
				content?: { type: string; text: string }[];
			}[];
		}[] = [];
		const client = new CodexSubscriptionClient({
			authFile,
			fetchImpl: (async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				requests.push(body);
				if (body.instructions.length > 1_048_576)
					return new Response("instructions too long", { status: 400 });
				return new Response(
					'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}) as typeof fetch,
		});
		const systemPrompt = getSystemPrompt({ conversationContext: context });
		const response = await client.sendMessage({
			content: "continue",
			model_name: "gpt-test",
			system_prompt: systemPrompt,
		});
		await client.sendMessage({
			thread_id: response.thread_id,
			content: "next",
			model_name: "gpt-test",
			system_prompt: systemPrompt,
		});
		expect(response.status).toBe("COMPLETED");
		expect(requests.map((request) => request.instructions.length)).toEqual([
			systemPrompt.length,
			systemPrompt.length,
		]);
		expect(systemPrompt.length).toBeLessThan(100_000);
		expect(requests[1]!.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "continue" }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "next" }],
			},
		]);
	});

	it("keeps Unicode intact at excerpt boundaries and fails if history cannot be archived", async () => {
		const root = await temporarySession();
		const history = `${"a".repeat(7_999)}😀${"b".repeat(20_000)}😀${"c".repeat(47_999)}`;
		const context = await buildServeConversationContext(
			history,
			undefined,
			root,
		);
		expect(context!.isWellFormed()).toBe(true);
		const invalidRoot = join(root, "file");
		await writeFile(invalidRoot, "not a directory");
		await expect(
			buildServeConversationContext(history, undefined, invalidRoot),
		).rejects.toThrow();
	});
});
