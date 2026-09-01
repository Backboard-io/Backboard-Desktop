import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortId } from "../../utils/id.ts";
import { EventBus } from "../bus/EventBus.ts";
import type { AgentEvent } from "../bus/events.ts";
import { emptyRuleSet } from "../permissions/PermissionRules.ts";
import { ClientEventLog } from "../session/ClientEventLog.ts";
import { Session } from "../session/Session.ts";
import {
	createIsolatedProcessToken,
	terminateIsolatedWorkerProcesses,
} from "../tools/IsolatedProcessTracker.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { ToolRegistry } from "../tools/ToolRegistry.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import { MAX_SUBAGENT_TOOL_ROUNDS } from "./SubAgentConstants.ts";
import type {
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
} from "./SubAgentTypes.ts";

export type {
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
	SubAgentToolFactory,
} from "./SubAgentTypes.ts";

/**
 * Drives one isolated sub-agent to completion and returns only its distilled
 * report. The sub-agent gets its own Session, EventBus, tool registry, and
 * Backboard thread, so its intermediate tool churn never enters the parent's
 * context. This context isolation is the core property that lets a long coding
 * session delegate work without suffering context rot.
 */
export class SubAgentRunner {
	constructor(private readonly deps: SubAgentRunnerDeps) {}

	async run(params: SubAgentRunParams): Promise<SubAgentResult> {
		const bus = new EventBus();
		const session = new Session(shortId("subagent"));
		let finalStatus: SubAgentResult["status"] = "failed";
		const detachSessionProjection = session.attach(bus);
		const childLog = params.trace
			? new ClientEventLog(params.trace.sessionId, params.trace.clientLogPath)
			: null;
		childLog?.attach(bus);
		if (params.trace) {
			bus.emit({
				type: "session:created",
				sessionId: session.sessionId,
				threadId: session.threadId,
			});
		}
		const detachParentProgress = this.attachParentProgressRelay(params, bus);
		if (
			params.parentBus &&
			params.parentToolCallId &&
			!params.parentSignal.aborted
		) {
			params.parentBus.emit({
				type: "agent:child_start",
				agentToolCallId: params.parentToolCallId,
				childSessionId: session.sessionId,
				prompt: params.prompt.trim(),
				workspace: params.workspace,
			});
		}

		let isolatedScratchRoot: string | undefined;
		let isolatedProcessToken: string | undefined;
		let processesTerminated = false;
		try {
			const reports: string[] = [];
			bus.on("assistant:message", (event) => {
				const text = event.text.trim();
				if (text) reports.push(text);
			});

			const tools = this.deps.toolFactory({
				depth: params.depth,
				readOnly: params.readOnly === true,
			});
			const registry = new ToolRegistry(tools);
			const toolSchemas = registry.toJSONSchemas();
			const loopFactory = new AgentLoopFactory({
				client: this.deps.client,
				hookController: this.deps.hookController,
			});
			const scheduler = loopFactory.createScheduler({
				registry,
				bus,
				isToolEnabled: this.deps.isToolEnabled,
			});

			const model = this.deps.getModel();
			const thinkingResolver = this.deps.getThinkingResolver
				? await this.deps.getThinkingResolver()
				: undefined;
			const thinking = thinkingResolver
				? undefined
				: await this.deps.getThinking();

			// The sub-agent's turns live on this private bus, so the shared
			// CheckpointStore never sees their turn:end and would never finalize a
			// checkpoint journaled under them. Scope captures to the spawning user
			// turn instead: sub-agent edits fold into the parent's (finalized)
			// checkpoint and stay visible to /undo and /rewind. Without a parent
			// turn to attribute to, capture is disabled rather than journaling
			// entries no checkpoint could ever surface.
			const parentRecorder = params.isolatedWorkspace
				? undefined
				: (params.checkpoints ?? this.deps.checkpoints);
			const checkpoints = params.parentTurnId
				? parentRecorder?.scopedToTurn(params.parentTurnId)
				: undefined;
			const loop = loopFactory.createLoop({
				scheduler,
				session,
				bus,
				tools: toolSchemas,
				systemPrompt: params.isolatedWorkspace
					? `${this.deps.systemPrompt}\n\nYou are running in an isolated native Git worktree at ${params.parentCwd}. This path is authoritative even if delegated prose names a different project directory. Prefer workspace-relative paths and use this worktree as the root for every file and terminal operation. Modify files only with Write, Edit, or ApplyPatch—not shell redirection, mkdir, installers, formatters, or other shell commands that mutate the checkout. Execute is read-only for the checkout; only its private scratch/cache is writable. Never read from or write to the coordinator checkout or another worker worktree.`
					: this.deps.systemPrompt,
				model,
				memory: this.deps.memory,
				memoryProfile: this.deps.memoryProfile,
				thinking,
				thinkingResolver,
				requestKind: "subagent",
				maxToolRounds: MAX_SUBAGENT_TOOL_ROUNDS,
			});

			// One worker-lifetime scratch directory lets repeated Execute calls reuse
			// package-manager caches. Per-command mkdtemp/rm made parallel workers pay
			// the same cold-cache and synchronous cleanup cost on every tool round.
			isolatedScratchRoot = params.isolatedWorkspace
				? await mkdtemp(join(tmpdir(), "backboard-worker-scratch-"))
				: undefined;
			isolatedProcessToken = params.isolatedWorkspace
				? createIsolatedProcessToken()
				: undefined;

			const ctx: ToolContext = {
				sessionId: session.sessionId,
				cwd: params.parentCwd,
				isolatedWorkspaceRoot: params.isolatedWorkspace
					? params.parentCwd
					: undefined,
				isolatedScratchRoot,
				isolatedProcessToken,
				bus,
				signal: params.parentSignal,
				// A sub-agent can never prompt the human, so AskUser is unavailable.
				askUser: async () => {
					throw new Error("A sub-agent cannot ask the user a question.");
				},
				getTodos: () => session.todos,
				agentDepth: params.depth,
				trace: params.trace?.context,
				// A language-server process is rooted in the coordinator checkout and
				// must not observe or mutate an isolated worker checkout.
				lsp: params.isolatedWorkspace ? undefined : this.deps.lsp,
				checkpoints,
				// interactive:false so a sub-agent "ask" auto-denies. Fall back to a
				// locked-down context (not undefined) so a missing parent can't
				// disable the gate.
				permissions: params.parentPermissions
					? {
							...params.parentPermissions,
							// Full Access applies to the coordinator, not permission to escape a
							// worker worktree. Auto mode keeps safe commands available while
							// denying outside-workspace writes in a headless worker.
							mode:
								params.isolatedWorkspace &&
								params.parentPermissions.mode === "bypass"
									? "auto"
									: params.parentPermissions.mode,
							interactive: false,
						}
					: { mode: "manual", rules: emptyRuleSet(), interactive: false },
			};

			const status = await loop.run(params.prompt.trim(), ctx);
			finalStatus = status;
			if (isolatedProcessToken) {
				try {
					await terminateIsolatedWorkerProcesses(isolatedProcessToken);
					processesTerminated = true;
				} catch (error) {
					finalStatus = "failed";
					throw error;
				}
			}

			return {
				report: reports.at(-1) ?? "(the sub-agent produced no output)",
				status,
				usage: session.usage,
				toolRounds: loop.toolRounds,
			};
		} finally {
			if (isolatedProcessToken && !processesTerminated) {
				// The turn already failed or was cancelled, so preserve that outcome;
				// cleanup remains best-effort because there is no result to integrate.
				await terminateIsolatedWorkerProcesses(isolatedProcessToken).catch(
					() => {},
				);
			}
			if (
				params.parentBus &&
				params.parentToolCallId &&
				!params.parentSignal.aborted
			) {
				params.parentBus.emit({
					type: "agent:child_end",
					agentToolCallId: params.parentToolCallId,
					status: finalStatus,
				});
			}
			detachParentProgress();
			detachSessionProjection();
			await childLog?.flush();
			if (isolatedScratchRoot) {
				await rm(isolatedScratchRoot, { recursive: true, force: true }).catch(
					() => {},
				);
			}
		}
	}

	private attachParentProgressRelay(
		params: SubAgentRunParams,
		bus: EventBus,
	): () => void {
		if (!params.parentBus || !params.parentToolCallId) return () => {};
		// The bus is synchronous, so once the parent cancels, a winding-down
		// child's events must not reach the parent - they would resurrect the
		// parent's already-committed "Interrupted" row.
		const lifecycleEvents = new Set([
			"session:created",
			"user:message",
			"turn:start",
			"turn:end",
			"turn:cancelled",
			"agent:child_start",
			"agent:child_status",
			"agent:parallel_status",
			"agent:child_event",
			"agent:child_end",
		]);
		const parentBus = params.parentBus;
		const parentToolCallId = params.parentToolCallId;
		let buffered:
			| {
					type: "assistant:delta" | "assistant:reasoning";
					turnId: string;
					messageId?: string;
					text: string;
			  }
			| undefined;
		let flushTimer: ReturnType<typeof setTimeout> | undefined;
		const emit = (event: AgentEvent): void => {
			if (params.parentSignal.aborted) return;
			parentBus.emit({
				type: "agent:child_event",
				agentToolCallId: parentToolCallId,
				event,
			});
		};
		const flush = (): void => {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			const event = buffered;
			buffered = undefined;
			if (!event) return;
			emit(
				event.type === "assistant:delta"
					? {
							type: event.type,
							turnId: event.turnId,
							messageId: event.messageId ?? "",
							text: event.text,
						}
					: {
							type: event.type,
							turnId: event.turnId,
							text: event.text,
						},
			);
		};
		const detach = bus.onAny((event) => {
			if (params.parentSignal.aborted) return;
			if (
				event.type === "assistant:delta" ||
				event.type === "assistant:reasoning"
			) {
				const messageId =
					event.type === "assistant:delta" ? event.messageId : undefined;
				if (
					buffered?.type !== event.type ||
					buffered.turnId !== event.turnId ||
					buffered.messageId !== messageId
				) {
					flush();
					buffered = {
						type: event.type,
						turnId: event.turnId,
						messageId,
						text: "",
					};
				}
				buffered.text += event.text;
				if (!flushTimer) {
					flushTimer = setTimeout(flush, 32);
					flushTimer.unref?.();
				}
				return;
			}
			flush();
			if (!lifecycleEvents.has(event.type)) emit(event);
		});
		return () => {
			detach();
			flush();
		};
	}
}
