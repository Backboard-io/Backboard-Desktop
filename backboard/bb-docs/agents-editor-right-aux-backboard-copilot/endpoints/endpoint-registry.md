# Agents Editor Right Aux Backboard Copilot Endpoint Registry

## Commands And Provider IDs

| Endpoint | Kind | Behavior |
|---|---|---|
| backboard.openRightPanel | Backboard command | Opens workbench.view.extension.backboard, then focuses backboard.panel. |
| backboard.openPanel | Backboard command | Opens the same Backboard view. |
| backboard.newChat | Backboard command | Opens the panel and posts newChat to the webview. |
| backboard.showHistory | Backboard command | Opens the panel and posts showHistory to the webview. |
| backboard.refreshModels | Backboard command | Calls the Backboard bridge model refresh. |
| backboard.extension.signIn | Backboard command | Starts Backboard OAuth/SSO flow. |
| workbench.action.agentSessions.pushEditorRight | Sessions editor action | Hides Parts.AUXILIARYBAR_PART so the editor expands right. |
| workbench.action.agentSessions.pullEditorLeft | Sessions editor action | Shows Parts.AUXILIARYBAR_PART again. |
| workbench.action.sessions.addBrowserAreaScreenshotToChat | Sessions/browser action | Finds a browser editor, opens it if needed, then runs BrowserViewCommandId.AddAreaScreenshotToChat. |
| copilotcli | Copilot chat-session type | Registered through vscode.chat.registerChatSessionContentProvider. |
| ClaudeSessionUri.scheme | Claude session scheme | Registered through vscode.chat.registerChatSessionContentProvider. |

## View And Container IDs

| ID | Owner | Meaning |
|---|---|---|
| backboard.panel | Backboard extension | Webview view provider registered by Backboard. |
| workbench.view.extension.backboard | Workbench/view contribution state | Command used to open Backboard view container. |
| workbench.sessions.auxiliaryBar.browserContainer | Sessions browser contribution | Browser container in the auxiliary bar. |
| workbench.sessions.auxiliaryBar.filesContainer | Sessions files contribution | Files container in the auxiliary bar. |
| copilotcli | Copilot extension | Copilot CLI chat-session type. |
| ClaudeSessionUri.scheme | Copilot extension | Claude chat-session scheme/provider id. |

## Literal Registration Snippets

### Backboard commands and webview provider

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

### Sessions browser container and screenshot action

```ts
const BrowserEditorOpenContext = ContextKeyExpr.has('browserEditorOpen');

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const browserViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	title: localize2('browser', "Browser"),
	icon: browserViewIcon,
	order: 12,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_BROWSER_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
		title: localize2('browser', "Browser"),
		mnemonicTitle: localize({ key: 'miBrowser', comment: ['&& denotes a mnemonic'] }, "Bro&&wser"),
		order: 2
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: SESSIONS_BROWSER_VIEW_ID,
	name: localize2('browser', "Browser"),
	containerIcon: browserViewIcon,
	ctorDescriptor: new SyncDescriptor(SessionsBrowserViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	when: ContextKeyExpr.and(IsPhoneLayoutContext.negate()),
	windowEnablement: WindowEnablement.Sessions,
}], browserViewContainer);

registerWorkbenchContribution2(SessionBrowserViewController.ID, SessionBrowserViewController, WorkbenchPhase.AfterRestored);

class AddBrowserAreaScreenshotToChatFromSessionAction extends Action2 {

	static readonly ID = 'workbench.action.sessions.addBrowserAreaScreenshotToChat';

	constructor() {
		super({
			id: AddBrowserAreaScreenshotToChatFromSessionAction.ID,
			title: localize2('sessions.browser.addAreaScreenshotToChat', "Add Area Screenshot to Chat"),
			icon: Codicon.screenFull,
			precondition: BrowserEditorOpenContext,
			menu: {
				id: Menus.TitleBarRightLayout,
				group: 'navigation',
				order: -1,
				when: ContextKeyExpr.and(
					IsAuxiliaryWindowContext.toNegated(),
					SessionsWelcomeVisibleContext.toNegated(),
					IsPhoneLayoutContext.negate()
				),
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const commandService = accessor.get(ICommandService);
		const browserViews = browserViewService.getContextualBrowserViews();
		const activeEditor = editorService.activeEditor;

		if (!(activeEditor instanceof BrowserEditorInput) || !browserViews.has(activeEditor.id)) {
			const browserInput = browserViews.values().next().value;
			if (!browserInput) {
				return;
			}

			await editorService.openEditor(browserInput);
		}

		await commandService.executeCommand(BrowserViewCommandId.AddAreaScreenshotToChat);
	}
}

registerAction2(AddBrowserAreaScreenshotToChatFromSessionAction);
```

### Copilot chat-session registration

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
