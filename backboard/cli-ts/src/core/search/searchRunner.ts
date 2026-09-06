import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { SearchError } from "./SearchError.ts";

export type SearchLimitReason =
	| "head_limit"
	| "file_limit"
	| "output_bytes"
	| "record_bytes";

export interface SearchMetadata {
	truncated: boolean;
	returnedCount: number;
	limit: number;
	limitUnit: "records" | "bytes";
	limitReason: SearchLimitReason | null;
	totalKnown: boolean;
	totalCount?: number;
}

export interface SearchRecord<T> {
	text: string;
	value: T;
}

interface SearchOptions<T> {
	executablePath: string;
	args: string[];
	cwd: string;
	signal: AbortSignal;
	delimiter: "\n" | "\0";
	maxRecords: number;
	recordLimitReason: "head_limit" | "file_limit";
	maxOutputBytes: number;
	maxRecordBytes?: number;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	mapRecord: (record: string) => Iterable<SearchRecord<T>>;
}

interface SearchOutput<T> extends SearchMetadata {
	records: SearchRecord<T>[];
	exitCode: number | null;
}

/** Reject a bad root before launching search; paths are already normalized by the caller. */
export async function inspectSearchPath(
	path: string,
	signal?: AbortSignal,
): Promise<"file" | "directory"> {
	if (signal?.aborted)
		throw new SearchError("Search cancelled.", "cancelled", "SEARCH_CANCELLED");
	try {
		const info = await stat(path);
		if (signal?.aborted)
			throw new SearchError(
				"Search cancelled.",
				"cancelled",
				"SEARCH_CANCELLED",
			);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		throw new SearchError(
			"Search path must be a regular file or directory.",
			"invalid_argument",
			"SEARCH_PATH_TYPE",
		);
	} catch (error) {
		if (signal?.aborted)
			throw new SearchError(
				"Search cancelled.",
				"cancelled",
				"SEARCH_CANCELLED",
			);
		if (error instanceof SearchError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			throw new SearchError(
				`Search path does not exist: ${path}. Use a known workspace path or omit path to search the workspace.`,
				"missing_path",
				"SEARCH_PATH_MISSING",
			);
		}
		throw new SearchError(
			`Cannot access search path: ${path}. ${code ?? "Filesystem error"}.`,
			code === "EACCES" || code === "EPERM" ? "permission" : "execution",
			"SEARCH_PATH_ACCESS",
		);
	}
}

/**
 * Bound both process I/O and rendered output. Decode only complete records so a
 * chunk boundary never splits UTF-8 or a filename. A cap is conservative: once
 * reached, the search stops immediately and the total is explicitly unknown.
 */
export function runSearch<T>(
	options: SearchOptions<T>,
): Promise<SearchOutput<T>> {
	return new Promise((resolvePromise, reject) => {
		if (options.signal.aborted) {
			reject(
				new SearchError("Search cancelled.", "cancelled", "SEARCH_CANCELLED"),
			);
			return;
		}
		const child = spawn(options.executablePath, options.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const records: SearchRecord<T>[] = [];
		const delimiter = options.delimiter.charCodeAt(0);
		const maxRecordBytes = options.maxRecordBytes ?? 256_000;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let outputBytes = 0;
		let stderr = Buffer.alloc(0);
		let stderrTruncated = false;
		let limitReason: SearchLimitReason | null = null;
		let failure: SearchError | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		const terminate = () => {
			if (closed || killTimer) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
			killTimer.unref();
		};
		const cap = (reason: SearchLimitReason) => {
			limitReason ??= reason;
			pending = [];
			pendingBytes = 0;
			terminate();
		};
		const cancel = () => {
			failure = new SearchError(
				"Search cancelled.",
				"cancelled",
				"SEARCH_CANCELLED",
			);
			terminate();
		};
		options.signal.addEventListener("abort", cancel, { once: true });
		const timeout = setTimeout(() => {
			// Once the cap stopped work, the bounded reap grace is cleanup, not
			// a search deadline failure. Caller cancellation still takes precedence.
			if (limitReason) return;
			failure ??= new SearchError(
				"Search deadline exceeded. Narrow path/glob or use a smaller head_limit before retrying.",
				"timeout",
				"SEARCH_TIMEOUT",
			);
			terminate();
		}, options.timeoutMs ?? 30_000);
		timeout.unref();
		const consume = (record: Buffer) => {
			try {
				for (const item of options.mapRecord(record.toString("utf8"))) {
					const bytes = Buffer.byteLength(item.text, "utf8") + 1;
					if (outputBytes + bytes > options.maxOutputBytes) {
						cap("output_bytes");
						return;
					}
					records.push(item);
					outputBytes += bytes;
					if (records.length >= options.maxRecords) {
						cap(options.recordLimitReason);
						return;
					}
				}
			} catch {
				failure = new SearchError(
					"ripgrep returned an invalid output record. Check the configured search executable.",
					"execution",
					"SEARCH_PROTOCOL_ERROR",
				);
				terminate();
			}
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (limitReason || failure) return;
			let start = 0;
			while (start < chunk.length && !limitReason && !failure) {
				const end = chunk.indexOf(delimiter, start);
				const part = chunk.subarray(start, end < 0 ? chunk.length : end);
				if (pendingBytes + part.length > maxRecordBytes) {
					cap("record_bytes");
					return;
				}
				pending.push(part);
				pendingBytes += part.length;
				if (end < 0) return;
				consume(Buffer.concat(pending, pendingBytes));
				pending = [];
				pendingBytes = 0;
				start = end + 1;
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const remaining = 8_192 - stderr.length;
			if (chunk.length > remaining) stderrTruncated = true;
			if (remaining > 0)
				stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			failure ??= new SearchError(
				`Cannot start ripgrep (${error.code ?? "spawn failure"}). Check BACKBOARD_RIPGREP_PATH and runtime PATH.`,
				error.code === "EACCES" || error.code === "EPERM"
					? "permission"
					: "unavailable",
				"SEARCH_SPAWN_FAILED",
			);
		});
		child.on("close", (exitCode, signal) => {
			closed = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", cancel);
			if (options.signal.aborted)
				failure = new SearchError(
					"Search cancelled.",
					"cancelled",
					"SEARCH_CANCELLED",
				);
			if (!failure && exitCode !== null && exitCode !== 0 && exitCode !== 1) {
				failure = processFailure(exitCode, stderr, stderrTruncated);
			}
			if (
				!failure &&
				signal &&
				!(limitReason && (signal === "SIGTERM" || signal === "SIGKILL"))
			) {
				failure = new SearchError(
					`ripgrep terminated unexpectedly (${signal}).`,
					"execution",
					"SEARCH_TERMINATED",
				);
			}
			if (!failure && !limitReason && pendingBytes > 0) {
				// rg promises delimiter-terminated records. Do not present damaged output as a complete search.
				failure = new SearchError(
					"ripgrep ended with an incomplete output record.",
					"execution",
					"SEARCH_INCOMPLETE_RECORD",
				);
			}
			if (failure) {
				reject(failure);
				return;
			}
			resolvePromise({
				records,
				exitCode,
				truncated: limitReason !== null,
				returnedCount: records.length,
				limit:
					limitReason === "record_bytes"
						? maxRecordBytes
						: limitReason === "output_bytes" ||
								options.maxRecords === Number.MAX_SAFE_INTEGER
							? options.maxOutputBytes
							: options.maxRecords,
				limitUnit:
					limitReason === "record_bytes" ||
					limitReason === "output_bytes" ||
					options.maxRecords === Number.MAX_SAFE_INTEGER
						? "bytes"
						: "records",
				limitReason,
				totalKnown: limitReason === null,
				...(limitReason === null ? { totalCount: records.length } : {}),
			});
		});
	});
}

function processFailure(
	exitCode: number,
	stderr: Buffer,
	truncated: boolean,
): SearchError {
	// stderr is diagnostics emitted by the executable, never searched source text.
	const detail = stderr.toString("utf8").trim().slice(0, 1_200);
	const suffix =
		truncated || stderr.length > 1_200 ? " [diagnostic shortened]" : "";
	const category = /permission denied|operation not permitted/i.test(detail)
		? "permission"
		: /no such file or directory|not a directory/i.test(detail)
			? "missing_path"
			: /PCRE2 is not available|not compiled with.*PCRE2/i.test(detail)
				? "unavailable"
				: /regex parse error|error parsing glob|unrecognized file type|invalid.*(?:glob|regex)|unclosed|PCRE2: error compiling/i.test(
							detail,
						)
					? "invalid_argument"
					: "execution";
	const repair =
		category === "invalid_argument"
			? ' Check the pattern/glob/type; for literal content use {"pattern":"text","fixed_string":true}.'
			: category === "unavailable"
				? " This regex requires a ripgrep build with PCRE2; retain regex semantics and select a compatible binary."
				: "";
	return new SearchError(
		`ripgrep failed (exit ${exitCode}): ${detail || "No diagnostic"}${suffix}.${repair}`,
		category,
		"SEARCH_PROCESS_FAILED",
		exitCode,
	);
}

/** Keep unusual filename delimiters unambiguous in model-visible line output. */
export function displaySearchPath(path: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: detect filename delimiters that require lossless escaping.
	return /[\u0000-\u001f\u007f:"\\]/.test(path) ? JSON.stringify(path) : path;
}

export function searchLimitNote(metadata: SearchMetadata): string {
	if (!metadata.truncated) return "";
	return `[Partial search: returned ${metadata.returnedCount} records; ${metadata.limitReason} reached (${metadata.limit} ${metadata.limitUnit}). Total unknown. Narrow the path/pattern to inspect more.]`;
}
