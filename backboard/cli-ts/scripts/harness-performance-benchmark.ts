#!/usr/bin/env bun
/** Opt-in offline replay. No credentials, network, shell commands, or private transcripts. */
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent, TurnStatus } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import type {
	AgentClient,
	RequestOptions,
} from "../src/providers/AgentClient.ts";
import type {
	ProviderEvent,
	ProviderToolCall,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";

interface Frame {
	delayMs?: number;
	event: ProviderEvent;
}
interface ReplayCase {
	name: string;
	initial: Frame[][];
	continuations: Frame[][];
	expectedStatus: TurnStatus;
	expectedRequests: number;
	expectedResults: number;
	serialReads?: boolean;
	cancelAfterMs?: number;
	toolDelayMs: number;
	expectedMutation?: boolean;
}

const inputSchema = z.object({
	value: z.string().optional(),
	command: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

class ReplayTool extends Tool<Input, string> {
	readonly inputSchema = inputSchema;
	constructor(
		readonly name: string,
		private readonly options: ReplayCase,
		private readonly state: { edits: number; executions: number },
	) {
		super();
	}
	override isReadOnly() {
		return this.name === "Read";
	}
	override isConcurrencySafe() {
		return this.name === "Read" && !this.options.serialReads;
	}
	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<string>> {
		this.state.executions++;
		await delay(this.options.toolDelayMs, undefined, { signal: ctx.signal });
		if (this.name === "Edit") this.state.edits++;
		const value = input.value ?? this.name;
		const result = ok(value, value, this.name);
		if (this.name === "Execute")
			result.execution = { validation: "passed", exitCode: 0 };
		return result;
	}
}

class ReplayClient implements AgentClient {
	readonly capabilities = { assistants: false, threads: false, memory: false };
	messageRequests = 0;
	continuationRequests = 0;
	results: SubmitToolOutputsRequest["tool_outputs"] = [];
	constructor(private readonly fixture: ReplayCase) {}

	runMessage(_req: SendMessageRequest, options: RequestOptions = {}) {
		const frames = this.fixture.initial[this.messageRequests++];
		if (!frames) throw new Error("Unexpected additional message inference");
		return this.replay(frames, options.signal);
	}
	runToolOutputs(req: SubmitToolOutputsRequest, options: RequestOptions = {}) {
		this.results.push(...req.tool_outputs);
		const frames = this.fixture.continuations[this.continuationRequests++];
		if (!frames) throw new Error("Unexpected additional tool continuation");
		return this.replay(frames, options.signal);
	}
	private async *replay(
		frames: readonly Frame[],
		signal?: AbortSignal,
	): AsyncIterable<ProviderEvent> {
		for (const frame of frames) {
			if (frame.delayMs) await delay(frame.delayMs, undefined, { signal });
			if (signal?.aborted) throw new Error("Replay cancelled");
			yield frame.event;
		}
	}
	async sendMessage(): Promise<never> {
		throw new Error("Offline replay disallows helper inference");
	}
	async createAssistant(): Promise<never> {
		throw new Error("Offline replay has no assistants");
	}
	async getThread(): Promise<never> {
		throw new Error("Offline replay has no remote threads");
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

function batch(calls: ProviderToolCall[], ready = true, tailMs = 70): Frame[] {
	return [
		{ delayMs: 30, event: { kind: "thread", threadId: "offline" } },
		...(ready
			? calls.map((call): Frame => ({ event: { kind: "tool_ready", call } }))
			: []),
		{
			delayMs: tailMs,
			event: { kind: "requires_action", runId: "offline-round", calls },
		},
	];
}

const complete: Frame[] = [
	{
		delayMs: 35,
		event: { kind: "assistant_delta", text: "Fixture complete." },
	},
	{ event: { kind: "completed", finalText: "Fixture complete." } },
];

function cases(): ReplayCase[] {
	const reads = (count: number): ProviderToolCall[] =>
		Array.from({ length: count }, (_, index) => ({
			id: `read-${index}`,
			name: "read",
			input: { value: `fixture-${index}` },
		}));
	const defaults = {
		expectedStatus: "completed" as const,
		expectedRequests: 2,
		toolDelayMs: 55,
	};
	return [
		{
			...defaults,
			name: "read-only-18",
			initial: [batch(reads(18))],
			continuations: [complete],
			expectedResults: 18,
		},
		{
			...defaults,
			name: "early-parallel-8",
			initial: [batch(reads(8))],
			continuations: [complete],
			expectedResults: 8,
		},
		{
			...defaults,
			name: "final-only-parallel-8",
			initial: [batch(reads(8), false)],
			continuations: [complete],
			expectedResults: 8,
		},
		{
			...defaults,
			name: "final-only-serial-8",
			initial: [batch(reads(8), false)],
			continuations: [complete],
			expectedResults: 8,
			serialReads: true,
		},
		{
			...defaults,
			name: "validated-edit-with-open-plan",
			initial: [
				batch([
					{ id: "edit", name: "edit", input: {} },
					{
						id: "check",
						name: "execute",
						input: { command: "bun test fixture.test.ts" },
					},
				]),
			],
			continuations: [complete],
			expectedResults: 2,
			expectedMutation: true,
			toolDelayMs: 5,
		},
		{
			...defaults,
			name: "retry-after-early-read",
			initial: [
				[
					{
						event: {
							kind: "tool_ready",
							call: {
								id: "read-0",
								name: "read",
								input: { value: "fixture-0" },
							},
						},
					},
					{
						delayMs: 5,
						event: {
							kind: "failed",
							error: "service unavailable",
							retryable: true,
						},
					},
				],
				batch(reads(1)),
			],
			continuations: [complete],
			expectedResults: 1,
			expectedRequests: 3,
		},
		{
			...defaults,
			name: "cancel-after-early-read",
			initial: [batch(reads(1))],
			continuations: [],
			expectedResults: 0,
			expectedRequests: 1,
			expectedStatus: "cancelled",
			cancelAfterMs: 40,
		},
	];
}

export async function runOfflineHarnessBenchmark() {
	const samples: Array<{
		case: string;
		success: boolean;
		status: TurnStatus;
		elapsedMs: number;
		firstVisibleMs: number | null;
		requests: number;
		rounds: number;
		submittedResults: number;
		executions: number;
		lateTerminalEvents: number;
		eventCounts: Partial<Record<AgentEvent["type"], number>>;
		timings: Record<string, number[]>;
	}> = [];
	for (const fixture of cases()) {
		const bus = new EventBus();
		const session = new Session(`benchmark-${fixture.name}`);
		if (fixture.expectedMutation)
			session.setTodos([
				{
					id: "follow-up",
					content: "User-requested follow-up remains open",
					status: "pending",
				},
			]);
		const client = new ReplayClient(fixture);
		const state = { edits: 0, executions: 0 };
		const tools = ["Read", "Edit", "Execute"].map(
			(name) => new ReplayTool(name, fixture, state),
		);
		const registry = new ToolRegistry(tools);
		const controller = new AbortController();
		const ctx: ToolContext = {
			sessionId: session.sessionId,
			cwd: process.cwd(),
			signal: controller.signal,
			bus,
			askUser: async () => {
				throw new Error("Unexpected approval in offline fixture");
			},
			getTodos: () => session.todos,
		};
		const loop = new AgentLoop({
			client,
			scheduler: new ToolScheduler(registry, bus),
			session,
			bus,
			tools: registry.toJSONSchemas(),
			systemPrompt: "Offline deterministic fixture.",
			model: { provider: "offline", model: "replay" },
			memory: "off",
			memoryProfile: "default",
			thinking: null,
			finalVerificationNudge: true,
			todoReconciliation: true,
		});
		const eventCounts: Partial<Record<AgentEvent["type"], number>> = {};
		const timings: Record<string, number[]> = {};
		let firstVisibleMs: number | null = null;
		let lateTerminalEvents = 0;
		let ended = false;
		const started = performance.now();
		const unsubscribe = bus.onAny((event) => {
			eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
			if (firstVisibleMs === null && event.type === "assistant:delta")
				firstVisibleMs = performance.now() - started;
			if (event.type === "performance:timing") {
				timings[event.phase] ??= [];
				timings[event.phase].push(event.durationMs);
			}
			if (
				ended &&
				(event.type === "tool:result" || event.type === "tool:error")
			)
				lateTerminalEvents++;
		});
		const timer = fixture.cancelAfterMs
			? setTimeout(() => controller.abort(), fixture.cancelAfterMs)
			: undefined;
		let status: TurnStatus;
		try {
			status = await loop.run(
				fixture.expectedMutation
					? "Make and validate a narrow edit."
					: "Read fixture files.",
				ctx,
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
		const elapsedMs = performance.now() - started;
		ended = true;
		if (fixture.cancelAfterMs) await delay(fixture.toolDelayMs);
		unsubscribe();
		const requests = client.messageRequests + client.continuationRequests;
		const ids = client.results.map((result) => result.tool_call_id);
		const success =
			status === fixture.expectedStatus &&
			requests === fixture.expectedRequests &&
			ids.length === fixture.expectedResults &&
			new Set(ids).size === ids.length &&
			lateTerminalEvents === 0 &&
			(!fixture.expectedMutation ||
				(state.edits === 1 && session.todos[0]?.status === "pending"));
		samples.push({
			case: fixture.name,
			success,
			status,
			elapsedMs,
			firstVisibleMs,
			requests,
			rounds: loop.toolRounds,
			submittedResults: ids.length,
			executions: state.executions,
			lateTerminalEvents,
			eventCounts,
			timings,
		});
	}
	const elapsed = (name: string) => {
		const sample = samples.find((sample) => sample.case === name);
		if (!sample) throw new Error(`Missing benchmark sample ${name}`);
		return sample.elapsedMs;
	};
	const early = elapsed("early-parallel-8");
	return {
		benchmark: "offline-harness-provider-replay",
		createdAt: new Date().toISOString(),
		definition:
			"Real AgentLoop and ToolScheduler, synthetic 30ms initial provider delay, 70ms final tool-frame delay, 35ms completion delay, 55ms reads. Comparators use identical calls with ready frames omitted or reads serialized. These are simulated delays, not live-model latency estimates.",
		samples,
		comparison: {
			earlyVsFinalOnlyMsSaved: elapsed("final-only-parallel-8") - early,
			earlyVsFinalOnlyPercent:
				(1 - early / elapsed("final-only-parallel-8")) * 100,
			earlyVsSerialMsSaved: elapsed("final-only-serial-8") - early,
		},
		success: samples.every((sample) => sample.success),
	};
}

if (import.meta.main) {
	const report = await runOfflineHarnessBenchmark();
	const encoded = `${JSON.stringify(report, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
	if (output) await writeFile(output, encoded);
	process.stdout.write(encoded);
	if (!report.success) process.exitCode = 1;
}
