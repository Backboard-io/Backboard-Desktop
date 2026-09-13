// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModelRef } from "../config/defaults.ts";
import type { AgentController } from "../core/agent/AgentController.ts";
import type { Session } from "../core/session/Session.ts";
import type { AgentClient } from "../providers/AgentClient.ts";
import { backboardThreadToMessages } from "../providers/backboard/threads.ts";

const message = z.discriminatedUnion("role", [
	z.object({ role: z.literal("user"), text: z.string(), ts: z.string() }),
	z.object({
		role: z.literal("assistant"),
		text: z.string(),
		ts: z.string(),
		toolCalls: z.array(
			z
				.object({ id: z.string(), name: z.string(), input: z.unknown() })
				.transform((value) => ({ ...value, input: value.input })),
		),
	}),
	z.object({
		role: z.literal("tool"),
		ts: z.string(),
		results: z.array(
			z
				.object({
					toolCallId: z.string(),
					name: z.string(),
					output: z.unknown(),
					isError: z.boolean(),
				})
				.transform((value) => ({ ...value, output: value.output })),
		),
	}),
]);
const snapshotSchema = z.object({
	threadId: z.string(),
	assistantId: z.string().nullable(),
	model: z.string(),
	messages: z.array(message),
	todos: z.array(
		z.object({
			id: z.string(),
			content: z.string(),
			status: z.enum(["pending", "in_progress", "completed"]),
			activeForm: z.string().optional(),
		}),
	),
	contextTokens: z.number().nonnegative(),
	contextLimit: z.number().positive().nullable(),
	pendingResume: z.string().optional(),
});

/** Restores the compactor's projection independently of the IDE's visible chat. */
export class ServeSessionRestore {
	private saving: Promise<void> = Promise.resolve();
	private modelKey: string | undefined;
	private readonly file: string;
	constructor(
		private readonly session: Session,
		private readonly controller: Pick<
			AgentController,
			"hydrateSession" | "setModelContextLimit" | "pendingCompactionContext"
		>,
		private readonly client: Pick<AgentClient, "getThread" | "listModels">,
		root: string,
	) {
		this.file = join(root, "compaction-state.json");
	}
	async prepare(threadId: string | undefined, model: ModelRef): Promise<void> {
		const key = `${model.provider}/${model.model}`;
		if (threadId && this.session.threadId === null) {
			let snapshot: z.infer<typeof snapshotSchema> | undefined;
			try {
				snapshot = snapshotSchema.parse(
					JSON.parse(await readFile(this.file, "utf8")),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					throw new Error("Could not restore compaction state", {
						cause: error,
					});
			}
			if (snapshot?.threadId === threadId) {
				this.controller.hydrateSession({
					threadId,
					assistantId: snapshot.assistantId ?? undefined,
					messages: snapshot.messages,
					pendingResume: snapshot.pendingResume,
				});
				this.session.setTodos(snapshot.todos);
				this.session.addUsage({
					contextTokens: snapshot.contextTokens,
					...(snapshot.model === key && snapshot.contextLimit
						? { contextLimit: snapshot.contextLimit }
						: {}),
				});
			} else {
				const thread = await this.client.getThread(threadId);
				this.controller.hydrateSession({
					threadId: thread.thread_id,
					assistantId: thread.assistant_id,
					messages: backboardThreadToMessages(thread),
				});
			}
		}
		if (this.modelKey !== key) {
			this.controller.setModelContextLimit(null);
			// Catalog lookup is best-effort. Per-turn provider usage remains authoritative.
			try {
				const catalog = await this.client.listModels({
					signal: AbortSignal.timeout(10_000),
				});
				const entry = catalog.models.find(
					(item) =>
						item.provider === model.provider && item.name === model.model,
				);
				if (
					entry?.context_limit &&
					Number.isFinite(entry.context_limit) &&
					entry.context_limit > 0
				)
					this.controller.setModelContextLimit(entry.context_limit);
			} catch {
				/* ResolveContextWindow supplies the existing conservative fallback. */
			}
			this.modelKey = key;
		}
	}
	async save(model: ModelRef): Promise<void> {
		if (!this.session.threadId) return;
		const data = {
			threadId: this.session.threadId,
			assistantId: this.session.assistantId,
			model: `${model.provider}/${model.model}`,
			messages: this.session.getMessages(),
			todos: this.session.todos,
			contextTokens: this.session.contextTokens,
			contextLimit: this.session.reportedContextLimit,
			pendingResume: this.controller.pendingCompactionContext,
		};
		const serialized = JSON.stringify(data);
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await writeFile(`${this.file}.tmp`, serialized, { mode: 0o600 });
				await rename(`${this.file}.tmp`, this.file);
			});
		await this.saving;
	}
}
