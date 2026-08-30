# Agents Editor Right Aux Backboard Copilot Extension Points

## Backboard Extension Points

- Commands: backboard.openRightPanel, backboard.openPanel, backboard.newChat, backboard.showHistory, backboard.refreshModels, backboard.extension.signIn.
- View provider: vscode.window.registerWebviewViewProvider('backboard.panel', ...).
- URI handler: Backboard OAuth callback handler.
- Configuration: Backboard API, OAuth, model, mode, web/image, MCP, voice, bridge, workspace, update settings.
- File watchers: config, panel state, thread history, Optimus command file.

## Sessions Extension Points

- Auxiliary bar containers are registered with ViewContainerLocation.AuxiliaryBar.
- Editor title actions are registered with MenuId.EditorTitleLayout.
- Browser screenshot action contributes to the sessions titlebar right layout.

## Copilot Extension Points

- Chat participants through vscode.chat.createChatParticipant.
- Chat-session content providers through vscode.chat.registerChatSessionContentProvider.
- Chat-session customization providers for Copilot CLI and Claude.
- Chat-session item providers for session listing/history.
- Custom agent providers for built-in and organization agents.

## Code Evidence

```ts
	const panelProvider = new BackboardPanelProvider(bridge, context);
	context.subscriptions.push(backboardToolOutput);
	context.subscriptions.push(bridge);
	backboardUpdateStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	backboardUpdateStatusItem.command = 'backboard.installAvailableUpdate';
	context.subscriptions.push(backboardUpdateStatusItem);
	context.subscriptions.push(vscode.commands.registerCommand('backboard.setApiKey', async () => {
		if (await setApiKey()) {
			bridge.restart();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.extension.signIn', () => promptBackboardSso(bridge)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.copyOAuthRedirectUri', () => copyBackboardOAuthRedirectUri()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.completeOAuthCallback', () => completeBackboardOAuthCallbackFromInput()));
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: uri => handleBackboardOAuthCallback(uri)
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.refreshModels', () => bridge.refreshModels()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.checkForUpdates', () => checkBackboardUpdates(true)));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.installAvailableUpdate', () => installAvailableBackboardUpdate()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.openRightPanel', () => openBackboardView()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.openPanel', () => openBackboardView()));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.newChat', async () => {
		await openBackboardView();
		await panelProvider.postUiCommand('newChat');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('backboard.showHistory', async () => {
		await openBackboardView();
		await panelProvider.postUiCommand('showHistory');
	}));
	void updateBackboardAuthContext();
	const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(backboardConfigPath()), path.basename(backboardConfigPath())));
	const refreshBackboardState = () => {
		void updateBackboardAuthContext();
		panelProvider.refreshState();
	};
	context.subscriptions.push(configWatcher);
	context.subscriptions.push(configWatcher.onDidCreate(refreshBackboardState));
	context.subscriptions.push(configWatcher.onDidChange(refreshBackboardState));
	context.subscriptions.push(configWatcher.onDidDelete(refreshBackboardState));
	const panelStateWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(backboardPanelStatePath()), path.basename(backboardPanelStatePath())));
	const panelThreadsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(backboardThreadsDir(), '*.json'));
	const optimusCommandWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(optimusPanelCommandPath()), path.basename(optimusPanelCommandPath())));
	const refreshPanelHistory = () => {
		void panelProvider.postPanelStateSnapshot();
	};
	context.subscriptions.push(panelStateWatcher);
	context.subscriptions.push(panelStateWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelStateWatcher.onDidDelete(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher);
	context.subscriptions.push(panelThreadsWatcher.onDidCreate(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidChange(refreshPanelHistory));
	context.subscriptions.push(panelThreadsWatcher.onDidDelete(refreshPanelHistory));
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('backboard.panel', panelProvider, { webviewOptions: { retainContextWhenHidden: true } }));
	const handleOptimusCommand = () => {
```

```ts
	private createAgent(name: string, defaultIntentIdOrGetter: IntentOrGetter, options?: { id?: string }): vscode.ChatParticipant {
		const id = options?.id || getChatParticipantIdFromName(name);
		const agent = vscode.chat.createChatParticipant(id, this.getChatParticipantHandler(id, name, defaultIntentIdOrGetter));
		agent.onDidReceiveFeedback(e => {
			this.userFeedbackService.handleFeedback(e, id);
		});
		agent.onDidPerformAction(e => {
			this.userFeedbackService.handleUserAction(e, id);
		});
		this._disposables.add(autorun(reader => {
			agent.supportIssueReporting = this.feedbackReporter.canReport.read(reader);
		}));

		return agent;
	}

	private registerVSCodeAgent(): IDisposable {
		const useInsidersIcon = vscode.env.appName.includes('Insiders') || vscode.env.appName.includes('OSS');
		const vscodeAgent = this.createAgent(vscodeAgentName, Intent.VSCode);
		vscodeAgent.iconPath = useInsidersIcon ? new vscode.ThemeIcon('vscode-insiders') : new vscode.ThemeIcon('vscode');
		return vscodeAgent;
	}

	private registerTerminalAgent(): IDisposable {
		const terminalAgent = this.createAgent(terminalAgentName, Intent.Terminal);

		terminalAgent.iconPath = new vscode.ThemeIcon('terminal');
		return terminalAgent;
	}

	private registerTerminalPanelAgent(): IDisposable {
		const terminalPanelAgent = this.createAgent(terminalAgentName, Intent.Terminal, { id: 'github.copilot.terminalPanel' });

		terminalPanelAgent.iconPath = new vscode.ThemeIcon('terminal');

		return terminalPanelAgent;
	}

	private registerEditingAgent(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentName, Intent.Edit);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
	}

	private registerEditingAgentEditor(): IDisposable {
		const editingAgent = this.createAgent(editingSessionAgentEditorName, Intent.InlineChat);
		editingAgent.iconPath = new vscode.ThemeIcon('copilot');
		return editingAgent;
	}

	private registerEditsAgent(): IDisposable {
		const editingAgent = this.createAgent(editsAgentName, Intent.Agent);
		editingAgent.iconPath = new vscode.ThemeIcon('tools');
		editingAgent.additionalWelcomeMessage = this.additionalWelcomeMessage;
		editingAgent.titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
		return editingAgent;
```
