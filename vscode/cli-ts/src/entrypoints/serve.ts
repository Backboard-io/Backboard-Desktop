import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Config } from "../config/Config.ts";
import { parseMemoryMode, parseModel } from "../config/defaults.ts";
import { parseThinking } from "../config/thinking.ts";
import { AgentController } from "../core/agent/AgentController.ts";
import { EventBus } from "../core/bus/EventBus.ts";
import { HookController, loadHookConfig } from "../core/hooks/index.ts";
import { LspService, resolveLspFlags } from "../core/lsp/index.ts";
import {
	loadMcpConfig,
	McpClientManager,
	McpToolRegistrar,
} from "../core/mcp/index.ts";
import { ClientEventLog } from "../core/session/ClientEventLog.ts";
import { JsonEventStream } from "../core/session/JsonEventStream.ts";
import { ServerEventLog } from "../core/session/ServerEventLog.ts";
import { Session } from "../core/session/Session.ts";
import { SessionStore } from "../core/session/SessionStore.ts";
import { SkillController } from "../core/skills/SkillController.ts";
import { ToolPermissionGate } from "../core/tools/ToolPermissionGate.ts";
import { ToolRegistry } from "../core/tools/ToolRegistry.ts";
import { buildStartupEnvironmentPrompt } from "../prompts/system/startupEnvironment.ts";
import { BackboardClient } from "../providers/backboard/BackboardClient.ts";
import { createDefaultTools } from "../tools/index.ts";
import { shortId } from "../utils/id.ts";
import type {
	ServeControl,
	ServeRecord,
	ServeRecordType,
} from "./ServeTypes.ts";
import { parseControlLine } from "./serveControl.ts";

/**
 * Persistent host mode: a long-lived agent session driven over stdio. The host
 * writes one `ServeControl` JSON object per stdin line and reads two kinds of
 * JSONL records from stdout: `JsonEventStream` agent events (`source:
 * "client"`) and serve control responses (`source: "serve"`). stdout carries
 * nothing else; human-readable output goes to stderr.
 */
export async function runServe(argv: string[]): Promise<void> {
	let config: Config;
	try {
		config = new Config({ argv });
	} catch (err) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const sessionId = shortId("sess");
	const store = new SessionStore(sessionId, config.cwd);
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

	const session = new Session(sessionId);
	bus.emit({ type: "session:created", sessionId, threadId: session.threadId });

	const client = new BackboardClient(config.env, serverLog);
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
	for (const warning of [...hookConfig.warnings, ...mcp.warnings]) {
		bus.emit({ type: "system:warning", message: warning });
	}

	const lspFlags = resolveLspFlags();
	const lsp = new LspService({
		directory: config.cwd,
		flags: { ...lspFlags, enabled: config.flags.lsp ?? lspFlags.enabled },
		onWarning: (message) => {
			bus.emit({ type: "system:warning", message });
		},
	});
	let registry: ToolRegistry;
	registry = new ToolRegistry(
		createDefaultTools({
			client,
			config,
			hookController,
			lsp,
			getTools: () => registry.list(),
		}),
	);
	const mcpToolRegistrar = new McpToolRegistrar(registry, bus);
	mcpToolRegistrar.register(mcp);
	const skillController = new SkillController({ cwd: config.cwd, bus });
	const syncMcpToolUpdates = async (signal: AbortSignal): Promise<void> => {
		const result = await mcpManager.refreshTools(signal);
		mcpToolRegistrar.applyRefresh(result);
		mcpToolRegistrar.emitWarnings(
			(await mcpManager.refreshPrompts(signal)).warnings,
		);
		mcpToolRegistrar.emitWarnings(
			(await mcpManager.refreshResources(signal)).warnings,
		);
	};

	const permissionGate = new ToolPermissionGate(bus);
	const controller = new AgentController({
		config,
		bus,
		session,
		registry,
		client,
		skillController,
		hookController,
		permissionGate,
		lsp,
		syncDynamicTools: syncMcpToolUpdates,
		startupEnvironmentPrompt,
	});

	/** Selects named repo/personal skills into the catalog for upcoming turns. */
	const selectSkillsByName = async (names: string[]): Promise<void> => {
		const tabs = await skillController.listSkillTabs();
		const wanted = new Set(names);
		for (const tab of tabs) {
			if (tab.id === "skills-sh") continue;
			for (const item of tab.items) {
				if (!wanted.delete(item.name)) continue;
				try {
					await skillController.selectSkill(item);
				} catch (err) {
					bus.emit({
						type: "system:warning",
						message: `Failed to load skill "${item.name}": ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
		}
		for (const name of wanted) {
			bus.emit({ type: "system:warning", message: `Unknown skill: ${name}` });
		}
	};

	/** Persists host-sent attachments and appends read-me pointers to the prompt. */
	const writeAttachments = async (
		prompt: string,
		files: readonly { fileName: string; dataBase64: string }[],
	): Promise<string> => {
		const attachmentsDir = join(dirname(store.paths.clientLog), "attachments");
		await mkdir(attachmentsDir, { recursive: true });
		const pointers: string[] = [];
		for (const file of files) {
			const safeName = basename(file.fileName) || "attachment";
			const target = join(attachmentsDir, safeName);
			await writeFile(target, Buffer.from(file.dataBase64, "base64"));
			pointers.push(`Attached file (read it with the Read tool): ${target}`);
		}
		return pointers.length ? `${prompt}\n\n${pointers.join("\n")}` : prompt;
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
		await controller.dispose();
		await lsp.shutdown();
		await mcpManager.close();
		await Promise.all([clientLog.flush(), serverLog.flush()]);
	};

	const pendingOps: Promise<void>[] = [];
	let disposing = false;
	const handleControl = async (control: ServeControl): Promise<void> => {
		switch (control.op) {
			case "submit": {
				const { requestId } = control;
				if (control.permission !== undefined) {
					permissionGate.setPolicy(control.permission);
				}
				if (control.skills?.length) {
					await selectSkillsByName(control.skills);
				}
				let prompt = control.prompt;
				if (control.files?.length) {
					prompt = await writeAttachments(prompt, control.files);
				}
				const status = await controller.submit(prompt, {
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
						if (control.computerUse !== undefined) {
							config.setComputerUse(control.computerUse);
						}
						if (control.browserUse !== undefined) {
							config.setBrowserUse(control.browserUse);
						}
						if (control.notify !== undefined) {
							config.setNotifyEnabled(control.notify);
						}
						if (control.imageGeneration !== undefined) {
							config.setImageGeneration(control.imageGeneration);
						}
					},
				});
				writeRecord("serve:turn", requestId, { status });
				return;
			}
			case "steer": {
				const status = await controller.steer(control.prompt, {
					emitUserMessage: true,
				});
				if (control.requestId !== undefined) {
					writeRecord("serve:turn", control.requestId, { status });
				}
				return;
			}
			case "warmup": {
				await controller.prewarmAssistant();
				if (control.requestId !== undefined) {
					writeRecord("serve:warm", control.requestId, { ok: true });
				}
				return;
			}
			case "cancel": {
				controller.cancel({ clearQueue: true });
				writeRecord("serve:ack", control.requestId, { op: "cancel" });
				return;
			}
			case "respondInput": {
				controller.provideInput(control.id, control.answer);
				return;
			}
			case "respondPermission": {
				permissionGate.respond(control.id, {
					decision: control.decision,
					reason: control.reason,
				});
				return;
			}
			case "setModel": {
				config.setModel(parseModel(control.model));
				writeRecord("serve:ack", control.requestId, {
					op: "setModel",
					model: config.modelString,
				});
				return;
			}
			case "listModels": {
				const models = await client.listModels();
				writeRecord("serve:models", control.requestId, models);
				return;
			}
			case "listTools": {
				const tools = registry.list().map((tool) => ({
					name: tool.agentName,
					displayName: tool.displayName,
				}));
				writeRecord("serve:tools", control.requestId, { tools });
				return;
			}
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
			case "dispose": {
				// Graceful shutdown: drain in-flight ops (e.g. an active turn)
				// before flushing. The snapshot is taken synchronously on
				// dispose entry, so it never contains dispose's own promise.
				// Hosts that want immediate teardown send `cancel` first; the
				// IDE additionally SIGKILLs after a grace period.
				disposing = true;
				await Promise.allSettled([...pendingOps]);
				await flush();
				process.exit(0);
			}
		}
	};

	// Fire SessionStart at init so hooks run even before the first submit.
	await controller.start();
	writeRecord("serve:ready", undefined, {
		sessionId,
		cwd: config.cwd,
		model: config.modelString,
	});

	const reader = createInterface({ input: process.stdin });
	reader.on("line", (line) => {
		const parsed = parseControlLine(line);
		if (parsed === null) return;
		if (!parsed.ok) {
			writeRecord("serve:error", parsed.requestId, { error: parsed.error });
			return;
		}
		const control = parsed.control;
		const run = handleControl(control).catch((err) => {
			const requestId =
				"requestId" in control && typeof control.requestId === "string"
					? control.requestId
					: undefined;
			writeRecord("serve:error", requestId, {
				op: control.op,
				error: err instanceof Error ? err.message : String(err),
			});
		});
		pendingOps.push(run);
	});

	await new Promise<void>((resolve) => {
		reader.on("close", () => resolve());
	});
	// stdin closed. If a graceful `dispose` op is already draining, let it
	// finish the in-flight turn; otherwise the host vanished — cancel work,
	// settle in-flight ops, and exit.
	if (!disposing) {
		controller.cancel({ clearQueue: true });
	}
	await Promise.allSettled(pendingOps);
	await flush();
}
