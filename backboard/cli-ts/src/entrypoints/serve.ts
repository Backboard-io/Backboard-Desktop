import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Config } from "../config/Config.ts";
import {
	parseMemoryMode,
	parseModel,
	parseThinking,
} from "../config/defaults.ts";
import { runtimeIdentity } from "../config/runtimeIdentity.ts";
import { AgentController } from "../core/agent/AgentController.ts";
import { AgentTaskManager } from "../core/agent/AgentTaskManager.ts";
import { AgentTaskStore } from "../core/agent/AgentTaskStore.ts";
import { EventBus } from "../core/bus/EventBus.ts";
import { createWorkerSnapshotMutation } from "../core/checkpoints/WorkerSnapshotMutation.ts";
import { EditorRewind } from "../core/checkpoints/EditorRewind.ts";
import { CheckpointManager } from "../core/checkpoints/CheckpointManager.ts";
import { CheckpointStore } from "../core/checkpoints/CheckpointStore.ts";
import { HookController, loadHookConfig } from "../core/hooks/index.ts";
import { LspService, resolveLspFlags } from "../core/lsp/index.ts";
import {
	loadMcpConfig,
	McpClientManager,
	McpController,
	McpToolRegistrar,
} from "../core/mcp/index.ts";
import {
	buildPermissionContext,
	parsePermissionMode,
} from "../core/permissions/index.ts";
import { resolveRipgrep } from "../core/search/ripgrep.ts";
import { ClientEventLog } from "../core/session/ClientEventLog.ts";
import { JsonEventStream } from "../core/session/JsonEventStream.ts";
import { ServerEventLog } from "../core/session/ServerEventLog.ts";
import { Session } from "../core/session/Session.ts";
import { SessionStore } from "../core/session/SessionStore.ts";
import { SkillController } from "../core/skills/SkillController.ts";
import { ClientToolBridge } from "../core/tools/ClientToolBridge.ts";
import { ToolRegistry } from "../core/tools/ToolRegistry.ts";
import { GitWorktreeManager } from "../core/workspaces/GitWorktreeManager.ts";
import { WorkerWorkspaceManager } from "../core/workspaces/WorkerWorkspaceManager.ts";
import { WorkerWorkspaceStore } from "../core/workspaces/WorkerWorkspaceStore.ts";
import { buildStartupEnvironmentPrompt } from "../prompts/system/startupEnvironment.ts";
import { createAgentClient } from "../providers/createAgentClient.ts";
import { createDefaultTools } from "../tools/index.ts";
import { errorMessage } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import type {
	ServeControl,
	ServeFileAttachment,
	ServeRecord,
	ServeRecordType,
} from "./ServeTypes.ts";
import { parseControlLine } from "./serveControl.ts";

/**
 * Persistent IDE host for the public Backboard R-CLI runtime.
 *
 * Backboard Studio owns only this NDJSON transport. R-CLI still owns provider
 * routing, the agent loop, permissions, tools, checkpoints, MCP, skills, and
 * local session state. stdout is machine-readable; diagnostics go to stderr.
 */
export async function runServe(argv: string[]): Promise<void> {
	let config: Config;
	try {
		config = new Config({ argv });
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}

	const requestedSessionId = process.env.BACKBOARD_SESSION_ID?.trim();
	const sessionId =
		requestedSessionId && /^[A-Za-z0-9._-]+$/.test(requestedSessionId)
			? requestedSessionId
			: shortId("sess");
	// The IDE intentionally keeps R-CLI's logs/checkpoints outside the opened
	// workspace so they never appear as agent edits in Changes/Review.
	const sessionBaseDir =
		process.env.BACKBOARD_SESSION_ROOT?.trim() || config.cwd;
	const store = new SessionStore(sessionId, sessionBaseDir);
	await store.init({
		sessionId,
		createdAt: new Date().toISOString(),
		cwd: config.cwd,
		model: config.modelString,
		profile: config.profile.name,
	});
	const bus = new EventBus();
	const clientLog = new ClientEventLog(sessionId, store.paths.clientLog);
	const serverLog = new ServerEventLog(sessionId, store.paths.serverLog);
	clientLog.attach(bus);
	const jsonStream = new JsonEventStream(sessionId);
	jsonStream.attach(bus);

	await CheckpointStore.recoverAbandonedRestore(store.paths.pendingUndo);
	const checkpoints = new CheckpointManager(bus, store.paths, config.cwd);
	checkpoints.warmShellCapture(config.cwd);

	const workerWorkspaceManager = new WorkerWorkspaceManager({
		parentSessionId: sessionId,
		store: new WorkerWorkspaceStore(store.paths.workers),
		git: new GitWorktreeManager(),
		snapshotMutation: createWorkerSnapshotMutation(checkpoints),
		maxWorkers: parseMaxWorkers(process.env.BACKBOARD_MAX_PARALLEL_WORKERS),
	});
	await workerWorkspaceManager.initialize();
	const agentTaskManager = new AgentTaskManager({
		store: new AgentTaskStore(join(store.paths.root, "agent-tasks.json")),
		workerWorkspaces: workerWorkspaceManager,
	});
	await agentTaskManager.initialize();

	const session = new Session(sessionId);
	bus.emit({ type: "session:created", sessionId, threadId: session.threadId });

	const client = createAgentClient(config, serverLog, sessionBaseDir);
	const hookConfig = loadHookConfig(config.hookConfigPaths);
	const startupEnvironmentPrompt = await buildStartupEnvironmentPrompt(
		config.cwd,
	);
	const hookController = new HookController({
		hooks: hookConfig.hooks,
		bus,
		cwd: config.cwd,
		sessionId,
	});

	const mcpConfig = await loadMcpConfig({
		cwd: config.cwd,
		paths: config.mcpConfigPaths,
	});
	const mcpManager = new McpClientManager(mcpConfig, config.cwd);
	const mcp = await mcpManager.initialize(new AbortController().signal);
	for (const warning of hookConfig.warnings) {
		bus.emit({ type: "system:warning", message: warning });
	}

	const lspFlags = resolveLspFlags();
	const lsp = new LspService({
		directory: config.cwd,
		flags: { ...lspFlags, enabled: config.flags.lsp ?? lspFlags.enabled },
		onWarning: (message) => bus.emit({ type: "system:warning", message }),
	});
	const skillController = new SkillController({ cwd: config.cwd, bus });
	let registry: ToolRegistry;
	let mcpController: McpController;
	registry = new ToolRegistry(
		createDefaultTools({
			client,
			config,
			hookController,
			lsp,
			checkpoints,
			getTools: () => registry.list(),
			skillController,
			getMcpRegistrar: () => mcpController,
			workerWorkspaceManager,
			agentTaskManager,
		}),
	);
	const mcpToolRegistrar = new McpToolRegistrar(registry, bus);
	mcpToolRegistrar.register({ ...mcp, warnings: [] });
	const clientToolBridge = new ClientToolBridge(bus, registry);
	const mcpRefreshTtlMs = 60_000;
	let lastMcpRefreshAt = Date.now();
	let mcpRefreshInFlight: Promise<void> | undefined;
	const syncMcpToolUpdates = async (signal: AbortSignal): Promise<void> => {
		if (Date.now() - lastMcpRefreshAt < mcpRefreshTtlMs) return;
		if (!mcpRefreshInFlight) {
			mcpRefreshInFlight = (async () => {
				const [tools, prompts, resources] = await Promise.all([
					mcpManager.refreshTools(signal),
					mcpManager.refreshPrompts(signal),
					mcpManager.refreshResources(signal),
				]);
				mcpToolRegistrar.applyRefresh(tools);
				mcpToolRegistrar.emitWarnings(prompts.warnings);
				mcpToolRegistrar.emitWarnings(resources.warnings);
				lastMcpRefreshAt = Date.now();
			})().finally(() => {
				mcpRefreshInFlight = undefined;
			});
		}
		await mcpRefreshInFlight;
	};
	mcpController = new McpController({
		cwd: config.cwd,
		activateServer: async (name, server, signal) => {
			const controller = signal ?? new AbortController().signal;
			return mcpToolRegistrar.register(
				await mcpManager.addServer(name, server, controller),
			);
		},
		authenticateServer: async (name, signal) => {
			const controller = signal ?? new AbortController().signal;
			const previousToolNames =
				mcpManager.listServerStatuses().find((status) => status.name === name)
					?.toolNames ?? [];
			const result = await mcpManager.authenticateServer(name, controller);
			mcpToolRegistrar.unregister({
				toolNames: previousToolNames,
				warnings: [],
			});
			return mcpToolRegistrar.register(result);
		},
		disableServer: async (name) =>
			mcpToolRegistrar.unregister(await mcpManager.disableServer(name)),
		removeServer: async (name) =>
			mcpToolRegistrar.unregister(await mcpManager.removeServer(name)),
		listServerStatuses: () => mcpManager.listServerStatuses(),
		listPrompts: (name, signal) => mcpManager.listPrompts(name, signal),
		getPrompt: (serverName, name, args, signal) =>
			mcpManager.getPrompt(serverName, name, args, signal),
		listResources: (name, signal) => mcpManager.listResources(name, signal),
		listResourceTemplates: (name, signal) =>
			mcpManager.listResourceTemplates(name, signal),
		readResource: (name, uri, signal) =>
			mcpManager.readResource(name, uri, signal),
		subscribeResource: (name, uri, signal) =>
			mcpManager.subscribeResource(name, uri, signal),
		unsubscribeResource: (name, uri, signal) =>
			mcpManager.unsubscribeResource(name, uri, signal),
		refreshPrompts: (signal) => mcpManager.refreshPrompts(signal),
		refreshResources: (signal) => mcpManager.refreshResources(signal),
	});

	const permissions = buildPermissionContext(config.cwd, "manual", true);
	let replacedThreadId: string | undefined;
	const controller = new AgentController({
		config,
		bus,
		session,
		registry,
		client,
		skillController,
		hookController,
		lsp,
		checkpoints,
		permissions,
		syncDynamicTools: syncMcpToolUpdates,
		finalVerificationNudge: false,
		todoReconciliation: false,
		startupEnvironmentPrompt,
		getDurableSession: () => ({
			sessionId,
			sessionRoot: store.paths.root,
			...(replacedThreadId ? { replacesThreadId: replacedThreadId } : {}),
		}),
		onThreadReplaced: (threadId) => {
			replacedThreadId = threadId ?? undefined;
		},
		getTranscriptPath: () => store.paths.clientLog,
		agentTasks: agentTaskManager,
	});

	const selectSkillsByName = async (names: string[]): Promise<void> => {
		const tabs = await skillController.listSkillTabs();
		const wanted = new Set(names);
		for (const tab of tabs) {
			if (tab.id === "skills-sh") continue;
			for (const item of tab.items) {
				if (!wanted.delete(item.name)) continue;
				try {
					await skillController.selectSkill(item);
				} catch (error) {
					bus.emit({
						type: "system:warning",
						message: `Failed to load skill "${item.name}": ${errorMessage(error)}`,
					});
				}
			}
		}
		for (const name of wanted) {
			bus.emit({ type: "system:warning", message: `Unknown skill: ${name}` });
		}
	};

	const stageAttachments = async (
		files: readonly ServeFileAttachment[],
	): Promise<string[]> => {
		const attachmentsDir = join(store.paths.root, "attachments");
		await mkdir(attachmentsDir, { recursive: true });
		const paths: string[] = [];
		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			if (!file) continue;
			const safeName = basename(file.fileName) || `attachment-${index + 1}`;
			const target = join(attachmentsDir, `${index + 1}-${safeName}`);
			await writeFile(target, Buffer.from(file.dataBase64, "base64"));
			paths.push(target);
		}
		return paths;
	};

	const writeRecord = (
		type: ServeRecordType,
		requestId?: string,
		payload?: unknown,
	): void => {
		const record: ServeRecord = {
			timestamp: new Date().toISOString(),
			session_id: sessionId,
			source: "serve",
			type,
			...(requestId === undefined ? {} : { requestId }),
			...(payload === undefined ? {} : { payload }),
		};
		process.stdout.write(`${JSON.stringify(record)}\n`);
	};

	let disposed = false;
	const flush = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		clientToolBridge.rejectAll("serve process is shutting down");
		await controller.dispose();
		await workerWorkspaceManager.waitForIdle();
		await lsp.shutdown();
		await mcpManager.close();
		await Promise.all([
			clientLog.flush(),
			serverLog.flush(),
			checkpoints.dispose(),
		]);
	};

	const editorRewind = new EditorRewind(checkpoints);
	await editorRewind.initialize();
	let rewinding = false;
	const pendingOps = new Set<Promise<void>>();
	let disposing = false;
	const handleControl = async (control: ServeControl): Promise<void> => {
		switch (control.op) {
			case "prepareRewind":
			case "commitRewind":
			case "recoverRewind": {
				if (rewinding) throw new Error("A rewind operation is already running");
				rewinding = true;
				try {
					controller.cancel({ clearQueue: true });
					workerWorkspaceManager.cancelAll();
					await controller.waitForIdle();
					await workerWorkspaceManager.waitForIdle();
					const tx =
						control.op === "prepareRewind"
							? await editorRewind.prepare(
									control.transactionId,
									control.turnIds,
									control.baseCheckpointId,
								)
							: control.op === "commitRewind"
								? await editorRewind.commit(
										control.transactionId,
										control.buffers,
									)
								: await editorRewind.recover(control.transactionId);
					if (tx.status === "committed") controller.newThread();
					writeRecord("serve:rewind", control.requestId, {
						transactionId: tx.id,
						status: tx.status,
						backupId: tx.backupId,
						headBackupId: tx.headBackupId,
						paths: tx.plan.entries.map((entry) => entry.path),
						buffers: tx.buffers,
					});
				} finally {
					rewinding = false;
				}
				return;
			}
			case "submit": {
				if (rewinding) throw new Error("Wait for file restoration to finish");
				editorRewind.assertReady();
				if (control.threadId && session.threadId === null) {
					session.threadId = control.threadId;
				}
				if (control.skills?.length) {
					await selectSkillsByName(control.skills);
				}
				const attachmentFilePaths = control.files?.length
					? await stageAttachments(control.files)
					: undefined;
				const status = await controller.submit(control.prompt, {
					turnId: control.turnId,
					attachmentFilePaths,
					displayContent: control.prompt,
					conversationContext:
						[control.forkContext, control.systemContext]
							.filter(
								(value): value is string =>
									value !== undefined && value.length > 0,
							)
							.join("\n\n") || undefined,
					onStart: () => {
						if (control.model !== undefined) {
							config.setModel(parseModel(control.model));
						}
						if (control.thinking !== undefined) {
							config.setThinking(parseThinking(control.thinking));
						}
						if (control.excludedTools !== undefined) {
							config.setExcludedTools(control.excludedTools);
						}
						if (control.memory !== undefined) {
							config.setMemory(parseMemoryMode(control.memory));
						}
						if (control.permission !== undefined) {
							permissions.mode = parsePermissionMode(control.permission);
						}
						if (control.computerUse !== undefined) {
							config.setComputerUseEnabled(control.computerUse);
						}
						if (control.browserUse !== undefined) {
							config.setBrowserUseEnabled(control.browserUse);
						}
						if (control.notify !== undefined) {
							config.setNotifyEnabled(control.notify);
						}
						if (control.imageGeneration !== undefined) {
							config.setImageGenerationEnabled(control.imageGeneration);
						}
						config.setOpenRouterProvider(control.openRouterProvider);
						// Sent on every turn; an absent list clears prior client
						// tools so a disconnected surface never leaves stale tools.
						clientToolBridge.setTools(control.clientTools ?? []);
					},
				});
				writeRecord("serve:turn", control.requestId, {
					status,
					threadId: session.threadId,
				});
				return;
			}
			case "steer": {
				const status = await controller.steer(control.prompt, {
					emitUserMessage: true,
					conversationContext: control.systemContext,
				});
				if (control.requestId !== undefined) {
					writeRecord("serve:turn", control.requestId, {
						status,
						threadId: session.threadId,
					});
				}
				return;
			}
			case "warmup":
				// Process startup itself is the main warm-up. A model request also
				// establishes DNS/TLS without creating remote assistant state.
				await client.listModels().catch(() => undefined);
				if (control.requestId !== undefined) {
					writeRecord("serve:warm", control.requestId, { ok: true });
				}
				return;
			case "cancel":
				controller.cancel({ clearQueue: true });
				workerWorkspaceManager.cancelAll();
				writeRecord("serve:ack", control.requestId, { op: "cancel" });
				return;
			case "respondInput":
				controller.provideInput(control.id, control.answers);
				return;
			case "clientToolResult":
				clientToolBridge.provideResult(
					control.id,
					control.error ? { error: control.error } : (control.result ?? {}),
				);
				return;
			case "setModel":
				config.setModel(parseModel(control.model));
				writeRecord("serve:ack", control.requestId, {
					op: "setModel",
					model: config.modelString,
				});
				return;
			case "listModels":
				writeRecord(
					"serve:models",
					control.requestId,
					await client.listModels(),
				);
				return;
			case "listTools":
				writeRecord("serve:tools", control.requestId, {
					tools: registry.list().map((tool) => ({
						name: tool.agentName,
						displayName: tool.displayName,
					})),
				});
				return;
			case "listSkills": {
				const tabs = await skillController.listSkillTabs();
				const skillsByName = new Map<
					string,
					{ name: string; source: string; description: string }
				>();
				for (const tab of tabs) {
					if (tab.id === "skills-sh") continue;
					for (const item of tab.items) {
						if (!skillsByName.has(item.name)) {
							skillsByName.set(item.name, {
								name: item.name,
								source: item.source,
								description: item.description,
							});
						}
					}
				}
				writeRecord("serve:skills", control.requestId, {
					skills: [...skillsByName.values()],
				});
				return;
			}
			case "archiveWorkers":
				writeRecord("serve:ack", control.requestId, {
					op: control.op,
					preservedWorktrees: await workerWorkspaceManager.archive(),
				});
				return;
			case "unarchiveWorkers":
				writeRecord("serve:ack", control.requestId, {
					op: control.op,
					workers: await workerWorkspaceManager.unarchive(),
				});
				return;
			case "deleteWorkers":
				writeRecord("serve:ack", control.requestId, {
					op: control.op,
					preservedWorktrees: await workerWorkspaceManager.delete(),
				});
				return;
			case "dispose":
				disposing = true;
				controller.cancel({ clearQueue: true });
				// handleControl reaches this await before the dispose promise is
				// inserted into pendingOps, so the snapshot contains only older work.
				await Promise.allSettled([...pendingOps]);
				await flush();
				process.exit(0);
		}
	};

	await controller.start();
	const [identity, ripgrep] = await Promise.all([
		runtimeIdentity(),
		resolveRipgrep().then(
			(value) => ({
				path: value.path,
				version: value.version,
				pcre2: value.pcre2,
			}),
			() => ({
				available: false,
				reason:
					"Ripgrep unavailable; configure BACKBOARD_RIPGREP_PATH or install rg on PATH.",
			}),
		),
	]);
	const runtime = { ...identity, ...controller.runtimePromptIdentity, ripgrep };
	if ("available" in ripgrep && !ripgrep.available)
		bus.emit({ type: "system:warning", message: ripgrep.reason });
	bus.emit({ type: "runtime:identity", identity: runtime });
	writeRecord("serve:ready", undefined, {
		sessionId,
		cwd: config.cwd,
		model: config.modelString,
		upstream: "Backboard-io/Backboard-R-CLI",
		runtime,
	});

	const reader = createInterface({ input: process.stdin });
	reader.on("line", (line) => {
		if (disposing) return;
		const parsed = parseControlLine(line);
		if (parsed === null) return;
		if (!parsed.ok) {
			writeRecord("serve:error", parsed.requestId, { error: parsed.error });
			return;
		}
		const control = parsed.control;
		let run: Promise<void>;
		run = handleControl(control)
			.catch((error) => {
				const requestId =
					"requestId" in control && typeof control.requestId === "string"
						? control.requestId
						: undefined;
				writeRecord("serve:error", requestId, {
					op: control.op,
					error: errorMessage(error),
				});
			})
			.finally(() => pendingOps.delete(run));
		pendingOps.add(run);
	});

	await new Promise<void>((resolve) => reader.on("close", resolve));
	if (!disposing) controller.cancel({ clearQueue: true });
	await Promise.allSettled([...pendingOps]);
	await flush();
}

function parseMaxWorkers(value: string | undefined): number {
	if (!value) return 4;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}
