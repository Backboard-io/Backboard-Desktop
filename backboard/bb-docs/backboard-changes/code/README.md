# Code Evidence

This page contains literal code excerpts from the current worktree. Paths are absolute and point to the inspected workspace.

## 1. Sessions Titlebar Action: Add Browser Area Screenshot To Chat

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

Relevant code:

```ts
class AddBrowserAreaScreenshotToChatFromSessionAction extends Action2 {

	static readonly ID = 'workbench.action.sessions.addBrowserAreaScreenshotToChat';

	constructor() {
		super({
			id: AddBrowserAreaScreenshotToChatFromSessionAction.ID,
			title: localize2('sessions.browser.addAreaScreenshotToChat', "Add Area Screenshot to Chat"),
			icon: Codicon.screenFull,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, BrowserEditorOpenContext),
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

What this code does:

- Registers a new action with command ID `workbench.action.sessions.addBrowserAreaScreenshotToChat`.
- Shows it in the Agents Window titlebar right layout when chat is enabled, a browser editor exists, the welcome page is hidden, the window is not auxiliary, and the layout is not phone.
- If the active editor is not a contextual `BrowserEditorInput`, opens the first contextual browser editor.
- Delegates the actual screenshot interaction to `BrowserViewCommandId.AddAreaScreenshotToChat`.

## 2. Account Widget Hides While Browser Editor Is Active

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/accountMenu/browser/account.contribution.ts
```

Relevant code:

```ts
private updateBrowserVisibility(): void {
	if (!this.container) {
		return;
	}

	const isBrowserEditorActive = this.editorService.activeEditor instanceof BrowserEditorInput;
	this.container.style.display = isBrowserEditorActive ? 'none' : '';
	this.container.setAttribute('aria-hidden', isBrowserEditorActive ? 'true' : 'false');
	if (isBrowserEditorActive && this.isMenuVisible) {
		this.hoverService.hideHover(true);
		this.clickPanelDisposable.clear();
	}
}
```

What this code does:

- Watches `IEditorService.onDidActiveEditorChange`.
- Checks whether the active editor is a browser editor.
- Hides the account titlebar widget and marks it `aria-hidden` when browser editor is active.
- Closes account hover/menu UI if it was open.

Why it matters:

- Browser editor workflows need titlebar space for browser-specific actions.
- Hidden account widget should not remain keyboard/screen-reader reachable while visually hidden.

## 3. Browser Editor Screenshot Action Is Also In Browser Toolbar

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts
```

Relevant diff-shaped code:

```ts
precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, ChatContextKeys.enabled),
toggled: CONTEXT_BROWSER_AREA_SELECTION_ACTIVE,
menu: [{
	id: MenuId.BrowserActionsToolbar,
	group: BrowserActionGroup.Tools,
	order: 1
}, {
	id: MenuId.BrowserChatActionsMenu,
	group: '2_screenshots',
	order: 2
}]
```

What this code does:

- Keeps the action tied to active browser editor + URL + chat enablement.
- Removes the previous dependency on `CONTEXT_BROWSER_HAS_ERROR.negate()`.
- Registers the action directly in `MenuId.BrowserActionsToolbar`.
- Keeps the action in `MenuId.BrowserChatActionsMenu`.

## 4. Backboard Panel Usage Button Removed From Composer Chrome

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts
```

Current composer button row:

```html
<button id="webBtn" class="iconButton featureButton" type="button" title="Web search" aria-label="Web search"><span class="codicon codicon-globe"></span></button>
<button id="imageBtn" class="iconButton featureButton" type="button" title="Image output" aria-label="Image output"><span class="codicon codicon-device-camera-video"></span></button>
<button id="voiceBtn" class="iconButton" type="button" title="Start speech-to-text" aria-label="Start speech-to-text"><span class="codicon codicon-mic"></span></button>
<button id="stopBtn" class="iconButton stopButton" type="button" title="Stop generation" aria-label="Stop generation"><span class="codicon codicon-debug-stop"></span></button>
<button id="sendBtn" class="iconButton sendButton" type="submit" title="Send" aria-label="Send" disabled><span class="codicon codicon-send"></span></button>
```

Removed from this location:

```html
<button id="usageBtn" class="iconButton featureButton usageFeatureButton" type="button" title="Usage details" aria-label="Usage details"><span class="codicon codicon-pulse"></span></button>
```

Effect:

- The composer row no longer includes the pulse/usage button.
- Related usage button wiring was removed from the visible `buttons` object and click/hover/focus handlers.
- `renderUsagePopover()` and `requestUsageSnapshot()` are still present in the script; the current diff removes the visible composer entry point, not all usage code.

## 5. Auxiliary Bar Width Tightening

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts
```

Relevant code:

```ts
private static readonly DEFAULT_MINIMUM_WIDTH = 120;
```

And:

```ts
return Math.max(width, 220);
```

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts
```

Relevant code:

```ts
const minimumAuxiliaryBarWidth = this.partVisibility.editor
	? Math.min(180, Math.max(120, Math.floor(rightWorkColumnWidth * 0.22)))
	: rightWorkColumnWidth;
const maximumAuxiliaryBarWidth = this.partVisibility.editor
	? Math.max(minimumAuxiliaryBarWidth, Math.min(260, Math.floor(rightWorkColumnWidth * 0.32)))
	: rightWorkColumnWidth;
const defaultAuxiliaryBarWidth = this.partVisibility.editor
	? Math.min(maximumAuxiliaryBarWidth, Math.max(minimumAuxiliaryBarWidth, Math.floor(rightWorkColumnWidth * 0.24)))
	: rightWorkColumnWidth;
```

What this does:

- Allows the auxiliary bar to become much narrower.
- Changes the default split ratio so the editor or main session content keeps more horizontal space.

## 6. Sidebar Header Area Instead Of Title Prepend

File:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts
```

Relevant code:

```ts
override create(parent: HTMLElement): void {
	super.create(parent);

	const navigation = $('.sidebar-activity-navigation-header');
	this.setHeaderArea(navigation);
	const entries: readonly { label: string; icon: string; command: string }[] = [
		{ label: localize('sidebarActivityExplorer', "Explorer"), icon: Codicon.folderOpened.id, command: 'workbench.view.explorer' },
		{ label: localize('sidebarActivitySearch', "Search"), icon: Codicon.searchSparkle.id, command: 'workbench.view.search' },
		{ label: localize('sidebarActivitySourceControl', "Source Control"), icon: Codicon.sourceControl.id, command: 'workbench.view.scm' },
		{ label: localize('sidebarActivityRun', "Run and Debug"), icon: Codicon.debugAlt.id, command: 'workbench.view.debug' },
		{ label: localize('sidebarActivityExtensions', "Extensions"), icon: Codicon.extensions.id, command: 'workbench.view.extensions' },
		{ label: localize('sidebarActivityChat', "Chat"), icon: Codicon.copilot.id, command: 'workbench.panel.chat.view.copilot' },
	];
```

What this does:

- Moves activity navigation into a header slot.
- Keeps navigation buttons wired to workbench view commands.
- Avoids mutating the title DOM by prepending into the title area.

