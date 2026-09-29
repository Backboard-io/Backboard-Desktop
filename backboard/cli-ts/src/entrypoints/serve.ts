import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
import { CheckpointManager } from "../core/checkpoints/CheckpointManager.ts";
import { CheckpointStore } from "../core/checkpoints/CheckpointStore.ts";
import { EditorRewind } from "../core/checkpoints/EditorRewind.ts";
import { createWorkerSnapshotMutation } from "../core/checkpoints/WorkerSnapshotMutation.ts";
import { HookController, loadHookConfig } from "../core/hooks/index.ts";
import { LspService, resolveLspFlags } from "../core/lsp/index.ts";
import {
	loadMcpConfig,
	McpClientManager,
	McpController,
	McpToolCache,
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
import type { ModelSource } from "../providers/backboard/types.ts";
import { createAgentClient } from "../providers/createAgentClient.ts";
import { createDefaultTools } from "../tools/index.ts";
import { errorMessage } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import {
	SERVE_CAPABILITIES,
	type ServeControl,
	type ServeFileAttachment,
	type ServeRecord,
	type ServeRecordType,
} from "./ServeTypes.ts";
import { parseControlLine } from "./serveControl.ts";
import { buildServeConversationContext } from "./serveConversationContext.ts";
import { ServeSessionRestore } from "./ServeSessionRestore.ts";
import {
	McpStatusPublisher,
	McpWorkQueue,
	mcpTurnWaitMs,
	resolveMcpServerSet,
	type ServeRuntimeMcpServer,
	waitForMcpWork,
} from "./serveMcp.ts";

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
	// Connecting is deferred until after `serve:ready` (see below): the IDE
	// kills a runtime that is not ready within 30s, and each server may take
	// up to its timeout to connect.
	const mcpManager = new McpClientManager(mcpConfig, config.cwd, undefined, {
		toolCache: new McpToolCache(
			join(dirname(config.mcpConfigPaths.user), "mcp-tool-cache"),
		),
	});
	/** Aborted on shutdown so no MCP connect or OAuth wait outlives the process. */
	const mcpShutdown = new AbortController();
	const mcpWork = new McpWorkQueue();
	/** Servers find_mcp added in this process, until the IDE adopts them. */
	const runtimeMcpServers = new Map<string, ServeRuntimeMcpServer>();
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
	mcpManager.onDidLoseTools((toolNames) =>
		mcpToolRegistrar.unregister({ toolNames, warnings: [] }),
	);
	const clientToolBridge = new ClientToolBridge(bus, registry);
	const mcpRefreshTtlMs = 60_000;
	const mcpTurnWait = mcpTurnWaitMs();
	let lastMcpRefreshAt = Date.now();
	let mcpRefreshInFlight: Promise<void> | undefined;
	// Runs before every turn (submit or steer) snapshots its tool list: the
	// turn first waits for queued MCP reconfiguration (the initial connect,
	// IDE pushes), capped so a slow server joins from a later turn instead.
	const syncMcpToolUpdates = async (signal: AbortSignal): Promise<void> => {
		const waited = await waitForMcpWork(
			mcpWork.turnBarrier,
			mcpTurnWait,
			signal,
		);
		if (waited === "timeout") {
			process.stderr.write(
				`MCP servers still connecting after ${mcpTurnWait}ms; starting the turn without them.\n`,
			);
		}
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
	const mcpSignal = (signal?: AbortSignal): AbortSignal =>
		signal ? AbortSignal.any([signal, mcpShutdown.signal]) : mcpShutdown.signal;
	// Every server-set mutation goes through `mcpWork` so it never interleaves
	// with the initial connect or an IDE push.
	mcpController = new McpController({
		cwd: config.cwd,
		userConfigPath: config.mcpConfigPaths.user,
		activateServer: (name, server, signal, source) =>
			mcpWork.run(async () => {
				const configSources = source ? [source] : [];
				const result = mcpToolRegistrar.register(
					await mcpManager.addServer(name, server, mcpSignal(signal), {
						configSources,
						origin: "runtime",
					}),
				);
				runtimeMcpServers.set(name, { entry: server, configSources });
				return result;
			}),
		authenticateServer: (name, signal) =>
			mcpWork.run(async () => {
				const previousToolNames =
					mcpManager.listServerStatuses().find((status) => status.name === name)
						?.toolNames ?? [];
				const result = await mcpManager.authenticateServer(
					name,
					mcpSignal(signal),
				);
				mcpToolRegistrar.unregister({
					toolNames: previousToolNames,
					warnings: [],
				});
				return mcpToolRegistrar.register(result);
			}),
		disableServer: (name) =>
			mcpWork.run(async () =>
				mcpToolRegistrar.unregister(await mcpManager.disableServer(name)),
			),
		removeServer: (name) =>
			mcpWork.run(async () =>
				mcpToolRegistrar.unregister(await mcpManager.removeServer(name)),
			),
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
		autoCompact: true,
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

	const sessionRestore = new ServeSessionRestore(
		session,
		controller,
		client,
		store.paths.root,
	);
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
	// Unsolicited `serve:mcp`: a full snapshot after any server-set or status
	// change (background connect, pushes, find_mcp, OAuth, disable/remove, a
	// connection that drops later), coalesced over 50ms.
	const mcpStatus = new McpStatusPublisher(
		(payload) => writeRecord("serve:mcp", undefined, payload),
		() => mcpManager.listServerStatuses(),
	);
	mcpManager.onDidChangeStatus(() => mcpStatus.schedule());

	let disposed = false;
	const flush = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		clientToolBridge.rejectAll("serve process is shutting down");
		mcpShutdown.abort();
		mcpStatus.dispose();
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
	let credentialRevision = -1;
	let credentialSnapshot = "";
	// A host that manages keys must state the route with every selection, and
	// may not move the live model to another billing source while a turn is
	// running: a selection takes effect only after the whole task is idle.
	const assertRouteAllowed = (
		model: string | undefined,
		source: ModelSource | undefined,
	): void => {
		if (model === undefined) return;
		if (config.hostManagedProviderKeys && source === undefined) {
			throw new Error(
				"A billing source is required for model selections in host-managed mode",
			);
		}
		if (
			(controller.isRunning || agentTaskManager.hasActiveTasks) &&
			(model !== config.modelString || source !== config.modelSource)
		) {
			throw new Error(
				"The model or billing source cannot change while a turn or its workers are running; wait for them to finish",
			);
		}
	};
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
				assertRouteAllowed(control.model, control.source);
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
					conversationContext: await buildServeConversationContext(
						control.forkContext,
						control.systemContext,
						store.paths.root,
					),
					onStart: async () => {
						config.refreshAuth();
						if (control.model !== undefined) {
							config.setModel(parseModel(control.model), control.source);
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
						if (control.imageModel !== undefined) {
							config.setImageModel(parseGenerativeModelRef(control.imageModel));
						}
						if (control.videoGeneration !== undefined) {
							config.setVideoGenerationEnabled(control.videoGeneration);
						}
						if (control.videoModel !== undefined) {
							config.setVideoModel(parseGenerativeModelRef(control.videoModel));
						}
						config.setOpenRouterProvider(control.openRouterProvider);
						// Sent on every turn; an absent list clears prior client
						// tools so a disconnected surface never leaves stale tools.
						clientToolBridge.setTools(control.clientTools ?? []);
						await sessionRestore.prepare(control.threadId, config.model);
					},
				});
				await sessionRestore.save(config.model);
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
				await sessionRestore.save(config.model);
				if (control.requestId !== undefined) {
					writeRecord("serve:turn", control.requestId, {
						status,
						threadId: session.threadId,
					});
				}
				return;
			}
			case "waitForIdle":
				await controller.waitForIdle();
				await workerWorkspaceManager.waitForIdle();
				writeRecord("serve:ack", control.requestId, { op: "waitForIdle" });
				return;
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
				assertRouteAllowed(control.model, control.source);
				config.setModel(parseModel(control.model), control.source);
				writeRecord("serve:ack", control.requestId, {
					op: "setModel",
					model: config.modelString,
					...(config.modelSource ? { source: config.modelSource } : {}),
				});
				return;
			case "setMcpServers": {
				// The IDE owns MCP configuration for the session and pushes the
				// full set on every change. Servers missing from the layered
				// set are disconnected; untouched servers keep their live
				// connection. See ServeTypes for what `authoritative` layers.
				const result = await mcpWork.run(
					async (releaseTurns) => {
						const { entries, sources } = await resolveMcpServerSet({
							cwd: config.cwd,
							paths: config.mcpConfigPaths,
							pushed: control.servers,
							authoritative: control.authoritative === true,
							runtime: runtimeMcpServers,
						});
						// A find_mcp server the IDE now lists is the IDE's: a later
						// push that drops it must disconnect it.
						for (const name of Object.keys(control.servers)) {
							runtimeMcpServers.delete(name);
						}
						return mcpManager.setServers(entries, mcpShutdown.signal, {
							forceNames: control.force,
							sources,
							onUpdate: (update) =>
								mcpToolRegistrar.applyRefresh({ ...update, warnings: [] }),
							onToolsAdvertised: releaseTurns,
						});
					},
					{ blocksTurns: true },
				);
				mcpToolRegistrar.emitWarnings(result.warnings);
				writeRecord(
					"serve:mcp",
					control.requestId,
					mcpStatus.snapshot(result.warnings),
				);
				mcpStatus.schedule();
				return;
			}
			case "authenticateMcpServer": {
				const current = mcpManager
					.listServerStatuses()
					.find((entry) => entry.name === control.name);
				if (!current) {
					throw new Error(`Unknown MCP server '${control.name}'.`);
				}
				if (current.type !== "http") {
					throw new Error(
						`MCP server '${control.name}' is a stdio server and has no OAuth sign-in; reconnect it instead.`,
					);
				}
				// Queued through `mcpWork` by the controller's authenticateServer.
				await mcpController.authenticateServer(current, mcpShutdown.signal);
				const after = mcpManager
					.listServerStatuses()
					.find((entry) => entry.name === control.name);
				if (after?.status !== "connected") {
					throw new Error(
						`Sign-in for MCP server '${control.name}' did not complete: ${after?.message ?? "the server is no longer configured"}`,
					);
				}
				writeRecord("serve:mcp", control.requestId, mcpStatus.snapshot());
				return;
			}
			case "setCredentials": {
				const snapshot = JSON.stringify(
					[...control.providerKeys].sort((a, b) =>
						a.provider.localeCompare(b.provider),
					),
				);
				if (
					control.revision < credentialRevision ||
					(control.revision === credentialRevision &&
						snapshot !== credentialSnapshot)
				) {
					throw new Error("Stale or conflicting credential revision");
				}
				credentialRevision = control.revision;
				credentialSnapshot = snapshot;
				// Synchronous on purpose: stdin lines are dispatched in order but
				// handlers run concurrently, so only the synchronous prefix of a
				// handler is guaranteed to precede the next line's work.
				config.setHostProviderKeys(
					control.providerKeys.map(({ provider, key }) => ({ provider, key })),
				);
				writeRecord("serve:ack", control.requestId, {
					op: "setCredentials",
					revision: control.revision,
					providers: control.providerKeys.map((entry) => entry.provider),
				});
				return;
			}
			case "listModels":
				config.refreshAuth();
				writeRecord(
					"serve:models",
					control.requestId,
					await client.listModels(),
				);
				return;
			case "listImageModels":
				config.refreshAuth();
				writeRecord(
					"serve:imageModels",
					control.requestId,
					(await client.listImageModels?.()) ?? { models: [], total: 0 },
				);
				return;
			case "listVideoModels":
				config.refreshAuth();
				writeRecord(
					"serve:videoModels",
					control.requestId,
					(await client.listVideoModels?.()) ?? { models: [], total: 0 },
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
				// Unblocks pending MCP connects/OAuth so the wait below is short.
				mcpShutdown.abort();
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
		capabilities: [...SERVE_CAPABILITIES],
		runtime,
	});

	// Connect configured MCP servers in the background. The initialize call
	// marks them `connecting` synchronously, which the status publisher
	// reports; each server's tools register as soon as it connects. Queued
	// first, so IDE pushes and turns line up behind it.
	void mcpWork
		.run(
			async (releaseTurns) => {
				const result = await mcpManager.initialize(mcpShutdown.signal, {
					onUpdate: (update) =>
						mcpToolRegistrar.applyRefresh({
							tools: update.tools,
							removedToolNames: update.removedToolNames ?? [],
							warnings: [],
						}),
					onToolsAdvertised: releaseTurns,
				});
				// Startup warnings stay out of the transcript (they cluttered
				// every launch); the IDE gets them with the status snapshot.
				mcpStatus.schedule(result.warnings);
			},
			{ blocksTurns: true },
		)
		.catch((error) => {
			process.stderr.write(
				`MCP initialization failed: ${errorMessage(error)}\n`,
			);
			mcpStatus.schedule();
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
	mcpShutdown.abort();
	await Promise.allSettled([...pendingOps]);
	await flush();
}

/**
 * Parses a `provider/name` selection into the pair Backboard expects.
 * Provider names never contain a slash, so splitting on the first one keeps
 * OpenRouter video ids (e.g. `openrouter/google/veo-3.1`) intact.
 */
function parseGenerativeModelRef(
	value: string,
): { provider: string; name: string } | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) {
		return undefined;
	}
	return {
		provider: trimmed.slice(0, separator),
		name: trimmed.slice(separator + 1),
	};
}

function parseMaxWorkers(value: string | undefined): number {
	if (!value) return 4;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}
