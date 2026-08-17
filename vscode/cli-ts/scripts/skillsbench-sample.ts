#!/usr/bin/env bun

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CLI_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_SAMPLE = path.join(
	CLI_ROOT,
	"benchmarks",
	"skillsbench-stratified-20-v1.json",
);

interface SampleTask {
	category: string;
	difficulty: "easy" | "medium" | "hard";
	id: string;
}

interface SampleManifest {
	benchmark: "skillsbench";
	commit: string;
	condition: "with-skill";
	defaultModel: string;
	name: string;
	ref: string;
	selection: object;
	tasks: SampleTask[];
}

export interface SkillsBenchSampleOptions {
	concurrency: number;
	dryRun: boolean;
	heartbeatSeconds: number;
	help: boolean;
	jobsDir: string;
	model?: string;
	resume: boolean;
	samplePath: string;
}

interface TaskRunResult extends SampleTask {
	agentDurationMs: number;
	costUsd: number;
	error?: string;
	exitCode: number;
	inputTokens: number;
	outputTokens: number;
	passed: boolean;
	reward: number | null;
	skillInvocations: number;
	status: "completed" | "error";
	totalTokens: number;
	toolCalls: number;
	verifierDurationMs: number;
}

interface BatchSummary {
	completedTasks: number;
	costUsd: number;
	errors: number;
	inputTokens: number;
	meanReward: number | null;
	outputTokens: number;
	passedTasks: number;
	skillInvocations: number;
	totalTasks: number;
	totalTokens: number;
	toolCalls: number;
}

interface ChildConditionResult {
	agent?: {
		durationMs?: number;
		trace?: {
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
			skillInvocations?: number;
			toolCalls?: number;
			totalTokens?: number;
		};
	};
	passed?: boolean;
	reward?: number | null;
	verifier?: { durationMs?: number };
}

interface ChildSummary {
	model?: string;
	results?: ChildConditionResult[];
	taskId?: string;
}

export function parseSkillsBenchSampleArgs(
	argv: string[],
	cwd = CLI_ROOT,
): SkillsBenchSampleOptions {
	const options: SkillsBenchSampleOptions = {
		concurrency: 1,
		dryRun: false,
		heartbeatSeconds: 30,
		help: false,
		jobsDir: path.join(
			cwd,
			"benchmark-results",
			"skillsbench",
			`sample-20-${timestamp()}`,
		),
		resume: true,
		samplePath: DEFAULT_SAMPLE,
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument || argument === "--") continue;
		switch (argument) {
			case "--concurrency":
				options.concurrency = positiveInteger(
					readValue(argv, ++index, argument),
					argument,
				);
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--heartbeat-seconds":
				options.heartbeatSeconds = positiveInteger(
					readValue(argv, ++index, argument),
					argument,
				);
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--jobs-dir":
				options.jobsDir = path.resolve(cwd, readValue(argv, ++index, argument));
				break;
			case "--model":
				options.model = readValue(argv, ++index, argument);
				break;
			case "--restart":
				options.resume = false;
				break;
			case "--sample":
				options.samplePath = path.resolve(
					cwd,
					readValue(argv, ++index, argument),
				);
				break;
			default:
				throw new Error(`Unknown SkillsBench sample option: ${argument}`);
		}
	}

	if (options.model && !/^[^\s/]+\/[^\s/]+$/.test(options.model)) {
		throw new Error("--model must use provider/model format");
	}
	return options;
}

export function summarizeBatchResults(
	results: TaskRunResult[],
	totalTasks: number,
): BatchSummary {
	const evaluated = results.filter((result) => result.reward !== null);
	return {
		completedTasks: results.filter((result) => result.status === "completed")
			.length,
		costUsd: sum(results, (result) => result.costUsd),
		errors: results.filter((result) => result.status === "error").length,
		inputTokens: sum(results, (result) => result.inputTokens),
		meanReward:
			evaluated.length > 0
				? sum(evaluated, (result) => result.reward ?? 0) / evaluated.length
				: null,
		outputTokens: sum(results, (result) => result.outputTokens),
		passedTasks: results.filter((result) => result.passed).length,
		skillInvocations: sum(results, (result) => result.skillInvocations),
		totalTasks,
		totalTokens: sum(results, (result) => result.totalTokens),
		toolCalls: sum(results, (result) => result.toolCalls),
	};
}

async function main(): Promise<void> {
	const options = parseSkillsBenchSampleArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(usage());
		return;
	}
	const sample = await readSampleManifest(options.samplePath);
	const model = options.model ?? sample.defaultModel;
	await mkdir(path.join(options.jobsDir, "tasks"), { recursive: true });
	await writeJson(path.join(options.jobsDir, "batch-manifest.json"), {
		...sample,
		createdAt: new Date().toISOString(),
		model,
		samplePath: options.samplePath,
	});

	process.stdout.write(
		`${sample.name}: ${sample.tasks.length} tasks, model=${model}, condition=${sample.condition}, concurrency=${options.concurrency}\n`,
	);
	if (options.dryRun) {
		for (const [index, task] of sample.tasks.entries()) {
			process.stdout.write(
				`${index + 1}. ${task.id} (${task.category}, ${task.difficulty})\n`,
			);
		}
		return;
	}

	const resultsByIndex = new Map<number, TaskRunResult>();
	let nextIndex = 0;
	let stopRequested = false;
	let summaryWrite = Promise.resolve();
	const workers = Array.from(
		{ length: Math.min(options.concurrency, sample.tasks.length) },
		async () => {
			while (!stopRequested) {
				const index = nextIndex++;
				const task = sample.tasks[index];
				if (!task) return;
				const position = index + 1;
				const taskDirectory = path.join(options.jobsDir, "tasks", task.id);
				const cached = options.resume
					? await readCompletedTask(taskDirectory, task, model)
					: null;
				let result: TaskRunResult;
				if (cached) {
					process.stdout.write(
						`[${position}/${sample.tasks.length}] ${task.id}: resumed reward=${formatReward(cached.reward)}\n`,
					);
					result = cached;
				} else {
					result = await runTask(options, sample, task, model, position);
				}
				resultsByIndex.set(index, result);
				const snapshot = orderedResults(resultsByIndex);
				summaryWrite = summaryWrite.then(() =>
					writeBatchSummary(options.jobsDir, sample, model, snapshot),
				);
				await summaryWrite;
				if (result.status === "error") stopRequested = true;
			}
		},
	);
	await Promise.all(workers);
	await summaryWrite;
	const results = orderedResults(resultsByIndex);
	const failed = results.filter((result) => result.status === "error");
	if (failed.length > 0) {
		process.stderr.write(
			`Sample stopped after ${failed.map((result) => result.id).join(", ")} failed before producing an evaluation result. Fix the infrastructure issue and rerun the same command to resume.\n`,
		);
		process.stderr.write(`Artifacts: ${options.jobsDir}\n`);
		process.exitCode = 1;
		return;
	}

	const aggregate = summarizeBatchResults(results, sample.tasks.length);
	process.stdout.write(
		`Sample complete: score=${formatReward(aggregate.meanReward)}, passed=${aggregate.passedTasks}/${sample.tasks.length}, cost=$${aggregate.costUsd.toFixed(4)}\n`,
	);
	process.stdout.write(`Artifacts: ${options.jobsDir}\n`);
	if (aggregate.errors > 0) process.exitCode = 1;
}

async function runTask(
	options: SkillsBenchSampleOptions,
	sample: SampleManifest,
	task: SampleTask,
	model: string,
	position: number,
): Promise<TaskRunResult> {
	const taskDirectory = path.join(options.jobsDir, "tasks", task.id);
	await mkdir(taskDirectory, { recursive: true });
	process.stdout.write(
		`[${position}/${sample.tasks.length}] ${task.id}: starting\n`,
	);
	const started = Date.now();
	const child = Bun.spawn(
		[
			"bun",
			"run",
			path.join(CLI_ROOT, "scripts", "skillsbench-eval.ts"),
			"--model",
			model,
			"--condition",
			sample.condition,
			"--task",
			task.id,
			"--ref",
			sample.ref,
			"--jobs-dir",
			taskDirectory,
			"--quiet",
		],
		{
			cwd: CLI_ROOT,
			env: process.env,
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const heartbeat = setInterval(() => {
		const elapsedMinutes = ((Date.now() - started) / 60_000).toFixed(1);
		process.stdout.write(
			`[${position}/${sample.tasks.length}] ${task.id}: running ${elapsedMinutes}m\n`,
		);
	}, options.heartbeatSeconds * 1_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearInterval(heartbeat);
	await writeFile(path.join(taskDirectory, "runner.stdout.log"), stdout);
	await writeFile(path.join(taskDirectory, "runner.stderr.log"), stderr);

	const summary = await readChildSummary(taskDirectory);
	const result = summary
		? taskResultFromSummary(task, summary, exitCode)
		: emptyTaskResult(
				task,
				exitCode,
				stderr.trim() || stdout.trim() || "Child run produced no summary",
			);
	process.stdout.write(
		`[${position}/${sample.tasks.length}] ${task.id}: reward=${formatReward(result.reward)}, cost=$${result.costUsd.toFixed(4)}, tools=${result.toolCalls}, skills=${result.skillInvocations}\n`,
	);
	return result;
}

async function readSampleManifest(filePath: string): Promise<SampleManifest> {
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
	if (!isRecord(parsed) || parsed.benchmark !== "skillsbench") {
		throw new Error(`Invalid SkillsBench sample manifest: ${filePath}`);
	}
	const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
	if (tasks.length === 0 || !tasks.every(isSampleTask)) {
		throw new Error(`SkillsBench sample has no valid tasks: ${filePath}`);
	}
	const ids = tasks.map((task) => task.id);
	if (new Set(ids).size !== ids.length) {
		throw new Error(
			`SkillsBench sample contains duplicate task ids: ${filePath}`,
		);
	}
	if (
		typeof parsed.name !== "string" ||
		typeof parsed.ref !== "string" ||
		typeof parsed.commit !== "string" ||
		typeof parsed.defaultModel !== "string" ||
		parsed.condition !== "with-skill" ||
		!isRecord(parsed.selection)
	) {
		throw new Error(`SkillsBench sample metadata is incomplete: ${filePath}`);
	}
	return {
		benchmark: "skillsbench",
		commit: parsed.commit,
		condition: "with-skill",
		defaultModel: parsed.defaultModel,
		name: parsed.name,
		ref: parsed.ref,
		selection: parsed.selection,
		tasks,
	};
}

async function readCompletedTask(
	taskDirectory: string,
	task: SampleTask,
	model: string,
): Promise<TaskRunResult | null> {
	const summary = await readChildSummary(taskDirectory);
	if (!summary || summary.model !== model || summary.taskId !== task.id)
		return null;
	return taskResultFromSummary(task, summary, 0);
}

async function readChildSummary(
	taskDirectory: string,
): Promise<ChildSummary | null> {
	const filePath = path.join(taskDirectory, "summary.json");
	if (!(await exists(filePath))) return null;
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as ChildSummary;
	} catch {
		return null;
	}
}

function taskResultFromSummary(
	task: SampleTask,
	summary: ChildSummary,
	exitCode: number,
): TaskRunResult {
	const condition = summary.results?.[0];
	const trace = condition?.agent?.trace;
	const reward =
		typeof condition?.reward === "number" && Number.isFinite(condition.reward)
			? condition.reward
			: null;
	return {
		...task,
		agentDurationMs: finiteNumber(condition?.agent?.durationMs),
		costUsd: finiteNumber(trace?.costUsd),
		error:
			condition && reward === null
				? "Verifier did not produce a numeric reward"
				: undefined,
		exitCode,
		inputTokens: finiteNumber(trace?.inputTokens),
		outputTokens: finiteNumber(trace?.outputTokens),
		passed: condition?.passed === true,
		reward,
		skillInvocations: finiteNumber(trace?.skillInvocations),
		status: condition && reward !== null ? "completed" : "error",
		totalTokens: finiteNumber(trace?.totalTokens),
		toolCalls: finiteNumber(trace?.toolCalls),
		verifierDurationMs: finiteNumber(condition?.verifier?.durationMs),
	};
}

function orderedResults(
	resultsByIndex: ReadonlyMap<number, TaskRunResult>,
): TaskRunResult[] {
	return [...resultsByIndex.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, result]) => result);
}

function emptyTaskResult(
	task: SampleTask,
	exitCode: number,
	error: string,
): TaskRunResult {
	return {
		...task,
		agentDurationMs: 0,
		costUsd: 0,
		error: error.slice(-2_000),
		exitCode,
		inputTokens: 0,
		outputTokens: 0,
		passed: false,
		reward: null,
		skillInvocations: 0,
		status: "error",
		totalTokens: 0,
		toolCalls: 0,
		verifierDurationMs: 0,
	};
}

async function writeBatchSummary(
	jobsDir: string,
	sample: SampleManifest,
	model: string,
	results: TaskRunResult[],
): Promise<void> {
	await writeJson(path.join(jobsDir, "summary.json"), {
		aggregate: summarizeBatchResults(results, sample.tasks.length),
		benchmark: sample.benchmark,
		condition: sample.condition,
		model,
		results,
		sample: sample.name,
		updatedAt: new Date().toISOString(),
	});
}

function isSampleTask(value: unknown): value is SampleTask {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		/^[a-z0-9][a-z0-9-]*$/.test(value.id) &&
		typeof value.category === "string" &&
		(value.difficulty === "easy" ||
			value.difficulty === "medium" ||
			value.difficulty === "hard")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sum<T>(items: T[], value: (item: T) => number): number {
	return items.reduce((total, item) => total + value(item), 0);
}

function readValue(argv: string[], index: number, option: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} must be a positive integer`);
	}
	return parsed;
}

async function exists(filePath: string): Promise<boolean> {
	return (await stat(filePath).catch(() => null)) !== null;
}

function formatReward(reward: number | null): string {
	return reward === null ? "missing" : reward.toFixed(4);
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath: string, value: object): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function usage(): string {
	return `Backboard SkillsBench sample runner

Usage:
  bun run test:skillsbench:sample -- [options]

Options:
  --model <provider/model>   Backboard model (default: sample manifest value)
  --sample <path>            Sample manifest JSON
  --jobs-dir <path>          Stable artifact directory for resumable runs
  --concurrency <n>          Tasks to evaluate in parallel (default: 1)
  --heartbeat-seconds <n>    Progress interval (default: 30)
  --restart                  Ignore completed task summaries
  --dry-run                  Validate and print the sample without model calls
  --help                     Show this message

Runs one with-skill trial per task, sequentially. Reusing the same jobs directory
skips completed matching task/model summaries and continues an interrupted run.
`;
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}
