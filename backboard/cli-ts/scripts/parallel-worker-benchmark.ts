#!/usr/bin/env bun
/** Opt-in offline subagent replay with real isolation, integration, and durable undo. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AgentTaskManager } from "../src/core/agent/AgentTaskManager.ts";
import { AgentTaskStore } from "../src/core/agent/AgentTaskStore.ts";
import { SubAgentRunner } from "../src/core/agent/SubAgentRunner.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CheckpointStore } from "../src/core/checkpoints/CheckpointStore.ts";
import { createWorkerSnapshotMutation } from "../src/core/checkpoints/WorkerSnapshotMutation.ts";
import { emptyRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { WorkerWorkspaceManager } from "../src/core/workspaces/WorkerWorkspaceManager.ts";
import { WorkerWorkspaceStore } from "../src/core/workspaces/WorkerWorkspaceStore.ts";
import type {
	AgentClient,
	RequestOptions,
} from "../src/providers/AgentClient.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { AgentSpawnBatchTool } from "../src/tools/AgentSpawnBatchTool.tsx";
import { AgentSpawnTool } from "../src/tools/AgentSpawnTool.tsx";
import { AgentTool } from "../src/tools/AgentTool.tsx";
import { AgentWaitTool } from "../src/tools/AgentWaitTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";

const exec = promisify(execFile);
const workerCount = 3;
export type LaunchMode =
	| "serial"
	| "sequential-registration"
	| "parallel"
	| "batch";
export type WorkspaceKind = "clean-git" | "non-git" | "dirty-git";
export interface WorkerReplayOptions {
	launchMode: LaunchMode;
	workspaceKind?: WorkspaceKind;
	modelDelayMs?: number;
	/** Hold synthetic responses until a real unrelated parent Write completes. */
	parentEdit?: boolean;
}
interface TimingSample {
	phase: string;
	durationMs: number;
	workerId?: string;
}

class WorkerReplay implements AgentClient {
	readonly capabilities = { assistants: false, threads: false, memory: false };
	requests = 0;
	continuations = 0;
	active = 0;
	maxActive = 0;
	private releaseResponses!: () => void;
	private readonly responsesReleased = new Promise<void>((resolve) => {
		this.releaseResponses = resolve;
	});
	constructor(
		private readonly modelDelayMs: number,
		private readonly holdResponses: boolean,
	) {}
	release(): void {
		this.releaseResponses();
	}
	async waitForStarts(count: number): Promise<void> {
		const deadline = performance.now() + 10_000;
		while (this.requests < count) {
			assert.ok(
				performance.now() < deadline,
				`Expected ${count} worker provider requests; got ${this.requests}`,
			);
			await delay(2);
		}
	}
	async *runMessage(
		req: SendMessageRequest,
		options: RequestOptions = {},
	): AsyncIterable<ProviderEvent> {
		this.requests++;
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await delay(this.modelDelayMs, undefined, { signal: options.signal });
			if (this.holdResponses) await this.responsesReleased;
			options.signal?.throwIfAborted();
			const worker = /worker-(\d+)/.exec(req.content)?.[1];
			assert.ok(worker, "Expected the synthetic worker prompt");
			yield { kind: "thread", threadId: `offline-worker-${worker}` };
			yield {
				kind: "requires_action",
				runId: `run-${worker}`,
				calls: [
					// Repeated IDs across independent child sessions must stay isolated.
					{
						id: "write-local",
						name: "Write",
						input: {
							file_path: `worker-${worker}.txt`,
							content: `result ${worker}\n`,
						},
					},
				],
			};
		} finally {
			this.active--;
		}
	}
	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.continuations++;
		assert.equal(req.tool_outputs.length, 1);
		assert.equal(req.tool_outputs[0]?.tool_call_id, "write-local");
		yield { kind: "assistant_delta", text: "Completed assigned file." };
		yield { kind: "completed" };
	}
	async sendMessage(): Promise<never> {
		throw new Error("No helper inference in offline replay");
	}
	async createAssistant(): Promise<never> {
		throw new Error("No remote assistants");
	}
	async getThread(): Promise<never> {
		throw new Error("No remote threads");
	}
	async listThreads() {
		return [];
	}
	async listAssistants() {
		return [];
	}
	async listModels() {
		return { models: [], total: 0 };
	}
	async getModelThinkingMetadata(provider: string, model: string) {
		return { provider, model, supports_thinking: false };
	}
}

export async function runWorkerReplayTrial(options: WorkerReplayOptions) {
	const workspaceKind = options.workspaceKind ?? "clean-git";
	const launchMode = options.launchMode;
	const parallel = launchMode !== "serial";
	const modelDelayMs = options.modelDelayMs ?? 300;
	const root = await mkdtemp(join(tmpdir(), "backboard-worker-benchmark-"));
	const repository = join(root, "repository");
	await mkdir(repository);
	const git = (...args: string[]) =>
		exec(
			"git",
			[
				"-c",
				"user.name=Offline Replay",
				"-c",
				"user.email=offline@example.invalid",
				...args,
			],
			{ cwd: repository },
		);
	await writeFile(
		join(repository, "README.md"),
		"Offline parallel writer fixture\n",
	);
	if (workspaceKind !== "non-git") {
		await git("init", "-q");
		if (workspaceKind === "dirty-git") {
			await writeFile(join(repository, "worker-0.txt"), "committed zero\n");
			await writeFile(join(repository, "worker-1.txt"), "committed one\n");
		}
		await git("add", ".");
		await git(
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--no-gpg-sign",
			"-qm",
			"fixture",
		);
	}
	if (workspaceKind === "dirty-git") {
		await writeFile(join(repository, "worker-0.txt"), "staged zero\r\n");
		await git("add", "worker-0.txt");
	}
	const originalFiles = new Map<string, Buffer>();
	if (workspaceKind !== "clean-git") {
		originalFiles.set(
			"worker-0.txt",
			Buffer.from("\uFEFFuser working zero\r\n"),
		);
		originalFiles.set("worker-1.txt", Buffer.from("user working one\n"));
		originalFiles.set("untracked-user.txt", Buffer.from("keep user note\n"));
		for (const [file, content] of originalFiles)
			await writeFile(join(repository, file), content);
	}
	const originalGit =
		workspaceKind === "dirty-git"
			? {
					head: (await git("rev-parse", "HEAD")).stdout,
					status: (await git("status", "--porcelain")).stdout,
					index: await readFile(join(repository, ".git", "index")),
					staged: (await git("show", ":worker-0.txt")).stdout,
				}
			: undefined;
	const bus = new EventBus();
	const timingSamples: TimingSample[] = [];
	const preparationStarts = new Map<string, number>();
	let peakWorkerLifetimes = 0;
	const activeWorkers = new Set<string>();
	bus.on("performance:timing", (event) => {
		timingSamples.push({
			phase: event.phase,
			durationMs: event.durationMs,
			workerId: event.workerId,
		});
	});
	bus.on("agent:child_start", (event) => {
		preparationStarts.set(event.agentToolCallId, performance.now());
		activeWorkers.add(event.agentToolCallId);
		peakWorkerLifetimes = Math.max(peakWorkerLifetimes, activeWorkers.size);
	});
	bus.on("agent:child_end", (event) => {
		activeWorkers.delete(event.agentToolCallId);
	});
	const sessionRoot = join(root, "session");
	const checkpoints = new CheckpointStore(
		{
			root: sessionRoot,
			clientLog: join(sessionRoot, "client.jsonl"),
			serverLog: join(sessionRoot, "server.jsonl"),
			meta: join(sessionRoot, "meta.json"),
			workers: join(root, "workers.json"),
			checkpoints: join(sessionRoot, "checkpoints"),
			checkpointObjects: join(root, "objects"),
			pendingUndo: join(root, "pending-undo.json"),
		},
		bus,
	);
	const store = new AgentTaskStore(join(root, "tasks.json"));
	const workspaces = new WorkerWorkspaceManager({
		parentSessionId: "replay",
		store: new WorkerWorkspaceStore(join(root, "workers.json")),
		worktreeRoot: join(root, "worktrees"),
		snapshotMutation: createWorkerSnapshotMutation(checkpoints),
	});
	const tasks = new AgentTaskManager({ store, workerWorkspaces: workspaces });
	const replay = new WorkerReplay(modelDelayMs, options.parentEdit === true);
	const runner = new SubAgentRunner({
		client: replay,
		getModel: () => ({ provider: "offline", model: "replay" }),
		memory: "off",
		memoryProfile: "code",
		getThinking: async () => null,
		systemPrompt: "Complete only the assigned file.",
		toolFactory: () => [new WriteTool()],
	});
	const agent = new AgentTool({
		runner,
		maxDepth: 2,
		workspaceManager: workspaces,
		taskManager: tasks,
		createRLMLoop: () => {
			throw new Error("No RLM in replay");
		},
	});
	const controller = new AbortController();
	const ctx: ToolContext = {
		cwd: repository,
		sessionId: "replay",
		turnId: "parent",
		checkpoints,
		bus,
		signal: controller.signal,
		askUser: async () => {
			throw new Error("Unexpected approval in replay");
		},
		permissions: {
			mode: "acceptEdits",
			rules: emptyRuleSet(),
			interactive: false,
		},
	};
	const scheduler = new ToolScheduler(
		new ToolRegistry([
			new AgentSpawnTool(agent, tasks),
			new AgentSpawnBatchTool(agent, tasks),
			new WriteTool(),
			new AgentWaitTool(tasks),
		]),
		bus,
	);
	try {
		await workspaces.initialize();
		await tasks.initialize();
		bus.emit({
			type: "user:message",
			text: "Run three offline writer fixtures",
		});
		bus.emit({ type: "turn:start", turnId: "parent" });
		const started = performance.now();
		const spawns = Array.from({ length: workerCount }, (_, i) => ({
			id: `worker-${i}`,
			name: "AgentSpawn",
			input: {
				name: `Worker ${i}`,
				prompt: `worker-${i}: create only your assigned file.`,
				read_only: false,
			},
		}));
		const joinWorkers = async (handles: string[], id: string) => {
			const outputs = await scheduler.run(
				[{ id, name: "AgentWait", input: { handles } }],
				ctx,
			);
			assert.ok(
				outputs.every((output) => !output.metadata?.error),
				JSON.stringify(outputs),
			);
			for (const handle of handles) {
				assert.equal(
					tasks.list().find((task) => task.handle === handle)?.status,
					"completed",
					"A timed-out join must not count as completed-task latency",
				);
			}
		};
		let parentEditVerified = false;
		const applyParentEdit = async (expectedStarts: number) => {
			if (!options.parentEdit || parentEditVerified) return;
			await replay.waitForStarts(expectedStarts);
			const outputs = await scheduler.run(
				[
					{
						id: "parent-independent-write",
						name: "Write",
						input: {
							file_path: "README.md",
							content: "Parent unrelated edit\n",
						},
					},
				],
				{ ...ctx, turnId: "parent-unrelated" },
			);
			assert.ok(
				outputs.every((output) => !output.metadata?.error),
				JSON.stringify(outputs),
			);
			await checkpoints.finishCapture("parent-unrelated");
			parentEditVerified = true;
			replay.release();
		};
		const registrationStarted = performance.now();
		let registrationMs = 0;
		if (launchMode === "batch") {
			const outputs = await scheduler.run(
				[
					{
						id: "worker-batch",
						name: "AgentSpawnBatch",
						input: { workers: spawns.map((call) => call.input) },
					},
				],
				ctx,
			);
			assert.ok(
				outputs.every((output) => !output.metadata?.error),
				JSON.stringify(outputs),
			);
			// Join handles actually submitted to the parent model, not a privileged
			// side channel that would hide a broken model-visible tool response.
			const handles = [
				...new Set(
					outputs.flatMap((output) =>
						[...output.output.matchAll(/\bworker-[a-f0-9]{64}\b/g)].map(
							(match) => match[0],
						),
					),
				),
			];
			assert.equal(handles.length, workerCount);
			assert.deepEqual(
				handles,
				tasks.list().map((task) => task.handle),
			);
			registrationMs = performance.now() - registrationStarted;
			await applyParentEdit(workerCount);
			await joinWorkers(handles, "wait-all");
		} else if (
			launchMode === "parallel" ||
			launchMode === "sequential-registration"
		) {
			if (launchMode === "parallel") {
				const outputs = await scheduler.run(spawns, ctx);
				assert.ok(
					outputs.every((output) => !output.metadata?.error),
					JSON.stringify(outputs),
				);
			} else {
				for (const call of spawns) {
					const outputs = await scheduler.run([call], ctx);
					assert.ok(
						outputs.every((output) => !output.metadata?.error),
						JSON.stringify(outputs),
					);
				}
			}
			registrationMs = performance.now() - registrationStarted;
			await applyParentEdit(workerCount);
			await joinWorkers(
				spawns.map((call) => call.id),
				"wait-all",
			);
		} else {
			for (const call of spawns) {
				const before = performance.now();
				const outputs = await scheduler.run([call], ctx);
				registrationMs += performance.now() - before;
				assert.ok(
					outputs.every((output) => !output.metadata?.error),
					JSON.stringify(outputs),
				);
				await applyParentEdit(1);
				await joinWorkers([call.id], `wait-${call.id}`);
			}
		}
		const joinedMs = performance.now() - started;
		await tasks.waitForIdle();
		await workspaces.waitForIdle();
		const elapsedMs = performance.now() - started;
		bus.emit({
			type: "turn:end",
			turnId: "parent",
			status: "completed",
			durationMs: elapsedMs,
		});
		await checkpoints.flush();
		const records = await store.load();
		assert.deepEqual(
			records.map((record) => record.status),
			["completed", "completed", "completed"],
		);
		assert.equal(
			workspaces
				.list()
				.filter((record) => record.integrationStatus === "integrated").length,
			workerCount,
		);
		for (let i = 0; i < workerCount; i++)
			assert.equal(
				await readFile(join(repository, `worker-${i}.txt`), "utf8"),
				`result ${i}\n`,
			);
		let undoVerified = false;
		let undoCount = 0;
		if (workspaceKind === "clean-git") {
			assert.equal(
				(await git("status", "--porcelain")).stdout.trim(),
				options.parentEdit ? "M README.md" : "",
			);
		} else {
			assert.ok(
				workspaces.list().every((record) => record.backend === "snapshot"),
			);
			if (originalGit) {
				assert.equal((await git("rev-parse", "HEAD")).stdout, originalGit.head);
				assert.deepEqual(
					await readFile(join(repository, ".git", "index")),
					originalGit.index,
					"worker integration must preserve the user's Git index bytes",
				);
				assert.equal(
					(await git("show", ":worker-0.txt")).stdout,
					originalGit.staged,
				);
			} else {
				await assert.rejects(access(join(repository, ".git")), {
					code: "ENOENT",
				});
			}
			// Undo is excluded from the completed-task timing, but checked using the
			// real journal: restore original working bytes, retain staged data, remove
			// only the newly created worker file, and preserve unrelated user files.
			for (let i = 0; i < workerCount; i++) {
				const undoTarget = checkpoints.undoTarget();
				assert.ok(
					undoTarget,
					"Each snapshot integration must create durable undo data",
				);
				const undone = await checkpoints.restore(
					await checkpoints.planRestore(undoTarget),
					{ skipDiverged: false },
				);
				assert.equal(undone.skipped.length, 0);
				undoCount++;
			}
			for (const [file, content] of originalFiles)
				assert.deepEqual(await readFile(join(repository, file)), content);
			await assert.rejects(access(join(repository, "worker-2.txt")), {
				code: "ENOENT",
			});
			if (originalGit) {
				assert.deepEqual(
					await readFile(join(repository, ".git", "index")),
					originalGit.index,
				);
				assert.equal(
					(await git("status", "--porcelain")).stdout.replace(
						/^ M README\.md\n/m,
						"",
					),
					originalGit.status,
				);
			} else
				await assert.rejects(access(join(repository, ".git")), {
					code: "ENOENT",
				});
			undoVerified = true;
		}
		assert.equal(replay.requests, workerCount);
		assert.equal(replay.continuations, workerCount);
		assert.ok(
			replay.maxActive >= 1 && replay.maxActive <= (parallel ? workerCount : 1),
		);
		if (options.parentEdit)
			assert.equal(replay.maxActive, parallel ? workerCount : 1);
		if (options.parentEdit)
			assert.equal(
				await readFile(join(repository, "README.md"), "utf8"),
				"Parent unrelated edit\n",
			);
		return {
			mode: launchMode,
			workspaceKind,
			modelDelayMs,
			elapsedMs,
			joinedMs,
			registrationMs,
			cleanupMs: elapsedMs - joinedMs,
			peakWorkerLifetimes,
			firstWorkerReadyMs: Math.min(...preparationStarts.values()) - started,
			lastWorkerReadyMs: Math.max(...preparationStarts.values()) - started,
			parentEditVerified,
			phaseMs: Object.fromEntries(
				[...new Set(timingSamples.map((sample) => sample.phase))]
					.sort()
					.map((phase) => {
						const samples = timingSamples
							.filter((sample) => sample.phase === phase)
							.map((sample) => sample.durationMs);
						return [
							phase,
							{
								samples,
								total: samples.reduce((sum, value) => sum + value, 0),
								maximum: Math.max(...samples),
							},
						];
					}),
			),
			maxActiveProviderRequests: replay.maxActive,
			providerRequests: replay.requests + replay.continuations,
			integratedWorkers: records.length,
			undoVerified,
			undoCount,
		};
	} finally {
		controller.abort();
		replay.release();
		tasks.cancelAll();
		workspaces.cancelAll();
		await tasks.waitForIdle();
		await workspaces.waitForIdle();
		await checkpoints.flush();
		checkpoints.dispose();
		await rm(root, { recursive: true, force: true });
	}
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}
function integerArgument(
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const value = Number(argument(name) ?? fallback);
	assert.ok(
		Number.isInteger(value) && value >= min && value <= max,
		`${name} must be an integer from ${min} to ${max}`,
	);
	return value;
}

async function main(): Promise<void> {
	const modelDelayMs = integerArgument("--delay-ms", 300, 0, 10_000);
	const iterations = integerArgument("--iterations", 3, 1, 10);
	const selected = argument("--modes")?.split(",") ?? [
		"serial",
		"sequential-registration",
		"parallel",
		"batch",
	];
	assert.ok(
		selected.every((mode) =>
			["serial", "sequential-registration", "parallel", "batch"].includes(mode),
		),
		"Unknown launch mode",
	);
	const workspaceKinds = argument("--workspace")?.split(",") ?? [
		"clean-git",
		"non-git",
		"dirty-git",
	];
	assert.ok(
		workspaceKinds.every((kind) =>
			["clean-git", "non-git", "dirty-git"].includes(kind),
		),
		"Unknown workspace kind",
	);
	const results: Awaited<ReturnType<typeof runWorkerReplayTrial>>[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		for (const workspaceKind of workspaceKinds as WorkspaceKind[]) {
			for (const launchMode of (iteration % 2 === 0
				? selected
				: [...selected].reverse()) as LaunchMode[])
				results.push(
					await runWorkerReplayTrial({
						launchMode,
						workspaceKind,
						modelDelayMs,
						parentEdit: process.argv.includes("--parent-edit"),
					}),
				);
		}
	}
	const medians = workspaceKinds.map((workspaceKind) => ({
		workspaceKind,
		...Object.fromEntries(
			selected.map((mode) => {
				const samples = results
					.filter(
						(result) =>
							result.mode === mode && result.workspaceKind === workspaceKind,
					)
					.map((result) => result.elapsedMs)
					.sort((a, b) => a - b);
				return [mode, samples[Math.floor(samples.length / 2)]];
			}),
		),
	}));
	const report = {
		scope:
			"Offline replay of actual worker tools, child loops, file permissions, isolation, integration, task durability, and snapshot undo. Provider frames/delays are synthetic; no network/model cost. Phase sums overlap and are not a wall-clock partition. Undo is excluded from elapsed task time.",
		generatedAt: new Date().toISOString(),
		runtime: {
			bun: Bun.version,
			platform: process.platform,
			arch: process.arch,
			entrySha256: createHash("sha256")
				.update(await readFile(process.argv[1]!))
				.digest("hex"),
		},
		workerCount,
		modelDelayMs,
		iterations,
		results,
		medianMs: medians,
	};
	const output = argument("--output");
	if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main();
