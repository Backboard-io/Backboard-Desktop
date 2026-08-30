# Agents Editor Right Aux Backboard Copilot Backboard Message Contract

## Webview Messages

| Message | Direction | Meaning |
|---|---|---|
| send | webview -> extension | Submits text prompt with options and optional chat/workspace id. |
| sendVoice | webview -> extension | Submits prompt plus audio attachment when voice mode supports it. |
| cancel | webview -> extension | Cancels the active run token. |
| reviewChanges | webview -> extension | Opens SCM view. |
| signIn | webview -> extension | Starts Backboard OAuth/SSO and refreshes state. |
| refreshModels | webview -> extension | Refreshes model list through BackboardBridge. |
| refreshUsage | webview -> extension | Requests account/run usage snapshot. |
| ready | webview -> extension | Signals the panel script is ready to receive state. |
| syncPanelState | webview -> extension | Requests persisted panel state synchronization. |
| runStarted | extension -> webview | Marks active run and selected chat id. |
| delta | extension -> webview | Streams assistant text into the log. |
| status | extension -> webview | Updates status bar text. |
| runFinished | extension -> webview | Clears running state and completes the turn. |
| settings | extension -> webview | Sends public settings and workspace path. |
| models | extension -> webview | Sends model inventory. |
| tools | extension -> webview | Sends tool inventory. |
| panelStateSnapshot | extension -> webview | Sends persisted history/tabs/panel state. |

## Provider Message Handling Snippet

```ts
		this.view = webviewView;
		webviewView.title = '\u200B';
		webviewView.webview.options = { enableScripts: true, localResourceRoots: webviewLocalResourceRoots(this.context) };
		webviewView.webview.html = panelHtml(webviewView.webview, codiconsStylesheetUri(this.context, webviewView.webview), iconBaseUri(this.context, webviewView.webview), fontBaseUri(this.context, webviewView.webview), { showHeader: false, initialState: this.readPanelState() });
		webviewView.webview.onDidReceiveMessage(message => {
			if (message?.type === 'send' && typeof message.prompt === 'string') {
				this.runPrompt(message.prompt, asPanelOptions(message.options), typeof message.chatId === 'string' ? message.chatId : undefined, undefined, typeof message.workspace === 'string' ? message.workspace : undefined);
			} else if (message?.type === 'sendVoice' && isVoiceAttachment(message.audio)) {
				this.runPrompt(typeof message.prompt === 'string' ? message.prompt : '', asPanelOptions(message.options), typeof message.chatId === 'string' ? message.chatId : undefined, message.audio, typeof message.workspace === 'string' ? message.workspace : undefined);
			} else if (message?.type === 'cancel') {
				this.runToken?.cancel();
			} else if (message?.type === 'reviewChanges') {
				void vscode.commands.executeCommand('workbench.view.scm');
				} else if (message?.type === 'setApiKey') {
					void promptBackboardSso(this.bridge).then(changed => {
						if (changed) {
							void postPanelState(this.bridge, webviewView.webview, true);
						}
					});
				} else if (message?.type === 'signIn') {
					void promptBackboardSso(this.bridge).then(changed => {
						if (changed) {
							void postPanelState(this.bridge, webviewView.webview, true);
						}
					});
				} else if (message?.type === 'insertActiveFile') {
				void postComposerContext(webviewView.webview, 'activeFile');
			} else if (message?.type === 'insertSelection') {
				void postComposerContext(webviewView.webview, 'selection');
			} else if (message?.type === 'insertBranchDiff') {
				void postBranchDiff(webviewView.webview);
			} else if (message?.type === 'ready' || message?.type === 'refreshModels') {
				void postPanelState(this.bridge, webviewView.webview, message?.type === 'refreshModels');
				void this.postPanelStateSnapshot();
			} else if (message?.type === 'refreshUsage') {
				void postUsageSnapshot(this.bridge, webviewView.webview);
			} else if (message?.type === 'saveSettings') {
				void savePanelOptions(asPanelOptions(message.options));
			} else if (message?.type === 'panelState' && isPanelPersistedState(message.state)) {
				void this.savePanelState(message.state);
			} else if (message?.type === 'syncPanelState') {
				void this.postPanelStateSnapshot();
			}
		});
		void postPanelState(this.bridge, webviewView.webview);
		void this.postPanelStateSnapshot();
	}

	private readPanelState(): PanelPersistedState {
		const currentWorkspace = workspacePath();
		return readSharedPanelState(currentWorkspace) ?? {};
	}

	private async savePanelState(state: PanelPersistedState): Promise<void> {
		await writeSharedPanelState(state).catch(error => {
			backboardToolOutput?.appendLine(`[panel-state] failed to save shared state: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async postPanelStateSnapshot(): Promise<void> {
		await this.view?.webview.postMessage({ type: 'panelStateSnapshot', state: this.readPanelState() });
	}
```

## Run Loop Snippet

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
