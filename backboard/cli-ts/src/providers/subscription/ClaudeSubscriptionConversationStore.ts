import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { qSessionDir } from "../../config/paths.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { ensureDir, renameOver } from "../../utils/fs.ts";
import type { StoredSubscriptionMessage } from "./SubscriptionConversationStore.ts";

const FILE_NAME = "claude-subscription-conversation.json";
const LOCK_FILE_NAME = "claude-subscription-conversation.lock";
const SCHEMA_VERSION = 1;

export interface StoredClaudeSubscriptionConversation {
	version: typeof SCHEMA_VERSION;
	revision: number;
	threadId: string;
	claudeSessionId: string;
	sessionId: string;
	sessionRoot: string;
	model: string;
	systemPrompt: string;
	createdAt: string;
	updatedAt: string;
	messages: StoredSubscriptionMessage[];
	memoryContext?: string;
}

/** Durable Backboard metadata for a Claude-owned transcript. */
export class ClaudeSubscriptionConversationStore {
	constructor(private readonly baseDir: string) {}

	async save(
		conversation: StoredClaudeSubscriptionConversation,
		expectedRevision: number,
		replacesThreadId?: string,
	): Promise<number> {
		const sessionRoot = qSessionDir(this.baseDir, conversation.sessionId);
		const file = this.pathFor(sessionRoot);
		await ensureDir(sessionRoot, 0o700);
		await chmod(sessionRoot, 0o700).catch(() => undefined);
		const lease = await acquireFileLease(join(sessionRoot, LOCK_FILE_NAME), {
			label: `Claude subscription conversation ${conversation.threadId}`,
			timeoutMs: 5_000,
			retryMs: 50,
			invalidOwnerStaleMs: 5_000,
		});
		try {
			const existing = await this.read(file);
			if (
				existing &&
				existing.threadId !== conversation.threadId &&
				existing.threadId !== replacesThreadId
			) {
				throw new Error(
					`Session ${conversation.sessionId} is already owned by Claude subscription conversation ${existing.threadId}.`,
				);
			}
			const actualRevision = existing?.revision ?? 0;
			if (actualRevision !== expectedRevision) {
				throw new Error(
					`Claude subscription conversation ${conversation.threadId} changed in another process. Resume it again before sending more messages.`,
				);
			}
			const revision = actualRevision + 1;
			const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
			try {
				await writeFile(
					temporary,
					`${JSON.stringify(
						{
							...conversation,
							version: SCHEMA_VERSION,
							revision,
							sessionRoot,
						},
						null,
						2,
					)}\n`,
					{ mode: 0o600 },
				);
				await chmod(temporary, 0o600).catch(() => undefined);
				await renameOver(temporary, file);
				await chmod(file, 0o600).catch(() => undefined);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			return revision;
		} finally {
			await lease.release();
		}
	}

	async get(
		threadId: string,
	): Promise<StoredClaudeSubscriptionConversation | null> {
		return (
			(await this.list()).find((entry) => entry.threadId === threadId) ?? null
		);
	}

	async getAtSessionRoot(
		sessionRoot: string,
		threadId: string,
	): Promise<StoredClaudeSubscriptionConversation | null> {
		const stored = await this.read(this.pathFor(sessionRoot));
		if (
			!stored ||
			stored.threadId !== threadId ||
			basename(sessionRoot) !== stored.sessionId
		) {
			return null;
		}
		return { ...stored, sessionRoot };
	}

	/** Whichever conversation holds this session's slot, if any. */
	async currentAtSessionRoot(
		sessionRoot: string,
	): Promise<StoredClaudeSubscriptionConversation | null> {
		const stored = await this.read(this.pathFor(sessionRoot));
		return stored && basename(sessionRoot) === stored.sessionId
			? { ...stored, sessionRoot }
			: null;
	}

	async list(): Promise<StoredClaudeSubscriptionConversation[]> {
		const root = dirname(qSessionDir(this.baseDir, "_"));
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
		const conversations: StoredClaudeSubscriptionConversation[] = [];
		for (const entry of entries) {
			try {
				const sessionRoot = join(root, entry);
				const stored = await this.read(this.pathFor(sessionRoot));
				if (stored && basename(sessionRoot) === stored.sessionId) {
					conversations.push({ ...stored, sessionRoot });
				}
			} catch {
				// One corrupt session must not hide the others.
			}
		}
		return conversations.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	private pathFor(sessionRoot: string): string {
		return join(sessionRoot, FILE_NAME);
	}

	private async read(
		file: string,
	): Promise<StoredClaudeSubscriptionConversation | null> {
		try {
			return parseConversation(
				JSON.parse(await readFile(file, "utf8")) as unknown,
			);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw error;
		}
	}
}

function parseConversation(
	value: unknown,
): StoredClaudeSubscriptionConversation | null {
	if (
		!isObject(value) ||
		value.version !== SCHEMA_VERSION ||
		typeof value.threadId !== "string" ||
		typeof value.claudeSessionId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionRoot !== "string" ||
		typeof value.model !== "string" ||
		typeof value.systemPrompt !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		!Array.isArray(value.messages) ||
		!value.messages.every(isStoredMessage)
	) {
		return null;
	}
	return {
		version: SCHEMA_VERSION,
		revision:
			typeof value.revision === "number" &&
			Number.isInteger(value.revision) &&
			value.revision >= 0
				? value.revision
				: 0,
		threadId: value.threadId,
		claudeSessionId: value.claudeSessionId,
		sessionId: value.sessionId,
		sessionRoot: value.sessionRoot,
		model: value.model,
		systemPrompt: value.systemPrompt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		messages: value.messages,
		...(typeof value.memoryContext === "string"
			? { memoryContext: value.memoryContext }
			: {}),
	};
}

function isStoredMessage(value: unknown): value is StoredSubscriptionMessage {
	return (
		isObject(value) &&
		(value.role === "user" ||
			value.role === "assistant" ||
			value.role === "tool") &&
		typeof value.content === "string" &&
		typeof value.createdAt === "string" &&
		(value.hidden === undefined || typeof value.hidden === "boolean") &&
		(value.toolCallId === undefined || typeof value.toolCallId === "string") &&
		(value.toolName === undefined || typeof value.toolName === "string") &&
		(value.toolCalls === undefined || Array.isArray(value.toolCalls))
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
