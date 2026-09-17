/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { bridgeConfig } from './backboardRuntimeShared.js';
import { CLI_TS_HOST_MANAGED_BYOK_CAPABILITY, type CliTsAgentEvent, type CliTsReadyPayload, type CliTsRecord, type CliTsServeControl, isCliTsRecord } from './cliTsProtocol.js';

/** Tells cli-ts that provider keys come only from the host, never from `~/.backboard/keys.json`. */
const HOST_MANAGED_KEYS_ENV = 'BACKBOARD_HOST_MANAGED_KEYS';

/** How long a child asked to shut down gets before it is killed. */
const SHUTDOWN_GRACE_MS = 2000;

/** The `setCredentials` control minus the request id the process assigns. */
export type CliTsCredentialSnapshot = Omit<Extract<CliTsServeControl, { op: 'setCredentials' }>, 'requestId'>;

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
export function resolveCliTsInvocation(logService: ILogService, appRoot = dirname(FileAccess.asFileUri('').fsPath)): CliTsInvocation {
	const envPath = process.env['BACKBOARD_CLI_TS_PATH']?.trim() || process.env['VSCODE_BACKBOARD_CLI_TS_PATH']?.trim();
	if (envPath) {
		return { command: envPath, args: [] };
	}
	const executable = process.platform === 'win32' ? 'backboard-cli-ts.exe' : 'backboard-cli-ts';
	const devEntrypoint = join(appRoot, 'cli-ts', 'src', 'entrypoints', 'cli.tsx');
	const resolveDevInvocation = (): CliTsInvocation => {
		const bunPath = resolveBunCommand();
		if (bunPath) {
			return { command: bunPath, args: ['run', devEntrypoint] };
		}
		throw new Error(`cli-ts dev entrypoint exists at ${devEntrypoint}, but Bun is not available. Install Bun, set BACKBOARD_BUN_PATH to a Bun executable, or set BACKBOARD_CLI_TS_PATH to a freshly built runtime.`);
	};
	// A checkout may contain yesterday's release binary. Dev windows must run
	// today's source so the workbench and runtime speak the same control protocol.
	if (process.env['VSCODE_DEV'] && fs.existsSync(devEntrypoint)) {
		return resolveDevInvocation();
	}
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
	if (fs.existsSync(devEntrypoint)) {
		return resolveDevInvocation();
	}
	throw new Error(`cli-ts binary not found. Build it with: npm --prefix extensions/backboard run package-cli-ts (looked at ${candidates.join(', ')})`);
}

export interface CliTsCommandOptions {
	/**
	 * Text written to the child's stdin, then closed. The only sanctioned way
	 * to hand a secret to a one-shot command: never argv, never the environment,
	 * and never logged here.
	 */
	readonly stdin?: string;
	/** Kills the child and rejects when it runs longer than this. */
	readonly timeoutMs?: number;
}

/** Runs a one-shot cli-ts command using the same executable as IDE sessions. */
export function runCliTsCommand(logService: ILogService, args: readonly string[], options: CliTsCommandOptions = {}): Promise<string> {
	const invocation = resolveCliTsInvocation(logService);
	return new Promise<string>((resolve, reject) => {
		const child = spawn(invocation.command, [...invocation.args, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, ...cliTsCredentialEnv() },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = options.timeoutMs !== undefined
			? setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, options.timeoutMs)
			: undefined;
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once('error', error => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', code => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Backboard CLI command timed out after ${options.timeoutMs}ms`));
				return;
			}
			if (code === 0) {
				resolve(stdout.trim());
				return;
			}
			const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
			reject(new Error(`Backboard CLI command failed: ${detail}`));
		});
		// stdin is always a pipe so the child never inherits the host's. It is
		// closed immediately when there is nothing to hand over.
		child.stdin.on('error', () => { /* the exit handler reports the failure */ });
		child.stdin.end(options.stdin ?? '');
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
	/**
	 * Called once when the process reports `serve:ready`, i.e. it is about to
	 * read control lines. Used to push state the process cannot read from disk
	 * (the IDE-owned MCP server set) into a freshly started run.
	 */
	readonly onReady?: () => void;
	/**
	 * The host's credential snapshot for this runtime. It is written after
	 * every spawn, once the child has announced itself and proved it honours
	 * host-managed keys, and every request or notification waits until the
	 * child has acknowledged it. A runtime without the capability never
	 * receives the snapshot; every request addressed to it fails with an
	 * update message instead.
	 */
	readonly credentialSnapshot?: () => CliTsCredentialSnapshot;
	readonly readyTimeoutMs?: number;
	readonly credentialAckTimeoutMs?: number;
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
	/** Settles with the `serve:ready` payload of the current child, or rejects when it dies first. */
	private ready: DeferredPromise<CliTsReadyPayload> | undefined;
	/** Resolves once the current child may receive traffic; rejects when it never can. */
	private gate: Promise<void> = Promise.resolve();
	/** Settles when the current child has exited. */
	private exit: DeferredPromise<void> | undefined;
	/** Set once the startup credential snapshot was written to the current child. */
	private snapshotWritten = false;
	private gateOpened = false;
	/** Why the host ended the child; reported instead of the generic exit message. */
	private terminationReason: string | undefined;
	/** The failure that ended the current child, for traffic released after it. */
	private lastFailure: Error | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly options: CliTsServeProcessOptions,
	) {
		super();
	}

	get isRunning(): boolean {
		return this.child !== null && !this.exited;
	}

	/**
	 * Resolves once the running child has announced itself. Spawns the child if
	 * needed. Callers that must know the runtime's capabilities before sending
	 * a turn wait on this; ordinary turns need not.
	 */
	whenReady(): Promise<CliTsReadyPayload> {
		this.ensureProcess();
		return this.ready!.p;
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

	/**
	 * True once the startup credential snapshot has been written to the running
	 * child. From then on a changed snapshot must be pushed explicitly; before
	 * that, the startup handshake reads the host's keys when the child becomes
	 * ready, so a change made meanwhile is already part of its snapshot.
	 */
	get credentialSnapshotWritten(): boolean {
		return this.isRunning && this.snapshotWritten;
	}

	/** Resolves once the current child has exited; immediately when none is running. */
	whenExited(): Promise<void> {
		return this.exit && this.isRunning ? this.exit.p : Promise.resolve();
	}

	override dispose(): void {
		const child = this.child;
		if (child && !this.exited) {
			// Ask for a clean shutdown; the exit handler rejects any leftovers.
			this.shutdown(child);
		}
		this.child = null;
		this.rejectAll(new Error('cli-ts serve process disposed.'));
		super.dispose();
	}

	/**
	 * Ends the child now, without waiting for its work. Requests it still owes
	 * an answer to, including the turn it was running, fail with `reason`
	 * instead of the generic exit message. The next request spawns a fresh
	 * child, which receives the current credential snapshot on startup.
	 */
	terminate(reason: string): void {
		const child = this.child;
		if (!child || this.exited) {
			return;
		}
		this.terminationReason = reason;
		const failure = new Error(reason);
		this.lastFailure = failure;
		this.rejectAll(failure);
		if (this.ready) { this.settleReady(this.ready, failure); }
		this.logService.warn(`[cli-ts] terminating serve process: ${reason}`);
		this.shutdown(child);
	}

	/**
	 * Sends a correlated control op and resolves with its serve response
	 * record. Traffic waits for the startup handshake of the child it is
	 * addressed to, in call order.
	 */
	async request(control: CliTsServeControl & { requestId: string }): Promise<CliTsRecord> {
		const child = this.ensureProcess();
		await this.gate;
		return this.send(child, control);
	}

	/** Sends a fire-and-forget control op (responses, cancel), queued like a request. */
	notify(control: CliTsServeControl): void {
		if (!this.isRunning) {
			return;
		}
		if (control.op === 'cancel' && !this.gateOpened) {
			this.terminate(localize('cliTsProcess.startupCancelled', "Runtime startup cancelled."));
			return;
		}
		const child = this.ensureProcess();
		this.gate.then(() => this.write(child, control), () => undefined);
	}

	/** Generates a request id for correlated ops. */
	nextRequestId(): string {
		return generateUuid();
	}

	private send(child: ChildProcessWithoutNullStreams, control: CliTsServeControl & { requestId: string }): Promise<CliTsRecord> {
		return new Promise<CliTsRecord>((resolve, reject) => {
			this.pending.set(control.requestId, { resolve, reject });
			if (!this.write(child, control)) {
				this.pending.delete(control.requestId);
				reject(this.lastFailure ?? new Error('cli-ts serve process exited before the request could be sent.'));
			}
		}).then(record => {
			if (control.op === 'setCredentials') {
				const payload = record.payload as { op?: string; revision?: number } | undefined;
				if (record.type !== 'serve:ack' || payload?.op !== control.op || payload.revision !== control.revision) {
					const message = localize('cliTsProcess.invalidCredentialAck', "Runtime returned an invalid credential acknowledgement. Retry to restart it.");
					this.terminate(message);
					throw new Error(message);
				}
			}
			return record;
		});
	}

	/** Writes one control line to `child`, but only while it is still the live child. */
	private write(child: ChildProcessWithoutNullStreams, control: CliTsServeControl): boolean {
		if (child !== this.child || this.exited || this.terminationReason) {
			return false;
		}
		child.stdin.write(`${JSON.stringify(control)}\n`);
		return true;
	}

	private shutdown(child: ChildProcessWithoutNullStreams): void {
		try {
			child.stdin.write(`${JSON.stringify({ op: 'dispose' } satisfies CliTsServeControl)}\n`);
		} catch {
			// stdin may already be gone; SIGKILL below still applies.
		}
		const killHandle = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS);
		child.once('exit', () => clearTimeout(killHandle));
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
		// Provider keys reach the runtime only through the bootstrap snapshot on
		// stdin; the user's CLI key file must never bill an IDE turn.
		env[HOST_MANAGED_KEYS_ENV] = '1';
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
		this.snapshotWritten = false;
		this.gateOpened = false;
		this.terminationReason = undefined;
		this.lastFailure = undefined;
		const ready = new DeferredPromise<CliTsReadyPayload>();
		this.ready = ready;
		const exit = new DeferredPromise<void>();
		this.exit = exit;
		// A broken pipe (the child died mid-write) must not take the host down.
		child.stdin.on('error', error => this.logService.warn(`[cli-ts] stdin error: ${error.message}`));
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
			const failure = new Error(`cli-ts serve process failed to start: ${error.message}`);
			this.lastFailure = failure;
			this.rejectAll(failure);
			this.settleReady(ready, failure);
			exit.complete();
			this.options.onExit?.(null, null);
		});
		child.on('exit', (code, signal) => {
			this.logService.warn(`[cli-ts] serve process exited code=${code} signal=${signal}`);
			this.exited = true;
			this.child = null;
			const failure = new Error(this.describeUnexpectedExit(code, signal));
			this.lastFailure = failure;
			this.rejectAll(failure);
			this.settleReady(ready, failure);
			exit.complete();
			this.options.onExit?.(code, signal);
		});
		const gate = this.openGate(child, ready.p);
		// A child started only to prewarm may never be awaited; its rejection
		// must not surface as unhandled. Traffic observes it through request().
		gate.catch(() => undefined);
		this.gate = gate;
		return child;
	}

	/**
	 * The startup handshake: wait for `serve:ready`, refuse a runtime that does
	 * not honour host-managed keys, then hand over the credential snapshot and
	 * wait for its acknowledgement. Only then may ordinary traffic flow, so a
	 * turn can never start on a runtime that still reads its own key file or
	 * holds a stale key set. Nothing is sent to a runtime that fails the check.
	 */
	private async openGate(child: ChildProcessWithoutNullStreams, ready: Promise<CliTsReadyPayload>): Promise<void> {
		const snapshot = this.options.credentialSnapshot;
		if (!snapshot) {
			this.gateOpened = true;
			return;
		}
		try {
			const payload = await this.startupDeadline(ready, this.options.readyTimeoutMs ?? 30_000, localize('cliTsProcess.readyTimeout', "Runtime did not become ready. Retry to restart it."));
			if (!payload.capabilities?.includes(CLI_TS_HOST_MANAGED_BYOK_CAPABILITY)) {
				throw new Error(localize('cliTsProcess.runtimeTooOld', "The bundled Backboard runtime does not support the current API key protocol. Update Backboard, or rebuild it with: npm --prefix extensions/backboard run package-cli-ts"));
			}
			const control = { ...snapshot(), requestId: this.nextRequestId() };
			this.snapshotWritten = true;
			await this.startupDeadline(this.send(child, control), this.options.credentialAckTimeoutMs ?? 5_000, localize('cliTsProcess.credentialTimeout', "Runtime did not acknowledge its API keys. Retry to restart it."));
			this.gateOpened = true;
		} catch (error) {
			this.terminate(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	private async startupDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([promise, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			})]);
		} finally {
			clearTimeout(timer);
		}
	}

	private settleReady(ready: DeferredPromise<CliTsReadyPayload>, failure: Error): void {
		if (!ready.isSettled) {
			// Nobody may be waiting; an unobserved rejection must not surface.
			ready.p.catch(() => undefined);
			ready.error(failure);
		}
	}

	/**
	 * Builds an actionable message for an unexpected serve-process exit. The
	 * common failure is macOS killing the packaged binary on first exec because
	 * `bun --compile` appends the JS bundle after ad-hoc signing (invalidating
	 * the signature) — the process dies before producing any output, usually
	 * with SIGKILL. Re-signing during packaging fixes it.
	 */
	private describeUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): string {
		if (this.terminationReason) {
			return this.terminationReason;
		}
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
			const payload = (record.payload && typeof record.payload === 'object' ? record.payload : {}) as CliTsReadyPayload;
			if (this.ready && !this.ready.isSettled) {
				this.ready.complete(payload);
			}
			try {
				this.options.onReady?.();
			} catch (error) {
				this.logService.warn(`[cli-ts] onReady callback failed: ${error instanceof Error ? error.message : String(error)}`);
			}
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
