import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { qSessionDir } from "../../config/paths.ts";
import { ensureDir } from "../../utils/fs.ts";

export interface SessionPaths {
	root: string;
	clientLog: string;
	serverLog: string;
	meta: string;
}

export interface SessionMeta {
	sessionId: string;
	createdAt: string;
	cwd: string;
	model: string;
	profile: string;
}

/**
 * Owns the on-disk layout for a single run. One directory per session under
 * `<cwd>/.backboard/sessions/<sessionId>/`, containing client + server JSONL
 * logs and a meta record. Resume is out of scope for this draft, but the structure is
 * sufficient to reconstruct the entire run later.
 */
export class SessionStore {
	readonly paths: SessionPaths;

	constructor(
		readonly sessionId: string,
		baseDir: string,
	) {
		const root = qSessionDir(baseDir, sessionId);
		this.paths = {
			root,
			clientLog: join(root, "client.jsonl"),
			serverLog: join(root, "server.jsonl"),
			meta: join(root, "meta.json"),
		};
	}

	async init(meta: SessionMeta): Promise<void> {
		await ensureDir(this.paths.root);
		await writeFile(this.paths.meta, JSON.stringify(meta, null, 2), "utf8");
	}
}
