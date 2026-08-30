#!/usr/bin/env bun
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Live end-to-end benchmark for the IDE's cli-ts chat bridge.
 *
 * Each sample starts a fresh `--serve` process, waits for it to be ready, then
 * measures from writing a submit control to receiving the first non-empty
 * `assistant:delta`. Multiple agents in a round are submitted concurrently to
 * model the Advanced Mode parallel-session workflow.
 *
 * This script makes real model requests. It is intentionally not part of
 * `bun test` or `bun run validate`.
 */

interface BenchmarkOptions {
	agents: number;
	rounds: number;
	timeoutMs: number;
	prompt: string;
	workingDirectory: string;
	model?: string;
	output?: string;
	warmup: boolean;
}

interface ServeRecord {
	source: "client" | "serve";
	type: string;
	requestId?: string;
	payload?: Record<string, unknown>;
}

interface ReadyInfo {
	model: string;
	startupMs: number;
}

interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	provider?: string;
	model?: string;
}

interface SampleResult {
	round: number;
	agent: number;
	model: string;
	startupMs: number;
	firstModelOutputMs: number | null;
	firstVisibleTokenMs: number | null;
	totalResponseMs: number;
	usage?: UsageInfo;
}

interface MetricSummary {
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
}

interface BenchmarkReport {
	benchmark: "ide-chat-first-visible-token";
	createdAt: string;
	definition: string;
	configuration: {
		agentsPerRound: number;
		rounds: number;
		samples: number;
		prompt: string;
		workingDirectory: string;
		requestedModel?: string;
		warmup: boolean;
	};
	samples: SampleResult[];
	summary: {
		startupMs: MetricSummary;
		firstModelOutputMs: MetricSummary | null;
		firstVisibleTokenMs: MetricSummary | null;
		totalResponseMs: MetricSummary;
	};
}

interface ActiveTurn {
	requestId: string;
	startedAt: number;
	firstModelOutputMs: number | null;
	firstVisibleTokenMs: number | null;
	usage?: UsageInfo;
	resolve: (
		result: Omit<SampleResult, "round" | "agent" | "model" | "startupMs">,
	) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface PendingServeRecord {
	type: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "src", "entrypoints", "cli.tsx");
const FIRST_TOKEN_DEFINITION =
	"Elapsed time from writing the IDE submit control to the first non-empty assistant:delta emitted by the CLI harness.";

class ServeAgent {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly startedAt = performance.now();
	private readonly ready: Promise<ReadyInfo>;
	private readonly pendingServeRecords = new Map<string, PendingServeRecord>();
	private resolveReady!: (ready: ReadyInfo) => void;
	private rejectReady!: (error: Error) => void;
	private activeTurn: ActiveTurn | null = null;
	private stderrTail: string[] = [];
	private selectedModel = "unknown";
	private startupMs = 0;
	private exited = false;
	private isReady = false;

	constructor(
		private readonly id: string,
		workingDirectory: string,
		private readonly timeoutMs: number,
	) {
		this.ready = new Promise<ReadyInfo>((resolveReady, rejectReady) => {
			this.resolveReady = resolveReady;
			this.rejectReady = rejectReady;
		});

		this.child = spawn(
			process.execPath,
			["run", ENTRYPOINT, "--serve", "--cwd", workingDirectory],
			{
				cwd: PACKAGE_ROOT,
				env: {
					...process.env,
					BACKBOARD_SESSION_ID: `ttft-${id}`,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		createInterface({ input: this.child.stdout }).on("line", (line) => {
			this.handleLine(line);
		});
		createInterface({ input: this.child.stderr }).on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			this.stderrTail.push(trimmed);
			this.stderrTail = this.stderrTail.slice(-10);
		});
		this.child.on("error", (error) => this.handleExit(error));
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			if (code !== 0 || !this.isReady || this.activeTurn !== null) {
				this.handleExit(
					new Error(
						`Agent ${this.id} exited before completing (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
					),
				);
			}
		});
	}

	async waitUntilReady(): Promise<ReadyInfo> {
		return withTimeout(
			this.ready,
			this.timeoutMs,
			`Agent ${this.id} did not become ready`,
		);
	}

	async warmup(): Promise<void> {
		const requestId = `${this.id}-warmup`;
		const response = this.waitForServeRecord("serve:warm", requestId);
		this.write({ op: "warmup", requestId });
		await response;
	}

	async submit(
		prompt: string,
		model: string | undefined,
	): Promise<Omit<SampleResult, "round" | "agent" | "model" | "startupMs">> {
		if (this.activeTurn) {
			throw new Error(`Agent ${this.id} already has an active turn.`);
		}
		const requestId = `${this.id}-submit`;
		return new Promise((resolveTurn, rejectTurn) => {
			const timeout = setTimeout(() => {
				this.write({ op: "cancel", requestId: `${requestId}-timeout` });
				this.activeTurn = null;
				rejectTurn(
					new Error(
						`Agent ${this.id} did not finish within ${this.timeoutMs}ms.`,
					),
				);
			}, this.timeoutMs);
			this.activeTurn = {
				requestId,
				startedAt: performance.now(),
				firstModelOutputMs: null,
				firstVisibleTokenMs: null,
				resolve: resolveTurn,
				reject: rejectTurn,
				timeout,
			};
			this.write({
				op: "submit",
				requestId,
				prompt,
				...(model ? { model } : {}),
				thinking: "off",
				memory: "off",
				permission: "manual",
				clientTools: [],
			});
		});
	}

	get readyInfo(): ReadyInfo {
		return { model: this.selectedModel, startupMs: this.startupMs };
	}

	async dispose(): Promise<void> {
		if (this.exited) return;
		this.write({ op: "dispose" });
		await Promise.race([
			new Promise<void>((resolveExit) =>
				this.child.once("exit", () => resolveExit()),
			),
			new Promise<void>((resolveTimeout) =>
				setTimeout(() => resolveTimeout(), 2_000),
			),
		]);
		if (!this.exited) this.child.kill("SIGTERM");
	}

	private handleLine(line: string): void {
		let record: ServeRecord;
		try {
			record = JSON.parse(line) as ServeRecord;
		} catch {
			return;
		}
		if (
			(record.source !== "client" && record.source !== "serve") ||
			typeof record.type !== "string"
		) {
			return;
		}

		if (record.source === "serve" && record.type === "serve:ready") {
			this.startupMs = elapsed(this.startedAt);
			this.selectedModel = stringField(record.payload, "model") ?? "unknown";
			this.isReady = true;
			this.resolveReady(this.readyInfo);
			return;
		}
		if (record.source === "serve" && record.requestId) {
			const pending = this.pendingServeRecords.get(record.requestId);
			if (pending && record.type === pending.type) {
				clearTimeout(pending.timeout);
				this.pendingServeRecords.delete(record.requestId);
				pending.resolve();
				return;
			}
			if (pending && record.type === "serve:error") {
				clearTimeout(pending.timeout);
				this.pendingServeRecords.delete(record.requestId);
				pending.reject(
					new Error(
						stringField(record.payload, "error") ??
							`Agent ${this.id} returned serve:error.`,
					),
				);
				return;
			}
		}

		const active = this.activeTurn;
		if (!active) return;
		if (
			record.source === "serve" &&
			record.type === "serve:error" &&
			record.requestId === active.requestId
		) {
			this.failActiveTurn(
				new Error(
					stringField(record.payload, "error") ??
						`Agent ${this.id} returned serve:error.`,
				),
			);
			return;
		}
		if (record.source !== "client") return;

		const text = stringField(record.payload, "text");
		if (
			active.firstModelOutputMs === null &&
			(record.type === "assistant:reasoning" ||
				record.type === "assistant:delta") &&
			text
		) {
			active.firstModelOutputMs = elapsed(active.startedAt);
		}
		if (
			active.firstVisibleTokenMs === null &&
			record.type === "assistant:delta" &&
			text
		) {
			active.firstVisibleTokenMs = elapsed(active.startedAt);
		}
		if (record.type === "usage") {
			active.usage = usageField(record.payload);
		}
		if (record.type === "run:error") {
			this.failActiveTurn(
				new Error(
					stringField(record.payload, "error") ??
						`Agent ${this.id} emitted run:error.`,
				),
			);
			return;
		}
		if (record.type !== "turn:end") return;

		const status = stringField(record.payload, "status");
		if (status !== "completed") {
			this.failActiveTurn(
				new Error(`Agent ${this.id} ended with status ${status ?? "unknown"}.`),
			);
			return;
		}
		clearTimeout(active.timeout);
		this.activeTurn = null;
		active.resolve({
			firstModelOutputMs: active.firstModelOutputMs,
			firstVisibleTokenMs: active.firstVisibleTokenMs,
			totalResponseMs: elapsed(active.startedAt),
			...(active.usage ? { usage: active.usage } : {}),
		});
	}

	private waitForServeRecord(type: string, requestId: string): Promise<void> {
		return new Promise((resolveRecord, rejectRecord) => {
			const timeout = setTimeout(() => {
				this.pendingServeRecords.delete(requestId);
				rejectRecord(
					new Error(`Agent ${this.id} did not return ${type} in time.`),
				);
			}, this.timeoutMs);
			this.pendingServeRecords.set(requestId, {
				type,
				resolve: resolveRecord,
				reject: rejectRecord,
				timeout,
			});
		});
	}

	private write(value: Record<string, unknown>): void {
		if (this.exited || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	private failActiveTurn(error: Error): void {
		const active = this.activeTurn;
		if (!active) return;
		clearTimeout(active.timeout);
		this.activeTurn = null;
		active.reject(error);
	}

	private handleExit(error: Error): void {
		const stderr = this.stderrTail.length
			? ` Last stderr: ${this.stderrTail.join(" | ")}`
			: "";
		const detailed = new Error(`${error.message}${stderr}`);
		if (!this.isReady) this.rejectReady(detailed);
		this.failActiveTurn(detailed);
		for (const pending of this.pendingServeRecords.values()) {
			clearTimeout(pending.timeout);
			pending.reject(detailed);
		}
		this.pendingServeRecords.clear();
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const results: SampleResult[] = [];
	process.stdout.write(
		`Running ${options.rounds} round(s) with ${options.agents} fresh agent(s) per round.\n`,
	);
	process.stdout.write(`${FIRST_TOKEN_DEFINITION}\n`);

	for (let round = 1; round <= options.rounds; round++) {
		process.stdout.write(
			`\nRound ${round}/${options.rounds}: starting agents...\n`,
		);
		const stamp = `${Date.now()}-${round}`;
		const agents = Array.from(
			{ length: options.agents },
			(_, index) =>
				new ServeAgent(
					`${stamp}-${index + 1}`,
					options.workingDirectory,
					options.timeoutMs,
				),
		);
		try {
			await Promise.all(agents.map((agent) => agent.waitUntilReady()));
			if (options.warmup) {
				await Promise.all(agents.map((agent) => agent.warmup()));
			}
			process.stdout.write(
				`Round ${round}/${options.rounds}: sending chats...\n`,
			);
			const roundResults = await Promise.all(
				agents.map((agent) => agent.submit(options.prompt, options.model)),
			);
			for (let index = 0; index < roundResults.length; index++) {
				const ready = agents[index]?.readyInfo;
				const result = roundResults[index];
				if (!ready || !result) continue;
				const sample: SampleResult = {
					round,
					agent: index + 1,
					model:
						result.usage?.provider && result.usage.model
							? `${result.usage.provider}/${result.usage.model}`
							: (options.model ?? ready.model),
					startupMs: ready.startupMs,
					...result,
				};
				results.push(sample);
				process.stdout.write(`${formatSample(sample)}\n`);
			}
		} finally {
			await Promise.allSettled(agents.map((agent) => agent.dispose()));
		}
	}

	const report = createReport(options, results);
	printSummary(report);
	if (options.output) {
		const outputPath = isAbsolute(options.output)
			? options.output
			: resolve(process.cwd(), options.output);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		process.stdout.write(`\nSaved JSON report to ${outputPath}\n`);
	}

	if (results.some((result) => result.firstVisibleTokenMs === null)) {
		process.stderr.write(
			"At least one completed turn did not emit a visible assistant token.\n",
		);
		process.exitCode = 1;
	}
}

function parseOptions(argv: string[]): BenchmarkOptions {
	const options: BenchmarkOptions = {
		agents: 1,
		rounds: 3,
		timeoutMs: 120_000,
		prompt: "Reply with exactly READY.",
		workingDirectory: process.cwd(),
		warmup: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!arg) continue;
		const [name, inlineValue] = arg.split("=", 2);
		const value = () => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[++index];
			if (!next) throw new Error(`${name} requires a value.`);
			return next;
		};
		switch (name) {
			case "--agents":
				options.agents = positiveInteger(value(), name);
				break;
			case "--rounds":
				options.rounds = positiveInteger(value(), name);
				break;
			case "--timeout-ms":
				options.timeoutMs = positiveInteger(value(), name);
				break;
			case "--prompt":
				options.prompt = value();
				break;
			case "--cwd":
				options.workingDirectory = resolve(value());
				break;
			case "--model":
				options.model = value();
				break;
			case "--output":
				options.output = value();
				break;
			case "--warmup":
				options.warmup = true;
				break;
			case "--help":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown option: ${name}`);
		}
	}
	return options;
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

function createReport(
	options: BenchmarkOptions,
	results: SampleResult[],
): BenchmarkReport {
	return {
		benchmark: "ide-chat-first-visible-token",
		createdAt: new Date().toISOString(),
		definition: FIRST_TOKEN_DEFINITION,
		configuration: {
			agentsPerRound: options.agents,
			rounds: options.rounds,
			samples: results.length,
			prompt: options.prompt,
			workingDirectory: options.workingDirectory,
			...(options.model ? { requestedModel: options.model } : {}),
			warmup: options.warmup,
		},
		samples: results,
		summary: {
			startupMs: summarize(results.map((result) => result.startupMs)),
			firstModelOutputMs: summarizeNullable(
				results.map((result) => result.firstModelOutputMs),
			),
			firstVisibleTokenMs: summarizeNullable(
				results.map((result) => result.firstVisibleTokenMs),
			),
			totalResponseMs: summarize(
				results.map((result) => result.totalResponseMs),
			),
		},
	};
}

function summarizeNullable(values: Array<number | null>): MetricSummary | null {
	const present = values.filter((value): value is number => value !== null);
	return present.length ? summarize(present) : null;
}

function summarize(values: number[]): MetricSummary {
	if (values.length === 0) {
		throw new Error("Cannot summarize an empty result set.");
	}
	const sorted = [...values].sort((left, right) => left - right);
	return {
		min: round(sorted[0] ?? 0),
		p50: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		max: round(sorted.at(-1) ?? 0),
		mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
	};
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 1) return sorted[0] ?? 0;
	const position = (sorted.length - 1) * fraction;
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sorted[lowerIndex] ?? 0;
	const upper = sorted[upperIndex] ?? lower;
	return lower + (upper - lower) * (position - lowerIndex);
}

function printSummary(report: BenchmarkReport): void {
	const models = [...new Set(report.samples.map((sample) => sample.model))];
	process.stdout.write("\nSummary\n");
	process.stdout.write(`Models: ${models.join(", ")}\n`);
	process.stdout.write(
		`${formatMetric("First visible token", report.summary.firstVisibleTokenMs)}\n`,
	);
	process.stdout.write(
		`${formatMetric("First model output", report.summary.firstModelOutputMs)}\n`,
	);
	process.stdout.write(
		`${formatMetric("Full response", report.summary.totalResponseMs)}\n`,
	);
	process.stdout.write(
		`${formatMetric("Agent startup", report.summary.startupMs)}\n`,
	);
}

function formatMetric(label: string, summary: MetricSummary | null): string {
	if (!summary) return `${label}: no samples`;
	return `${label}: p50 ${formatMs(summary.p50)}, p95 ${formatMs(summary.p95)}, min ${formatMs(summary.min)}, max ${formatMs(summary.max)}, mean ${formatMs(summary.mean)}`;
}

function formatSample(sample: SampleResult): string {
	const visible =
		sample.firstVisibleTokenMs === null
			? "no visible token"
			: `first token ${formatMs(sample.firstVisibleTokenMs)}`;
	return `  agent ${sample.agent}: ${visible}, complete ${formatMs(sample.totalResponseMs)}, startup ${formatMs(sample.startupMs)}`;
}

function usageField(payload: Record<string, unknown> | undefined): UsageInfo {
	const usage = recordField(payload, "usage");
	return {
		...(numberField(usage, "inputTokens") !== undefined
			? { inputTokens: numberField(usage, "inputTokens") }
			: {}),
		...(numberField(usage, "outputTokens") !== undefined
			? { outputTokens: numberField(usage, "outputTokens") }
			: {}),
		...(numberField(usage, "totalTokens") !== undefined
			? { totalTokens: numberField(usage, "totalTokens") }
			: {}),
		...(numberField(usage, "costUsd") !== undefined
			? { costUsd: numberField(usage, "costUsd") }
			: {}),
		...(stringField(usage, "provider")
			? { provider: stringField(usage, "provider") }
			: {}),
		...(stringField(usage, "model")
			? { model: stringField(usage, "model") }
			: {}),
	};
}

function recordField(
	record: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	const value = record?.[key];
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(
	record: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = record?.[key];
	return typeof value === "number" ? value : undefined;
}

function elapsed(startedAt: number): number {
	return round(performance.now() - startedAt);
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

function formatMs(value: number): string {
	return value < 1_000
		? `${Math.round(value)}ms`
		: `${(value / 1_000).toFixed(2)}s`;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`${message} in ${timeoutMs}ms.`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function printHelp(): void {
	process.stdout.write(`Chat first-token benchmark\n\n`);
	process.stdout.write(`Usage:\n`);
	process.stdout.write(`  bun run test:chat-ttft -- [options]\n\n`);
	process.stdout.write(`Options:\n`);
	process.stdout.write(
		`  --agents <n>       Fresh agents sent concurrently per round (default: 1)\n`,
	);
	process.stdout.write(`  --rounds <n>       Number of rounds (default: 3)\n`);
	process.stdout.write(
		`  --model <id>       Model override, for example openai/gpt-5.6-sol\n`,
	);
	process.stdout.write(
		`  --prompt <text>    Chat prompt (default: Reply with exactly READY.)\n`,
	);
	process.stdout.write(
		`  --cwd <path>       Workspace exposed to the agents (default: current directory)\n`,
	);
	process.stdout.write(
		`  --timeout-ms <n>   Per-startup and per-turn timeout (default: 120000)\n`,
	);
	process.stdout.write(
		`  --warmup           Warm DNS/TLS before measuring; off by default for first-send timing\n`,
	);
	process.stdout.write(`  --output <path>    Save the complete JSON report\n`);
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.stack : String(error)}\n`,
	);
	process.exit(1);
});
