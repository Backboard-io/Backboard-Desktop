import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRipgrep } from "../src/core/search/ripgrep.ts";
import { runSearch } from "../src/core/search/searchRunner.ts";

const scratch: string[] = [];

afterEach(async () => {
	await Promise.all(
		scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

function replay(
	script: string,
	overrides: Partial<Parameters<typeof runSearch<string>>[0]> = {},
) {
	return runSearch({
		executablePath: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		signal: new AbortController().signal,
		delimiter: "\n",
		maxRecords: 100,
		recordLimitReason: "head_limit",
		maxOutputBytes: 4_000,
		mapRecord: (record) => [{ text: record, value: record }],
		...overrides,
	});
}

describe("bounded search stream", () => {
	it("preserves UTF-8 across every byte boundary and null-delimited filenames", async () => {
		const names = ["snow 雪🙂\nfile.txt", "tab\tcolon:file.txt"];
		const script = `const bytes=Buffer.from(${JSON.stringify(`${names.join("\0")}\0`)}); for(const byte of bytes){process.stdout.write(Buffer.from([byte])); await Bun.sleep(1);}`;
		const result = await replay(script, { delimiter: "\0" });
		expect(result.records.map((record) => record.value)).toEqual(names);
		expect(result).toMatchObject({
			truncated: false,
			totalKnown: true,
			totalCount: 2,
			exitCode: 0,
		});
	});

	it("returns no matches only for a normal no-match exit", async () => {
		const result = await replay("process.exit(1)");
		expect(result).toMatchObject({
			records: [],
			exitCode: 1,
			truncated: false,
			totalKnown: true,
		});
	});

	it("stops and reaps the child immediately at head_limit", async () => {
		const started = performance.now();
		const result = await replay(
			"console.log(process.pid); for(let i=0;i<100;i++) console.log('record'); setTimeout(()=>process.exit(0), 10000)",
			{ maxRecords: 3 },
		);
		expect(result).toMatchObject({
			truncated: true,
			returnedCount: 3,
			limit: 3,
			limitReason: "head_limit",
			totalKnown: false,
		});
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(() => process.kill(Number(result.records[0]?.value), 0)).toThrow();
	});

	it("escalates SIGTERM to SIGKILL and waits for process reaping", async () => {
		const result = await replay(
			"process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)",
			{ maxRecords: 1 },
		);
		expect(result).toMatchObject({ truncated: true, returnedCount: 1 });
		expect(() => process.kill(Number(result.records[0]?.value), 0)).toThrow();
	});

	it("caps complete rendered records without cutting multibyte content", async () => {
		const result = await replay(
			`process.stdout.write(${JSON.stringify("雪🙂\n雪🙂\n")})`,
			{
				maxOutputBytes: 9,
			},
		);
		expect(result.records.map((record) => record.text)).toEqual(["雪🙂"]);
		expect(result).toMatchObject({
			truncated: true,
			limit: 9,
			limitUnit: "bytes",
			limitReason: "output_bytes",
			totalKnown: false,
		});
	});

	it("bounds a single unterminated huge record without claiming no matches", async () => {
		const result = await replay("process.stdout.write('x'.repeat(1000000))", {
			maxRecordBytes: 1_024,
		});
		expect(result).toMatchObject({
			records: [],
			truncated: true,
			limitReason: "record_bytes",
			limit: 1_024,
			totalKnown: false,
		});
	});

	it("never converts invalid/truncated protocol records into success", async () => {
		await expect(
			replay("process.stdout.write('partial')"),
		).rejects.toMatchObject({
			code: "SEARCH_INCOMPLETE_RECORD",
			category: "execution",
		});
		await expect(
			replay("console.log('invalid-json')", {
				mapRecord: (record) => {
					JSON.parse(record);
					return [];
				},
			}),
		).rejects.toMatchObject({ code: "SEARCH_PROTOCOL_ERROR" });
	});

	it("reports unexpected signal termination as failure rather than no matches", async () => {
		await expect(
			replay("process.kill(process.pid, 'SIGTERM')"),
		).rejects.toMatchObject({
			category: "execution",
			code: "SEARCH_TERMINATED",
		});
	});

	it("bounds stderr while preserving real failure even after stdout cap", async () => {
		await expect(
			replay(
				"process.on('SIGTERM',()=>{console.error('regex parse error');process.exit(2)});console.log('one');setInterval(()=>{},1000)",
				{ maxRecords: 1 },
			),
		).rejects.toMatchObject({ category: "invalid_argument", exitCode: 2 });
		await expect(
			replay(
				"process.stderr.write('regex parse error: '+ 'x'.repeat(100000)); await Bun.sleep(20); process.exit(2)",
			),
		).rejects.toMatchObject({ category: "invalid_argument", exitCode: 2 });
		try {
			await replay(
				"process.stderr.write('permission denied: '+ 'x'.repeat(100000)); await Bun.sleep(20); process.exit(2)",
			);
			throw new Error("Expected search failure");
		} catch (error) {
			expect(error).toMatchObject({ category: "permission", exitCode: 2 });
			expect((error as Error).message.length).toBeLessThan(1_500);
		}
	});

	it("does not relabel cap cleanup as a search timeout", async () => {
		const result = await replay(
			"process.on('SIGTERM',()=>{}); console.log('one'); setInterval(()=>{},1000)",
			{ maxRecords: 1, timeoutMs: 150 },
		);
		expect(result).toMatchObject({
			truncated: true,
			limitReason: "head_limit",
		});
	});

	it("distinguishes missing PCRE2 support without changing regex semantics", async () => {
		await expect(
			replay(
				"console.error('PCRE2 is not available in this build of ripgrep'); process.exit(2)",
			),
		).rejects.toMatchObject({ category: "unavailable", exitCode: 2 });
	});

	it("distinguishes caller cancellation from deadlines and output caps", async () => {
		const controller = new AbortController();
		const work = replay("setInterval(()=>{},1000)", {
			signal: controller.signal,
		});
		controller.abort();
		await expect(work).rejects.toMatchObject({
			category: "cancelled",
			cancelled: true,
			timedOut: false,
			retryable: false,
		});
		await expect(
			replay("setInterval(()=>{},1000)", { timeoutMs: 10 }),
		).rejects.toMatchObject({
			category: "timeout",
			timedOut: true,
			cancelled: false,
		});
	});

	it("honors cancellation even after a cap while waiting for child shutdown", async () => {
		const controller = new AbortController();
		const work = replay(
			"process.on('SIGTERM',()=>{}); console.log('one'); setInterval(()=>{},1000)",
			{ signal: controller.signal, maxRecords: 1 },
		);
		const timer = setTimeout(() => controller.abort(), 80);
		try {
			await expect(work).rejects.toMatchObject({ category: "cancelled" });
		} finally {
			clearTimeout(timer);
		}
	});

	it("reports missing and non-executable binaries as explicit capability/permission failures", async () => {
		await expect(
			replay("", { executablePath: "/not-a-real-directory/not-rg" }),
		).rejects.toMatchObject({
			category: "unavailable",
			code: "SEARCH_SPAWN_FAILED",
		});
		const directory = await mkdtemp(join(tmpdir(), "search-permission-"));
		scratch.push(directory);
		const path = join(directory, "rg");
		await writeFile(path, "unexecutable");
		await chmod(path, 0o600);
		await expect(replay("", { executablePath: path })).rejects.toMatchObject({
			category: "permission",
			code: "SEARCH_SPAWN_FAILED",
		});
	});
});

describe("ripgrep capability resolution", () => {
	it("finds and identifies the exact executable under sparse GUI PATH", async () => {
		const actual = await resolveRipgrep();
		const explicit = await resolveRipgrep({
			executablePath: actual.path,
			env: { PATH: "/usr/bin:/bin" },
		});
		expect(explicit).toEqual(actual);
		expect(explicit.version).toStartWith("ripgrep ");
		const usingEnvironment = await resolveRipgrep({
			env: { PATH: "", BACKBOARD_RIPGREP_PATH: actual.path },
		});
		expect(usingEnvironment).toEqual(actual);
	});

	it("caches failed configuration probes without respawning or searching elsewhere", async () => {
		const first = resolveRipgrep({
			env: { PATH: "/path-that-does-not-exist" },
		});
		const repeated = resolveRipgrep({
			env: { PATH: "/path-that-does-not-exist" },
		});
		expect(repeated).toBe(first);
		await expect(first).rejects.toMatchObject({
			category: "unavailable",
			code: "RIPGREP_UNAVAILABLE",
			retryable: false,
		});
	});

	it("rejects incompatible executables early", async () => {
		await expect(
			resolveRipgrep({ executablePath: process.execPath }),
		).rejects.toMatchObject({
			category: "unavailable",
			code: "RIPGREP_INCOMPATIBLE",
		});
	});
});
