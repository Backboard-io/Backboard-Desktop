#!/usr/bin/env bun

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from "node:crypto";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { resolveAuth } from "../src/config/auth.ts";

const CLI_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_TASK = "tictoc-unnecessary-abort-detection";
const DEFAULT_REF = "v1.1";
const SKILLSBENCH_REPOSITORY =
	"https://github.com/benchflow-ai/skillsbench.git";

type SkillsBenchCondition = "with-skill" | "no-skill";
type RequestedCondition = SkillsBenchCondition | "both";

export interface SkillsBenchOptions {
	cacheDir: string;
	condition: RequestedCondition;
	help: boolean;
	jobsDir: string;
	model?: string;
	prepareOnly: boolean;
	ref: string;
	stream: boolean;
	taskId: string;
}

interface TaskDefinition {
	agentTimeoutMs: number;
	cpus?: number;
	memoryMb?: number;
	prompt: string;
	verifierTimeoutMs: number;
}

interface CommandOptions {
	allowFailure?: boolean;
	cwd?: string;
	env?: Record<string, string | undefined>;
	input?: string;
	stream?: boolean;
	timeoutMs?: number;
}

interface CommandResult {
	durationMs: number;
	exitCode: number;
	stderr: string;
	stdout: string;
	timedOut: boolean;
}

interface AgentTraceSummary {
	costUsd: number;
	inputTokens: number;
	invalidLines: number;
	models: string[];
	outputTokens: number;
	skillInvocations: number;
	toolCalls: number;
	totalTokens: number;
}

interface PreparedBenchmark {
	binaryPath: string;
	checkoutDir: string;
	commit: string;
	image: string;
	task: TaskDefinition;
	taskDir: string;
	workingDirectory: string;
}

interface ConditionResult {
	agent: {
		durationMs: number;
		exitCode: number;
		timedOut: boolean;
		trace: AgentTraceSummary;
	};
	condition: SkillsBenchCondition;
	passed: boolean;
	reward: number | null;
	verifier: {
		durationMs: number;
		exitCode: number;
		timedOut: boolean;
	};
}

export function parseSkillsBenchArgs(
	argv: string[],
	cwd = CLI_ROOT,
): SkillsBenchOptions {
	const options: SkillsBenchOptions = {
		cacheDir: path.join(cwd, "benchmark-cache", "skillsbench"),
		condition: "with-skill",
		help: false,
		jobsDir: path.join(cwd, "benchmark-results", "skillsbench", timestamp()),
		prepareOnly: false,
		ref: DEFAULT_REF,
		stream: true,
		taskId: DEFAULT_TASK,
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument || argument === "--") continue;
		switch (argument) {
			case "--cache-dir":
				options.cacheDir = path.resolve(
					cwd,
					readValue(argv, ++index, argument),
				);
				break;
			case "--condition": {
				const condition = readValue(argv, ++index, argument);
				if (
					condition !== "with-skill" &&
					condition !== "no-skill" &&
					condition !== "both"
				) {
					throw new Error("--condition must be with-skill, no-skill, or both");
				}
				options.condition = condition;
				break;
			}
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
			case "--prepare-only":
				options.prepareOnly = true;
				break;
			case "--quiet":
				options.stream = false;
				break;
			case "--ref":
				options.ref = readValue(argv, ++index, argument);
				break;
			case "--task":
				options.taskId = readValue(argv, ++index, argument);
				break;
			default:
				throw new Error(`Unknown SkillsBench option: ${argument}`);
		}
	}

	validateTaskId(options.taskId);
	validateGitRef(options.ref);
	if (!options.help && !options.prepareOnly) validateModel(options.model);
	return options;
}

export function parseTaskDefinition(content: string): TaskDefinition {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
		content,
	);
	if (!match)
		throw new Error("SkillsBench task.md is missing YAML frontmatter");

	const document = parseDocument(match[1] ?? "");
	if (document.errors.length > 0) {
		throw new Error(
			`Invalid SkillsBench task.md: ${document.errors[0]?.message}`,
		);
	}
	const metadata = document.toJSON() as unknown;
	const root = recordValue(metadata);
	const agent = recordValue(root?.agent);
	const verifier = recordValue(root?.verifier);
	const environment = recordValue(root?.environment);
	const prompt = (match[2] ?? "").trim();
	if (!prompt) throw new Error("SkillsBench task.md has an empty prompt body");

	return {
		agentTimeoutMs: secondsToMilliseconds(
			numberValue(agent?.timeout_sec),
			1_800,
		),
		cpus: positiveNumber(environment?.cpus),
		memoryMb: positiveNumber(environment?.memory_mb),
		prompt,
		verifierTimeoutMs: secondsToMilliseconds(
			numberValue(verifier?.timeout_sec),
			600,
		),
	};
}

export function bunTargetForDockerArchitecture(architecture: string): string {
	switch (architecture.trim().toLowerCase()) {
		case "amd64":
		case "x86_64":
			return "bun-linux-x64";
		case "arm64":
		case "aarch64":
			return "bun-linux-arm64";
		default:
			throw new Error(
				`Docker architecture ${architecture.trim() || "(empty)"} is not supported`,
			);
	}
}

export function summarizeAgentTrace(ndjson: string): AgentTraceSummary {
	const summary: AgentTraceSummary = {
		costUsd: 0,
		inputTokens: 0,
		invalidLines: 0,
		models: [],
		outputTokens: 0,
		skillInvocations: 0,
		toolCalls: 0,
		totalTokens: 0,
	};
	const models = new Set<string>();

	for (const line of ndjson.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			summary.invalidLines++;
			continue;
		}
		const record = recordValue(parsed);
		const payload = recordValue(record?.payload);
		if (record?.type === "tool:requested") {
			const calls = Array.isArray(payload?.calls) ? payload.calls : [];
			summary.toolCalls += calls.length;
			for (const call of calls) {
				const item = recordValue(call);
				const name = stringValue(item?.name)?.toLowerCase();
				if (name === "findskill" || name === "find_skill") {
					summary.skillInvocations++;
				}
			}
		}
		if (record?.type === "usage") {
			const usage = recordValue(payload?.usage);
			summary.inputTokens += numberValue(usage?.inputTokens) ?? 0;
			summary.outputTokens += numberValue(usage?.outputTokens) ?? 0;
			summary.totalTokens += numberValue(usage?.totalTokens) ?? 0;
			summary.costUsd += numberValue(usage?.costUsd) ?? 0;
			const model = stringValue(usage?.model);
			if (model) models.add(model);
		}
	}

	summary.models = [...models].sort();
	return summary;
}

async function main(): Promise<void> {
	const options = parseSkillsBenchArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(usage());
		return;
	}
	loadBackboardCredentials(options);

	await preflight();
	const prepared = await prepareBenchmark(options);
	await mkdir(options.jobsDir, { recursive: true });
	await writeJson(path.join(options.jobsDir, "run-manifest.json"), {
		benchmark: "skillsbench",
		binary: prepared.binaryPath,
		commit: prepared.commit,
		conditions: requestedConditions(options.condition),
		createdAt: new Date().toISOString(),
		image: prepared.image,
		model: options.model ?? null,
		ref: options.ref,
		taskId: options.taskId,
	});

	if (options.prepareOnly) {
		process.stdout.write(
			`SkillsBench ${options.taskId}@${prepared.commit.slice(0, 12)} is prepared.\n`,
		);
		process.stdout.write(`Image: ${prepared.image}\n`);
		process.stdout.write(`Binary: ${prepared.binaryPath}\n`);
		process.stdout.write(`Manifest: ${options.jobsDir}/run-manifest.json\n`);
		return;
	}

	const results: ConditionResult[] = [];
	for (const condition of requestedConditions(options.condition)) {
		results.push(await runCondition(options, prepared, condition));
	}
	await writeJson(path.join(options.jobsDir, "summary.json"), {
		benchmark: "skillsbench",
		commit: prepared.commit,
		model: options.model,
		results,
		taskId: options.taskId,
	});

	for (const result of results) {
		process.stdout.write(
			`${result.condition}: reward=${result.reward ?? "missing"} ${result.passed ? "PASS" : "FAIL"}, tool_calls=${result.agent.trace.toolCalls}, tokens=${result.agent.trace.totalTokens}\n`,
		);
	}
	process.stdout.write(`Artifacts: ${options.jobsDir}\n`);
	if (results.some((result) => result.reward === null)) process.exitCode = 1;
}

function loadBackboardCredentials(options: SkillsBenchOptions): void {
	if (options.prepareOnly) return;
	const backboard = resolveAuth().backboard;
	if (!backboard) {
		throw new Error(
			"A Backboard login is required for a live SkillsBench run. Run `backboard login` or export BACKBOARD_API_KEY.",
		);
	}
	process.env.BACKBOARD_API_KEY = backboard.apiKey;
	process.env.BACKBOARD_API_URL = backboard.apiUrl;
}

async function preflight(): Promise<void> {
	await runCommand(["git", "--version"]);
	await runCommand(["bun", "--version"]);
	try {
		await runCommand(["docker", "info"], { timeoutMs: 30_000 });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Docker is required for SkillsBench. Start Docker Desktop or run \`colima start\`, then retry.\n${detail}`,
		);
	}
}

async function prepareBenchmark(
	options: SkillsBenchOptions,
): Promise<PreparedBenchmark> {
	const checkoutDir = await ensureSkillsBenchCheckout(options);
	const taskDir = path.join(checkoutDir, "tasks", options.taskId);
	const taskMarkdown = path.join(taskDir, "task.md");
	await requireFile(taskMarkdown);
	await requireDirectory(path.join(taskDir, "environment"));
	await requireFile(path.join(taskDir, "verifier", "test.sh"));
	const task = parseTaskDefinition(await readFile(taskMarkdown, "utf8"));
	const commit = (
		await runCommand(["git", "rev-parse", "HEAD"], { cwd: checkoutDir })
	).stdout.trim();

	const architecture = (
		await runCommand(["docker", "info", "--format", "{{.Architecture}}"])
	).stdout.trim();
	const binaryPath = await buildLinuxBinary(
		options.cacheDir,
		bunTargetForDockerArchitecture(architecture),
	);
	const image = await buildTaskImage(taskDir, options.taskId, commit);
	const workingDirectory = await dockerImageWorkingDirectory(image);
	return {
		binaryPath,
		checkoutDir,
		commit,
		image,
		task,
		taskDir,
		workingDirectory,
	};
}

async function ensureSkillsBenchCheckout(
	options: SkillsBenchOptions,
): Promise<string> {
	const checkoutDir = path.join(options.cacheDir, safePathSegment(options.ref));
	const gitDir = path.join(checkoutDir, ".git");
	if (!(await exists(gitDir))) {
		if (await exists(checkoutDir)) {
			throw new Error(
				`Incomplete SkillsBench cache at ${checkoutDir}; move it aside and retry`,
			);
		}
		await mkdir(path.dirname(checkoutDir), { recursive: true });
		await runCommand(
			[
				"git",
				"clone",
				"--depth",
				"1",
				"--filter=blob:none",
				"--sparse",
				"--branch",
				options.ref,
				SKILLSBENCH_REPOSITORY,
				checkoutDir,
			],
			{ stream: true, timeoutMs: 300_000 },
		);
	}

	await runCommand(
		["git", "sparse-checkout", "set", `tasks/${options.taskId}`],
		{ cwd: checkoutDir, stream: true, timeoutMs: 300_000 },
	);
	return checkoutDir;
}

async function buildLinuxBinary(
	cacheDir: string,
	target: string,
): Promise<string> {
	const outputDir = path.join(cacheDir, "bin", target);
	const binaryPath = path.join(outputDir, "backboard");
	await mkdir(outputDir, { recursive: true });
	await runCommand(
		[
			"bun",
			"build",
			"--compile",
			"--target",
			target,
			"--outfile",
			binaryPath,
			"./src/entrypoints/cli.tsx",
		],
		{ cwd: CLI_ROOT, stream: true, timeoutMs: 300_000 },
	);
	await chmod(binaryPath, 0o755);
	return binaryPath;
}

async function buildTaskImage(
	taskDir: string,
	taskId: string,
	commit: string,
): Promise<string> {
	const temporaryRoot = await mkdtemp(
		path.join(os.tmpdir(), "backboard-skillsbench-context-"),
	);
	const contextDir = path.join(temporaryRoot, "environment");
	try {
		const environmentDir = path.join(taskDir, "environment");
		await cp(environmentDir, contextDir, {
			filter: (source) => {
				const relative = path.relative(environmentDir, source);
				return relative.split(path.sep)[0] !== "skills";
			},
			recursive: true,
		});
		const image = `backboard-skillsbench-${safeDockerName(taskId)}:${commit.slice(0, 12)}`;
		await runCommand(["docker", "build", "--tag", image, contextDir], {
			stream: true,
			timeoutMs: 900_000,
		});
		return image;
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}
}

async function dockerImageWorkingDirectory(image: string): Promise<string> {
	const result = await runCommand([
		"docker",
		"image",
		"inspect",
		"--format",
		"{{json .Config.WorkingDir}}",
		image,
	]);
	const value = JSON.parse(result.stdout.trim()) as unknown;
	return stringValue(value) || "/";
}

async function runCondition(
	options: SkillsBenchOptions,
	prepared: PreparedBenchmark,
	condition: SkillsBenchCondition,
): Promise<ConditionResult> {
	const outputDir = path.join(options.jobsDir, condition);
	const verifierLogs = path.join(outputDir, "verifier");
	await mkdir(verifierLogs, { recursive: true });
	const containerName = safeDockerName(
		`backboard-skillsbench-${options.taskId}-${condition}-${Date.now()}-${randomBytes(3).toString("hex")}`,
	);
	let created = false;
	try {
		const createArgs = [
			"docker",
			"create",
			"--name",
			containerName,
			"--workdir",
			prepared.workingDirectory,
			"--env",
			`HOME=${prepared.workingDirectory}`,
			"--env",
			"BACKBOARD_API_KEY",
			"--env",
			"BACKBOARD_BENCHMARK=1",
			"--volume",
			`${prepared.binaryPath}:/opt/backboard/backboard:ro`,
			"--volume",
			`${verifierLogs}:/logs/verifier`,
		];
		for (const variable of [
			"BACKBOARD_API_URL",
			"BACKBOARD_ALLOW_INSECURE_API_URL",
		]) {
			if (process.env[variable]?.trim()) createArgs.push("--env", variable);
		}
		if (prepared.task.cpus) {
			createArgs.push("--cpus", String(prepared.task.cpus));
		}
		if (prepared.task.memoryMb) {
			createArgs.push("--memory", `${prepared.task.memoryMb}m`);
		}
		createArgs.push(prepared.image, "tail", "-f", "/dev/null");
		await runCommand(createArgs);
		created = true;
		await runCommand(["docker", "start", containerName]);
		await runCommand([
			"docker",
			"exec",
			containerName,
			"mkdir",
			"-p",
			"/verifier",
		]);
		await runCommand([
			"docker",
			"cp",
			`${path.join(prepared.taskDir, "verifier")}${path.sep}.`,
			`${containerName}:/verifier`,
		]);

		if (condition === "with-skill") {
			const skillsDir = path.join(prepared.taskDir, "environment", "skills");
			await requireDirectory(skillsDir);
			const skillRoot = path.posix.join(
				prepared.workingDirectory,
				".agents",
				"skills",
			);
			await runCommand([
				"docker",
				"exec",
				containerName,
				"mkdir",
				"-p",
				skillRoot,
			]);
			await runCommand([
				"docker",
				"cp",
				`${skillsDir}${path.sep}.`,
				`${containerName}:${skillRoot}`,
			]);
		}

		const excludedTools =
			condition === "with-skill" ? "AskUser" : "AskUser,FindSkill";
		const agent = await runCommand(
			[
				"docker",
				"exec",
				"--interactive",
				"--workdir",
				prepared.workingDirectory,
				containerName,
				"/opt/backboard/backboard",
				"--format",
				"json",
				"--model",
				options.model ?? "",
				"--memory",
				"off",
				"--permission-mode",
				"bypass",
				"--fresh",
				"--no-lsp",
				"--excluded-tools",
				excludedTools,
			],
			{
				allowFailure: true,
				input: prepared.task.prompt,
				stream: options.stream,
				timeoutMs: prepared.task.agentTimeoutMs,
			},
		);
		await writeFile(path.join(outputDir, "agent.ndjson"), agent.stdout);
		await writeFile(path.join(outputDir, "agent.stderr.log"), agent.stderr);
		if (agent.timedOut) {
			await runCommand(["docker", "stop", "--time", "5", containerName]);
			await runCommand(["docker", "start", containerName]);
		}

		const verifier = await runCommand(
			[
				"docker",
				"exec",
				"--workdir",
				prepared.workingDirectory,
				containerName,
				"/bin/bash",
				"/verifier/test.sh",
			],
			{
				allowFailure: true,
				stream: options.stream,
				timeoutMs: prepared.task.verifierTimeoutMs,
			},
		);
		await writeFile(
			path.join(outputDir, "verifier.stdout.log"),
			verifier.stdout,
		);
		await writeFile(
			path.join(outputDir, "verifier.stderr.log"),
			verifier.stderr,
		);
		await copyBackboardArtifacts(
			containerName,
			prepared.workingDirectory,
			outputDir,
		);

		const reward = await readReward(path.join(verifierLogs, "reward.txt"));
		const result: ConditionResult = {
			agent: {
				durationMs: agent.durationMs,
				exitCode: agent.exitCode,
				timedOut: agent.timedOut,
				trace: summarizeAgentTrace(agent.stdout),
			},
			condition,
			passed: reward === 1,
			reward,
			verifier: {
				durationMs: verifier.durationMs,
				exitCode: verifier.exitCode,
				timedOut: verifier.timedOut,
			},
		};
		await writeJson(path.join(outputDir, "result.json"), result);
		return result;
	} finally {
		if (created) {
			await runCommand(["docker", "rm", "--force", containerName], {
				allowFailure: true,
			});
		}
	}
}

async function copyBackboardArtifacts(
	containerName: string,
	workingDirectory: string,
	outputDir: string,
): Promise<void> {
	const artifactDir = path.join(outputDir, "backboard");
	await mkdir(artifactDir, { recursive: true });
	await runCommand(
		[
			"docker",
			"cp",
			`${containerName}:${path.posix.join(workingDirectory, ".backboard")}${path.posix.sep}.`,
			artifactDir,
		],
		{ allowFailure: true },
	);
}

async function readReward(filePath: string): Promise<number | null> {
	try {
		const reward = Number.parseFloat((await readFile(filePath, "utf8")).trim());
		return Number.isFinite(reward) ? reward : null;
	} catch {
		return null;
	}
}

async function runCommand(
	command: string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	const started = Date.now();
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: options.input === undefined ? "ignore" : "pipe",
		stderr: "pipe",
		stdout: "pipe",
	});
	const stdin = child.stdin;
	if (
		options.input !== undefined &&
		stdin !== undefined &&
		typeof stdin !== "number"
	) {
		stdin.write(options.input);
		stdin.end();
	}

	let timedOut = false;
	const timer = options.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, options.timeoutMs)
		: undefined;
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(child.stdout, options.stream ? process.stdout : undefined),
		readStream(child.stderr, options.stream ? process.stderr : undefined),
		child.exited,
	]);
	if (timer) clearTimeout(timer);
	const result: CommandResult = {
		durationMs: Date.now() - started,
		exitCode,
		stderr,
		stdout,
		timedOut,
	};
	if (exitCode !== 0 && !options.allowFailure) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
		throw new Error(`${command[0]} failed: ${detail.slice(-2_000)}`);
	}
	return result;
}

async function readStream(
	stream: ReadableStream<Uint8Array>,
	sink?: NodeJS.WritableStream,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		chunks.push(chunk);
		sink?.write(chunk);
	}
	const final = decoder.decode();
	if (final) {
		chunks.push(final);
		sink?.write(final);
	}
	return chunks.join("");
}

async function requireFile(filePath: string): Promise<void> {
	const information = await stat(filePath).catch(() => null);
	if (!information?.isFile())
		throw new Error(`Required file not found: ${filePath}`);
}

async function requireDirectory(directory: string): Promise<void> {
	const information = await stat(directory).catch(() => null);
	if (!information?.isDirectory()) {
		throw new Error(`Required directory not found: ${directory}`);
	}
}

async function exists(filePath: string): Promise<boolean> {
	return (await stat(filePath).catch(() => null)) !== null;
}

function requestedConditions(
	condition: RequestedCondition,
): SkillsBenchCondition[] {
	return condition === "both" ? ["no-skill", "with-skill"] : [condition];
}

function readValue(argv: string[], index: number, option: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function validateTaskId(taskId: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) {
		throw new Error("--task must be a lowercase SkillsBench task id");
	}
}

function validateGitRef(ref: string): void {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) ||
		ref.includes("..") ||
		ref.includes("//")
	) {
		throw new Error("--ref must be a simple branch, tag, or commit name");
	}
}

function validateModel(model: string | undefined): asserts model is string {
	if (!model || !/^[^\s/]+\/[^\s/]+$/.test(model)) {
		throw new Error("--model must use provider/model format");
	}
}

function safePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function safeDockerName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 120);
}

function secondsToMilliseconds(
	seconds: number | undefined,
	fallbackSeconds: number,
): number {
	return Math.round(
		(seconds && seconds > 0 ? seconds : fallbackSeconds) * 1_000,
	);
}

function positiveNumber(value: unknown): number | undefined {
	const number = numberValue(value);
	return number !== undefined && number > 0 ? number : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath: string, value: object): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function usage(): string {
	return `Backboard SkillsBench canary

Usage:
  bun run test:skillsbench -- --model <provider/model> [options]

Options:
  --model <provider/model>  Model routed through Backboard (required for live runs)
  --task <id>               SkillsBench task (default: ${DEFAULT_TASK})
  --ref <git-ref>           SkillsBench revision (default: ${DEFAULT_REF})
  --condition <mode>        with-skill | no-skill | both (default: with-skill)
  --jobs-dir <path>         Artifact directory (default: benchmark-results/...)
  --cache-dir <path>        Checkout and binary cache (default: benchmark-cache/...)
  --prepare-only            Fetch, compile, and build without using a model
  --quiet                   Save agent/verifier logs without streaming them
  --help                    Show this message

The runner builds the official task image without its skills, executes the
Backboard CLI in the disposable container, adds skills only for with-skill,
and runs the upstream verifier unchanged. Sign in with Backboard or export
BACKBOARD_API_KEY before a live run. Results are canary scores, not official
SkillsBench leaderboard runs.
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
