import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeSessionRestore } from "../src/entrypoints/ServeSessionRestore.ts";
import { Session } from "../src/core/session/Session.ts";
import { userMessage, assistantMessage } from "../src/core/session/Message.ts";
import type { AgentController } from "../src/core/agent/AgentController.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import { Compactor } from "../src/core/context/Compactor.ts";
import { Config } from "../src/config/Config.ts";
import type { SendMessageRequest } from "../src/providers/backboard/types.ts";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function root() {
	const path = await mkdtemp(join(tmpdir(), "restore-test-"));
	roots.push(path);
	return path;
}
function controller(session: Session) {
	return {
		pendingCompactionContext: undefined as string | undefined,
		hydrateSession(input: Parameters<AgentController["hydrateSession"]>[0]) {
			session.hydrate(input);
			this.pendingCompactionContext = input.pendingResume;
		},
		setModelContextLimit(limit: number | null) {
			session.setContextLimit(limit);
		},
	};
}
const model = { provider: "openai-subscription", model: "gpt-test" };
function client(): Pick<AgentClient, "getThread" | "listModels"> {
	return {
		async getThread(threadId: string) {
			return {
				thread_id: threadId,
				messages: [
					{
						message_id: "u",
						role: "user",
						content: "Original requirement: use blue",
					},
					{ message_id: "a", role: "assistant", content: "Blue selected" },
					{ message_id: "u", role: "user", content: "Then add a footer" },
					{ message_id: "a", role: "assistant", content: "Footer pending" },
				],
			};
		},
		async listModels() {
			return {
				models: [
					{
						name: model.model,
						provider: model.provider,
						context_limit: 272000,
						model_type: "llm",
					},
					{
						name: "smaller",
						provider: model.provider,
						context_limit: 32000,
						model_type: "llm",
					},
				],
				total: 2,
			};
		},
	};
}
describe("Studio compactor restoration", () => {
	it("fetches old provider history and includes it in the actual compaction request", async () => {
		const session = new Session("test");
		const c = controller(session);
		const api = client();
		await new ServeSessionRestore(session, c, api, await root()).prepare(
			"sub_old",
			model,
		);
		expect(session.getMessages()).toHaveLength(4);
		expect(session.reportedContextLimit).toBe(272000);
		let request: SendMessageRequest | undefined;
		const summarizer = {
			async sendMessage(req: SendMessageRequest) {
				request = req;
				return {
					thread_id: "summary",
					status: "COMPLETED",
					content: "## Objective\nUse blue\n## Current State\nFooter pending",
				};
			},
		};
		const result = await new Compactor({
			session,
			config: new Config({
				env: { apiKey: "test", apiUrl: "https://example.test" },
				argv: [],
			}),
			client: summarizer as unknown as AgentClient,
		}).compact();
		expect(request?.content).toContain("Original requirement: use blue");
		expect(result.resumeContext).toContain("Footer pending");
	});
	it("restores summaries, pending resume text, todos and usage across restart without duplicating history", async () => {
		const path = await root();
		const first = new Session("test");
		const c = controller(first);
		const api = client();
		first.threadId = "sub_new";
		first.addMessage(userMessage("Summary of older work"));
		first.addMessage(assistantMessage("Recent response"));
		first.setTodos([
			{ id: "footer", content: "Add footer", status: "pending" },
		]);
		first.addUsage({ contextTokens: 12345, contextLimit: 272000 });
		c.pendingCompactionContext = "Summary awaiting successful send";
		await new ServeSessionRestore(first, c, api, path).save(model);
		const second = new Session("test");
		const d = controller(second);
		const restore = new ServeSessionRestore(second, d, api, path);
		await restore.prepare("sub_new", model);
		await restore.prepare("sub_new", model);
		expect(second.getMessages()).toEqual(first.getMessages());
		expect(second.todos).toEqual(first.todos);
		expect(second.contextTokens).toBe(12345);
		expect(d.pendingCompactionContext).toBe(c.pendingCompactionContext);
		await restore.prepare("sub_new", { ...model, model: "smaller" });
		expect(second.reportedContextLimit).toBe(32000);
		await restore.prepare("sub_new", { ...model, model: "unknown" });
		expect(second.reportedContextLimit).toBeNull();
	});
	it("does not use a different thread's snapshot and does not adopt a failed restore", async () => {
		const path = await root();
		const first = new Session("test");
		first.threadId = "sub_a";
		first.addMessage(userMessage("Wrong thread"));
		await new ServeSessionRestore(
			first,
			controller(first),
			client(),
			path,
		).save(model);
		const second = new Session("test");
		await new ServeSessionRestore(
			second,
			controller(second),
			client(),
			path,
		).prepare("sub_b", model);
		expect(JSON.stringify(second.getMessages())).not.toContain("Wrong thread");
		const third = new Session("test");
		const api = client();
		api.getThread = async () => {
			throw new Error("unavailable");
		};
		await expect(
			new ServeSessionRestore(third, controller(third), api, path).prepare(
				"sub_c",
				model,
			),
		).rejects.toThrow("unavailable");
		expect(third.threadId).toBeNull();
	});
});
