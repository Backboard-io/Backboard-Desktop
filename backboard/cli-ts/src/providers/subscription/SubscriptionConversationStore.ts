import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { qSessionDir } from "../../config/paths.ts";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedValue,
	newSalt,
} from "../../core/keys/KeyCipher.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { ensureDir, renameOver } from "../../utils/fs.ts";

const FILE_NAME = "subscription-conversation.json";
const LOCK_FILE_NAME = "subscription-conversation.lock";
const SCHEMA_VERSION = 1;

export type SubscriptionJsonObject = Record<string, unknown>;

export interface StoredSubscriptionMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	createdAt: string;
	hidden?: boolean;
	toolCallId?: string;
	toolName?: string;
	toolCalls?: Array<{ id: string; name: string; input: unknown }>;
}

export interface StoredSubscriptionConversation {
	version: typeof SCHEMA_VERSION;
	revision: number;
	threadId: string;
	sessionId: string;
	sessionRoot: string;
	model: string;
	instructions: string;
	tools: SubscriptionJsonObject[];
	input: SubscriptionJsonObject[];
	createdAt: string;
	updatedAt: string;
	messages: StoredSubscriptionMessage[];
	memoryContext?: string;
	pendingMemory?: {
		user: string;
		profile: "default" | "code";
		write: boolean;
	};
}

interface ConversationEnvelope {
	version: typeof SCHEMA_VERSION;
	threadId: string;
	sessionId: string;
	salt: string;
	payload: ReturnType<typeof encryptSecret>;
}

export class SubscriptionConversationStore {
	constructor(private readonly baseDir: string) {}

	async save(
		conversation: StoredSubscriptionConversation,
		expectedRevision: number,
		replacesThreadId?: string,
	): Promise<number> {
		const sessionRoot = qSessionDir(this.baseDir, conversation.sessionId);
		const path = this.pathFor(sessionRoot);
		await ensureDir(sessionRoot, 0o700);
		await chmod(sessionRoot, 0o700).catch(() => undefined);
		const lease = await acquireFileLease(join(sessionRoot, LOCK_FILE_NAME), {
			label: `subscription conversation ${conversation.threadId}`,
			timeoutMs: 5_000,
			retryMs: 50,
			invalidOwnerStaleMs: 5_000,
		});
		try {
			const existing = await this.readEnvelope(path);
			if (
				existing &&
				existing.conversation.threadId !== conversation.threadId &&
				existing.conversation.threadId !== replacesThreadId
			) {
				throw new Error(
					`Session ${conversation.sessionId} is already owned by subscription conversation ${existing.conversation.threadId}.`,
				);
			}
			const actualRevision = existing?.conversation.revision ?? 0;
			if (actualRevision !== expectedRevision) {
				throw new Error(
					`Subscription conversation ${conversation.threadId} changed in another CLI process. Resume it again before sending more messages.`,
				);
			}
			const revision = actualRevision + 1;
			const salt = existing?.salt ?? newSalt();
			const stored: StoredSubscriptionConversation = {
				...conversation,
				version: SCHEMA_VERSION,
				revision,
				sessionRoot,
			};
			const envelope: ConversationEnvelope = {
				version: SCHEMA_VERSION,
				threadId: conversation.threadId,
				sessionId: conversation.sessionId,
				salt,
				payload: encryptSecret(JSON.stringify(stored), salt),
			};
			const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
			try {
				await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
					mode: 0o600,
				});
				await chmod(temporary, 0o600).catch(() => undefined);
				await renameOver(temporary, path);
				await chmod(path, 0o600).catch(() => undefined);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			return revision;
		} finally {
			await lease.release();
		}
	}

	async get(threadId: string): Promise<StoredSubscriptionConversation | null> {
		return (
			(await this.list()).find(
				(conversation) => conversation.threadId === threadId,
			) ?? null
		);
	}

	async getAtSessionRoot(
		sessionRoot: string,
		threadId: string,
	): Promise<StoredSubscriptionConversation | null> {
		const stored = await this.readEnvelope(this.pathFor(sessionRoot));
		if (
			!stored ||
			stored.conversation.threadId !== threadId ||
			basename(sessionRoot) !== stored.conversation.sessionId
		) {
			return null;
		}
		return { ...stored.conversation, sessionRoot };
	}

	async list(): Promise<StoredSubscriptionConversation[]> {
		const root = dirname(qSessionDir(this.baseDir, "_"));
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}
		const conversations: StoredSubscriptionConversation[] = [];
		for (const entry of entries) {
			try {
				const sessionRoot = join(root, entry);
				const stored = await this.readEnvelope(this.pathFor(sessionRoot));
				if (stored && basename(sessionRoot) === stored.conversation.sessionId) {
					conversations.push({ ...stored.conversation, sessionRoot });
				}
			} catch {
				// A corrupt or machine-moved encrypted session must not hide others.
			}
		}
		return conversations.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	private pathFor(sessionRoot: string): string {
		return join(sessionRoot, FILE_NAME);
	}

	private async readEnvelope(path: string): Promise<{
		conversation: StoredSubscriptionConversation;
		salt: string;
	} | null> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw error;
		}
		if (
			!isObject(parsed) ||
			parsed.version !== SCHEMA_VERSION ||
			typeof parsed.salt !== "string" ||
			!isEncryptedValue(parsed.payload)
		) {
			return null;
		}
		const plaintext = decryptSecret(parsed.payload, parsed.salt);
		if (!plaintext) return null;
		const conversation = parseConversation(JSON.parse(plaintext) as unknown);
		return conversation ? { conversation, salt: parsed.salt } : null;
	}
}

function parseConversation(
	value: unknown,
): StoredSubscriptionConversation | null {
	if (
		!isObject(value) ||
		value.version !== SCHEMA_VERSION ||
		typeof value.threadId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionRoot !== "string" ||
		typeof value.model !== "string" ||
		typeof value.instructions !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		!Array.isArray(value.tools) ||
		!value.tools.every(isObject) ||
		!Array.isArray(value.input) ||
		!value.input.every(isObject) ||
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
		sessionId: value.sessionId,
		sessionRoot: value.sessionRoot,
		model: value.model,
		instructions: value.instructions,
		tools: value.tools,
		input: value.input,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		messages: value.messages,
		...(typeof value.memoryContext === "string"
			? { memoryContext: value.memoryContext }
			: {}),
		...(isPendingMemory(value.pendingMemory)
			? { pendingMemory: value.pendingMemory }
			: {}),
	};
}

function isObject(value: unknown): value is SubscriptionJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredMessage(value: unknown): value is StoredSubscriptionMessage {
	if (
		!isObject(value) ||
		(value.role !== "user" &&
			value.role !== "assistant" &&
			value.role !== "tool") ||
		typeof value.content !== "string" ||
		typeof value.createdAt !== "string"
	) {
		return false;
	}
	return (
		(value.hidden === undefined || typeof value.hidden === "boolean") &&
		(value.toolCallId === undefined || typeof value.toolCallId === "string") &&
		(value.toolName === undefined || typeof value.toolName === "string") &&
		(value.toolCalls === undefined || Array.isArray(value.toolCalls))
	);
}

function isPendingMemory(
	value: unknown,
): value is NonNullable<StoredSubscriptionConversation["pendingMemory"]> {
	return (
		isObject(value) &&
		typeof value.user === "string" &&
		(value.profile === "default" || value.profile === "code") &&
		typeof value.write === "boolean"
	);
}
