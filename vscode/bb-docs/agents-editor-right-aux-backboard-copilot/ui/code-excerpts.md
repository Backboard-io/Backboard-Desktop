# Agents Editor Right Aux Backboard Copilot UI Code Excerpts

## Sessions Right Work Column

```ts
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
```

## Auxiliary Bar Part

```ts
 */
export class AuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.agentsession.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.agentsession.auxiliarybar.pinnedPanels';
	static readonly input hintViewContainersKey = 'workbench.agentsession.auxiliarybar.input hintPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.auxiliarybar.viewContainersWorkspaceState';

	/** Agent sessions parts are flush; layout only subtracts borders. */
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_LEFT = 0;

	// Action ID for run script - defined here to avoid layering issues
	private static readonly RUN_SCRIPT_ACTION_ID = 'workbench.action.agentSessions.runScript';
	private static readonly RUN_SCRIPT_DROPDOWN_MENU_ID = MenuId.for('AgentSessionsRunScriptDropdown');
	private static readonly DEFAULT_MINIMUM_WIDTH = 120;

	// Run script dropdown management
	private readonly _runScriptDropdown = this._register(new MutableDisposable<DropdownWithPrimaryActionViewItem>());
	private readonly _runScriptMenu = this._register(new MutableDisposable<IMenu>());
	private readonly _runScriptMenuListener = this._register(new MutableDisposable<IDisposable>());

	// Sessions-specific auxiliary bar dimensions (intentionally not tied to the sessions SidebarPart values)
	override get minimumWidth(): number {
		return AuxiliaryBarPart.DEFAULT_MINIMUM_WIDTH;
	}
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean {
		return this.hasAttachedEditorRequiringSidebarSpace() ? false : super.snap;
	}

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();

		if (!activeComposite) {
			return undefined;
		}

		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 220);
	}

	readonly priority = LayoutPriority.Low;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
	) {
		super(
			Parts.AUXILIARYBAR_PART,
			{
				hasTitle: true,
				trailingSeparator: false,
				borderWidth: () => 0,
			},
			AuxiliaryBarPart.activeViewSettingsKey,
			ActiveAuxiliaryContext.bindTo(contextKeyService),
			AuxiliaryBarFocusContext.bindTo(contextKeyService),
			'auxiliarybar',
			'auxiliarybar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.AuxiliaryBar,
```

## Editor Push/Pull Actions

```ts
class PushEditorRightAction extends Action2 {
	static readonly ID = 'workbench.action.agentSessions.pushEditorRight';

	constructor() {
		super({
			id: PushEditorRightAction.ID,
			title: localize2('pushEditorRight', "Push Editor Right"),
			icon: Codicon.chevronRight,
			f1: false,
			menu: {
				id: MenuId.EditorTitleLayout,
				group: 'navigation',
				order: 99.5,
				when: ContextKeyExpr.and(editorLeftRightWhen, AuxiliaryBarVisibleContext)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IAgentWorkbenchLayoutService);
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
	}
}

registerAction2(PushEditorRightAction);

class PullEditorLeftAction extends Action2 {
	static readonly ID = 'workbench.action.agentSessions.pullEditorLeft';

	constructor() {
		super({
			id: PullEditorLeftAction.ID,
			title: localize2('pullEditorLeft', "Show Secondary Side Bar"),
			icon: Codicon.chevronLeft,
			f1: false,
			toggled: AuxiliaryBarVisibleContext.toNegated(),
			menu: {
				id: MenuId.EditorTitleLayout,
				group: 'navigation',
				order: 99.5,
				when: ContextKeyExpr.and(editorLeftRightWhen, AuxiliaryBarVisibleContext.toNegated())
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IAgentWorkbenchLayoutService);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	}
}

registerAction2(PullEditorLeftAction);


class OpenEditorInModalEditorAction extends Action2 {
	static readonly ID = 'workbench.action.agentSessions.openEditorInModal';
```

## Browser Container In Auxiliary Bar

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
```

## Backboard Webview Provider

```ts
class BackboardPanelProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private runToken: vscode.CancellationTokenSource | undefined;
	private activePromptRun: Promise<void> | undefined;
	private promptRunSerial = 0;

	constructor(private readonly bridge: BackboardBridge, private readonly context: vscode.ExtensionContext) {
	}

	async postUiCommand(command: 'newChat' | 'showHistory' | 'showChat', workspace?: string): Promise<boolean> {
		return this.view?.webview.postMessage({ type: 'command', command, workspace }) ?? false;
	}

	async whenReady(timeoutMs = 2000): Promise<boolean> {
		if (this.view) {
			return true;
		}
		const expires = Date.now() + timeoutMs;
		while (!this.view && Date.now() < expires) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return !!this.view;
	}

	async openHistoryEntry(chatId: string | undefined): Promise<boolean> {
		if (!chatId) {
			return this.postUiCommand('showHistory');
		}
		return this.view?.webview.postMessage({ type: 'command', command: 'openHistoryEntry', chatId }) ?? false;
	}

	submitPromptFromOptimus(prompt: string, options: PanelOptions, chatId: string | undefined, workspaceOverride: string | undefined): void {
		if (!prompt.trim()) {
			return;
		}
		this.runPrompt(prompt, options, chatId, undefined, workspaceOverride);
	}

	cancelActiveRun(): void {
		this.runToken?.cancel();
	}

	async reviewChanges(): Promise<void> {
		await vscode.commands.executeCommand('workbench.view.scm');
	}

	refreshState(): void {
		const view = this.view;
		if (view) {
			void postPanelState(this.bridge, view.webview);
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
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
```

## Copilot Participant Registration

```ts
		this._disposables.dispose();
	}

	register(): void {
		this.additionalWelcomeMessage = this.instantiationService.invokeFunction(getAdditionalWelcomeMessage);
		this._disposables.add(this.registerDefaultAgent());
		this._disposables.add(this.registerEditingAgent());
		this._disposables.add(this.registerEditingAgentEditor());
		this._disposables.add(this.registerEditsAgent());
		this._disposables.add(this.registerNotebookEditorDefaultAgent());
		this._disposables.add(this.registerNotebookDefaultAgent());
		this._disposables.add(this.registerVSCodeAgent());
		this._disposables.add(this.registerTerminalAgent());
		this._disposables.add(this.registerTerminalPanelAgent());
	}

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
	}

	private registerDefaultAgent(): IDisposable {
		const intentGetter = (request: vscode.ChatRequest) => {
			if (this.configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.AskAgent, this.experimentationService) && request.model.capabilities.supportsToolCalling && this.configurationService.getNonExtensionConfig('chat.agent.enabled')) {
				return Intent.AskAgent;
			}
			return Intent.Unknown;
		};
		const defaultAgent = this.createAgent(defaultAgentName, intentGetter);
		defaultAgent.iconPath = new vscode.ThemeIcon('copilot');

		defaultAgent.helpTextPrefix = vscode.l10n.t('You can ask me general programming questions, or chat with the following participants which have specialized expertise and can perform actions:');
```
