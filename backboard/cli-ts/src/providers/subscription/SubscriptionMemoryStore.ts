import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryProfile } from "../../config/defaults.ts";
import { qProjectConfigDir } from "../../config/paths.ts";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedValue,
	newSalt,
} from "../../core/keys/KeyCipher.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { ensureDir, renameOver } from "../../utils/fs.ts";

const MEMORY_FILE = "subscription-memory.json";
const MEMORY_LOCK = "subscription-memory.lock";
const MAX_ENTRIES = 12;
const MAX_CONTEXT_CHARS = 24_000;

interface MemoryEntry {
	profile: MemoryProfile;
	user: string;
	assistant: string;
	createdAt: string;
}

interface MemoryPayload {
	version: 1;
	entries: MemoryEntry[];
}

interface MemoryEnvelope {
	version: 1;
	salt: string;
	payload: ReturnType<typeof encryptSecret>;
}

/** Encrypted, workspace-local rolling memory for the subscription backend. */
export class SubscriptionMemoryStore {
	private readonly root: string;
	private readonly path: string;
	private readonly lockPath: string;

	constructor(baseDir: string) {
		this.root = qProjectConfigDir(baseDir);
		this.path = join(this.root, MEMORY_FILE);
		this.lockPath = join(this.root, MEMORY_LOCK);
	}

	async context(profile: MemoryProfile = "default"): Promise<string> {
		const payload = await this.read();
		const relevant = payload.entries.filter(
			(entry) => entry.profile === profile,
		);
		let context = "";
		for (const entry of relevant.toReversed()) {
			const next = `User: ${entry.user}\nAssistant: ${entry.assistant}\n`;
			if (context.length + next.length > MAX_CONTEXT_CHARS) break;
			context = `${next}\n${context}`;
		}
		return context.trim();
	}

	async remember(
		user: string,
		assistant: string,
		profile: MemoryProfile = "default",
	): Promise<void> {
		const normalizedUser = user.trim();
		const normalizedAssistant = assistant.trim();
		if (!normalizedUser || !normalizedAssistant) return;
		await ensureDir(this.root, 0o700);
		await chmod(this.root, 0o700).catch(() => undefined);
		const lease = await acquireFileLease(this.lockPath, {
			label: "subscription memory",
			timeoutMs: 5_000,
			retryMs: 50,
			invalidOwnerStaleMs: 5_000,
		});
		try {
			const current = await this.readEnvelope();
			const entries = [
				...current.payload.entries,
				{
					profile,
					user: normalizedUser.slice(0, 4_000),
					assistant: normalizedAssistant.slice(0, 8_000),
					createdAt: new Date().toISOString(),
				},
			].slice(-MAX_ENTRIES);
			const envelope: MemoryEnvelope = {
				version: 1,
				salt: current.salt,
				payload: encryptSecret(
					JSON.stringify({ version: 1, entries } satisfies MemoryPayload),
					current.salt,
				),
			};
			const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
			try {
				await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
					mode: 0o600,
				});
				await chmod(temporary, 0o600).catch(() => undefined);
				await renameOver(temporary, this.path);
				await chmod(this.path, 0o600).catch(() => undefined);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
		} finally {
			await lease.release();
		}
	}

	private async read(): Promise<MemoryPayload> {
		return (await this.readEnvelope()).payload;
	}

	private async readEnvelope(): Promise<{
		salt: string;
		payload: MemoryPayload;
	}> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") {
				return { salt: newSalt(), payload: { version: 1, entries: [] } };
			}
			throw error;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("salt" in parsed) ||
			typeof parsed.salt !== "string" ||
			!("payload" in parsed) ||
			!isEncryptedValue(parsed.payload)
		) {
			throw new Error(`Subscription memory at ${this.path} is malformed.`);
		}
		const plaintext = decryptSecret(parsed.payload, parsed.salt);
		if (!plaintext) {
			throw new Error(
				`Subscription memory at ${this.path} cannot be decrypted on this machine.`,
			);
		}
		const payload: unknown = JSON.parse(plaintext);
		if (!isPayload(payload)) {
			throw new Error(`Subscription memory at ${this.path} is malformed.`);
		}
		return { salt: parsed.salt, payload };
	}
}

function isPayload(value: unknown): value is MemoryPayload {
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("entries" in value) ||
		!Array.isArray(value.entries)
	) {
		return false;
	}
	return value.entries.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"profile" in entry &&
			(entry.profile === "default" || entry.profile === "code") &&
			"user" in entry &&
			typeof entry.user === "string" &&
			"assistant" in entry &&
			typeof entry.assistant === "string" &&
			"createdAt" in entry &&
			typeof entry.createdAt === "string",
	);
}
