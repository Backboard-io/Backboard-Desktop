import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { APP_DISPLAY_NAME } from "../config/branding.ts";
import type { Config } from "../config/Config.ts";
import { formatModel } from "../config/defaults.ts";
import { loadBrowserEnv } from "../config/env.ts";
import type { AgentController } from "../core/agent/AgentController.ts";
import type { BackboardDeviceCodeResponse } from "../core/auth/BackboardOAuth.ts";
import type { EventBus } from "../core/bus/EventBus.ts";
import type {
	AddHookInput,
	HookEventName,
	HookEventSummary,
	HookManagerController,
	HookManagerSnapshot,
	LoadedHook,
} from "../core/hooks/index.ts";
import type { LspService } from "../core/lsp/index.ts";
import type {
	McpAddResult,
	McpController,
	McpPromptDefinition,
	McpRegistryItem,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpServerRuntimeStatus,
} from "../core/mcp/index.ts";
import {
	formatMcpPromptForUser,
	formatMcpResourceForUser,
	resourceTemplateVariables,
} from "../core/mcp/index.ts";
import type {
	SkillController,
	SkillPickerItem,
	SkillPickerTab,
} from "../core/skills/SkillController.ts";
import type { BackboardClient } from "../providers/backboard/BackboardClient.ts";
import { fetchModels } from "../providers/backboard/models.ts";
import type { ModelInfo } from "../providers/backboard/types.ts";
import {
	canRunCommandAfterSessionEnd,
	HELP_TEXT,
	parseCommand,
} from "./commands/index.ts";
import { AskUserPrompt } from "./components/AskUserPrompt.tsx";
import { HookAddForm } from "./components/HookAddForm.tsx";
import { HookDetails } from "./components/HookDetails.tsx";
import {
	type HookEventSelection,
	HookEventSelector,
} from "./components/HookEventSelector.tsx";
import {
	type HookManagerSelection,
	HookManagerSelector,
} from "./components/HookManagerSelector.tsx";
import { HookMatcherSelector } from "./components/HookMatcherSelector.tsx";
import { ManualMcpInput } from "./components/ManualMCPInput.tsx";
import {
	type McpArgumentField,
	McpArgumentInput,
} from "./components/MCPArgumentInput.tsx";
import {
	type McpManagerSelection,
	McpManagerSelector,
} from "./components/MCPManagerSelector.tsx";
import {
	type McpPrimitiveSelection,
	McpPrimitiveSelector,
} from "./components/MCPPrimitiveSelector.tsx";
import { McpRegistrySelector } from "./components/MCPRegistrySelector.tsx";
import { McpServerActions } from "./components/MCPServerActions.tsx";
import {
	type MemoryChoice,
	MemorySelector,
} from "./components/MemorySelector.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ModelSelector } from "./components/ModelSelector.tsx";
import {
	emptyPromptHistoryState,
	PromptInput,
} from "./components/PromptInput.tsx";
import { SkillsSelector } from "./components/SkillsSelector.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { StaticTranscript } from "./components/StaticTranscript.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import {
	modelUsesAutomaticThinkingOnly,
	type ThinkingChoice,
	ThinkingSelector,
} from "./components/ThinkingSelector.tsx";
import {
	TodoPanel,
	todoPanelDisplayForTerminalHeight,
} from "./components/TodoPanel.tsx";
import { compactLiveTranscriptItems } from "./components/TranscriptLayout.ts";
import { CLEAR_VISIBLE_SCREEN } from "./hooks/ResizeStabilizer.constants.ts";
import { TerminalSizeProvider } from "./hooks/TerminalSizeContext.tsx";
import { useAgent } from "./hooks/useAgent.ts";
import { useResizeStabilizer } from "./hooks/useResizeStabilizer.ts";
import { useStableTranscriptLayout } from "./hooks/useStableTranscriptLayout.ts";
import { useStartupPickerPreload } from "./hooks/useStartupPickerPreload.ts";
import type { PromptHistoryState, QueuedPromptItem } from "./input/types.ts";
import { playCompletionNotification } from "./notify.ts";
import { theme } from "./theme/theme.ts";

interface Props {
	config: Config;
	bus: EventBus;
	controller: AgentController;
	skillController: SkillController;
	mcpController: McpController;
	hookManager: HookManagerController;
	lsp: LspService;
	client: BackboardClient;
	startupWarnings: readonly string[];
	onLogin: (
		onDeviceCode?: (response: BackboardDeviceCodeResponse) => void,
	) => Promise<string>;
	onLogout: () => Promise<string>;
	onExit: () => void;
}

type Mode =
	| "normal"
	| "loading"
	| "model"
	| "thinking"
	| "memory"
	| "skills"
	| "hooks"
	| "hooks-event"
	| "hooks-matcher"
	| "hook-detail"
	| "hooks-add"
	| "mcp"
	| "mcp-server"
	| "mcp-primitives"
	| "mcp-arguments"
	| "mcp-registry"
	| "mcp-manual";

type PendingMcpArgumentSelection =
	| { type: "prompt"; prompt: McpPromptDefinition }
	| { type: "template"; template: McpResourceTemplateDefinition };

const DOUBLE_CTRL_C_MS = 1500;

export function App({
	config,
	bus,
	controller,
	skillController,
	mcpController,
	hookManager,
	lsp,
	client,
	startupWarnings,
	onLogin,
	onLogout,
	onExit,
}: Props): React.ReactElement {
	const app = useApp();
	const agent = useAgent(controller, bus, config.modelString, startupWarnings);
	const [showBanner, setShowBanner] = useState(true);
	const [queuedPrompts, setQueuedPrompts] = useState<QueuedPromptItem[]>([]);
	const [promptHistory, setPromptHistory] = useState<PromptHistoryState>(
		emptyPromptHistoryState,
	);
	const nextQueuedPromptId = useRef(0);
	const initialBanner = useRef({
		id: "banner",
		status: agent.state.status,
		model: agent.state.model,
		cwd: config.cwd,
		usage: { ...agent.state.usage },
	});
	const [mode, setMode] = useState<Mode>("normal");
	const [loadingLabel, setLoadingLabel] = useState("Loading");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [pendingModel, setPendingModel] = useState<ModelInfo | null>(null);
	const [skillTabs, setSkillTabs] = useState<SkillPickerTab[]>([]);
	const [skillCommands, setSkillCommands] = useState<string[]>([]);
	const [hookSnapshot, setHookSnapshot] = useState<HookManagerSnapshot | null>(
		null,
	);
	const [selectedHookEvent, setSelectedHookEvent] =
		useState<HookEventSummary | null>(null);
	const [pendingHookMatcher, setPendingHookMatcher] = useState<string | null>(
		null,
	);
	const [selectedHookMatcherHooks, setSelectedHookMatcherHooks] = useState<
		LoadedHook[]
	>([]);
	const [selectedHook, setSelectedHook] = useState<LoadedHook | null>(null);
	const [addContext, setAddContext] = useState<{
		event: HookEventName;
		initialMatcher?: string;
	} | null>(null);
	const [addToolNames, setAddToolNames] = useState<string[]>([]);
	const [mcpServers, setMcpServers] = useState<McpRegistryItem[]>([]);
	const [mcpServerStatuses, setMcpServerStatuses] = useState<
		McpServerRuntimeStatus[]
	>(() => mcpController.listServerStatuses());
	const [selectedMcpServer, setSelectedMcpServer] =
		useState<McpServerRuntimeStatus | null>(null);
	const [mcpPrompts, setMcpPrompts] = useState<McpPromptDefinition[]>([]);
	const [mcpResources, setMcpResources] = useState<McpResourceDefinition[]>([]);
	const [mcpResourceTemplates, setMcpResourceTemplates] = useState<
		McpResourceTemplateDefinition[]
	>([]);
	const [pendingMcpArguments, setPendingMcpArguments] =
		useState<PendingMcpArgumentSelection | null>(null);
	const [lastCtrlC, setLastCtrlC] = useState(0);
	const [sessionEnded, setSessionEnded] = useState(false);
	const skillCommandSet = useMemo(
		() => new Set(skillCommands),
		[skillCommands],
	);
	useStartupPickerPreload(client, skillController);
	const terminalSize = useWindowSize();
	const { stdout, write } = useStdout();
	const submitPrompt = useCallback(
		(
			text: string,
			options: {
				steer?: boolean;
				onStart?: () => void;
			} = {},
		) => {
			const run = options.steer
				? controller.steer(text, { onStart: options.onStart })
				: controller.submit(text, { onStart: options.onStart });
			void run
				.then((status) => {
					if (status === "completed" && config.isNotifyEnabled) {
						playCompletionNotification(write);
					}
				})
				.catch(() => {
					// Errors are already surfaced as run:error events.
				});
		},
		[config, controller, write],
	);
	const selectSkill = useCallback(
		(item: SkillPickerItem, signal: AbortSignal) =>
			skillController.selectSkill(item, signal),
		[skillController],
	);
	const openModelSelector = useCallback(() => {
		setLoadingLabel("Loading models");
		setMode("loading");
		void fetchModels(client)
			.then((result) => {
				setModels(result);
				setMode("model");
			})
			.catch((err) => {
				agent.notice(
					`Failed to load models: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				setMode("normal");
			});
	}, [agent, client]);
	const openSkillsSelector = useCallback(() => {
		setLoadingLabel("Loading skills");
		setMode("loading");
		void skillController
			.listSkillTabs()
			.then((result) => {
				setSkillTabs(result);
				setMode("skills");
			})
			.catch((err) => {
				agent.notice(
					`Failed to load skills: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				setMode("normal");
			});
	}, [agent, skillController]);
	const toggleLsp = useCallback(() => {
		void lsp
			.toggleEnabled()
			.then((enabled) => {
				agent.notice(
					`LSP diagnostics ${enabled ? "enabled" : "disabled"} for this session.`,
				);
			})
			.catch((err) => {
				agent.notice(
					`Failed to toggle LSP diagnostics: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			});
	}, [agent, lsp]);
	const openHookManager = useCallback(() => {
		const snapshot = hookManager.snapshot();
		setHookSnapshot(snapshot);
		for (const warning of snapshot.warnings) {
			agent.notice(warning, "error");
		}
		setMode("hooks");
	}, [agent, hookManager]);
	const startAddHook = useCallback(
		(event: HookEventName, matcher?: string) => {
			setAddContext({ event, initialMatcher: matcher });
			setAddToolNames(controller.listToolNames());
			setMode("hooks-add");
		},
		[controller],
	);
	const addHook = useCallback(
		async (input: AddHookInput) => {
			const snapshot = await hookManager.addHook(input);
			setHookSnapshot(snapshot);
			const summary = snapshot.events.find(
				(event) => event.event === input.event,
			);
			if (summary) {
				setSelectedHookEvent(summary);
				setMode("hooks-event");
			} else {
				setMode("hooks");
			}
			agent.notice("Hook added.", "info");
		},
		[agent, hookManager],
	);
	const selectHookManagerItem = useCallback(
		(selection: HookManagerSelection) => {
			setSelectedHookEvent(selection.event);
			setMode("hooks-event");
		},
		[],
	);
	const selectHookEventItem = useCallback((selection: HookEventSelection) => {
		setPendingHookMatcher(selection.matcher);
		setSelectedHookMatcherHooks(selection.hooks);
		setMode("hooks-matcher");
	}, []);
	const viewHookDetails = useCallback((hook: LoadedHook) => {
		setSelectedHook(hook);
		setMode("hook-detail");
	}, []);
	const removeHook = useCallback(
		async (hook: LoadedHook) => {
			const snapshot = await hookManager.removeHook(hook);
			setHookSnapshot(snapshot);
			const matcherKey = hook.matcher ?? "*";
			const remaining = snapshot.hooks.filter(
				(candidate) =>
					candidate.event === hook.event &&
					(candidate.matcher ?? "*") === matcherKey,
			);
			if (remaining.length === 0) {
				setMode("hooks-event");
			} else {
				setSelectedHookMatcherHooks(remaining);
			}
			agent.notice("Hook removed.", "info");
		},
		[agent, hookManager],
	);
	const noticeMcpAdded = useCallback(
		(result: McpAddResult) => {
			const envNote =
				result.requiredEnv.length > 0
					? ` Required env: ${result.requiredEnv.join(", ")}.`
					: "";
			const toolsNote =
				result.toolNames.length > 0
					? ` Loaded ${result.toolNames.length} tool${result.toolNames.length === 1 ? "" : "s"}.`
					: " No tools loaded in this session.";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Added MCP server: ${result.title}.${toolsNote}${envNote}${warningNote}`,
			);
		},
		[agent],
	);
	const refreshMcpStatuses = useCallback((): McpServerRuntimeStatus[] => {
		const statuses = mcpController.listServerStatuses();
		setMcpServerStatuses(statuses);
		return statuses;
	}, [mcpController]);
	const openMcpServer = useCallback(
		(serverName: string): boolean => {
			const statuses = refreshMcpStatuses();
			const status = statuses.find(
				(candidate) => candidate.name === serverName,
			);
			if (!status) return false;
			setSelectedMcpServer(status);
			setMode("mcp-server");
			return true;
		},
		[refreshMcpStatuses],
	);
	const addMcpServer = useCallback(
		async (server: McpRegistryItem, signal: AbortSignal) => {
			const result = await mcpController.addRegistryServer(server, signal);
			noticeMcpAdded(result);
			if (!openMcpServer(result.name)) {
				setMode("mcp");
			}
		},
		[mcpController, noticeMcpAdded, openMcpServer],
	);
	const openMcpRegistry = useCallback(() => {
		setLoadingLabel("Loading MCP catalog");
		setMode("loading");
		void mcpController
			.listRegistryServers()
			.then((result) => {
				setMcpServers(result);
				setMode("mcp-registry");
			})
			.catch((err) => {
				agent.notice(
					`Failed to load MCP catalog: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				setMode("mcp");
			});
	}, [agent, mcpController]);
	const submitManualMcp = useCallback(
		async (input: string, signal?: AbortSignal) => {
			const result = await mcpController.addManualServer(input, signal);
			noticeMcpAdded(result);
			if (!openMcpServer(result.name)) {
				setMode("mcp");
			}
		},
		[mcpController, noticeMcpAdded, openMcpServer],
	);
	const authenticateMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.authenticateServer(server, signal);
			const statuses = mcpController.listServerStatuses();
			const nextServer =
				statuses.find((candidate) => candidate.name === server.name) ?? server;
			setMcpServerStatuses(statuses);
			setSelectedMcpServer(nextServer);

			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			if (nextServer.status !== "connected") {
				const detail = nextServer.message
					? ` ${nextServer.message}`
					: warningNote;
				agent.notice(
					`Failed to authenticate MCP server: ${server.name}.${detail}`,
					"error",
				);
				return;
			}

			const toolsNote =
				result.toolNames.length > 0
					? ` Loaded ${result.toolNames.length} tool${result.toolNames.length === 1 ? "" : "s"}.`
					: " No tools loaded.";
			agent.notice(
				`Authenticated MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
		},
		[agent, mcpController],
	);
	const disableMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.disableServer(server, signal);
			const toolsNote =
				result.toolNames.length > 0
					? ` Unloaded ${result.toolNames.length} tool${result.toolNames.length === 1 ? "" : "s"}.`
					: "";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Disabled MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
			const statuses = mcpController.listServerStatuses();
			setMcpServerStatuses(statuses);
			setSelectedMcpServer(
				statuses.find((candidate) => candidate.name === server.name) ?? null,
			);
		},
		[agent, mcpController],
	);
	const removeMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.removeServer(server, signal);
			const toolsNote =
				result.toolNames.length > 0
					? ` Unloaded ${result.toolNames.length} tool${result.toolNames.length === 1 ? "" : "s"}.`
					: "";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Removed MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
			setSelectedMcpServer(null);
			refreshMcpStatuses();
			setMode("mcp");
		},
		[agent, mcpController, refreshMcpStatuses],
	);
	const browseMcpPrimitives = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.browsePrimitives(server, signal);
			if (result.warnings.length > 0) {
				agent.notice(result.warnings.join(" "), "error");
			}
			setMcpPrompts(result.prompts);
			setMcpResources(result.resources);
			setMcpResourceTemplates(result.templates);
			const statuses = refreshMcpStatuses();
			setSelectedMcpServer(
				statuses.find((candidate) => candidate.name === server.name) ?? server,
			);
			setMode("mcp-primitives");
		},
		[agent, mcpController, refreshMcpStatuses],
	);
	const selectMcpPrimitive = useCallback(
		async (selection: McpPrimitiveSelection, signal: AbortSignal) => {
			if (!selectedMcpServer) return;
			if (selection.type === "prompt") {
				if ((selection.prompt.arguments ?? []).length > 0) {
					setPendingMcpArguments(selection);
					setMode("mcp-arguments");
					return;
				}
				const result = await mcpController.getPrompt(
					selectedMcpServer,
					selection.prompt.name,
					undefined,
					signal,
				);
				submitPrompt(formatMcpPromptForUser(selectedMcpServer.name, result));
				setMode("normal");
				return;
			}
			if (selection.type === "resource") {
				if (selection.action === "subscribe") {
					await mcpController.subscribeResource(
						selectedMcpServer,
						selection.resource.uri,
						signal,
					);
					agent.notice(`Subscribed MCP resource: ${selection.resource.uri}`);
					const statuses = refreshMcpStatuses();
					setSelectedMcpServer(
						statuses.find(
							(candidate) => candidate.name === selectedMcpServer.name,
						) ?? selectedMcpServer,
					);
					setMode("mcp-primitives");
					return;
				}
				if (selection.action === "unsubscribe") {
					await mcpController.unsubscribeResource(
						selectedMcpServer,
						selection.resource.uri,
						signal,
					);
					agent.notice(`Unsubscribed MCP resource: ${selection.resource.uri}`);
					const statuses = refreshMcpStatuses();
					setSelectedMcpServer(
						statuses.find(
							(candidate) => candidate.name === selectedMcpServer.name,
						) ?? selectedMcpServer,
					);
					setMode("mcp-primitives");
					return;
				}
				const result = await mcpController.readResource(
					selectedMcpServer,
					selection.resource.uri,
					signal,
				);
				submitPrompt(
					formatMcpResourceForUser(selectedMcpServer.name, result.contents),
				);
				setMode("normal");
				return;
			}
			const fields = resourceTemplateFields(selection.template.uriTemplate);
			if (fields.length > 0) {
				setPendingMcpArguments(selection);
				setMode("mcp-arguments");
				return;
			}
			const result = await mcpController.readResource(
				selectedMcpServer,
				selection.template.uriTemplate,
				signal,
			);
			submitPrompt(
				formatMcpResourceForUser(selectedMcpServer.name, result.contents),
			);
			setMode("normal");
		},
		[agent, mcpController, refreshMcpStatuses, selectedMcpServer, submitPrompt],
	);
	const submitMcpArguments = useCallback(
		async (values: Record<string, string>, signal: AbortSignal) => {
			if (!selectedMcpServer || !pendingMcpArguments) return;
			if (pendingMcpArguments.type === "prompt") {
				const result = await mcpController.getPrompt(
					selectedMcpServer,
					pendingMcpArguments.prompt.name,
					values,
					signal,
				);
				submitPrompt(formatMcpPromptForUser(selectedMcpServer.name, result));
				setPendingMcpArguments(null);
				setMode("normal");
				return;
			}
			const result = await mcpController.readResourceTemplate(
				selectedMcpServer,
				pendingMcpArguments.template.uriTemplate,
				values,
				signal,
			);
			submitPrompt(
				formatMcpResourceForUser(selectedMcpServer.name, result.contents),
			);
			setPendingMcpArguments(null);
			setMode("normal");
		},
		[mcpController, pendingMcpArguments, selectedMcpServer, submitPrompt],
	);
	const selectMcpAction = useCallback(
		(selection: McpManagerSelection) => {
			if (selection.type === "server") {
				setSelectedMcpServer(selection.server);
				setMode("mcp-server");
				return;
			}
			if (selection.type === "registry") {
				openMcpRegistry();
				return;
			}
			setMode("mcp-manual");
		},
		[openMcpRegistry],
	);
	const applyModelSelection = useCallback(
		async (selectedModel: ModelInfo, choice: ThinkingChoice) => {
			config.setModel({
				provider: selectedModel.provider,
				model: selectedModel.model,
			});
			config.setThinking(choice.value);
			agent.setModelLabel(formatModel(selectedModel));
			try {
				await config.saveRuntimeSelection();
				agent.notice(
					`Model: ${formatModel(selectedModel)} · thinking ${choice.label}`,
				);
			} catch (err) {
				agent.notice(
					`Model changed for this session, but saving the selection failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
					"error",
				);
			} finally {
				setPendingModel(null);
				setMode("normal");
			}
		},
		[agent, config],
	);
	const applyModel = useCallback(
		async (choice: ThinkingChoice) => {
			if (!pendingModel) return;
			await applyModelSelection(pendingModel, choice);
		},
		[applyModelSelection, pendingModel],
	);
	const applyMemory = useCallback(
		async (choice: MemoryChoice) => {
			config.setMemory(choice.mode);
			try {
				await config.saveRuntimeSelection();
				agent.notice(`Memory: ${choice.label}`);
			} catch (err) {
				agent.notice(
					`Memory changed for this session, but saving the selection failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
					"error",
				);
			} finally {
				setMode("normal");
			}
		},
		[agent, config],
	);

	const quit = useCallback(() => {
		onExit();
		app.exit();
	}, [app, onExit]);
	const logout = useCallback(() => {
		void onLogout()
			.then(() => {
				agent.cancel();
				onExit();
				app.exit();
			})
			.catch((err) => {
				agent.notice(
					`Failed to sign out: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			});
	}, [agent, app, onExit, onLogout]);
	const login = useCallback(() => {
		setLoadingLabel("Waiting for Backboard login");
		setMode("loading");
		void onLogin((response) => {
			agent.notice(
				[
					"Open this URL on any device with a browser (code already filled in):",
					response.verification_uri_complete,
					"",
					`Or go to ${response.verification_uri} and enter code: ${response.user_code}`,
				].join("\n"),
			);
		})
			.then((message) => {
				agent.notice(message);
				setSessionEnded(false);
				setMode("normal");
			})
			.catch((err) => {
				agent.notice(
					`Failed to sign in: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				setMode("normal");
			});
	}, [agent, onLogin]);
	const enableBrowser = useCallback(() => {
		controller.enableBrowserUse();
		agent.notice(`Browser tool enabled: ${browserTargetLabel()}`);
	}, [agent, controller]);
	const running = agent.state.status === "running";
	const allowPromptCommand = useCallback(
		(command: Parameters<typeof canRunCommandAfterSessionEnd>[0]) =>
			!sessionEnded || canRunCommandAfterSessionEnd(command),
		[sessionEnded],
	);
	const cancelUserTurns = useCallback(() => {
		setQueuedPrompts([]);
		agent.cancel();
	}, [agent]);
	const cancelActiveUserTurn = useCallback(() => {
		agent.cancelCurrent();
	}, [agent]);

	useInput((_input, key) => {
		if (key.escape && agent.state.status === "running") {
			cancelActiveUserTurn();
			return;
		}
		if (!key.ctrl || _input !== "c") return;
		if (agent.state.status === "running") {
			cancelUserTurns();
			return;
		}
		const now = Date.now();
		if (now - lastCtrlC < DOUBLE_CTRL_C_MS) {
			quit();
		} else {
			setLastCtrlC(now);
			agent.notice("Press Ctrl+C again to exit.");
		}
	});

	const handleSubmit = useCallback(
		(raw: string, intent: "send" | "steer" | "queue") => {
			const command = parseCommand(raw, skillCommandSet);
			if (running && command.type === "message") {
				const text = command.text;
				if (!text) return;
				if (intent === "queue") {
					nextQueuedPromptId.current += 1;
					const queuedPrompt = {
						id: `queue-${nextQueuedPromptId.current}`,
						text,
					};
					setQueuedPrompts((current) => [...current, queuedPrompt]);
					submitPrompt(text, {
						onStart: () =>
							setQueuedPrompts((current) =>
								current.filter((prompt) => prompt.id !== queuedPrompt.id),
							),
					});
					return;
				}
				submitPrompt(text, {
					steer: true,
					onStart: () =>
						agent.notice(`Steering with ${formatInlinePrompt(text)}`),
				});
				return;
			}
			if (sessionEnded && !canRunCommandAfterSessionEnd(command.type)) {
				agent.notice(
					`This ${APP_DISPLAY_NAME} session has ended. Run /login to sign in again or /exit to close ${APP_DISPLAY_NAME}.`,
					"error",
				);
				return;
			}
			switch (command.type) {
				case "message":
					submitPrompt(command.text);
					break;
				case "help":
					agent.notice(HELP_TEXT);
					break;
				case "new":
					agent.newThread();
					if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
					setShowBanner(true);
					break;
				case "quit":
					quit();
					break;
				case "login":
					login();
					break;
				case "logout":
					logout();
					break;
				case "model":
					openModelSelector();
					break;
				case "memory":
					setMode("memory");
					break;
				case "lsp":
					toggleLsp();
					break;
				case "mcp":
					setLoadingLabel("Loading MCP servers");
					setMode("loading");
					void mcpController
						.refreshPromptAndResourceUpdates()
						.then((result) => {
							if (result.warnings.length > 0) {
								agent.notice(result.warnings.join(" "), "error");
							}
							if (result.updatedResourceUris.length > 0) {
								agent.notice(
									`Updated MCP resources: ${result.updatedResourceUris.join(", ")}`,
								);
							}
							refreshMcpStatuses();
							setMode("mcp");
						})
						.catch((err) => {
							agent.notice(
								err instanceof Error ? err.message : String(err),
								"error",
							);
							refreshMcpStatuses();
							setMode("mcp");
						});
					break;
				case "hooks":
					openHookManager();
					break;
				case "skills":
					openSkillsSelector();
					break;
				case "notify":
					config.setNotifyEnabled(!config.isNotifyEnabled);
					void config.saveNotifyPreference().catch((err) => {
						agent.notice(
							`Failed to save notify preference: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					});
					agent.notice(
						`Completion notifications ${config.isNotifyEnabled ? "enabled" : "disabled"}.`,
					);
					break;
				case "cua":
					controller.enableComputerUse();
					agent.notice("Computer use enabled for this session.");
					break;
				case "browser":
					enableBrowser();
					break;
				case "unknown":
					agent.notice(`Unknown command: /${command.name}`, "error");
					break;
			}
		},
		[
			agent,
			config,
			controller,
			enableBrowser,
			login,
			mcpController,
			logout,
			openHookManager,
			openModelSelector,
			openSkillsSelector,
			quit,
			refreshMcpStatuses,
			running,
			sessionEnded,
			skillCommandSet,
			stdout,
			submitPrompt,
			toggleLsp,
			write,
		],
	);

	const resize = useResizeStabilizer(terminalSize, {
		isTerminal: stdout.isTTY,
		write,
	});
	const transcriptLayout = useStableTranscriptLayout(
		agent.state.render.staticItems,
		running ? 0 : undefined,
	);
	const liveItems = compactLiveTranscriptItems(agent.state.render.liveItems);
	const todoPanelDisplay = todoPanelDisplayForTerminalHeight(terminalSize.rows);

	if (resize.isResizing) {
		return <Box />;
	}

	return (
		<TerminalSizeProvider size={terminalSize}>
			<Box flexDirection="column">
				<StaticTranscript
					items={transcriptLayout.staticItems}
					generation={agent.state.render.generation + resize.resizeEpoch}
					banner={showBanner ? initialBanner.current : null}
				/>
				<MessageList
					items={[...transcriptLayout.responsiveItems, ...liveItems]}
				/>
				<TodoPanel todos={agent.state.todos} display={todoPanelDisplay} />

				{running && !agent.state.pendingAsk ? (
					<Box marginTop={1}>
						<Spinner showElapsed showInterruptHint showResultMarker />
					</Box>
				) : null}

				{agent.state.pendingAsk ? (
					<AskUserPrompt
						request={agent.state.pendingAsk}
						onAnswer={agent.provideInput}
					/>
				) : mode === "loading" ? (
					<Box marginTop={1}>
						<Spinner label={loadingLabel} showResultMarker />
					</Box>
				) : mode === "model" ? (
					<ModelSelector
						models={models}
						onSelect={(model) => {
							if (modelUsesAutomaticThinkingOnly(model)) {
								void applyModelSelection(model, {
									label: "automatic",
									value: undefined,
								});
								return;
							}
							setPendingModel(model);
							setMode("thinking");
						}}
						onCancel={() => setMode("normal")}
					/>
				) : mode === "thinking" ? (
					pendingModel ? (
						<ThinkingSelector
							model={pendingModel}
							onSelect={applyModel}
							onCancel={() => {
								setPendingModel(null);
								setMode("normal");
							}}
						/>
					) : null
				) : mode === "memory" ? (
					<MemorySelector
						onSelect={applyMemory}
						onCancel={() => setMode("normal")}
					/>
				) : mode === "skills" ? (
					<SkillsSelector
						tabs={skillTabs}
						onSelect={async (item, signal) => {
							const result = await selectSkill(item, signal);
							setSkillCommands(result.loadedNames);
							agent.notice(`Loaded skill: ${result.selectedName}`);
							setMode("normal");
						}}
						onCancel={() => setMode("normal")}
					/>
				) : mode === "hooks" && hookSnapshot ? (
					<HookManagerSelector
						snapshot={hookSnapshot}
						onSelect={selectHookManagerItem}
						onCancel={() => setMode("normal")}
					/>
				) : mode === "hooks-event" && hookSnapshot && selectedHookEvent ? (
					<HookEventSelector
						event={selectedHookEvent}
						snapshot={hookSnapshot}
						onSelect={selectHookEventItem}
						onAddHook={startAddHook}
						onCancel={() => setMode("hooks")}
					/>
				) : mode === "hooks-matcher" &&
					selectedHookEvent &&
					pendingHookMatcher ? (
					<HookMatcherSelector
						event={selectedHookEvent.event}
						matcher={pendingHookMatcher}
						hooks={selectedHookMatcherHooks}
						onSelect={viewHookDetails}
						onAddHook={startAddHook}
						onDelete={removeHook}
						onCancel={() => setMode("hooks-event")}
					/>
				) : mode === "hook-detail" && selectedHook ? (
					<HookDetails
						hook={selectedHook}
						onCancel={() => setMode("hooks-matcher")}
					/>
				) : mode === "hooks-add" && addContext ? (
					<HookAddForm
						event={addContext.event}
						initialMatcher={addContext.initialMatcher}
						toolNames={addToolNames}
						onSubmit={addHook}
						onCancel={() =>
							setMode(selectedHookEvent ? "hooks-event" : "hooks")
						}
					/>
				) : mode === "mcp" ? (
					<McpManagerSelector
						servers={mcpServerStatuses}
						onSelect={selectMcpAction}
						onCancel={() => setMode("normal")}
					/>
				) : mode === "mcp-server" && selectedMcpServer ? (
					<McpServerActions
						server={selectedMcpServer}
						onAuthenticate={authenticateMcpServer}
						onDisable={disableMcpServer}
						onRemove={removeMcpServer}
						onBrowse={browseMcpPrimitives}
						onCancel={() => {
							refreshMcpStatuses();
							setMode("mcp");
						}}
					/>
				) : mode === "mcp-primitives" && selectedMcpServer ? (
					<McpPrimitiveSelector
						serverName={selectedMcpServer.name}
						prompts={mcpPrompts}
						resources={mcpResources}
						templates={mcpResourceTemplates}
						resourceSubscriptions={Boolean(
							selectedMcpServer.capabilities?.resources?.subscribe,
						)}
						subscribedResourceUris={
							selectedMcpServer.subscribedResourceUris ?? []
						}
						updatedResourceUris={selectedMcpServer.updatedResourceUris ?? []}
						onSelect={selectMcpPrimitive}
						onCancel={() => setMode("mcp-server")}
					/>
				) : mode === "mcp-arguments" && pendingMcpArguments ? (
					<McpArgumentInput
						title={mcpArgumentTitle(pendingMcpArguments)}
						fields={mcpArgumentFields(pendingMcpArguments)}
						onSubmit={submitMcpArguments}
						onCancel={() => {
							setPendingMcpArguments(null);
							setMode("mcp-primitives");
						}}
					/>
				) : mode === "mcp-registry" ? (
					<McpRegistrySelector
						servers={mcpServers}
						onSelect={addMcpServer}
						onCancel={() => setMode("mcp")}
					/>
				) : mode === "mcp-manual" ? (
					<ManualMcpInput
						onSubmit={submitManualMcp}
						onCancel={() => setMode("mcp")}
					/>
				) : (
					<>
						<PromptInput
							busy={running}
							queuedPrompts={queuedPrompts}
							skillCommands={skillCommands}
							allowCommand={allowPromptCommand}
							promptHistory={promptHistory}
							onPromptHistoryChange={setPromptHistory}
							onSubmit={handleSubmit}
						/>
						<StatusBar
							status={agent.state.status}
							model={agent.state.model}
							thinking={config.thinking}
							memory={config.memory}
							usage={agent.state.usage}
							cwd={config.cwd}
						/>
					</>
				)}

				{mode === "model" || mode === "thinking" || mode === "memory" ? (
					<Text color={theme.subtle}>
						Use ↑/↓ and Enter to select, Esc to cancel.
					</Text>
				) : null}
			</Box>
		</TerminalSizeProvider>
	);
}

function mcpArgumentTitle(selection: PendingMcpArgumentSelection): string {
	if (selection.type === "prompt") {
		return `MCP prompt: ${selection.prompt.name}`;
	}
	return `MCP resource template: ${selection.template.name}`;
}

function mcpArgumentFields(
	selection: PendingMcpArgumentSelection,
): McpArgumentField[] {
	if (selection.type === "prompt") {
		return (selection.prompt.arguments ?? []).map((argument) => ({
			name: argument.name,
			description: argument.description,
			required: Boolean(argument.required),
		}));
	}
	return resourceTemplateFields(selection.template.uriTemplate);
}

function resourceTemplateFields(uriTemplate: string): McpArgumentField[] {
	return resourceTemplateVariables(uriTemplate).map((variable) => ({
		name: variable.name,
		required: variable.required,
	}));
}

function formatInlinePrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	return normalized.length > 100
		? `${normalized.slice(0, 97).trimEnd()}...`
		: normalized;
}

function browserTargetLabel(): string {
	const env = loadBrowserEnv();
	if (env.browserWsUrl) return "configured DevTools websocket";
	if (env.browserCdpUrl) return "configured DevTools endpoint";
	return "default DevTools endpoint or local browser";
}
