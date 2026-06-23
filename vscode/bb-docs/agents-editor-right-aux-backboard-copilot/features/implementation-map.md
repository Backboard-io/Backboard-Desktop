# Agents Editor Right Aux Backboard Copilot Implementation Map

## Architecture

```text
Agent Sessions Window
|
|-- left/center sessions chat bar
|   L-- sessions part and chat-session providers
|
|-- right work column
|   |-- right auxiliary panel
|   |   |-- Files container
|   |   |-- Browser container
|   |   L-- Backboard panel when workbench.view.extension.backboard is opened
|   |
|   L-- editor column
|       |-- normal editors
|       |-- BrowserEditorInput
|       L-- push/pull actions that hide or restore the right auxiliary panel
|
|-- Backboard implementation
|   |-- VS Code extension activation
|   |-- WebviewViewProvider for backboard.panel
|   |-- HTML/CSS/JS composer UI built inside panelHtml()
|   |-- BackboardBridge to local Rust bridge and hosted Backboard API
|   L-- webview message contract: send, cancel, settings, tools, history, state
|
L-- Copilot implementation
    |-- Chat participants registered through vscode.chat.createChatParticipant
    |-- chat-session content providers for Claude, Copilot CLI, and cloud agents
    |-- subagent/tool invocation formatting and trace linking
    L-- worktree/session metadata services for long-running agent sessions
```

## Key Source Files

| Source path | Exists | Role |
|---|---:|---|
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts | exists | Owns the agent-session workbench grid: sessions chat bar, auxiliary bar, and editor column. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/layoutPolicy.ts | exists | Provides viewport defaults for sessions part visibility and size. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts | exists | Implements the right auxiliary pane as a sessions-specific pane composite part. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/paneCompositePartService.ts | exists | Registers the auxiliary bar part implementation for sessions windows. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css | exists | Controls right panel density, titlebars, animation, and phone overlay behavior. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/editor/browser/editor.contribution.ts | exists | Adds editor title actions that hide/show the auxiliary bar to push or pull the editor. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/files/browser/files.contribution.ts | exists | Registers the Files container inside the right auxiliary bar. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts | exists | Registers the Browser container inside the auxiliary bar and titlebar screenshot action. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserPanel.ts | exists | Defines sessions browser view/container ids and browser view pane. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.ts | exists | Controls sessions browser view lifecycle. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/common/browserEditorInput.ts | exists | Defines browser editor input used beside the auxiliary bar. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts | exists | Implements browser editor widgets and action groups. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts | exists | Connects browser editor sharing, element/area screenshot, and chat attachment actions. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/package.json | exists | Declares Backboard commands, activation events, settings, and update commands. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts | exists | Implements the Backboard webview panel, bridge, OAuth, model settings, and turn loop. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/chatParticipants.ts | exists | Registers Copilot chat participants and participant icons/intents. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/conversation/vscode-node/conversationFeature.ts | exists | Activates Copilot chat enablement and participant registration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts | exists | Registers Copilot CLI, Claude, and cloud chat-session providers. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts | exists | Provides Copilot CLI session item/content behavior and editor session commands. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/claudeChatSessionContentProvider.ts | exists | Provides Claude session content, creation, folder selection, and history. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/vscode-node/chatHistoryBuilder.ts | exists | Builds native VS Code chat history from Claude/session records. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/copilotcli/common/copilotCLITools.ts | exists | Formats Copilot CLI tool/subagent invocations into chat parts. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts | exists | Models and runs Copilot CLI sessions. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/tools/vscode-node/toolsService.ts | exists | Stores trace context for subagent/tool execution. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/exploreAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/planAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |
| /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/agents/vscode-node/askAgentProvider.ts | exists | Supplies built-in custom agent markdown/configuration. |

## Sessions Layout Code

```ts
	/**
	 * Creates the grid descriptor for the Agent Sessions layout.
	 *
	 * Structure (horizontal orientation):
	 * - Sidebar (left, spans full height from top to bottom)
	 * - Right section (vertical):
	 *   - Titlebar (top of right section)
	 *   - Top right (horizontal): Chat Bar | Right workbench
	 *     - Right workbench: Changes/Files/Browser | Editor
	 *   - Panel (below chat and right workbench)
	 */
	private createGridDescriptor(): ISerializedGrid {
		const { width, height } = this._mainContainerDimension;

		return this.createDesktopGridDescriptor(width, height);
	}

	/**
	 * Standard multi-part layout for all viewport classes.
	 * On phone, the titlebar is hidden via CSS and a MobileTitlebarPart
	 * is prepended before the grid. Sidebar/panel/auxbar are hidden
	 * in the grid via partVisibility defaults.
	 */
	private createDesktopGridDescriptor(width: number, height: number): ISerializedGrid {

		// Default sizes from layout policy
		const sizes = this.layoutPolicy.getPartSizes(width, height);
		// For hidden parts, still provide a reasonable cached size for when they're shown later.
		// Saved sizes from a previous session take precedence over policy defaults.
		const sideBarSize = this._savedPartSizes.sidebar
			?? (this.partVisibility.sidebar ? sizes.sideBarSize : Math.max(sizes.sideBarSize, 250));
		const panelSize = this._savedPartSizes.panel
			?? (this.partVisibility.panel ? sizes.panelSize : Math.max(sizes.panelSize, 250));
		const titleBarHeight = this.titleBarPartView?.minimumHeight ?? 30;

		// Calculate right section width - when sidebar is hidden it takes no space
		const effectiveSideBarWidth = this.partVisibility.sidebar ? sideBarSize : 0;
		const rightSectionWidth = Math.max(0, width - effectiveSideBarWidth);
		const preferredRightWorkColumnWidth = this._savedPartSizes.sessions !== undefined
			? rightSectionWidth - this._savedPartSizes.sessions
			: Math.max(sizes.auxiliaryBarSize, Math.floor(rightSectionWidth * 0.56));
		const minimumRightWorkColumnWidth = (this.partVisibility.auxiliaryBar && this.partVisibility.editor)
			? Math.min(rightSectionWidth, Math.max(420, rightSectionWidth < 900 ? Math.floor(rightSectionWidth * 0.72) : Math.max(560, Math.floor(rightSectionWidth * 0.48))))
			: 300;
		const rightWorkColumnWidth = Math.min(rightSectionWidth, Math.max(minimumRightWorkColumnWidth, preferredRightWorkColumnWidth));
		const effectiveRightWorkColumnWidth = (this.partVisibility.auxiliaryBar || this.partVisibility.editor) ? rightWorkColumnWidth : 0;
		// Prefer the saved chat bar width so the user's preferred chat bar size
		// is preserved across reloads. Fall back to the remainder of the right
		// section, which the grid distributes proportionally when the saved
		// sizes don't fit the current container.
		const sessionsWidth = this._savedPartSizes.sessions !== undefined
			? Math.max(0, Math.min(this._savedPartSizes.sessions, rightSectionWidth - effectiveRightWorkColumnWidth))
			: Math.max(0, rightSectionWidth - effectiveRightWorkColumnWidth);

		const contentHeight = Math.max(0, height - titleBarHeight);
		const topRightHeight = Math.max(0, contentHeight - panelSize);
		const minimumAuxiliaryBarWidth = this.partVisibility.editor
			? Math.min(180, Math.max(120, Math.floor(rightWorkColumnWidth * 0.22)))
			: rightWorkColumnWidth;
		const maximumAuxiliaryBarWidth = this.partVisibility.editor
			? Math.max(minimumAuxiliaryBarWidth, Math.min(260, Math.floor(rightWorkColumnWidth * 0.32)))
			: rightWorkColumnWidth;
		const defaultAuxiliaryBarWidth = this.partVisibility.editor
			? Math.min(maximumAuxiliaryBarWidth, Math.max(minimumAuxiliaryBarWidth, Math.floor(rightWorkColumnWidth * 0.24)))
			: rightWorkColumnWidth;
		const auxiliaryBarSize = this.partVisibility.auxiliaryBar
			? Math.min(maximumAuxiliaryBarWidth, Math.max(minimumAuxiliaryBarWidth, this._savedPartSizes.auxiliaryBar ?? defaultAuxiliaryBarWidth))
			: 0;
		const editorSize = this.partVisibility.editor
			? Math.max(0, rightWorkColumnWidth - (this.partVisibility.auxiliaryBar ? auxiliaryBarSize : 0))
			: 0;

		const isPhone = this.layoutPolicy.viewportClass.get() === 'phone';

		const titleBarNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.TITLEBAR_PART },
			size: titleBarHeight,
			visible: !isPhone
		};

		const sideBarNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.SIDEBAR_PART },
			size: sideBarSize,
			visible: this.partVisibility.sidebar
		};

		const auxiliaryBarNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.AUXILIARYBAR_PART },
			size: auxiliaryBarSize,
			visible: this.partVisibility.auxiliaryBar
		};

		const sessionsNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.SESSIONS_PART },
			size: sessionsWidth,
			visible: this.partVisibility.sessions
		};

		const editorNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.EDITOR_PART },
			size: editorSize,
			visible: this.partVisibility.editor
		};

		const panelNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.PANEL_PART },
			size: panelSize,
			visible: this.partVisibility.panel
		};

		// Top right section: Chat Bar | Right workbench (Files/Browser/Changes + Editor)
		const topRightSection: ISerializedNode = {
			type: 'branch',
			data: [sessionsNode, auxiliaryBarNode, editorNode],
			size: topRightHeight
		};

		// Right section: Top Right | Panel (vertical)
		const rightSection: ISerializedNode = {
			type: 'branch',
			data: [topRightSection, panelNode],
			size: rightSectionWidth
		};
```

## Backboard Run Loop Code

```ts
	private runPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string): void {
		const serial = ++this.promptRunSerial;
		const previousRun = this.activePromptRun;
		if (previousRun) {
			this.runToken?.cancel();
			void this.view?.webview.postMessage({ type: 'status', text: 'Waiting for the current Backboard turn to stop.' });
		}
		const run = (async () => {
			if (previousRun) {
				try {
					await previousRun;
				} catch {
					// The previous run already reported its error to the webview.
				}
			}
			if (serial !== this.promptRunSerial) {
				return;
			}
			await this.sendPrompt(prompt, options, chatId, audio, workspaceOverride);
		})();
		this.activePromptRun = run;
		void run.finally(() => {
			if (this.activePromptRun === run) {
				this.activePromptRun = undefined;
			}
		});
	}

	private async sendPrompt(prompt: string, options: PanelOptions, chatId: string | undefined, audio?: VoiceAttachment, workspaceOverride?: string): Promise<void> {
		const view = this.view;
		if (!view || (!prompt.trim() && !audio)) {
			return;
		}
		const settings = resolveTurnSettings(options);
		const voiceMode = audio && (settings.voiceMode === 'off' || settings.voiceMode === 'tts') ? 'conversation' : settings.voiceMode;
		const voiceBlock = audio ? undefined : unsupportedVoiceModeMessage(voiceMode);
		if (voiceBlock) {
			await view.webview.postMessage({ type: 'status', text: voiceBlock });
			return;
		}
		this.runToken?.cancel();
		this.runToken = new vscode.CancellationTokenSource();
		const token = this.runToken.token;
		const actualWorkspace = workspacePath();
		const requestedWorkspace = workspaceOverride?.trim();
		if (requestedWorkspace && actualWorkspace && requestedWorkspace !== actualWorkspace) {
			backboardToolOutput?.appendLine(`[panel] ignored stale workspace override ${requestedWorkspace}; using open workspace ${actualWorkspace}`);
			await view.webview.postMessage({ type: 'settings', settings: publicSettings(readSettings()), workspace: actualWorkspace });
		}
		const effectiveWorkspace = requestedWorkspace && (!actualWorkspace || requestedWorkspace === actualWorkspace)
			? requestedWorkspace
			: actualWorkspace;
		const chatWorkspace = readSharedPanelThreadWorkspace(chatId);
		const effectiveChatId = chatId && (!chatWorkspace || !effectiveWorkspace || chatWorkspace === effectiveWorkspace) ? chatId : undefined;
		if (chatId && chatWorkspace && effectiveWorkspace && chatWorkspace !== effectiveWorkspace) {
			backboardToolOutput?.appendLine(`[panel] ignored stale chat ${chatId} from ${chatWorkspace}; using fresh chat in ${effectiveWorkspace}`);
		}
		const sessionId = `panel:${effectiveWorkspace ?? 'default'}:${effectiveChatId || 'default'}`;
		const sink = this.panelSink(view);
		const content = prompt.trim() || 'Please transcribe this audio and respond.';
		const imageGeneration = imageGenerationForPrompt(content, settings.imageGeneration);
		await view.webview.postMessage({ type: 'runStarted', prompt: content, chatId: effectiveChatId });
		await view.webview.postMessage({ type: 'status', text: 'Sending to Backboard.' });
		const pendingToolRequests: ToolResultRequest[] = [];
		const seenToolRequests = new Set<string>();
		try {
			let currentToolRequest: ToolResultRequest | undefined;
			const submitTools = trimBackboardToolsForRequest(
				await this.bridge.listTools(settings.mode, token).catch(() => undefined),
				content,
				settings.webSearch,
				imageGeneration
			);
			await this.bridge.send('sendPrompt', sessionId, {
				content,
				workspace: effectiveWorkspace,
				provider: settings.defaultProvider,
				model: settings.defaultModel,
				mode: settings.mode,
				intensity: settings.intensity,
				webSearch: settings.webSearch,
				imageGeneration: imageGeneration === 'auto' ? 'auto' : undefined,
				voiceMode,
				audioFile: audio,
				mcpCalls: mcpCallsPayload(settings),
				tools: submitTools,
				config: settings.config
			}, event => {
				const toolRequest = renderBridgeEvent(event, sink, currentToolRequest);
				if (toolRequest && toolRequest !== currentToolRequest) {
					currentToolRequest = toolRequest;
					enqueueToolResultRequest(pendingToolRequests, toolRequest, seenToolRequests);
				}
			}, token);

			let nextToolRequest = pendingToolRequests.shift();
			while (nextToolRequest && !token.isCancellationRequested) {
				const toolOutputs = await executeToolCalls(this.bridge, nextToolRequest.toolCalls, settings.mode, sink, token);
				if (token.isCancellationRequested) {
					break;
				}
				if (toolOutputs.length !== nextToolRequest.toolCalls.length) {
					await view.webview.postMessage({ type: 'status', text: 'Stopped before submitting incomplete tool outputs.' });
					break;
				}
				let currentContinuationToolRequest: ToolResultRequest | undefined;
				await this.bridge.send('submitToolResult', sessionId, {
					threadId: nextToolRequest.threadId,
					runId: nextToolRequest.runId,
					toolOutputs,
					tools: submitTools,
					config: settings.config
				}, event => {
					const followupToolRequest = renderBridgeEvent(event, sink, currentContinuationToolRequest);
					if (followupToolRequest && followupToolRequest !== currentContinuationToolRequest) {
						currentContinuationToolRequest = followupToolRequest;
						enqueueToolResultRequest(pendingToolRequests, followupToolRequest, seenToolRequests);
					}
				}, token);
				nextToolRequest = pendingToolRequests.shift();
			}
			await view.webview.postMessage({ type: 'runFinished', chatId: effectiveChatId });
			await view.webview.postMessage({ type: 'status', text: token.isCancellationRequested ? 'Cancelled.' : 'Done.' });
		} catch (error) {
			await view.webview.postMessage({ type: 'append', role: 'error', text: error instanceof Error ? error.message : String(error) });
			await view.webview.postMessage({ type: 'runFinished', chatId: effectiveChatId });
			await handleBackboardError(view.webview, error, this.bridge);
		}
	}

	private panelSink(view: vscode.WebviewView): ResponseSink {
		return {
			markdown: value => {
				void view.webview.postMessage({ type: 'delta', role: 'assistant', text: typeof value === 'string' ? value : value.value });
			},
			progress: value => {
				void view.webview.postMessage({ type: 'status', text: value });
				},
				event: (type, payload) => {
					void view.webview.postMessage({ type, payload });
				}
```

## Copilot Session Registration Code

```ts
		// #region Claude Code Chat Sessions
		const claudeAgentInstaService = instantiationService.createChild(
			new ServiceCollection(
				[IAgentSessionsWorkspace, new SyncDescriptor(AgentSessionsWorkspace)],
				[IClaudeAgentSdkLoaderService, new SyncDescriptor(RoutingClaudeAgentSdkLoaderService)],
				[IClaudeCodeSessionService, new SyncDescriptor(ClaudeCodeSessionService)],
				[IClaudeCodeSdkService, new SyncDescriptor(ClaudeCodeSdkService)],
				[IClaudeCodeModels, new SyncDescriptor(ClaudeCodeModels)],
				[ILanguageModelServer, new SyncDescriptor(LanguageModelServer)],
				[IClaudeToolPermissionService, new SyncDescriptor(ClaudeToolPermissionService)],
				[IClaudePlanFileTracker, new SyncDescriptor(ClaudePlanFileTracker)],
				[IClaudeSessionStateService, new SyncDescriptor(ClaudeSessionStateService)],
				[IClaudeSlashCommandService, new SyncDescriptor(ClaudeSlashCommandService)],
				[IChatSessionMetadataStore, sessionMetadata],
				[IChatSessionWorktreeService, new SyncDescriptor(ChatSessionWorktreeService)],
				[IChatSessionWorktreeCheckpointService, new SyncDescriptor(ChatSessionWorktreeCheckpointService)],
				[IChatSessionWorkspaceFolderService, new SyncDescriptor(ChatSessionWorkspaceFolderService)],
				[IClaudeWorkspaceFolderService, new SyncDescriptor(ClaudeWorkspaceFolderService)],
				[IFolderRepositoryManager, new SyncDescriptor(ClaudeFolderRepositoryManager)],
				[IChatFolderMruService, new SyncDescriptor(ClaudeCodeFolderMruService)],
				[IClaudeRuntimeDataService, new SyncDescriptor(ClaudeRuntimeDataService)],
				[IClaudePluginService, new SyncDescriptor(ClaudePluginService)],
			));
		const claudeAgentManager = this._register(claudeAgentInstaService.createInstance(ClaudeAgentManager));
		const claudeModels = claudeAgentInstaService.invokeFunction(accessor => accessor.get(IClaudeCodeModels));
		claudeModels.registerLanguageModelChatProvider(vscode.lm);
		const chatSessionContentProvider = this._register(claudeAgentInstaService.createInstance(ClaudeChatSessionContentProvider, claudeAgentManager));
		const chatParticipant = vscode.chat.createChatParticipant(ClaudeSessionUri.scheme, chatSessionContentProvider.createHandler());
		chatParticipant.iconPath = new vscode.ThemeIcon('claude');
		this._register(vscode.chat.registerChatSessionContentProvider(ClaudeSessionUri.scheme, chatSessionContentProvider, chatParticipant));
		const claudeCustomizationProvider = this._register(claudeAgentInstaService.createInstance(ClaudeCustomizationProvider));
		this._register(vscode.chat.registerChatSessionCustomizationProvider(ClaudeSessionUri.scheme, ClaudeCustomizationProvider.metadata, claudeCustomizationProvider));
```
