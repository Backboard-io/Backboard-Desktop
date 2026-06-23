# Agents Editor Right Aux Backboard Copilot Screen Map

## Desktop Map

```text
+--------------------------------------------------------------------------------------------------+
| Agent Sessions Workbench                                                                          |
|                                                                                                  |
| +------------------------+ +--------------------------------+ +---------------+ +-------------+ |
| | sessions/chat column    | | right auxiliary panel          | | editor column | | optional     | |
| |                         | |                                | |               | | bottom panel  | |
| | conversation, sessions, | | Files / Browser / Backboard    | | code editor,   | | logs/output   | |
| | cloud/local agent cards | | detail panes, compact titlebar  | | browser editor | | terminals     | |
| +------------------------+ +--------------------------------+ +---------------+ +-------------+ |
|                                                                                                  |
| Backboard panel visual: status row, recent tabs, log/history stack, compact composer card.        |
| Composer controls: Mode, Model, Web, Image, Voice, Stop, Send. Usage button was removed.          |
| Copilot visual: native chat/session editors and agent participants, not Backboard's webview HTML. |
+--------------------------------------------------------------------------------------------------+
```

## Backboard Webview Interior

```text
Backboard panel
|
|-- top/status
|   |-- elapsed run clock
|   |-- status text
|   L-- recent chat tabs
|
|-- content stack
|   |-- chat log with assistant/user/tool cards
|   |-- empty state
|   |-- history pane
|   L-- change stack / checkpoint strip
|
|-- composer
|   |-- hidden state controls for provider/model/mode/intensity/web/image/voice/MCP toggles
|   |-- popover for mode, model, web, image, voice
|   |-- textarea and action bar
|   L-- right actions: web, image, voice, stop, send
|
L-- auth overlay
    L-- SSO sign-in card when Backboard credentials are not present
```

## Important Visual Differences

| Area | Visual style | Implementation style |
|---|---|---|
| Right auxiliary panel | Compact sessions-specific pane with title actions and composite tabs. | AuxiliaryBarPart subclass in sessions workbench. |
| Editor column | Native editor stack beside the auxiliary panel. | Workbench editor part sized by sessions grid. |
| Browser editor | Native workbench editor with URL/tool widgets and screenshot/share actions. | Browser editor contribution plus browser view model. |
| Backboard panel | Custom chat UI inside a webview: status, log/history stack, composer, popovers. | BackboardPanelProvider and panelHtml(). |
| Copilot participants | Native VS Code chat participant/session editors. | VS Code chat APIs and session content providers. |

## Code Anchors

### Sessions grid

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

### Backboard visible shell

```ts
		.modelChoice .codicon-check { width: 12px; flex: 0 0 auto; color: var(--vscode-focusBorder, var(--bb-primary)); font-size: 12px; }
		.modelChoiceCheckSpacer { width: 12px; flex: 0 0 auto; }
		.modelProviderPill { display: none; }
	</style>
	</head>
		<body>
			<div class="root">
				${header}
				${recentTabs}
				<div class="statusBar">
					<div id="runClock" class="runClock" hidden>00:00</div>
					<div id="status" class="status">Ready.</div>
				</div>
				${checkpointStrip}
				<div class="viewStack">
				<div id="log" class="log viewPane active" role="tabpanel" ${logLabel}>
					<div id="emptyState" class="emptyState">
						<div class="emptyIcon" aria-hidden="true"></div>
						<div class="emptyTagline">Ask anything about your code</div>
						<div class="emptyHints">
							<div class="emptyHint">Try: "Explain this function"</div>
							<div class="emptyHint">Try: "Find bugs in my code"</div>
						</div>
					</div>
				</div>
				${historyPane}
				</div>
			<div class="composer">
			<select id="provider" class="stateControl" aria-hidden="true"></select>
			<select id="model" class="stateControl" aria-hidden="true"></select>
			<select id="mode" class="stateControl" aria-hidden="true">
				<option value="agent">Agent</option>
				<option value="ask">Ask</option>
				<option value="manual">Manual</option>
				<option value="free">Full Access</option>
			</select>
			<select id="intensity" class="stateControl" aria-hidden="true">
				<option value="fast">Fast</option>
				<option value="balanced">Balanced</option>
				<option value="deep">Deep</option>
			</select>
			<select id="webSearch" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="Auto">Auto</option>
			</select>
			<select id="imageGeneration" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="auto">Auto</option>
			</select>
			<select id="voiceMode" class="stateControl" aria-hidden="true">
				<option value="off">Off</option>
				<option value="tts">TTS</option>
				<option value="stt">STT</option>
				<option value="conversation">Conversation</option>
			</select>
			<input id="mcpFigma" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpNotion" class="stateControl" type="checkbox" aria-hidden="true">
			<input id="mcpGoogle" class="stateControl" type="checkbox" aria-hidden="true">
			<span id="toolCount" class="stateControl" aria-hidden="true">Tools loading</span>
				<div id="popover" class="popover" role="dialog" aria-modal="false" aria-hidden="true">
				<div class="popoverHeader">
```
