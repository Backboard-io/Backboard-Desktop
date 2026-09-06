import { describe, expect, it } from "bun:test";
import type { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { finalVerificationNotification } from "../src/core/agent/notifications/FinalVerificationNotification.ts";
import type {
	SystemNotification,
	SystemNotificationContext,
} from "../src/core/agent/notifications/SystemNotification.ts";
import {
	SystemNotificationRunner,
	type SystemNotificationRunnerDeps,
} from "../src/core/agent/notifications/SystemNotificationRunner.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { FINAL_VERIFICATION_NUDGE } from "../src/prompts/finalVerification.ts";

function notification(
	overrides: Partial<SystemNotification> & { id: string },
): SystemNotification {
	return {
		supersedesFinalAnswer: false,
		hidesResponse: false,
		shouldFire: () => true,
		content: () => `content:${overrides.id}`,
		...overrides,
	};
}

/**
 * Builds a runner over stubbed consumer/processor deps. Each processed
 * notification advances the fake counters by one round and callsPerProcess
 * calls, mirroring how ToolRoundProcessor's counters move between injections.
 */
function makeRunner(
	notifications: SystemNotification[],
	options: {
		rounds?: number;
		calls?: number;
		callsPerProcess?: number;
		todos?: readonly { id: string; content: string; status: string }[];
		tools?: readonly { function: { name: string } }[];
		refreshSystemPrompt?: () => string;
		/** Notification ids whose runMessage should throw. */
		failFor?: readonly string[];
		/** Called at the start of each injected notification's consume. */
		probe?: () => void;
	} = {},
) {
	const counters = {
		executedRounds: options.rounds ?? 1,
		executedToolCalls: options.calls ?? 20,
	};
	const sent: string[] = [];
	const events: AgentEvent[] = [];
	const bus = new EventBus();
	bus.onAny((event) => events.push(event));
	let resets = 0;
	const roundBudgets: (number | undefined)[] = [];
	const requests: Record<string, unknown>[] = [];
	const deps = {
		client: {
			runMessage: (request: Record<string, unknown> & { content: string }) => {
				if (
					options.failFor?.some((id) => request.content === `content:${id}`)
				) {
					throw new Error(`provider rejected ${request.content}`);
				}
				sent.push(request.content);
				requests.push(request);
				return { kind: "fake-stream" };
			},
		},
		consumer: {
			consumeWithRetry: async (create: () => unknown) => {
				options.probe?.();
				return create();
			},
		},
		processor: {
			get executedRounds() {
				return counters.executedRounds;
			},
			get executedToolCalls() {
				return counters.executedToolCalls;
			},
			createEarlyRound: () => ({
				reset: () => {
					resets++;
				},
			}),
			process: async (
				_pending: unknown,
				_turnId: string,
				_assistant: unknown,
				_ctx: ToolContext,
				_early: unknown,
				budget?: number,
			) => {
				roundBudgets.push(budget);
				counters.executedRounds += 1;
				counters.executedToolCalls += options.callsPerProcess ?? 1;
			},
		},
		session: { threadId: "thread_1", todos: options.todos ?? [] },
		tools: options.tools ?? [],
		systemPrompt: "system prompt",
		refreshSystemPrompt: options.refreshSystemPrompt,
		model: { provider: "openai", model: "gpt-test" },
		memory: "off",
		memoryProfile: "default",
		requestKind: "user",
	} as unknown as SystemNotificationRunnerDeps;
	const runner = new SystemNotificationRunner(deps, notifications);
	const ctx = { signal: new AbortController().signal, bus } as ToolContext;
	const assistant = {
		discardPartial: () => {},
	} as unknown as AssistantAccumulator;
	return {
		runner,
		sent,
		requests,
		counters,
		events,
		roundBudgets,
		get resets() {
			return resets;
		},
		run: () => runner.runPending("turn_1", assistant, ctx),
	};
}

describe("SystemNotificationRunner", () => {
	it("bounds notification tool rounds and records timing without prompt content", async () => {
		const made = makeRunner([notification({ id: "bounded" })]);
		await made.run();
		expect(made.roundBudgets).toEqual([3]);
		const spans = made.events.filter(
			(event) => event.type === "notification:run",
		);
		expect(spans.map((event) => event.stage)).toEqual(["start", "end"]);
		expect(spans[1]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(spans)).not.toContain("content:bounded");
		expect(made.resets).toBe(1);
	});

	it("resets a notification's early tools even when initial consumption fails", async () => {
		const made = makeRunner(
			[notification({ id: "flaky", supersedesFinalAnswer: true })],
			{ failFor: ["flaky"] },
		);
		await expect(made.run()).rejects.toThrow("provider rejected");
		expect(made.resets).toBe(1);
		expect(
			made.events
				.filter((event) => event.type === "notification:run")
				.map((event) => event.stage),
		).toEqual(["start", "end"]);
	});

	it("reports a superseding final answer only when a superseding notification would fire", () => {
		const firing = makeRunner([
			notification({ id: "a", supersedesFinalAnswer: true }),
		]);
		expect(firing.runner.willSupersedeFinalAnswer()).toBe(true);

		const notFiring = makeRunner([
			notification({
				id: "a",
				supersedesFinalAnswer: true,
				shouldFire: () => false,
			}),
		]);
		expect(notFiring.runner.willSupersedeFinalAnswer()).toBe(false);

		const nonSuperseding = makeRunner([notification({ id: "a" })]);
		expect(nonSuperseding.runner.willSupersedeFinalAnswer()).toBe(false);
	});

	it("evaluates willSupersedeFinalAnswer against the live processor counters", () => {
		const { runner, counters } = makeRunner(
			[
				notification({
					id: "a",
					supersedesFinalAnswer: true,
					shouldFire: (context) => context.executedToolCalls >= 25,
				}),
			],
			{ calls: 20 },
		);
		expect(runner.willSupersedeFinalAnswer()).toBe(false);
		counters.executedToolCalls = 25;
		expect(runner.willSupersedeFinalAnswer()).toBe(true);
	});

	it("fires notifications in order and skips non-firing ones without stopping", async () => {
		const { sent, run } = makeRunner([
			notification({ id: "a" }),
			notification({ id: "skipped", shouldFire: () => false }),
			notification({ id: "b" }),
		]);
		await run();
		expect(sent).toEqual(["content:a", "content:b"]);
	});

	it("freezes gating counts so an earlier notification's tool calls can't fire a later one", async () => {
		// The double-summary bug: the main turn ended at 16 tool calls (below a
		// 17 threshold), so the final answer was shown unbuffered. The first
		// notification then injects tool calls, pushing the LIVE counter past
		// 17 - but the second must still see the frozen main-turn count and NOT
		// fire, or the user gets a second summary.
		const seen: number[] = [];
		const { sent, run } = makeRunner(
			[
				notification({ id: "reconcile" }),
				notification({
					id: "verify",
					shouldFire: (context) => {
						seen.push(context.executedToolCalls);
						return context.executedToolCalls >= 17;
					},
				}),
			],
			{ calls: 16, callsPerProcess: 5 },
		);
		await run();
		expect(seen).toEqual([16]); // frozen main-turn count, not 21
		expect(sent).toEqual(["content:reconcile"]);
	});

	it("loops a repeatable notification until it stops wanting to fire", async () => {
		// Emulates the todo reminder closing items pass by pass (live state,
		// not the frozen counts), then stopping once none remain.
		let open = 4;
		const { sent, run } = makeRunner([
			notification({
				id: "todo",
				maxRepeats: 5,
				shouldFire: () => open > 0,
				content: () => {
					const current = open;
					open -= 1;
					return `open:${current}`;
				},
			}),
		]);
		await run();
		expect(sent).toEqual(["open:4", "open:3", "open:2", "open:1"]);
	});

	it("stops repeating when a pass produces no change (stall break)", async () => {
		const { sent, run } = makeRunner([
			notification({ id: "todo", maxRepeats: 5, content: () => "unchanged" }),
		]);
		await run();
		expect(sent).toEqual(["unchanged"]);
	});

	it("caps repeats at maxRepeats when the state keeps changing", async () => {
		let n = 0;
		const { sent, run } = makeRunner([
			notification({
				id: "todo",
				maxRepeats: 3,
				content: () => `c:${n++}`,
			}),
		]);
		await run();
		expect(sent).toEqual(["c:0", "c:1", "c:2"]);
	});

	it("reports hidden responses only while a hidesResponse notification is injecting", async () => {
		const seen: boolean[] = [];
		let runnerRef: SystemNotificationRunner | undefined;
		const made = makeRunner(
			[
				notification({ id: "hidden", hidesResponse: true }),
				notification({ id: "visible" }),
			],
			{
				probe: () => {
					seen.push(runnerRef?.activeNotificationHidesResponse() ?? false);
				},
			},
		);
		runnerRef = made.runner;
		await made.run();

		expect(seen).toEqual([true, false]);
		expect(made.runner.activeNotificationHidesResponse()).toBe(false);
	});

	it("exposes the session todos to shouldFire and content", async () => {
		const seen: SystemNotificationContext[] = [];
		const { run } = makeRunner(
			[
				notification({
					id: "a",
					shouldFire: (context) => {
						seen.push(context);
						return false;
					},
				}),
			],
			{
				todos: [{ id: "todo_1", content: "Plan work", status: "pending" }],
			},
		);
		await run();

		expect(seen[0]?.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "pending" },
		]);
	});

	it("swallows failures from best-effort notifications and keeps going", async () => {
		const { sent, run } = makeRunner(
			[notification({ id: "flaky" }), notification({ id: "b" })],
			{ failFor: ["flaky"] },
		);
		await run();
		expect(sent).toEqual(["content:b"]);
	});

	it("propagates failures from notifications that supersede the final answer", async () => {
		const { run } = makeRunner(
			[notification({ id: "flaky", supersedesFinalAnswer: true })],
			{ failFor: ["flaky"] },
		);
		await expect(run()).rejects.toThrow("provider rejected content:flaky");
	});

	it("applies per-notification tool restriction and thinking override", async () => {
		const { requests, run } = makeRunner(
			[
				notification({
					id: "restricted",
					thinking: null,
					restrictTools: (tools) =>
						tools.filter((tool) => tool.function.name === "todo_write"),
				}),
				notification({ id: "unrestricted" }),
			],
			{
				tools: [
					{ function: { name: "todo_write" } },
					{ function: { name: "execute" } },
				],
			},
		);
		await run();

		expect(requests[0]?.tools).toEqual([{ function: { name: "todo_write" } }]);
		expect(requests[0]?.thinking).toBeNull();
		expect(requests[1]?.tools).toHaveLength(2);
		expect(requests[1] && "thinking" in requests[1]).toBe(false);
	});

	it("refreshes the system prompt for injected requests", async () => {
		const { requests, run } = makeRunner([notification({ id: "a" })], {
			refreshSystemPrompt: () => "fresh prompt",
		});
		await run();
		expect(requests[0]?.system_prompt).toBe("fresh prompt");
	});

	it("tags injected requests with the notification id so they can be pruned/filtered", async () => {
		const { requests, run } = makeRunner([
			notification({ id: "todo-reconciliation" }),
		]);
		await run();
		expect(
			(requests[0]?.metadata as Record<string, unknown> | undefined)
				?.injected_notification,
		).toBe("todo-reconciliation");
	});

	it("passes each notification's content through the run-message request", async () => {
		const seen: SystemNotificationContext[] = [];
		const { sent, run } = makeRunner(
			[
				notification({
					id: "a",
					content: (context) => {
						seen.push(context);
						return `calls:${context.executedToolCalls}`;
					},
				}),
			],
			{ calls: 42 },
		);
		await run();
		expect(sent).toEqual(["calls:42"]);
		expect(seen[0]?.requestKind).toBe("user");
	});
});

describe("finalVerificationNotification", () => {
	const context = (
		overrides: Partial<SystemNotificationContext> = {},
	): SystemNotificationContext => ({
		requestKind: "user",
		executedRounds: 1,
		executedToolCalls: 1,
		completionEvidence: {
			successfulMutations: 1,
			unvalidatedMutations: 1,
			validationFailed: false,
		},
		todos: [],
		...overrides,
	});

	it("supersedes the final answer with the verification nudge", () => {
		const nudge = finalVerificationNotification(true);
		expect(nudge.id).toBe("final-verification");
		expect(nudge.supersedesFinalAnswer).toBe(true);
		expect(nudge.content(context())).toBe(FINAL_VERIFICATION_NUDGE);
	});

	it("fires only for enabled user turns with unvalidated mutations", () => {
		expect(finalVerificationNotification(true).shouldFire(context())).toBe(
			true,
		);
		expect(finalVerificationNotification(false).shouldFire(context())).toBe(
			false,
		);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({ requestKind: "subagent" }),
			),
		).toBe(false);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({ completionEvidence: undefined }),
			),
		).toBe(false);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({
					completionEvidence: {
						successfulMutations: 1,
						unvalidatedMutations: 0,
						validationFailed: false,
					},
				}),
			),
		).toBe(false);
	});
});
