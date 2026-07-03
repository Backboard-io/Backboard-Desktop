import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string, mode?: number): Promise<void> {
	await mkdir(path, { recursive: true, mode });
}

export async function appendLine(
	filePath: string,
	line: string,
): Promise<void> {
	await ensureDir(dirname(filePath), 0o700);
	await appendFile(filePath, line.endsWith("\n") ? line : `${line}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readUtf8(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function fileSize(path: string): Promise<number> {
	const s = await stat(path);
	return s.size;
}
