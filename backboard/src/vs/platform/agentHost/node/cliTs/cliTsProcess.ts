/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { bridgeConfig } from './backboardRuntimeShared.js';
import { type CliTsAgentEvent, type CliTsRecord, type CliTsServeControl, isCliTsRecord } from './cliTsProtocol.js';

interface PendingServeRequest {
	readonly resolve: (record: CliTsRecord) => void;
	readonly reject: (error: Error) => void;
}

export interface CliTsInvocation {
	readonly command: string;
	readonly args: readonly string[];
}

function resolveBunCommand(): string | undefined {
	const envBunPath = process.env['BACKBOARD_BUN_PATH']?.trim() || process.env['BUN_PATH']?.trim();
	if (envBunPath && fs.existsSync(envBunPath)) {
		return envBunPath;
	}

	const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
	const candidates = [
		process.env['BUN_INSTALL'] ? join(process.env['BUN_INSTALL'], 'bin', executable) : undefined,
		join(os.homedir(), '.bun', 'bin', executable),
		join(process.cwd(), 'node_modules', '.bin', executable),
		'/opt/homebrew/bin/bun',
		'/usr/local/bin/bun',
	].filter((candidate): candidate is string => !!candidate);

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	const pathValue = process.env['PATH'] ?? '';
	const pathSeparator = process.platform === 'win32' ? ';' : ':';
	for (const dir of pathValue.split(pathSeparator)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, executable);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Stable identity for the executable used by a serve process. Size joins mtime
 * because some build/copy tools preserve timestamps, while the resolved command
 * and args detect a runtime override changing underneath an existing session.
 */
export function cliTsInvocationFingerprint(invocation: CliTsInvocation): string {
	let file: { mtimeMs: number; size: number } | undefined;
	try {
		const stat = fs.statSync(invocation.command);
		file = { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		// Resolution/spawn will report a missing command normally. Keeping the
		// command in the fingerprint still detects a changed env override.
	}
	return JSON.stringify({
		command: invocation.command,
		args: invocation.args,
		file,
	});
}

/** Returns the CPU architecture encoded in a native executable header. */
export function detectCliTsExecutableArchitecture(header: Buffer, platform: NodeJS.Platform): NodeJS.Architecture | undefined {
	if (platform === 'darwin' && header.length >= 8) {
		const magic = header.readUInt32LE(0);
		if (magic === 0xfeedfacf || magic === 0xfeedface) {
			switch (header.readUInt32LE(4)) {
				case 0x01000007: return 'x64';
				case 0x0100000c: return 'arm64';
			}
		}
	}

	if (platform === 'linux' && header.length >= 20 && header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF') {
		const machine = header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18);
		switch (machine) {
			case 0x3e: return 'x64';
			case 0xb7: return 'arm64';
		}
	}

	if (platform === 'win32' && header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
		const peOffset = header.readUInt32LE(0x3c);
		if (peOffset + 6 <= header.length && header.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0') {
			switch (header.readUInt16LE(peOffset + 4)) {
				case 0x8664: return 'x64';
				case 0xaa64: return 'arm64';
			}
		}
	}

	return undefined;
}

function isCliTsExecutableCompatible(path: string): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(path, 'r');
		const header = Buffer.alloc(4096);
		const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
		const executableArchitecture = detectCliTsExecutableArchitecture(header.subarray(0, bytesRead), process.platform);
		return executableArchitecture === undefined || executableArchitecture === process.arch;
	} catch {
		// Let spawn surface unreadable or unrecognized executable errors normally.
		return true;
	} finally {
		if (descriptor !== undefined) {
			fs.closeSync(descriptor);
		}
	}
}

/**
 * Resolves how to start cli-ts, shared by persistent serve processes and
 * one-shot account commands such as ChatGPT subscription login.
 */
export function resolveCliTsInvocation(logService: ILogService): CliTsInvocation {
	const envPath = process.env['BACKBOARD_CLI_TS_PATH']?.trim() || process.env['VSCODE_BACKBOARD_CLI_TS_PATH']?.trim();
	if (envPath) {
		return { command: envPath, args: [] };
	}
	const executable = process.platform === 'win32' ? 'backboard-cli-ts.exe' : 'backboard-cli-ts';
	const appRoot = dirname(FileAccess.asFileUri('').fsPath);
	const candidates = [
		join(appRoot, 'extensions', 'backboard', 'bin', executable),
		join(process.cwd(), 'extensions', 'backboard', 'bin', executable),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			if (isCliTsExecutableCompatible(candidate)) {
				return { command: candidate, args: [] };
			}
			logService.warn(`[cli-ts] skipping packaged binary for the wrong CPU architecture: ${candidate} (host=${process.platform}-${process.arch})`);
		}
	}
	const devEntrypoint = join(appRoot, 'cli-ts', 'src', 'entrypoints', 'cli.tsx');
	if (fs.existsSync(devEntrypoint)) {
		const bunPath = resolveBunCommand();
		if (bunPath) {
			return { command: bunPath, args: ['run', devEntrypoint] };
		}

		throw new Error(`cli-ts dev entrypoint exists at ${devEntrypoint}, but Bun is not available. Install Bun, set BACKBOARD_BUN_PATH to a Bun executable, or build the packaged cli-ts binary with: npm --prefix extensions/backboard run package-cli-ts`);
	}
	throw new Error(`cli-ts binary not found. Build it with: npm --prefix extensions/backboard run package-cli-ts (looked at ${candidates.join(', ')})`);
}

/** Runs a one-shot cli-ts command using the same executable as IDE sessions. */
export function runCliTsCommand(logService: ILogService, args: readonly string[]): Promise<string> {
	const invocation = resolveCliTsInvocation(logService);
	return new Promise<string>((resolve, reject) => {
		const child = spawn(invocation.command, [...invocation.args, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, ...cliTsCredentialEnv() },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolve(stdout.trim());
				return;
			}
			const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
			reject(new Error(`Backboard CLI command failed: ${detail}`));
		});
	});
}

export interface CliTsServeProcessOptions {
	/** Stable IDE session id used for durable cli-ts worker metadata. */
	readonly sessionId?: string;
	/** Working directory the agent operates on (the session's workspace folder). */
	readonly workingDirectory?: string;
	/** Extra directories prepended to the child's PATH (e.g. bundled ripgrep). */
	readonly extraPathDirs?: readonly string[];
	/** Receives every `source: 'client'` agent event streamed by the process. */
	readonly onEvent: (event: CliTsAgentEvent) => void;
	/** Called once when the process exits (for any reason). */
	readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Owns one `backboard-cli-ts --serve` subprocess: binary resolution, spawn,
 * NDJSON control writes, stdout record routing, and teardown. One instance
 * per Backboard session — the serve process holds the session's Backboard
 * thread binding and working directory for its whole lifetime.
 */
export class CliTsServeProcess extends Disposable {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly pending = new Map<string, PendingServeRequest>();
	private exited = false;
	/** Whether the process ever produced a stdout line (reached serve startup). */
	private sawOutput = false;
	/** Tail of recent stderr, surfaced when the process dies unexpectedly. */
	private readonly stderrTail: string[] = [];
	/** The binary/command that was spawned, for actionable error messages. */
	private spawnedCommand = '';
	/** On-disk identity of the executable at spawn time. */
	private spawnedInvocationFingerprint: string | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly options: CliTsServeProcessOptions,
	) {
		super();
	}

	get isRunning(): boolean {
		return this.child !== null && !this.exited;
	}

	/** True when a rebuild or path override replaced the running executable. */
	get isInvocationStale(): boolean {
		if (!this.isRunning || !this.spawnedInvocationFingerprint) {
			return false;
		}
		return cliTsInvocationFingerprint(this.resolveCliTsInvocation()) !== this.spawnedInvocationFingerprint;
	}

	/** Starts the serve subprocess without submitting a turn. */
	start(): void {
		this.ensureProcess();
	}

	override dispose(): void {
		const child = this.child;
		if (child && !this.exited) {
			// Ask for a clean shutdown; the exit handler rejects any leftovers.
			try {
				child.stdin.write(`${JSON.stringify({ op: 'dispose' } satisfies CliTsServeControl)}\n`);
			} catch {
				// stdin may already be gone; SIGKILL below still applies.
			}
			const killHandle = setTimeout(() => child.kill('SIGKILL'), 2000);
			child.once('exit', () => clearTimeout(killHandle));
		}
		this.child = null;
		this.rejectAll(new Error('cli-ts serve process disposed.'));
		super.dispose();
	}

	/** Sends a correlated control op and resolves with its serve response record. */
	request(control: CliTsServeControl & { requestId: string }): Promise<CliTsRecord> {
		const child = this.ensureProcess();
		return new Promise<CliTsRecord>((resolve, reject) => {
			this.pending.set(control.requestId, { resolve, reject });
			child.stdin.write(`${JSON.stringify(control)}\n`);
		});
	}

	/** Sends a fire-and-forget control op (responses, cancel). */
	notify(control: CliTsServeControl): void {
		if (!this.isRunning) {
			return;
		}
		this.ensureProcess().stdin.write(`${JSON.stringify(control)}\n`);
	}

	/** Generates a request id for correlated ops. */
	nextRequestId(): string {
		return generateUuid();
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.child && !this.exited) {
			return this.child;
		}
		this.exited = false;
		// Validate the cwd up front: Node reports a missing spawn cwd as
		// `spawn <command> ENOENT`, which reads as if the binary were missing.
		// A session restored against a deleted/renamed folder must fail with
		// the real reason instead.
		if (this.options.workingDirectory && !fs.existsSync(this.options.workingDirectory)) {
			throw new Error(`The session's working directory no longer exists: ${this.options.workingDirectory}. Start a new session from an existing folder.`);
		}
		const invocation = this.resolveCliTsInvocation();
		this.spawnedInvocationFingerprint = cliTsInvocationFingerprint(invocation);
		const args = [...invocation.args, '--serve'];
		if (this.options.workingDirectory) {
			args.push('--cwd', this.options.workingDirectory);
		}
		const env = { ...process.env, ...cliTsCredentialEnv() };
		// Keep cli-ts's per-session logs/scratch out of the user's workspace so
		// they never show up as agent file edits in the Changes/Review view.
		env['BACKBOARD_SESSION_ROOT'] = join(os.homedir(), '.backboard_ide', 'cli-ts-sessions');
		if (this.options.sessionId) {
			env['BACKBOARD_SESSION_ID'] = this.options.sessionId;
		}
		if (this.options.extraPathDirs?.length) {
			const sep = process.platform === 'win32' ? ';' : ':';
			env['PATH'] = [...this.options.extraPathDirs, env['PATH'] ?? ''].join(sep);
		}
		this.spawnedCommand = `${invocation.command} ${args.join(' ')}`;
		this.sawOutput = false;
		this.stderrTail.length = 0;
		this.logService.info(`[cli-ts] spawning ${this.spawnedCommand}`);
		const child = spawn(invocation.command, args, {
			cwd: this.options.workingDirectory ?? process.cwd(),
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.child = child;
		const reader = readline.createInterface({ input: child.stdout });
		reader.on('line', line => this.handleLine(line));
		child.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) {
				this.stderrTail.push(text);
				if (this.stderrTail.length > 10) {
					this.stderrTail.shift();
				}
				this.logService.info(`[cli-ts] ${text}`);
			}
		});
		child.on('error', error => {
			this.logService.error(`[cli-ts] process error: ${error.message}`);
			this.exited = true;
			this.rejectAll(new Error(`cli-ts serve process failed to start: ${error.message}`));
			this.options.onExit?.(null, null);
		});
		child.on('exit', (code, signal) => {
			this.logService.warn(`[cli-ts] serve process exited code=${code} signal=${signal}`);
			this.exited = true;
			this.child = null;
			this.rejectAll(new Error(this.describeUnexpectedExit(code, signal)));
			this.options.onExit?.(code, signal);
		});
		return child;
	}

	/**
	 * Builds an actionable message for an unexpected serve-process exit. The
	 * common failure is macOS killing the packaged binary on first exec because
	 * `bun --compile` appends the JS bundle after ad-hoc signing (invalidating
	 * the signature) — the process dies before producing any output, usually
	 * with SIGKILL. Re-signing during packaging fixes it.
	 */
	private describeUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): string {
		const where = `${this.spawnedCommand} (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
		if (!this.sawOutput) {
			const stderr = this.stderrTail.length ? ` Last stderr: ${this.stderrTail.join(' | ')}` : '';
			return `The Backboard agent (cli-ts) failed to start and produced no output. This usually means the packaged binary's code signature is invalid (macOS kills it on first run). Rebuild it with: npm --prefix extensions/backboard run package-cli-ts. [${where}]${stderr}`;
		}
		return `cli-ts serve process exited unexpectedly: ${where}`;
	}

	private handleLine(line: string): void {
		this.sawOutput = true;
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let record: unknown;
		try {
			record = JSON.parse(trimmed);
		} catch {
			this.logService.info(`[cli-ts] non-JSON stdout line: ${trimmed.slice(0, 200)}`);
			return;
		}
		if (!isCliTsRecord(record)) {
			this.logService.info(`[cli-ts] unrecognized stdout record: ${trimmed.slice(0, 200)}`);
			return;
		}
		if (record.source === 'serve') {
			this.handleServeRecord(record);
			return;
		}
		const payload = record.payload;
		if (payload && typeof payload === 'object' && typeof (payload as CliTsAgentEvent).type === 'string') {
			const eventType = (payload as CliTsAgentEvent).type;
			if (['tool:identity', 'thinking:resolved', 'thinking:wire', 'notification:run', 'runtime:identity'].includes(eventType)) {
				// These runtime diagnostics contain identities, hashes and timings only.
				this.logService.trace(`[cli-ts] diagnostic: ${JSON.stringify(payload)}`);
			}
			this.options.onEvent(payload as CliTsAgentEvent);
		}
	}

	private handleServeRecord(record: CliTsRecord): void {
		if (record.type === 'serve:ready') {
			this.logService.info(`[cli-ts] serve ready: ${JSON.stringify(record.payload)}`);
			return;
		}
		const requestId = record.requestId;
		if (!requestId) {
			if (record.type === 'serve:error') {
				this.logService.warn(`[cli-ts] serve error: ${JSON.stringify(record.payload)}`);
			}
			return;
		}
		const pending = this.pending.get(requestId);
		if (!pending) {
			return;
		}
		this.pending.delete(requestId);
		if (record.type === 'serve:error') {
			const payload = record.payload as { error?: string } | undefined;
			pending.reject(new Error(payload?.error ?? 'cli-ts serve request failed.'));
		} else {
			pending.resolve(record);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	/**
	 * Resolves how to start cli-ts, in priority order:
	 *  1. `BACKBOARD_CLI_TS_PATH` / `VSCODE_BACKBOARD_CLI_TS_PATH` env override.
	 *  2. The packaged binary `extensions/backboard/bin/backboard-cli-ts(.exe)`.
	 *  3. Dev fallback: `<resolved bun> run <appRoot>/cli-ts/src/entrypoints/cli.tsx`.
	 */
	private resolveCliTsInvocation(): CliTsInvocation {
		return resolveCliTsInvocation(this.logService);
	}
}

/**
 * Maps the IDE's persisted Backboard credentials (same source the Rust bridge
 * used: `~/.backboard_ide/config.json` overridden by `BACKBOARD_*` env vars)
 * onto the env vars cli-ts reads, so the serve process authenticates as the
 * IDE user without a separate `backboard login`.
 */
export function cliTsCredentialEnv(): Record<string, string> {
	const config = bridgeConfig();
	const out: Record<string, string> = {};
	if (typeof config.apiKey === 'string' && config.apiKey) {
		out['BACKBOARD_API_KEY'] = config.apiKey;
	}
	if (typeof config.apiUrl === 'string' && config.apiUrl) {
		out['BACKBOARD_API_URL'] = config.apiUrl;
	}
	return out;
}
