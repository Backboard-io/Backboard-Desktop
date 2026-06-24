# Backboard Endpoints And Rust/TypeScript Bridge Walkthrough

This is the single-file deep walk through the Backboard endpoint surface and the Rust/TypeScript bridge implementation. It is grounded in the current workspace source and follows the request path from the right-panel UI to VS Code extension code, through the JSONL bridge, into Rust command dispatch, and finally into Backboard HTTP routes.

## Source Files Covered

| Layer | Absolute path | Role |
|---|---|---|
| Extension manifest | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/package.json` | Declares VS Code commands, activation events, Backboard settings, build scripts, and packaging surface. |
| TypeScript extension | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` | Owns activation, OAuth, webview provider, panel HTML, panel messages, BackboardBridge child process transport, tool execution, cache, and usage calls. |
| Rust bridge binary | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` | Implements the JSONL bridge protocol, command dispatcher, model/tool listing, prompt streaming, tool-output continuation, API command mapping, and Rust-side network tools. |
| Rust Backboard client library | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` | Implements Backboard configuration, auth headers, route helpers, JSON parsing, SSE streaming, and HTTP endpoint methods. |
| Rust workspace | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/Cargo.toml` | Defines Rust workspace members and shared dependency versions. |
| Bridge crate | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/Cargo.toml` | Builds the executable binary named backboard-bridge. |
| Client crate | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/Cargo.toml` | Builds the reusable library crate named backboard. |


## End-To-End System Map

```text
Backboard panel webview
    |
    | vscode.postMessage({ type: 'send' | 'sendVoice' | 'refreshModels' | 'refreshUsage' | ... })
    v
BackboardPanelProvider in extension.ts
    |
    | onDidReceiveMessage()
    | runPrompt()
    | sendPrompt()
    | bridge.listTools()
    | bridge.send('sendPrompt')
    | bridge.send('submitToolResult')
    v
BackboardBridge in extension.ts
    |
    | child_process.spawn(backboard-bridge)
    | stdin:  JSON request lines
    | stdout: JSON event lines
    | pending request map keyed by requestId
    v
Rust backboard_bridge/src/main.rs
    |
    | handle_request()
    | listModels/listTools/runTool/sendPrompt/submitToolResult/cancel/API commands
    v
Rust backboard/src/backboard.rs
    |
    | BackboardClient
    | X-API-Key or Bearer auth
    | reqwest HTTP and SSE streams
    v
Backboard HTTP API
    |
    | /assistants
    | /threads/messages
    | /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true
    | /models
    | /billing/usage/*
    | /documents/*
    v
Backboard service response stream
    |
    | bridge events: progress, delta, toolCalls, usage, apiResponse, done, error
    v
Backboard panel webview
```

## Endpoint Vocabulary

| Term | Meaning |
|---|---|
| VS Code command endpoint | Command declared in package.json and registered in activate(), such as backboard.openPanel or backboard.refreshModels. |
| Webview endpoint | Message type sent by the webview script to extension.ts, or by extension.ts back to the webview. |
| Bridge command | JSONL command sent by TypeScript to Rust, such as sendPrompt, listModels, or getBillingBalance. |
| Rust API command | Bridge command accepted by is_api_command() and mapped to BackboardClient. |
| Backboard HTTP endpoint | Actual REST or streaming route under the configured Backboard API base URL. |
| Tool call | Model-requested function call. TypeScript executes most host/workspace tools; Rust executes web_search and web_fetch. |


## 1. Manifest Endpoints

The manifest is the static endpoint registry. It exposes activation events, commands, menu entries, configuration keys, and build scripts. TypeScript activation later binds these declared endpoints to behavior.

### Activation Events

| Activation event | Runtime meaning |
|---|---|
| onStartupFinished | Activates Backboard after startup so the panel, auth state, caches, update checks, and watchers can initialize. |
| onCommand:backboard.extension.signIn | Activates sign-in. |
| onCommand:backboard.setApiKey | Activates legacy API-key entry. |
| onCommand:backboard.copyOAuthRedirectUri | Activates redirect URI copy helper. |
| onCommand:backboard.completeOAuthCallback | Activates manual OAuth callback completion. |
| onCommand:backboard.refreshModels | Activates model refresh. |
| onCommand:backboard.openRightPanel | Activates right panel opening. |
| onCommand:backboard.openPanel | Activates panel opening. |
| onCommand:backboard.newChat | Activates panel and new-chat UI command. |
| onCommand:backboard.showHistory | Activates panel and history UI command. |
| onUri | Activates OAuth callback URI handling. |

### VS Code Commands

| Command | TypeScript behavior | Endpoint class |
|---|---|---|
| backboard.setApiKey | Prompts for legacy API key, writes config, restarts bridge. | Credential endpoint. |
| backboard.extension.signIn | Starts Backboard SSO flow. | OAuth endpoint. |
| backboard.copyOAuthRedirectUri | Copies redirect URI. | OAuth helper endpoint. |
| backboard.completeOAuthCallback | Accepts pasted callback URI. | OAuth helper endpoint. |
| backboard.refreshModels | Calls BackboardBridge.refreshModels(). | Metadata bridge endpoint. |
| backboard.checkForUpdates | Checks update manifest. | Update endpoint. |
| backboard.installAvailableUpdate | Installs available update. | Update endpoint. |
| backboard.openRightPanel | Opens workbench.view.extension.backboard and focuses backboard.panel. | UI endpoint. |
| backboard.openPanel | Same open behavior. | UI endpoint. |
| backboard.newChat | Opens panel and posts newChat UI command. | UI endpoint. |
| backboard.showHistory | Opens panel and posts showHistory UI command. | UI endpoint. |

### Configuration Keys

| Setting | Consumed by | Bridge/API effect |
|---|---|---|
| backboard.apiKey | TypeScript credential writer and Rust BackboardConfig. | Legacy X-API-Key auth. |
| backboard.env | readSettings(), Rust ConfigParams, BackboardConfig. | Selects prod/dev/local base URL. |
| backboard.apiUrl | readSettings(), Rust ConfigParams. | Overrides env-derived base URL. |
| backboard.oauthRedirectUri | OAuth flow. | Local callback URI for SSO. |
| backboard.defaultProvider | sendPrompt settings. | Sent as provider to Rust and Backboard. |
| backboard.defaultModel | sendPrompt settings. | Sent as model to Rust and Backboard. |
| backboard.mode | panel options and tool selection. | Controls agent/ask/manual/free behavior. |
| backboard.intensity | thinking_payload in Rust. | Maps to reasoning budget. |
| backboard.webSearch | sendPrompt settings. | Sent as web_search. |
| backboard.imageGeneration | sendPrompt settings. | Enables image-generation request fields. |
| backboard.mcpFigma | mcpCallsPayload(). | Requests hosted Figma MCP intent. |
| backboard.mcpNotion | mcpCallsPayload(). | Requests hosted Notion MCP intent. |
| backboard.mcpGoogle | mcpCallsPayload(). | Requests hosted Google MCP intent. |
| backboard.voiceMode | sendPrompt settings and Rust voice_payload(). | Controls TTS/STT/conversation payload. |
| backboard.bridgePath | BackboardBridge.resolveBridgePath(). | Overrides child-process binary path. |
| backboard.workspaceRoot | workspacePath()/configuredWorkspaceRoot(). | Controls workspace sent to prompt/tool context. |
| backboard.updates.* | update checker. | Controls manifest URL/channel/frequency. |


### Manifest command, setting, and build-script surface

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/package.json` lines 20-270

```json
  ],
  "activationEvents": [
    "onStartupFinished",
    "onCommand:backboard.extension.signIn",
    "onCommand:backboard.setApiKey",
    "onCommand:backboard.copyOAuthRedirectUri",
    "onCommand:backboard.completeOAuthCallback",
    "onCommand:backboard.refreshModels",
    "onCommand:backboard.openRightPanel",
    "onCommand:backboard.openPanel",
    "onCommand:backboard.newChat",
    "onCommand:backboard.showHistory",
    "onUri"
  ],
  "extensionKind": [
    "workspace",
    "ui"
  ],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited"
    }
  },
  "contributes": {
    "commands": [
      {
        "command": "backboard.setApiKey",
        "title": "Backboard: Set API Key"
      },
      {
        "command": "backboard.extension.signIn",
        "title": "Backboard: Sign In"
      },
      {
        "command": "backboard.copyOAuthRedirectUri",
        "title": "Backboard: Copy OAuth Redirect URI"
      },
      {
        "command": "backboard.completeOAuthCallback",
        "title": "Backboard: Complete OAuth Callback"
      },
      {
        "command": "backboard.refreshModels",
        "title": "Backboard: Refresh Models"
      },
      {
        "command": "backboard.openRightPanel",
        "title": "Backboard: Open Right Panel"
      },
      {
        "command": "backboard.openPanel",
        "title": "Backboard: Open Panel"
      },
      {
        "command": "backboard.newChat",
        "title": "Backboard: New Chat"
      },
      {
        "command": "backboard.showHistory",
        "title": "Backboard: Show History"
      },
      {
        "command": "backboard.checkForUpdates",
        "title": "Backboard: Check for Updates"
      },
      {
        "command": "backboard.installAvailableUpdate",
        "title": "Backboard: Install Update",
        "icon": "$(cloud-download)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "backboard.installAvailableUpdate",
          "when": "view == backboard.panel && backboard.updateAvailable",
          "group": "navigation@1"
        }
      ],
      "commandPalette": [
        {
          "command": "backboard.installAvailableUpdate",
          "when": "backboard.updateAvailable"
        }
      ]
    },
    "configuration": [
      {
        "title": "Backboard",
        "properties": {
          "backboard.apiKey": {
            "type": "string",
            "default": "",
            "editPresentation": "secretText",
            "markdownDescription": "Legacy Backboard API key fallback. Prefer **Backboard: Sign in with SSO**.",
            "scope": "machine-overridable"
          },
          "backboard.env": {
            "type": "string",
            "enum": [
              "prod",
              "dev",
              "local"
            ],
            "default": "prod",
            "description": "Backboard API environment."
          },
          "backboard.apiUrl": {
            "type": "string",
            "default": "",
            "description": "Custom Backboard API base URL. Overrides the environment when set."
          },
          "backboard.oauthRedirectUri": {
            "type": "string",
            "default": "",
            "description": "OAuth redirect URI for Backboard sign in. Leave empty to use http://127.0.0.1:49321/auth/callback, which the IDE listens on during sign in. Register this exact URI in the Backboard OAuth app."
          },
          "backboard.defaultProvider": {
            "type": "string",
            "default": "openrouter",
            "description": "Default Backboard model provider."
          },
          "backboard.defaultModel": {
            "type": "string",
            "default": "deepseek/deepseek-v4-flash",
            "description": "Default Backboard model name."
          },
          "backboard.mode": {
            "type": "string",
            "enum": [
              "agent",
              "ask",
              "manual",
              "free"
            ],
            "default": "free",
            "description": "Backboard tool mode."
          },
          "backboard.intensity": {
            "type": "string",
            "enum": [
              "fast",
              "balanced",
              "deep"
            ],
            "default": "fast",
            "description": "Reasoning intensity sent to Backboard."
          },
          "backboard.webSearch": {
            "type": "string",
            "enum": [
              "off",
              "Auto"
            ],
            "default": "off",
            "description": "Web search setting for Backboard turns."
          },
          "backboard.imageGeneration": {
            "type": "string",
            "enum": [
              "off",
              "auto"
            ],
            "default": "off",
            "description": "Image generation setting for Backboard turns."
          },
          "backboard.mcpFigma": {
            "type": "boolean",
            "default": true,
            "description": "Request Backboard-hosted Figma MCP tool intent for Backboard turns."
          },
          "backboard.mcpNotion": {
            "type": "boolean",
            "default": false,
            "description": "Request Backboard-hosted Notion MCP tool intent for Backboard turns."
          },
          "backboard.mcpGoogle": {
            "type": "boolean",
            "default": false,
            "description": "Request Backboard-hosted Google MCP tool intent for Backboard turns."
          },
          "backboard.voiceMode": {
            "type": "string",
            "enum": [
              "off",
              "tts",
              "stt",
              "conversation"
            ],
            "default": "off",
            "description": "Backboard voice mode for REST turns. TTS synthesizes assistant audio; STT and conversation require audio attachment support."
          },
          "backboard.bridgePath": {
            "type": "string",
            "default": "",
            "description": "Path to the local backboard-bridge binary. Leave empty for the built-in development/package lookup."
          },
          "backboard.workspaceRoot": {
            "type": "string",
            "default": "",
            "description": "Path to use as the Backboard panel workspace root. Supports ${workspaceFolder} and ${userHome}. Leave empty to use the open workspace folder. Can also be set with BACKBOARD_WORKSPACE_ROOT."
          },
          "backboard.updates.enabled": {
            "type": "boolean",
            "default": true,
            "description": "Check the Backboard Studio S3 manifest for IDE updates after Backboard activates."
          },
          "backboard.updates.manifestBaseUrl": {
            "type": "string",
            "default": "https://ide-bucket-059623506914-ca-central-1-an.s3.ca-central-1.amazonaws.com/ide-releases",
            "description": "Base URL for Backboard Studio update manifests."
          },
          "backboard.updates.channel": {
            "type": "string",
            "enum": [
              "",
              "stable",
              "sandbox"
            ],
            "default": "",
            "description": "Backboard Studio update channel. Leave empty to use sandbox for development builds and stable for packaged production builds."
          },
          "backboard.updates.manifestUrl": {
            "type": "string",
            "default": "",
            "description": "Full Backboard Studio update manifest URL override. Leave empty to derive the URL from the base URL, channel, platform, and architecture."
          },
          "backboard.updates.checkIntervalMinutes": {
            "type": "number",
            "default": 360,
            "minimum": 15,
            "description": "How often Backboard Studio checks the S3 update manifest while the IDE is open."
          }
        }
      }
    ]
  },
  "scripts": {
    "build-bridge": "cargo build --manifest-path ./rust/Cargo.toml -p backboard_bridge",
    "package-bridge": "npm run build-bridge && mkdir -p ./bin && cp ./rust/target/debug/backboard-bridge ./bin/backboard-bridge && chmod 755 ./bin/backboard-bridge",
    "compile": "tsgo --project ./tsconfig.json",
    "watch": "tsgo --project ./tsconfig.json --watch",
    "typecheck": "tsgo --project ./tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "24.x"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/microsoft/vscode.git"
  }
```


## 2. TypeScript Activation And Command Binding

The TypeScript activation function is where static command declarations become behavior. It creates one BackboardBridge, creates one BackboardPanelProvider, registers commands, registers a URI handler, registers file watchers, and registers backboard.panel as a webview view provider.

### Activation Responsibilities

1. Create the Backboard Tools output channel.
2. Create BackboardBridge.
3. Create BackboardPanelProvider.
4. Register credential, OAuth, model refresh, update, panel open, new-chat, and history commands.
5. Register URI handler for OAuth callback URIs.
6. Watch config files and shared panel state files.
7. Register the webview provider for backboard.panel.
8. Watch Optimus panel command file for cross-surface panel commands.
9. Start Backboard update checks.


### Activation and command binding

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 175-240

```ts
	const bridge = new BackboardBridge(context);
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
		void handleOptimusPanelCommand(panelProvider);
	};
	context.subscriptions.push(optimusCommandWatcher);
	context.subscriptions.push(optimusCommandWatcher.onDidCreate(handleOptimusCommand));
	context.subscriptions.push(optimusCommandWatcher.onDidChange(handleOptimusCommand));
	handleOptimusCommand();
	startBackboardUpdateChecks(context);
}

```


## 3. Webview Message Endpoints

The webview is a custom panel UI. It does not call Rust directly. It posts messages into BackboardPanelProvider, and that provider decides whether the message is a UI command, settings write, model refresh, usage fetch, OAuth request, context insertion, cancellation, or prompt run.

### Webview To Extension

| Message type | Required fields | Handler | Result |
|---|---|---|---|
| send | prompt | runPrompt(prompt, options, chatId, undefined, workspace) | Starts text prompt turn. |
| sendVoice | audio | runPrompt(prompt, options, chatId, audio, workspace) | Starts audio prompt turn. |
| cancel | none | this.runToken?.cancel() | Cancels current prompt/tool loop. |
| reviewChanges | none | workbench.view.scm | Opens SCM. |
| setApiKey | none | promptBackboardSso() | Starts SSO path despite legacy name. |
| signIn | none | promptBackboardSso() | Starts SSO. |
| insertActiveFile | none | postComposerContext(activeFile) | Adds active file context. |
| insertSelection | none | postComposerContext(selection) | Adds selected text context. |
| insertBranchDiff | none | postBranchDiff() | Adds branch diff context. |
| ready | none | postPanelState(), postPanelStateSnapshot() | Hydrates panel. |
| refreshModels | none | postPanelState(forceModelRefresh=true) | Forces metadata refresh. |
| refreshUsage | none | postUsageSnapshot() | Calls billing endpoints. |
| saveSettings | options | savePanelOptions() | Persists panel options. |
| panelState | state | savePanelState() | Persists shared panel UI state. |
| syncPanelState | none | postPanelStateSnapshot() | Re-sends persisted state. |

### Extension To Webview

| Message type | Source | Purpose |
|---|---|---|
| settings | postPanelState() | Public settings plus workspace path. |
| models | postPanelState() | Model metadata. |
| tools | postPanelState() | Tool definitions. |
| status | many paths | User-visible status. |
| panelStateSnapshot | postPanelStateSnapshot() | Shared history/tabs/state. |
| usageSnapshot | postUsageSnapshot() | Billing balance/summary/recent usage. |
| runStarted | sendPrompt() | Marks active run. |
| delta | panelSink.markdown | Streams assistant text. |
| append | error path | Appends error card/log text. |
| runFinished | sendPrompt() | Clears running state. |
| command | postUiCommand() | Drives newChat/showHistory/openHistoryEntry. |


### Webview message dispatch

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 2140-2190

```ts
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
```


## 4. Prompt Turn Flow In TypeScript

A prompt turn begins as a webview message and becomes a Rust bridge request only after TypeScript resolves panel options, workspace identity, chat identity, model/tool metadata, and UI sinks.

```text
webview send/sendVoice
  -> BackboardPanelProvider.runPrompt()
  -> cancel previous active run when needed
  -> BackboardPanelProvider.sendPrompt()
  -> resolveTurnSettings(options)
  -> compute effective workspace and chat id
  -> post runStarted/status
  -> bridge.listTools(mode)
  -> trimBackboardToolsForRequest(...)
  -> bridge.send('sendPrompt', sessionId, params, onEvent)
  -> renderBridgeEvent(event, sink)
  -> enqueue tool requests from stream
  -> executeToolCalls(...)
  -> bridge.send('submitToolResult', sessionId, params, onEvent)
  -> repeat until no tool requests remain
  -> post runFinished/status
```

### sendPrompt Params Sent To Rust

| Field | Source | Meaning |
|---|---|---|
| content | Prompt text or audio fallback text. | Main user message. |
| workspace | effectiveWorkspace. | Workspace path for context and tools. |
| provider | settings.defaultProvider. | Model provider. |
| model | settings.defaultModel. | Model name. |
| mode | settings.mode. | agent/ask/manual/free mode. |
| intensity | settings.intensity. | Thinking budget selector. |
| webSearch | settings.webSearch. | Backboard web search setting. |
| imageGeneration | derived image setting. | Enables media-generation fields. |
| voiceMode | resolved voice mode. | off/tts/stt/conversation. |
| audioFile | optional voice attachment. | Audio bytes and metadata. |
| mcpCalls | settings-derived MCP hints. | Hosted MCP intent. |
| tools | submitTools. | Tool schema list sent to model. |
| config | settings.config. | env/apiUrl/accessToken for Rust client. |

### submitToolResult Params Sent To Rust

| Field | Meaning |
|---|---|
| threadId | Thread id associated with current Backboard run. |
| runId | Run id associated with the tool request. |
| toolOutputs | Host-executed outputs, one per requested tool call. |
| tools | Same tool schema list for continuation context. |
| config | env/apiUrl/accessToken for Rust client. |


### Prompt execution and tool continuation loop

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 2192-2340

```ts

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
```


## 5. TypeScript BackboardBridge Transport

BackboardBridge is the TypeScript JSONL adapter between VS Code extension host and the Rust child process.

### Transport Rules

| Rule | Implementation |
|---|---|
| One request gets one requestId. | send() calls newId(). |
| Request serialization is JSONL. | child.stdin.write(JSON.stringify({ requestId, command, sessionId, params }) + newline). |
| Rust response parsing is line-based. | readline over child.stdout calls handleLine(). |
| Events are grouped by requestId. | pending Map stores events, callbacks, timeout reset, resolve, reject. |
| Event type done resolves. | handleLine() deletes pending and resolves. |
| Cancellation is another bridge command. | cancelRequest writes command cancel with target requestId in params. |
| sendPrompt and submitToolResult have no TS inactivity timeout. | bridgeInactivityTimeoutMs returns 0. |
| listModels has 30s timeout. | bridgeInactivityTimeoutMs returns 30000. |
| Other commands default to 20s timeout. | bridgeInactivityTimeoutMs default. |
| Credential restart kills bridge. | restart() rejects all pending and kills child. |

### TypeScript Bridge Request Shape

```ts
interface TypeScriptBridgeRequest {
  requestId: string;
  command: string;
  sessionId?: string;
  params: unknown;
}
```

### TypeScript Bridge Event Shape

```ts
interface BridgeEvent {
  type: string;
  requestId: string;
  sessionId?: string;
  message?: string;
  text?: string;
  models?: BridgeModel[];
  tools?: unknown[];
  toolCalls?: unknown[];
  threadId?: string;
  runId?: string;
  stopReason?: string;
  usage?: unknown;
  chunk?: unknown;
  assistantId?: string;
  output?: unknown;
  status?: string;
  name?: string;
  data?: unknown;
}
```


### BackboardBridge transport and process spawn

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 5431-5759

```ts
class BackboardBridge implements vscode.Disposable {
	private static readonly modelCacheTtl = 24 * 60 * 60 * 1000;
	private static readonly modelCacheVersion = 2;
	private static readonly toolCacheTtl = 24 * 60 * 60 * 1000;
	private static readonly toolCacheVersion = 1;
	private child: cp.ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly output = vscode.window.createOutputChannel('Backboard Bridge');
	private pendingModelRefresh: Promise<BridgeModel[]> | undefined;
	private readonly pendingToolRefreshes = new Map<string, Promise<unknown[]>>();

	constructor(private readonly context: vscode.ExtensionContext) {
	}

	dispose(): void {
		this.child?.kill();
		this.output.dispose();
	}

	restart(): void {
		this.pendingModelRefresh = undefined;
		this.pendingToolRefreshes.clear();
		const child = this.child;
		this.child = undefined;
		if (!child || child.killed) {
			this.pending.clear();
			return;
		}
		this.output.appendLine(`[${new Date().toISOString()}] Restarting Backboard bridge after credential change`);
		for (const pending of this.pending.values()) {
			pending.reject(new Error('Backboard bridge restarted after credential change.'));
		}
		this.pending.clear();
		child.kill();
		const forceKillTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, 2000);
		forceKillTimer.unref();
	}

	refreshModels(): void {
		void this.listModels(new vscode.CancellationTokenSource().token, true);
	}

	async cachedModels(): Promise<BridgeModel[] | undefined> {
		const entry = await this.readModelCache();
		return entry?.models;
	}

	async cachedTools(mode: string): Promise<unknown[] | undefined> {
		const entry = await this.readToolCache(mode);
		return entry?.tools;
	}

	async hasFreshPanelMetadata(mode: string): Promise<boolean> {
		const [modelCache, toolCache] = await Promise.all([this.readModelCache(), this.readToolCache(mode)]);
		const now = Date.now();
		return Boolean(
			modelCache && now - modelCache.fetchedAt < BackboardBridge.modelCacheTtl
			&& toolCache && now - toolCache.fetchedAt < BackboardBridge.toolCacheTtl
		);
	}

	async listModels(token: vscode.CancellationToken, forceRefresh = false): Promise<BridgeModel[]> {
		const cached = await this.readModelCache();
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.modelCacheTtl) {
			return cached.models;
		}
		if (this.pendingModelRefresh) {
			return this.pendingModelRefresh;
		}
		this.pendingModelRefresh = this.fetchAndCacheModels(token);
		try {
			return await this.pendingModelRefresh;
		} finally {
			this.pendingModelRefresh = undefined;
		}
	}

	private async fetchAndCacheModels(token: vscode.CancellationToken): Promise<BridgeModel[]> {
		const events = await this.send('listModels', undefined, { config: readSettings().config }, undefined, token);
		const models = (events.find(event => event.type === 'models')?.models ?? []).filter(isVisibleBridgeModel);
		await this.writeModelCache(models);
		return models;
	}

	private modelCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'models.json');
	}

	private async readModelCache(): Promise<ModelCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.modelCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.modelCacheVersion || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
				return undefined;
			}
			return { env, version: parsed.version, fetchedAt: parsed.fetchedAt, models: parsed.models.filter(isBridgeModel).filter(isVisibleBridgeModel) };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeModelCache(models: BridgeModel[]): Promise<void> {
		const cachePath = this.modelCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `models.${process.pid}.${Date.now()}.tmp`);
		const entry: ModelCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.modelCacheVersion,
			fetchedAt: Date.now(),
			models: models.filter(isBridgeModel).filter(isVisibleBridgeModel)
		};
		await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(tempPath, cachePath);
	}

	async listTools(mode: string, token: vscode.CancellationToken, forceRefresh = false): Promise<unknown[]> {
		const cached = await this.readToolCache(mode);
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.toolCacheTtl) {
			return cached.tools;
		}
		const pending = this.pendingToolRefreshes.get(mode);
		if (pending) {
			return pending;
		}
		const refresh = this.fetchAndCacheTools(mode, token);
		this.pendingToolRefreshes.set(mode, refresh);
		try {
			return await refresh;
		} finally {
			this.pendingToolRefreshes.delete(mode);
		}
	}

	private async fetchAndCacheTools(mode: string, token: vscode.CancellationToken): Promise<unknown[]> {
		const events = await this.send('listTools', undefined, { mode }, undefined, token);
		const tools = events.find(event => event.type === 'tools')?.tools ?? [];
		await this.writeToolCache(mode, tools);
		return tools;
	}

	private toolCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'tools.json');
	}

	private async readToolCache(mode: string): Promise<ToolCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.toolCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.toolCacheVersion || parsed.mode !== mode || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tools)) {
				return undefined;
			}
			return { env, version: parsed.version, mode, fetchedAt: parsed.fetchedAt, tools: parsed.tools };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeToolCache(mode: string, tools: unknown[]): Promise<void> {
		const cachePath = this.toolCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `tools.${process.pid}.${Date.now()}.tmp`);
		const entry: ToolCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.toolCacheVersion,
			mode,
			fetchedAt: Date.now(),
			tools
		};
		await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(tempPath, cachePath);
	}

	async runRustTool(name: string, args: Record<string, unknown>, token: vscode.CancellationToken): Promise<unknown> {
		const events = await this.send('runTool', undefined, { name, args }, undefined, token);
		const result = [...events].reverse().find(event => event.type === 'toolFinished' && event.status === 'finished');
		return result?.output ?? { success: false, error: `Rust tool ${name} did not return output.` };
	}

	async callApi(command: string, params: Record<string, unknown>, token: vscode.CancellationToken): Promise<unknown> {
		const events = await this.send(command, undefined, { ...params, config: readSettings().config }, undefined, token);
		return events.find(event => event.type === 'apiResponse')?.data;
	}

	async send(command: string, sessionId: string | undefined, params: unknown, onEvent: ((event: BridgeEvent) => void | Promise<void>) | undefined, token: vscode.CancellationToken): Promise<BridgeEvent[]> {
		const requestId = newId();
		const child = this.ensureProcess();
		this.logBridgeRequest(requestId, command, sessionId, params);
		const timeoutMs = bridgeInactivityTimeoutMs(command);
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const clearTimeoutHandle = (): void => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
		};
		const resetTimeout = (): void => {
			clearTimeoutHandle();
			if (timeoutMs <= 0) {
				return;
			}
			timeoutHandle = setTimeout(() => {
				const pending = this.pending.get(requestId);
				if (!pending) {
					return;
				}
				const message = `Backboard bridge did not respond to ${command} for ${Math.round(timeoutMs / 1000)}s.`;
				this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
				this.pending.delete(requestId);
				pending.reject(new Error(message));
				this.child?.kill();
			}, timeoutMs);
		};
		const cancelRequest = () => {
			clearTimeoutHandle();
			this.write({ requestId: newId(), command: 'cancel', sessionId, params: { requestId } });
			const pending = this.pending.get(requestId);
			if (!pending) {
				return;
			}
			this.pending.delete(requestId);
			pending.events.push({ type: 'done', requestId, sessionId, stopReason: 'cancelled' });
			pending.resolve(pending.events);
		};
		const promise = new Promise<BridgeEvent[]>((resolve, reject) => {
			let disposable: vscode.Disposable | undefined;
			this.pending.set(requestId, {
				events: [],
				onEvent,
				resetTimeout,
				resolve: events => {
					clearTimeoutHandle();
					disposable?.dispose();
					resolve(events);
				},
				reject: error => {
					clearTimeoutHandle();
					disposable?.dispose();
					reject(error);
				}
			});
			resetTimeout();
			disposable = token.onCancellationRequested(cancelRequest);
			if (token.isCancellationRequested) {
				cancelRequest();
			}
		});
		if (!token.isCancellationRequested) {
			child.stdin.write(`${JSON.stringify({ requestId, command, sessionId, params })}\n`);
		}
		return promise;
	}

	private ensureProcess(): cp.ChildProcessWithoutNullStreams {
		if (this.child && !this.child.killed) {
			return this.child;
		}
		const bridgePath = this.resolveBridgePath();
		if (!fs.existsSync(bridgePath)) {
			throw new Error(`Backboard bridge binary not found at ${bridgePath}. Build it with: npm --prefix extensions/backboard run build-bridge`);
		}
		const cwd = workspacePath() ?? os.homedir();
		this.output.appendLine(`[${new Date().toISOString()}] Starting Backboard bridge`);
		this.output.appendLine(`  bridgePath: ${bridgePath}`);
		this.output.appendLine(`  bridgeDirectory: ${path.dirname(bridgePath)}`);
		this.output.appendLine(`  cwd: ${cwd}`);
		this.output.appendLine(`  workspaceRoot: ${workspacePath() ?? '<none>'}`);
		this.output.appendLine(`  configuredWorkspaceRoot: ${configuredWorkspaceRoot() ?? '<none>'}`);
		const child = cp.spawn(bridgePath, [], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		this.child = child;
		readline.createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
		child.stderr.on('data', chunk => this.output.append(chunk.toString()));
		child.on('error', error => {
			this.output.appendLine(`Bridge process error: ${error.message}`);
			for (const pending of this.pending.values()) {
				pending.reject(error);
			}
			this.pending.clear();
			if (this.child === child) {
				this.child = undefined;
			}
		});
		child.on('exit', (code, signal) => {
			this.output.appendLine(`Bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
			for (const pending of this.pending.values()) {
				pending.reject(new Error('Backboard bridge exited.'));
			}
			this.pending.clear();
			if (this.child === child) {
				this.child = undefined;
			}
		});
		return child;
	}

	private resolveBridgePath(): string {
		const configured = vscode.workspace.getConfiguration('backboard').get<string>('bridgePath')?.trim();
		if (configured) {
			return configured;
		}
		const development = this.resolveDevelopmentBridgePath();
		if (development) {
			return development;
		}
		const packaged = path.join(this.context.extensionPath, 'bin', process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge');
		if (fs.existsSync(packaged)) {
			return packaged;
		}
		return path.join(this.context.extensionPath, 'rust', 'target', 'debug', process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge');
	}

	private resolveDevelopmentBridgePath(): string | undefined {
		const binaryName = process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge';
		for (const profile of ['debug', 'release']) {
			const candidate = path.join(this.context.extensionPath, 'rust', 'target', profile, binaryName);
			if (fs.existsSync(candidate)) {
				return candidate;
```


### BackboardBridge stdout handling

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 5765-5814

```ts
	private write(payload: unknown): void {
		this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private logBridgeRequest(requestId: string, command: string, sessionId: string | undefined, params: unknown): void {
		const payload = {
			requestId,
			command,
			sessionId,
			workspaceRoot: workspacePath() ?? null,
			configuredWorkspaceRoot: configuredWorkspaceRoot() ?? null,
			processCwd: process.cwd(),
			params: redactSensitiveValues(params)
		};
		this.output.appendLine(`[${new Date().toISOString()}] Backboard Studio -> Backboard bridge`);
		if (backboardVerboseBridgeLogging()) {
			this.output.appendLine(JSON.stringify(payload, undefined, '\t'));
		} else {
			this.output.appendLine(JSON.stringify({
				requestId,
				command,
				sessionId,
				workspaceRoot: payload.workspaceRoot,
				configuredWorkspaceRoot: payload.configuredWorkspaceRoot,
				processCwd: payload.processCwd,
				params: bridgeRequestSummary(params),
			}));
		}
	}

	private handleLine(line: string): void {
		let event: BridgeEvent;
		try {
			event = JSON.parse(line) as BridgeEvent;
		} catch {
			this.output.appendLine(line);
			return;
		}
		const pending = this.pending.get(event.requestId);
		if (!pending) {
			return;
		}
		pending.resetTimeout();
		pending.events.push(event);
		void pending.onEvent?.(event);
		if (event.type === 'done') {
			this.pending.delete(event.requestId);
			pending.resolve(pending.events);
		}
	}
```


## 6. Rust Workspace And Binary

The Rust workspace has two members:

- backboard: reusable client library.
- backboard_bridge: executable binary named backboard-bridge.

TypeScript looks for the binary in configured, development, packaged, and fallback locations. The package script builds the bridge with Cargo.


### Rust workspace manifest

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/Cargo.toml` lines 1-32

```toml
[workspace]
resolver = "2"
members = [
	"backboard",
	"backboard_bridge",
]

[workspace.package]
publish = false
edition = "2024"

[workspace.dependencies]
anyhow = "1.0.86"
async-channel = "2.5.0"
backboard = { path = "backboard" }
dirs = "6.0"
futures = "0.3.32"
reqwest = { git = "https://github.com/zed-industries/reqwest.git", rev = "c15662463bda39148ba154100dd44d3fba5873a4", default-features = false, features = [
	"charset",
	"http2",
	"json",
	"macos-system-configuration",
	"multipart",
	"rustls-tls-native-roots",
	"socks",
	"stream",
], package = "zed-reqwest", version = "0.12.15-zed" }
serde = { version = "1.0.221", features = ["derive", "rc"] }
serde_json = { version = "1.0.144", features = ["preserve_order", "raw_value"] }
thiserror = "2.0.12"
tokio = { version = "1" }
urlencoding = "2.1.2"
```


### Rust bridge binary manifest

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/Cargo.toml` lines 1-23

```toml
[package]
name = "backboard_bridge"
version = "0.1.0"
edition.workspace = true
publish.workspace = true
license = "GPL-3.0-or-later"

[lints]
workspace = true

[[bin]]
name = "backboard-bridge"
path = "src/main.rs"

[dependencies]
anyhow.workspace = true
backboard.workspace = true
futures.workspace = true
reqwest.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio = { workspace = true, features = ["io-std", "io-util", "macros", "rt-multi-thread", "sync", "time"] }
urlencoding.workspace = true
```


### Rust client library manifest

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/Cargo.toml` lines 1-23

```toml
[package]
name = "backboard"
version = "0.1.0"
edition.workspace = true
publish.workspace = true
license = "GPL-3.0-or-later"

[lints]
workspace = true

[lib]
path = "src/backboard.rs"
doctest = false

[dependencies]
anyhow.workspace = true
async-channel.workspace = true
dirs.workspace = true
futures.workspace = true
reqwest.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
```


## 7. Rust Bridge Request And Command Dispatch

The Rust bridge reads stdin line by line. Every non-empty line must decode as BridgeRequest. The command string drives dispatch. Long-running commands are spawned onto Tokio tasks so the bridge can keep reading stdin for cancellation and later requests.

### Rust Request Shape

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: String,
    command: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    params: Value,
}
```

### Rust Command Families

| Command | Handler | Emits | Purpose |
|---|---|---|---|
| initialize | inline | initialized | Protocol handshake. |
| listModels | list_models | models, done | Fetch Backboard models. |
| listTools | list_tools | tools, done | Return local tool schemas. |
| runTool | run_tool | toolFinished, done | Execute Rust-owned tool. |
| sendPrompt | send_prompt | progress/delta/tool events/usage/done | Start message stream. |
| submitToolResult | submit_tool_result | progress/delta/tool events/usage/done | Continue after tool outputs. |
| cancel | cancel_request | cancellation events | Cancel active request/session. |
| getSession | get_session | session, done | Return session state. |
| disposeSession | dispose_session | done | Clear session state. |
| API commands | call_api_endpoint | apiResponse, done | Direct REST calls. |


### Rust request structs and main loop

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 122-320

```rust
    writer: EventWriter,
}

#[derive(Clone)]
struct EventWriter {
    stdout: Arc<Mutex<io::Stdout>>,
}

#[derive(Clone)]
struct SessionState {
    thread_id: Option<String>,
    assistant_id: Option<String>,
    current_run_id: Option<String>,
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: String,
    command: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigParams {
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    api_url: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendPromptParams {
    content: String,
    #[serde(default)]
    workspace: Option<PathBuf>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    intensity: Option<String>,
    #[serde(default)]
    web_search: Option<String>,
    #[serde(default)]
    image_generation: Option<String>,
    #[serde(default)]
    voice_mode: Option<String>,
    #[serde(default)]
    audio_file: Option<AudioFileParams>,
    #[serde(default)]
    tools: Option<Vec<Value>>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    assistant_id: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    config: Option<ConfigParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioFileParams {
    data: Vec<u8>,
    file_name: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitToolResultParams {
    thread_id: Option<String>,
    run_id: Option<String>,
    tool_outputs: Vec<Value>,
    #[serde(default)]
    tools: Option<Vec<Value>>,
    #[serde(default)]
    workspace: Option<PathBuf>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    intensity: Option<String>,
    #[serde(default)]
    web_search: Option<String>,
    #[serde(default)]
    image_generation: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    config: Option<ConfigParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunToolParams {
    name: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEndpointParams {
    #[serde(default)]
    config: Option<ConfigParams>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    query: Option<Value>,
    #[serde(default)]
    file_path: Option<PathBuf>,
    #[serde(default)]
    assistant_id: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    document_id: Option<String>,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    provider_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeModel {
    provider: String,
    name: String,
    model_type: Option<String>,
    display_name: Option<String>,
    context_limit: Option<u64>,
    supports_thinking: Option<bool>,
    #[serde(rename = "inputPricePerMillion")]
    input_price_per_million: Option<f64>,
    #[serde(rename = "outputPricePerMillion")]
    output_price_per_million: Option<f64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let state = BridgeState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        tool_runs_in_flight: Arc::new(Mutex::new(HashSet::new())),
        submitted_tool_runs: Arc::new(Mutex::new(HashSet::new())),
        writer: EventWriter {
            stdout: Arc::new(Mutex::new(io::stdout())),
        },
    };
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<BridgeRequest>(trimmed) {
            Ok(request) => request,
            Err(error) => {
                state.writer.emit(json!({
                    "type": "error",
                    "bridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "requestId": Value::Null,
                    "sessionId": Value::Null,
                    "message": format!("invalid bridge request: {error}")
                }));
                continue;
            }
        };
        handle_request(state.clone(), request).await;
    }

    Ok(())
}

async fn handle_request(state: BridgeState, request: BridgeRequest) {
    match request.command.as_str() {
        "initialize" => {
            state.writer.emit(base_event(
                "initialized",
                &request.request_id,
                request.session_id.as_deref(),
                json!({ "bridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION }),
```


### Rust command dispatcher

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 321-410

```rust
            ));
        }
        "listModels" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = list_models(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "listTools" => list_tools(&state, &request),
        "runTool" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = run_tool(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "sendPrompt" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = send_prompt(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "submitToolResult" => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = submit_tool_result(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        "cancel" => cancel_request(&state, &request),
        "getSession" => get_session(&state, &request),
        "disposeSession" => dispose_session(&state, &request),
        command if is_api_command(command) => {
            let state = state.clone();
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let session_id = request.session_id.clone();
                if let Err(error) = call_api_endpoint(state.clone(), request).await {
                    emit_error(
                        &state.writer,
                        &error,
                        Some(&request_id),
                        session_id.as_deref(),
                    );
                }
            });
        }
        command => {
            emit_error(
                &state.writer,
                &anyhow!("unknown bridge command `{command}`"),
                Some(&request.request_id),
                request.session_id.as_deref(),
            );
        }
    }
```


### Rust EventWriter and base_event

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 3020-3084

```rust
impl EventWriter {
    fn emit(&self, event: Value) {
        let mut stdout = self.stdout.lock().expect("stdout lock");
        if serde_json::to_writer(&mut *stdout, &event).is_ok() {
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }
}

fn base_event(kind: &str, request_id: &str, session_id: Option<&str>, mut extra: Value) -> Value {
    let mut event = serde_json::Map::new();
    event.insert("type".to_string(), Value::String(kind.to_string()));
    event.insert(
        "bridgeProtocolVersion".to_string(),
        Value::Number(BRIDGE_PROTOCOL_VERSION.into()),
    );
    event.insert(
        "requestId".to_string(),
        Value::String(request_id.to_string()),
    );
    event.insert(
        "sessionId".to_string(),
        session_id
            .map(|id| Value::String(id.to_string()))
            .unwrap_or(Value::Null),
    );
    if let Value::Object(extra) = &mut extra {
        event.extend(std::mem::take(extra));
    }
    Value::Object(event)
}

fn emit_trace(
    state: &BridgeState,
    request_id: &str,
    session_id: Option<&str>,
    stage: &str,
    started_at: Instant,
    details: Value,
) {
    state.writer.emit(base_event(
        "trace",
        request_id,
        session_id,
        json!({
            "stage": stage,
            "elapsedMs": started_at.elapsed().as_millis(),
            "details": details
        }),
    ));
}

fn emit_error(
    writer: &EventWriter,
    error: &anyhow::Error,
    request_id: Option<&str>,
    session_id: Option<&str>,
) {
    writer.emit(base_event(
        "error",
        request_id.unwrap_or_default(),
        session_id,
        json!({ "message": format!("{error:#}") }),
    ));
```


## 8. Rust API Command Registry

Rust bridge commands that match is_api_command() are direct Backboard API calls. call_api_endpoint() parses ApiEndpointParams, constructs a BackboardClient, calls the mapped method, emits apiResponse, and then emits done.

### Direct API Command Mapping

| Bridge API command | Required params | BackboardClient method | HTTP route family |
|---|---|---|---|
| createAssistant | body | create_assistant_value | POST /assistants |
| listAssistants | none | list_assistants | GET /assistants |
| getAssistant | assistantId | get_assistant | GET /assistants/{assistant_id} |
| updateAssistant | assistantId, body | update_assistant_value | PUT /assistants/{assistant_id} |
| deleteAssistant | assistantId | delete_assistant | DELETE /assistants/{assistant_id} |
| createAssistantThread | assistantId | create_thread | POST /assistants/{assistant_id}/threads |
| listAssistantThreads | assistantId | list_threads(Some) | GET /assistants/{assistant_id}/threads |
| listAssistantDocuments | assistantId | list_assistant_documents | GET /assistants/{assistant_id}/documents |
| uploadAssistantDocument | assistantId, filePath | upload_document | POST /assistants/{assistant_id}/documents |
| sendMessage | body | send_message_value | POST /threads/messages |
| submitToolOutputsSimple | body | submit_tool_outputs_simple | POST /threads/tool-outputs |
| listThreads | none | list_threads(None) | GET /threads |
| getThread | threadId | get_thread | GET /threads/{thread_id} |
| deleteThread | threadId | delete_thread | DELETE /threads/{thread_id} |
| listThreadDocuments | threadId | list_thread_documents | GET /threads/{thread_id}/documents |
| uploadThreadDocument | threadId, filePath | upload_thread_document | POST /threads/{thread_id}/documents |
| addThreadMessage | threadId, body | add_thread_message | POST /threads/{thread_id}/messages |
| getDocumentStatus | documentId | get_document_status | GET /documents/{document_id}/status |
| deleteDocument | documentId | delete_document | DELETE /documents/{document_id} |
| getModel | modelName | get_model | GET /models/{model_name} |
| listProviders | none | list_providers | GET /models/providers |
| listModelsByProvider | providerName | list_models_by_provider | GET /models/provider/{provider_name} |
| listEmbeddingModels | none | list_embedding_models | GET /models/embedding/all |
| listEmbeddingProviders | none | list_embedding_providers | GET /models/embedding/providers |
| getEmbeddingModel | modelName | get_embedding_model | GET /models/embedding/{model_name} |
| getBillingBalance | none | get_billing_balance | GET /billing/balance |
| getRecentUsage | query | get_recent_usage | GET /billing/usage/recent |
| getUsageSummary | query | get_usage_summary | GET /billing/usage/summary |

### apiResponse Shape

```json
{
  "type": "apiResponse",
  "requestId": "request-id",
  "sessionId": null,
  "command": "getBillingBalance",
  "data": {}
}
```


### Rust API command set and dispatch

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 580-748

```rust
fn is_api_command(command: &str) -> bool {
    matches!(
        command,
        "createAssistant"
            | "listAssistants"
            | "getAssistant"
            | "updateAssistant"
            | "deleteAssistant"
            | "createAssistantThread"
            | "listAssistantThreads"
            | "listAssistantDocuments"
            | "uploadAssistantDocument"
            | "sendMessage"
            | "submitToolOutputsSimple"
            | "listThreads"
            | "getThread"
            | "deleteThread"
            | "listThreadDocuments"
            | "uploadThreadDocument"
            | "addThreadMessage"
            | "getDocumentStatus"
            | "deleteDocument"
            | "getModel"
            | "listProviders"
            | "listModelsByProvider"
            | "listEmbeddingModels"
            | "listEmbeddingProviders"
            | "getEmbeddingModel"
            | "getBillingBalance"
            | "getRecentUsage"
            | "getUsageSummary"
    )
}

async fn call_api_endpoint(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let command = request.command.clone();
    let params: ApiEndpointParams = serde_json::from_value(request.params.clone())?;
    let client = client_from_params(params.config.as_ref())?;
    let output = match command.as_str() {
        "createAssistant" => client.create_assistant_value(api_body(&params)).await?,
        "listAssistants" => json!({ "assistants": client.list_assistants().await? }),
        "getAssistant" => {
            client
                .get_assistant(&required(params.assistant_id.as_deref(), "assistantId")?)
                .await?
        }
        "updateAssistant" => {
            client
                .update_assistant_value(
                    &required(params.assistant_id.as_deref(), "assistantId")?,
                    api_body(&params),
                )
                .await?
        }
        "deleteAssistant" => {
            client
                .delete_assistant(&required(params.assistant_id.as_deref(), "assistantId")?)
                .await?
        }
        "createAssistantThread" => {
            client
                .create_thread(&required(params.assistant_id.as_deref(), "assistantId")?)
                .await?
        }
        "listAssistantThreads" => json!({
            "threads": client
                .list_threads(Some(&required(params.assistant_id.as_deref(), "assistantId")?))
                .await?
        }),
        "listAssistantDocuments" => {
            client
                .list_assistant_documents(&required(params.assistant_id.as_deref(), "assistantId")?)
                .await?
        }
        "uploadAssistantDocument" => {
            client
                .upload_document(
                    &required(params.assistant_id.as_deref(), "assistantId")?,
                    &required_path(params.file_path.as_ref(), "filePath")?,
                )
                .await?
        }
        "sendMessage" => client.send_message_value(api_body(&params)).await?,
        "submitToolOutputsSimple" => client.submit_tool_outputs_simple(api_body(&params)).await?,
        "listThreads" => json!({ "threads": client.list_threads(None).await? }),
        "getThread" => {
            client
                .get_thread(&required(params.thread_id.as_deref(), "threadId")?)
                .await?
        }
        "deleteThread" => {
            client
                .delete_thread(&required(params.thread_id.as_deref(), "threadId")?)
                .await?
        }
        "listThreadDocuments" => {
            client
                .list_thread_documents(&required(params.thread_id.as_deref(), "threadId")?)
                .await?
        }
        "uploadThreadDocument" => {
            client
                .upload_thread_document(
                    &required(params.thread_id.as_deref(), "threadId")?,
                    &required_path(params.file_path.as_ref(), "filePath")?,
                )
                .await?
        }
        "addThreadMessage" => {
            client
                .add_thread_message(
                    &required(params.thread_id.as_deref(), "threadId")?,
                    api_body(&params),
                )
                .await?
        }
        "getDocumentStatus" => {
            client
                .get_document_status(&required(params.document_id.as_deref(), "documentId")?)
                .await?
        }
        "deleteDocument" => {
            client
                .delete_document(&required(params.document_id.as_deref(), "documentId")?)
                .await?
        }
        "getModel" => {
            client
                .get_model(&required(params.model_name.as_deref(), "modelName")?)
                .await?
        }
        "listProviders" => json!({ "providers": client.list_providers().await? }),
        "listModelsByProvider" => json!({
            "models": client
                .list_models_by_provider(
                    &required(params.provider_name.as_deref(), "providerName")?,
                    None,
                )
                .await?
                .into_iter()
                .map(to_bridge_model)
                .collect::<Vec<_>>()
        }),
        "listEmbeddingModels" => client.list_embedding_models().await?,
        "listEmbeddingProviders" => client.list_embedding_providers().await?,
        "getEmbeddingModel" => {
            client
                .get_embedding_model(&required(params.model_name.as_deref(), "modelName")?)
                .await?
        }
        "getBillingBalance" => client.get_billing_balance().await?,
        "getRecentUsage" => client
            .get_recent_usage(recent_usage_query(params.query.as_ref()))
            .await?
            .unwrap_or_else(|| json!({})),
        "getUsageSummary" => {
            client
                .get_usage_summary(usage_summary_query(params.query.as_ref()))
                .await?
        }
        _ => unreachable!("API command checked before dispatch"),
    };

    state.writer.emit(base_event(
        "apiResponse",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "command": command, "data": output }),
    ));
```


## 9. BackboardClient HTTP Layer

BackboardClient owns the real HTTP methods. It applies auth headers, builds URLs, encodes request bodies, sends requests with reqwest, parses JSON responses, and streams SSE JSON for prompt and tool-output continuation.

### Base URLs

| Environment | URL |
|---|---|
| prod | https://app.backboard.io/api |
| dev | https://dev.app.backboard.io/api |
| local | http://localhost:8000 |

### Auth Header Selection

| Auth source | Header |
|---|---|
| API key | X-API-Key: value |
| OAuth access token | Authorization: Bearer value |

BackboardConfig can load api_key, env_keys, api_url, env, and oauth.access_token from the Backboard config file. BackboardAuth applies either API key auth or OAuth bearer auth.


### BackboardConfig and credential storage shape

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 135-235

```rust

    ConfigPathOverrideGuard {
        previous_path,
        _lock: lock,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackboardConfig {
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub env_keys: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<BackboardOAuthConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct BackboardOAuthConfig {
    #[serde(default)]
    pub access_token: Option<String>,
}

fn default_env() -> String {
    "prod".into()
}

impl BackboardConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let map = read_config_map(&path)?;
        let mut config: Self = serde_json::from_value(Value::Object(map))
            .with_context(|| format!("parsing Backboard config at {}", path.display()))?;
        config.normalize_env();
        config.promote_legacy_default_env();
        Ok(config)
    }

    pub fn load_or_default() -> Self {
        Self::load().unwrap_or_default()
    }

    pub fn save_api_key_for_current_env(api_key: impl Into<String>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();
        let api_key = api_key.into().trim().to_string();
        let env = config.env.to_lowercase();

        config.env_keys.insert(env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn save_api_key_for_env(api_key: impl Into<String>, env: impl AsRef<str>) -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();

        let api_key = api_key.into().trim().to_string();
        let target_env = normalize_env(env.as_ref());
        let current_env = config.env.to_lowercase();

        if target_env != current_env {
            if let Some(current_key) = config.api_key.as_deref().and_then(non_empty_api_key) {
                config.env_keys.entry(current_env).or_insert(current_key);
            }
            config.env = target_env.clone();
            config.api_url = default_api_url_override_for_env(&target_env);
        }

        config.env_keys.insert(target_env, api_key.clone());
        config.api_key = Some(api_key);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn clear_api_key_for_current_env() -> Result<Self> {
        let mut config = Self::load_or_default();
        config.normalize_env();
        config.promote_legacy_default_env();
        let env = config.env.to_lowercase();

        config.api_key = None;
        config.env_keys.remove(&env);
        config.save()?;
        publish_config_change(config.clone());

        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
```


### BackboardAuth header application and config path

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 520-575

```rust
}

pub fn config_path() -> Result<PathBuf> {
    if let Some(path) = config_path_override().clone() {
        return Ok(path);
    }

    let home = dirs::home_dir().context("failed to determine user profile directory")?;
    Ok(home.join(".backboard_ide").join("config.json"))
}

#[derive(Debug, Error)]
pub enum BackboardError {
    #[error("Backboard API key is missing. Run `backboard config set-api-key <key>`.")]
    MissingApiKey,
    #[error("Backboard authentication is missing. Sign in to Backboard or set an API key.")]
    MissingAuth,
    #[error("Backboard API returned {status}: {body}")]
    Api { status: StatusCode, body: String },
}

#[derive(Clone, Debug)]
pub enum BackboardAuth {
    ApiKey(String),
    OAuthAccessToken(String),
}

impl BackboardAuth {
    fn apply(&self, request: RequestBuilder) -> RequestBuilder {
        match self {
            Self::ApiKey(api_key) => request.header("X-API-Key", api_key),
            Self::OAuthAccessToken(access_token) => request.bearer_auth(access_token),
        }
    }

    fn headers(&self) -> Result<reqwest::header::HeaderMap> {
        let mut headers = reqwest::header::HeaderMap::new();
        match self {
            Self::ApiKey(api_key) => {
                headers.insert("X-API-Key", header_value(api_key, "Backboard API key")?);
            }
            Self::OAuthAccessToken(access_token) => {
                let value = format!("Bearer {access_token}");
                headers.insert(
                    reqwest::header::AUTHORIZATION,
                    header_value(&value, "Backboard OAuth access token")?,
                );
            }
        }
        Ok(headers)
    }

    fn api_key(&self) -> Option<&str> {
        match self {
            Self::ApiKey(api_key) => Some(api_key),
            Self::OAuthAccessToken(_) => None,
```


### Assistant, thread, document, and message methods

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 827-1068

```rust
    pub async fn create_assistant(&self, request: CreateAssistantRequest) -> Result<Value> {
        self.json(
            self.client
                .post(self.url("/assistants"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn update_assistant(
        &self,
        assistant_id: &str,
        request: UpdateAssistantRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .put(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn update_assistant_value(
        &self,
        assistant_id: &str,
        request: Value,
    ) -> Result<Value> {
        self.json_value(
            self.client
                .put(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn create_assistant_value(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/assistants"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn get_assistant(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_assistants(&self) -> Result<Vec<Value>> {
        self.json(
            self.client
                .get(self.url("/assistants"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_assistant(&self, assistant_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/assistants/{assistant_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn create_thread(&self, assistant_id: &str) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&format!("/assistants/{assistant_id}/threads")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&json!({}))?),
        )
        .await
    }

    pub async fn get_thread(&self, thread_id: &str) -> Result<Value> {
        self.json(
            self.client
                .get(self.url(&format!("/threads/{thread_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_threads(&self, assistant_id: Option<&str>) -> Result<Vec<Value>> {
        let path = assistant_id.map_or_else(
            || "/threads".to_string(),
            |id| format!("/assistants/{id}/threads"),
        );
        self.json(
            self.client
                .get(self.url(&path))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/threads/{thread_id}")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_assistant_documents(&self, assistant_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/assistants/{assistant_id}/documents")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_thread_documents(&self, thread_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/threads/{thread_id}/documents")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn send_message(&self, request: SendMessageRequest) -> Result<Value> {
        self.json(self.message_request_builder(self.url("/threads/messages"), request, false)?)
            .await
    }

    pub async fn send_message_value(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/threads/messages"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn send_message_in_thread(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Value> {
        self.send_message(request.with_thread_id(thread_id)).await
    }

    pub async fn send_message_stream(
        &self,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        validate_message_request(&request, true)?;
        let client = self.client.clone();
        let url = self.url("/threads/messages");
        let auth = self.auth.clone();
        Ok(retrying_sse_json_stream(move || {
            message_request_builder(
                client.clone(),
                url.clone(),
                auth.clone(),
                request.clone(),
                true,
            )
        }))
    }

    pub async fn send_message_stream_in_thread(
        &self,
        thread_id: &str,
        request: SendMessageRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        self.send_message_stream(request.with_thread_id(thread_id))
            .await
    }

    pub fn realtime_voice_url(&self) -> String {
        realtime_voice_url(&self.base_url, self.auth.api_key().unwrap_or_default())
    }

    pub async fn upload_document(&self, assistant_id: &str, file_path: &Path) -> Result<Value> {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document")
            .to_string();
        let bytes = std::fs::read(file_path)
            .with_context(|| format!("reading document {}", file_path.display()))?;
        let form = Form::new().part("file", Part::bytes(bytes).file_name(file_name));
        self.json(
            self.auth
                .apply(
                    self.client
                        .post(self.url(&format!("/assistants/{assistant_id}/documents"))),
                )
                .multipart(form),
        )
        .await
    }

    pub async fn upload_thread_document(&self, thread_id: &str, file_path: &Path) -> Result<Value> {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document")
            .to_string();
        let bytes = std::fs::read(file_path)
            .with_context(|| format!("reading document {}", file_path.display()))?;
        let form = Form::new().part("file", Part::bytes(bytes).file_name(file_name));
        self.json_value(
            self.auth
                .apply(
                    self.client
                        .post(self.url(&format!("/threads/{thread_id}/documents"))),
                )
                .multipart(form),
        )
        .await
    }

    pub async fn get_document_status(&self, document_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/documents/{document_id}/status")))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn delete_document(&self, document_id: &str) -> Result<Value> {
        self.json_value(
            self.client
                .delete(self.url(&format!("/documents/{document_id}")))
```


### Model and billing methods

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 1088-1342

```rust
            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(MODELS_ROUTE))
                        .headers(self.json_headers()?)
                        .query(&params),
                )
                .await?;
            let received = page.models.len();
            models.extend(page.models);

            if received == 0 {
                break;
            }
            skip += received;
            if let Some(total) = page.total {
                if skip as u64 >= total {
                    break;
                }
            }
        }

        Ok(models)
    }

    pub async fn list_models_by_provider(
        &self,
        provider_name: &str,
        limit: Option<u32>,
    ) -> Result<Vec<BackboardModel>> {
        let max_records = limit.unwrap_or(u32::MAX) as usize;
        let mut skip = 0usize;
        let mut models = Vec::new();
        let route = model_provider_route(provider_name);

        while models.len() < max_records {
            let current_limit = MODEL_PAGE_SIZE.min(max_records - models.len());
            let params = [
                ("skip", skip.to_string()),
                ("limit", current_limit.to_string()),
            ];

            let page: ListModelsResponse = self
                .json(
                    self.client
                        .get(self.url(&route))
                        .headers(self.json_headers()?)
                        .query(&params),
                )
                .await?;
            let received = page.models.len();
            models.extend(page.models);

            if received == 0 {
                break;
            }
            skip += received;
            if let Some(total) = page.total {
                if skip as u64 >= total {
                    break;
                }
            }
        }

        Ok(models)
    }

    pub async fn list_providers(&self) -> Result<Vec<String>> {
        let data: Value = self
            .json(
                self.client
                    .get(self.url(MODEL_PROVIDERS_ROUTE))
                    .headers(self.json_headers()?),
            )
            .await?;
        Ok(data
            .get("providers")
            .and_then(Value::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn get_model(&self, model_name: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!("/models/{}", urlencoding::encode(model_name))))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_embedding_models(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/models/embedding/all"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn list_embedding_providers(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/models/embedding/providers"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn get_embedding_model(&self, model_name: &str) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url(&format!(
                    "/models/embedding/{}",
                    urlencoding::encode(model_name)
                )))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn submit_tool_outputs(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Value> {
        self.json(
            self.client
                .post(self.url(&format!(
                    "/threads/{thread_id}/runs/{run_id}/submit-tool-outputs"
                )))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn submit_tool_outputs_stream(
        &self,
        thread_id: &str,
        run_id: &str,
        request: SubmitToolOutputsRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Value>> + Send>>> {
        let response = self
            .client
            .post(self.url(&format!(
                "/threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true"
            )))
            .headers(self.json_headers()?)
            .body(serde_json::to_vec(&request)?)
            .send()
            .await?;
        let response = self.ensure_success(response).await?;
        Ok(Box::pin(sse_json_stream(response)))
    }

    pub async fn submit_tool_outputs_simple(&self, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url("/threads/tool-outputs"))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn add_thread_message(&self, thread_id: &str, request: Value) -> Result<Value> {
        self.json_value(
            self.client
                .post(self.url(&format!("/threads/{thread_id}/messages")))
                .headers(self.json_headers()?)
                .body(serde_json::to_vec(&request)?),
        )
        .await
    }

    pub async fn cancel_run(&self, thread_id: &str, run_id: &str) -> Result<bool> {
        let response = self
            .client
            .post(self.url(&format!("/threads/{thread_id}/runs/{run_id}/cancel")))
            .headers(self.json_headers()?)
            .send()
            .await?;
        Ok(response.status().is_success())
    }

    pub async fn get_recent_usage(&self, query: RecentUsageQuery) -> Result<Option<Value>> {
        let mut params = vec![
            ("page", query.page.unwrap_or(1).to_string()),
            ("page_size", query.page_size.clamp(1, 100).to_string()),
        ];
        if let Some(model) = query.model {
            params.push(("model", model));
        }
        if let Some(input_tokens) = query.input_tokens {
            params.push(("input_tokens", input_tokens.to_string()));
        }
        if let Some(output_tokens) = query.output_tokens {
            params.push(("output_tokens", output_tokens.to_string()));
        }
        if let Some(start) = query.start {
            params.push(("start", start));
        }
        if let Some(end) = query.end {
            params.push(("end", end));
        }
        if let Some(credit_type) = query.credit_type {
            params.push(("credit_type", credit_type));
        }
        if let Some(sort_by) = query.sort_by {
            params.push(("sort_by", sort_by));
        }
        if let Some(sort_order) = query.sort_order {
            params.push(("sort_order", sort_order));
        }
        let response = self
            .client
            .get(self.url("/billing/usage/recent"))
            .headers(self.json_headers()?)
            .query(&params)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(Some(parse_json_response(response).await?))
        } else {
            Ok(None)
        }
    }

    pub async fn get_billing_balance(&self) -> Result<Value> {
        self.json_value(
            self.client
                .get(self.url("/billing/balance"))
                .headers(self.json_headers()?),
        )
        .await
    }

    pub async fn get_usage_summary(&self, query: UsageSummaryQuery) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(range) = query.range {
            params.push(("range", range));
        }
        self.json_value(
            self.client
                .get(self.url("/billing/usage/summary"))
                .headers(self.json_headers()?)
                .query(&params),
```


### Message form payload builder

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 1480-1548

```rust

fn message_form(request: &SendMessageRequest, stream: bool) -> Result<Vec<(String, String)>> {
    let mut form = vec![
        ("content".to_string(), request.content.clone()),
        ("stream".to_string(), stream.to_string()),
        ("web_search".to_string(), request.web_search.clone()),
    ];
    if let Some(memory) = request.memory.clone() {
        form.push(("memory".to_string(), memory));
    }
    if let Some(thread_id) = request.thread_id.clone() {
        form.push(("thread_id".to_string(), thread_id));
    }
    if let Some(assistant_id) = request.assistant_id.clone() {
        form.push(("assistant_id".to_string(), assistant_id));
    }
    if let Some(provider) = request.provider.clone() {
        form.push(("llm_provider".to_string(), provider));
    }
    if let Some(model) = request.model.clone() {
        form.push(("model_name".to_string(), model));
    }
    if let Some(image_generation) = request.image_generation.clone() {
        form.push(("image_generation".to_string(), image_generation));
    }
    if let Some(image_model_provider) = request.image_model_provider.clone() {
        form.push(("image_model_provider".to_string(), image_model_provider));
    }
    if let Some(image_model_name) = request.image_model_name.clone() {
        form.push(("image_model_name".to_string(), image_model_name));
    }
    if let Some(voice) = request.voice.clone() {
        form.push(("voice".to_string(), serde_json::to_string(&voice)?));
    }
    if let Some(send_to_llm) = request.send_to_llm {
        form.push(("send_to_llm".to_string(), send_to_llm.to_string()));
    }
    if let Some(mcp_calls) = request.mcp_calls.clone() {
        form.push(("mcp_calls".to_string(), serde_json::to_string(&mcp_calls)?));
    }
    if let Some(max_tokens) = request.max_tokens {
        form.push(("max_tokens".to_string(), max_tokens.to_string()));
    }
    if let Some(thinking) = request.thinking.clone() {
        form.push(("thinking".to_string(), serde_json::to_string(&thinking)?));
    }
    if let Some(tools) = request.tools.clone() {
        form.push(("tools".to_string(), serde_json::to_string(&tools)?));
    }
    if let Some(parallel_tool_calls) = request.parallel_tool_calls {
        form.push((
            "parallel_tool_calls".to_string(),
            parallel_tool_calls.to_string(),
        ));
    }
    Ok(form)
}

fn message_json(request: &SendMessageRequest, stream: bool) -> Value {
    let mut body = Map::new();
    body.insert("content".to_string(), request.content.clone().into());
    body.insert("stream".to_string(), stream.into());
    body.insert("web_search".to_string(), request.web_search.clone().into());
    if let Some(memory) = request.memory.clone() {
        body.insert("memory".to_string(), memory.into());
    }
    if let Some(thread_id) = request.thread_id.clone() {
        body.insert("thread_id".to_string(), thread_id.into());
    }
```


### Message JSON payload builder

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard/src/backboard.rs` lines 1548-1595

```rust
    }
    if let Some(assistant_id) = request.assistant_id.clone() {
        body.insert("assistant_id".to_string(), assistant_id.into());
    }
    if let Some(provider) = request.provider.clone() {
        body.insert("llm_provider".to_string(), provider.into());
    }
    if let Some(model) = request.model.clone() {
        body.insert("model_name".to_string(), model.into());
    }
    if let Some(image_generation) = request.image_generation.clone() {
        body.insert("image_generation".to_string(), image_generation.into());
    }
    if let Some(image_model_provider) = request.image_model_provider.clone() {
        body.insert(
            "image_model_provider".to_string(),
            image_model_provider.into(),
        );
    }
    if let Some(image_model_name) = request.image_model_name.clone() {
        body.insert("image_model_name".to_string(), image_model_name.into());
    }
    if let Some(voice) = request.voice.clone() {
        body.insert("voice".to_string(), voice);
    }
    if let Some(send_to_llm) = request.send_to_llm {
        body.insert("send_to_llm".to_string(), send_to_llm.to_string().into());
    }
    if let Some(mcp_calls) = request.mcp_calls.clone() {
        body.insert("mcp_calls".to_string(), mcp_calls);
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert("max_tokens".to_string(), max_tokens.into());
    }
    if let Some(thinking) = request.thinking.clone() {
        body.insert("thinking".to_string(), thinking);
    }
    if let Some(tools) = request.tools.clone() {
        body.insert("tools".to_string(), tools.into());
    }
    if let Some(parallel_tool_calls) = request.parallel_tool_calls {
        body.insert(
            "parallel_tool_calls".to_string(),
            parallel_tool_calls.into(),
        );
    }
    Value::Object(body)
}
```


## 10. Rust sendPrompt

sendPrompt is the bridge command for a normal Backboard turn. It accepts content and turn options from TypeScript, builds a Backboard message request, sends it as a stream, consumes stream chunks, and emits bridge events back to TypeScript.

### sendPrompt Responsibilities

| Step | Detail |
|---|---|
| Session id | Uses provided sessionId or creates UUID. |
| Params | Deserializes SendPromptParams. |
| Provider/model/mode/intensity | Uses explicit params or defaults. |
| Voice/audio | Builds AudioAttachment and voice payload. |
| Client | Builds BackboardClient from config params. |
| Tool list | Uses provided tools or derives tool_definitions_for_request(). |
| Prompt augmentation | Adds workspace/runtime context. |
| SendMessageRequest | Includes model, thinking, tools, web, image, voice, audio, max tokens. |
| Streaming | Calls client.send_message_stream(). |
| Recovery | Retries once on upstream idle timeout with recovery prompt. |


### Rust sendPrompt request building

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 790-936

```rust
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(100),
    }
}

fn usage_summary_query(query: Option<&Value>) -> UsageSummaryQuery {
    UsageSummaryQuery {
        range: query.and_then(|value| string_arg(value, &["range"])),
    }
}

fn u64_arg(args: &Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| {
        let value = args.get(*name)?;
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
    })
}

async fn send_prompt(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let request_started_at = Instant::now();
    let session_id = request
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let params: SendPromptParams = serde_json::from_value(request.params.clone())?;
    let provider = params
        .provider
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let model = params.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let mode = params.mode.unwrap_or_else(|| "free".to_string());
    let intensity = params
        .intensity
        .unwrap_or_else(|| DEFAULT_INTENSITY.to_string());
    let voice_mode = params.voice_mode.unwrap_or_else(|| "off".to_string());
    let audio_file = params.audio_file.map(|audio| AudioAttachment {
        data: audio.data,
        file_name: audio.file_name,
        mime_type: audio.mime_type,
    });
    let cancel_flag = session_cancel_flag(&state, &session_id);
    cancel_flag.store(false, Ordering::SeqCst);

    let thread_id = params
        .thread_id
        .or_else(|| session_thread_id(&state, &session_id));
    let assistant_id = params.assistant_id;
    let client = client_from_params(params.config.as_ref())?;
    let backboard_image_generation =
        backboard_image_generation_enabled(params.image_generation.as_deref());
    let ignored_tool_call_names = if backboard_image_generation {
        BACKBOARD_IMAGE_TOOL_NAMES
    } else {
        &[]
    };
    let tools = params.tools.unwrap_or_else(|| {
        tool_definitions_for_request(&mode, backboard_image_generation, &params.content)
    });
    let content = augment_prompt(&params.content, params.workspace.as_ref(), &mode, &tools);
    emit_trace(
        &state,
        &request.request_id,
        Some(&session_id),
        "request_built",
        request_started_at,
        json!({
            "provider": provider.clone(),
            "model": model.clone(),
            "mode": mode.clone(),
            "intensity": intensity.clone(),
            "memory": "off",
            "toolCount": tools.len(),
            "promptChars": content.len()
        }),
    );
    state.writer.emit(base_event(
        "progress",
        &request.request_id,
        Some(&session_id),
        json!({ "message": "Sending to Backboard." }),
    ));

    let mut send_request = SendMessageRequest {
        thread_id,
        assistant_id,
        content,
        provider: Some(provider.clone()),
        model: Some(model.clone()),
        memory: Some("off".to_string()),
        thinking: thinking_payload(&intensity, &provider, &model),
        tools: Some(tools),
        parallel_tool_calls: Some(true),
        web_search: params.web_search.unwrap_or_else(|| "off".to_string()),
        image_generation: params.image_generation.clone(),
        image_model_provider: params
            .image_generation
            .as_deref()
            .filter(|value| *value == "auto")
            .map(|_| DEFAULT_IMAGE_PROVIDER.to_string()),
        image_model_name: params
            .image_generation
            .as_deref()
            .filter(|value| *value == "auto")
            .map(|_| DEFAULT_IMAGE_MODEL.to_string()),
        voice: voice_payload(&voice_mode),
        send_to_llm: send_to_llm_for_voice(&voice_mode),
        mcp_calls: None,
        max_tokens: params.max_tokens,
        audio_file,
    };
    for attempt in 0..=MAX_UPSTREAM_IDLE_RECOVERY_ATTEMPTS {
        log_backboard_request(&send_request, params.workspace.as_ref(), &mode)?;
        emit_trace(
            &state,
            &request.request_id,
            Some(&session_id),
            "post_start",
            request_started_at,
            json!({ "attempt": attempt }),
        );
        let stream = client.send_message_stream(send_request.clone()).await?;
        emit_trace(
            &state,
            &request.request_id,
            Some(&session_id),
            "post_stream_open",
            request_started_at,
            json!({ "attempt": attempt }),
        );

        match consume_stream(
            state.clone(),
            &request.request_id,
            &session_id,
            stream,
            ignored_tool_call_names,
            request_started_at,
            "sendPrompt",
        )
        .await?
        {
            StreamOutcome::Done => return Ok(()),
            StreamOutcome::UpstreamIdleTimeout { message }
                if attempt < MAX_UPSTREAM_IDLE_RECOVERY_ATTEMPTS =>
            {
                emit_upstream_idle_recovery_progress(&state, &request.request_id, &session_id);
```


## 11. Rust submitToolResult

submitToolResult is the bridge command for continuing a Backboard run after the IDE has executed requested tools. It is stateful because it needs session id, thread id, run id, tool output ids, and de-duplication protection.

### submitToolResult Responsibilities

| Step | Detail |
|---|---|
| sessionId | Required. |
| threadId/runId | Taken from params or Rust session state. |
| client | Built from config params. |
| ignored tool names | Image tool names ignored when image generation is enabled. |
| normalize outputs | Converts host outputs into Backboard tool-output payload. |
| de-duplicate | Prevents duplicate in-flight/submitted output sets. |
| POST stream | Calls submit_tool_outputs_stream(thread, run, request). |
| duplicate/stale error handling | Emits clean completion events rather than crashing panel. |
| idle recovery | Sends recovery message when continuation stream idles. |


### Rust submitToolResult path

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 967-1115

```rust
async fn submit_tool_result(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let request_started_at = Instant::now();
    let session_id = request
        .session_id
        .clone()
        .context("submitToolResult requires sessionId")?;
    let params: SubmitToolResultParams = serde_json::from_value(request.params.clone())?;
    let thread_id = params
        .thread_id
        .or_else(|| session_thread_id(&state, &session_id))
        .context("submitToolResult requires a threadId")?;
    let run_id = params
        .run_id
        .or_else(|| session_run_id(&state, &session_id))
        .context("submitToolResult requires a runId")?;
    let client = client_from_params(params.config.as_ref())?;
    let ignored_tool_call_names =
        if backboard_image_generation_enabled(params.image_generation.as_deref()) {
            BACKBOARD_IMAGE_TOOL_NAMES
        } else {
            &[]
        };
    let tool_outputs = params
        .tool_outputs
        .into_iter()
        .map(normalize_tool_output)
        .collect::<Vec<_>>();
    let submission_key =
        tool_outputs_submission_key(&session_id, &thread_id, &run_id, &tool_outputs);
    if !try_begin_tool_outputs_submission(&state, &submission_key) {
        emit_duplicate_tool_outputs_submitted(&state, &request.request_id, &session_id);
        return Ok(());
    }
    emit_trace(
        &state,
        &request.request_id,
        Some(&session_id),
        "tool_outputs_post_start",
        request_started_at,
        json!({ "threadId": thread_id.clone(), "runId": run_id.clone() }),
    );
    let tools = params.tools;
    let submit_request = SubmitToolOutputsRequest {
        tool_outputs,
        tools: tools.clone(),
    };
    let stream = match client
        .submit_tool_outputs_stream(&thread_id, &run_id, submit_request)
        .await
    {
        Ok(stream) => {
            finish_tool_outputs_submission(&state, &submission_key, true);
            emit_trace(
                &state,
                &request.request_id,
                Some(&session_id),
                "tool_outputs_stream_open",
                request_started_at,
                json!({}),
            );
            stream
        }
        Err(error) if is_duplicate_tool_outputs_error(&error) => {
            finish_tool_outputs_submission(&state, &submission_key, true);
            emit_duplicate_tool_outputs_submitted(&state, &request.request_id, &session_id);
            return Ok(());
        }
        Err(error) if is_stale_tool_outputs_error(&error) => {
            finish_tool_outputs_submission(&state, &submission_key, true);
            emit_stale_tool_outputs_ignored(&state, &request.request_id, &session_id);
            return Ok(());
        }
        Err(error) => {
            finish_tool_outputs_submission(&state, &submission_key, false);
            return Err(error);
        }
    };
    match consume_stream(
        state.clone(),
        &request.request_id,
        &session_id,
        stream,
        ignored_tool_call_names,
        request_started_at,
        "submitToolResult",
    )
    .await
    {
        Ok(StreamOutcome::Done) => Ok(()),
        Ok(StreamOutcome::UpstreamIdleTimeout { message }) => {
            emit_upstream_idle_recovery_progress(&state, &request.request_id, &session_id);
            let provider = params
                .provider
                .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
            let model = params.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
            let mode = params.mode.unwrap_or_else(|| "free".to_string());
            let intensity = params
                .intensity
                .unwrap_or_else(|| DEFAULT_INTENSITY.to_string());
            let recovery_prompt = upstream_idle_recovery_prompt(&message, "submitToolResult");
            let recovery_content = augment_prompt(
                &recovery_prompt,
                params.workspace.as_ref(),
                &mode,
                tools.as_deref().unwrap_or(&[]),
            );
            let recovery_request = SendMessageRequest {
                thread_id: Some(thread_id.clone()),
                assistant_id: None,
                content: recovery_content,
                provider: Some(provider.clone()),
                model: Some(model.clone()),
                memory: Some("off".to_string()),
                thinking: thinking_payload(&intensity, &provider, &model),
                tools: tools.clone(),
                parallel_tool_calls: Some(true),
                web_search: params.web_search.unwrap_or_else(|| "off".to_string()),
                image_generation: params.image_generation.clone(),
                image_model_provider: params
                    .image_generation
                    .as_deref()
                    .filter(|value| *value == "auto")
                    .map(|_| DEFAULT_IMAGE_PROVIDER.to_string()),
                image_model_name: params
                    .image_generation
                    .as_deref()
                    .filter(|value| *value == "auto")
                    .map(|_| DEFAULT_IMAGE_MODEL.to_string()),
                voice: None,
                send_to_llm: Some(true),
                mcp_calls: None,
                max_tokens: params.max_tokens,
                audio_file: None,
            };
            emit_trace(
                &state,
                &request.request_id,
                Some(&session_id),
                "idle_recovery_post_start",
                request_started_at,
                json!({ "phase": "submitToolResult" }),
            );
            let recovery_stream = client.send_message_stream(recovery_request).await?;
            match consume_stream(
                state.clone(),
                &request.request_id,
                &session_id,
                recovery_stream,
                ignored_tool_call_names,
```


## 12. Tool Execution Split

Backboard model tools are advertised by Rust, but execution is intentionally split.

| Tool family | Executed by | Why |
|---|---|---|
| read_file, write_file, edit_file, grep, glob, list_dir, delete_file, create_directory | TypeScript host | Needs workspace and VS Code host context. |
| bash, run_code, repl, read_lints, sleep | TypeScript host | Needs process/diagnostic integration and cancellation. |
| web_search | Rust bridge | Network utility implemented in Rust. |
| web_fetch | Rust bridge | Network utility with URL validation, timeout, and byte limits. |
| computer | Rust reports unsupported | Desktop automation is not implemented in this bridge. |
| generate_image | Backboard/media path | Request-side model tool, filtered when image generation is enabled. |

### Tool Loop Sequence

```text
Rust stream emits toolCalls
  -> TypeScript renderBridgeEvent() returns ToolResultRequest
  -> TypeScript executeToolCalls()
  -> approveTool()
  -> executeTool()
  -> host-owned tool or bridge.runRustTool()
  -> TypeScript wraps toolOutput(call.id, result)
  -> TypeScript bridge.send('submitToolResult')
  -> Rust submit_tool_result()
  -> Backboard continuation stream
```


### TypeScript host tool execution loop

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 5816-5960

```ts

function bridgeInactivityTimeoutMs(command: string): number {
	switch (command) {
		case 'submitToolResult':
		case 'sendPrompt':
			return 0;
		case 'listModels':
			return 30_000;
		default:
			return 20_000;
	}
}

async function executeToolCalls(bridge: BackboardBridge, toolCalls: unknown[], mode: string, response: ResponseSink, token: vscode.CancellationToken): Promise<unknown[]> {
	if (toolCalls.length > 1 && toolCalls.every(rawCall => {
		const call = parseToolCall(rawCall);
		return (mode === 'free' || isReadOnlyTool(call.name)) && isParallelSafeTool(call.name);
	})) {
		const calls = toolCalls.map(parseToolCall);
		return Promise.all(calls.map(call => executeOneToolCall(bridge, call, mode, response, token)));
	}
	const outputs: unknown[] = [];
	for (const rawCall of toolCalls) {
		if (token.isCancellationRequested) {
			break;
		}
		const call = parseToolCall(rawCall);
		outputs.push(await executeOneToolCall(bridge, call, mode, response, token));
	}
	return outputs;
}

async function executeOneToolCall(bridge: BackboardBridge, call: { id: string; name: string; args: Record<string, unknown> }, mode: string, response: ResponseSink, token: vscode.CancellationToken): Promise<unknown> {
	const allowed = await approveTool(call.name, call.args, mode);
	if (!allowed) {
		logToolDiagnostic('denied', call);
		response.event?.('toolFinished', { status: 'denied', key: call.id, name: call.name, args: call.args });
		return toolOutput(call.id, { success: false, content: 'User denied this tool call.' });
	}
	try {
		logToolDiagnostic('started', call);
		response.event?.('toolFinished', { status: 'started', key: call.id, name: call.name, args: call.args });
		const result = await executeTool(bridge, call.name, call.args, response, token, call.id);
		logToolDiagnostic('finished', call, result);
		response.event?.('toolFinished', { status: 'finished', key: call.id, name: call.name, args: call.args, output: result });
		return toolOutput(call.id, { success: true, content: result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logToolDiagnostic('failed', call, undefined, error);
		response.event?.('toolFinished', { status: 'failed', key: call.id, name: call.name, args: call.args, error: message });
		return toolOutput(call.id, { success: false, content: message });
	}
}

function isParallelSafeTool(name: string): boolean {
	return ['read_file', 'list_dir', 'glob', 'grep', 'codebase_search'].includes(name);
}

function logToolDiagnostic(status: string, call: { id: string; name: string; args: Record<string, unknown> }, output?: unknown, error?: unknown): void {
	const channel = backboardToolOutput;
	if (!channel) {
		return;
	}
	const timestamp = new Date().toISOString();
	channel.appendLine(`[${timestamp}] ${status.toUpperCase()} ${call.name} (${call.id})`);
	channel.appendLine(`args: ${safeDiagnosticJson(call.args)}`);
	if (output !== undefined) {
		channel.appendLine(`output: ${safeDiagnosticJson(output)}`);
	}
	if (error !== undefined) {
		channel.appendLine(`error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	}
	channel.appendLine('');
}

function safeDiagnosticJson(value: unknown): string {
	try {
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
}

function backboardVerboseBridgeLogging(): boolean {
	const value = process.env.BACKBOARD_BRIDGE_VERBOSE_REQUESTS || process.env.BACKBOARD_PANEL_VERBOSE_REQUESTS;
	return value === '1' || value?.toLowerCase() === 'true';
}

function bridgeRequestSummary(params: unknown): unknown {
	if (!isObjectRecord(params)) {
		return typeof params;
	}
	return {
		keys: Object.keys(params),
		provider: stringValueFromRecord(params.provider),
		model: stringValueFromRecord(params.model),
		mode: stringValueFromRecord(params.mode),
		contentChars: typeof params.content === 'string' ? params.content.length : undefined,
		toolCount: Array.isArray(params.tools) ? params.tools.length : undefined,
		toolOutputCount: Array.isArray(params.toolOutputs) ? params.toolOutputs.length : undefined,
		hasAudio: Boolean(params.audioFile),
		hasConfig: Boolean(params.config),
	};
}

async function approveTool(name: string, args: Record<string, unknown>, mode: string): Promise<boolean> {
	if (mode === 'free' || isReadOnlyTool(name)) {
		return true;
	}
	const command = typeof args.command === 'string' ? `\n\n${args.command}` : '';
	const choice = await vscode.window.showWarningMessage(`Backboard wants to run ${name}.${command}`, { modal: true }, 'Allow');
	return choice === 'Allow';
}

async function executeTool(bridge: BackboardBridge, name: string, args: Record<string, unknown>, response: ResponseSink, token: vscode.CancellationToken, toolKey?: string): Promise<string> {
	switch (name) {
		case 'read_file':
			return readFile(args);
		case 'list_dir':
			return listDir(args);
		case 'glob':
			return globFiles(args);
		case 'grep':
			return grepFiles(args);
		case 'codebase_search':
			return codebaseSearch(args);
		case 'web_search':
		case 'web_fetch':
		case 'computer':
			return asCompactJson(await bridge.runRustTool(name, args, token));
		case 'generate_image':
		case 'image_generate':
			return generateImageTool(args);
		case 'read_lints':
			return readLints(args, token);
		case 'write':
		case 'write_file':
		case 'create_file':
		case 'overwrite_file':
			return writeFileTool(name, args, response);
		case 'append_file':
			return appendFileTool(args, response);
		case 'edit':
		case 'edit_file':
		case 'search_replace':
```


### Rust runTool and execute_rust_tool start

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 528-579

```rust
fn list_tools(state: &BridgeState, request: &BridgeRequest) {
    let mode = request
        .params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    state.writer.emit(base_event(
        "tools",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "tools": tool_definitions(mode) }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
}

async fn run_tool(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let params: RunToolParams = serde_json::from_value(request.params.clone())?;
    let name = params.name.clone();
    state.writer.emit(base_event(
        "toolFinished",
        &request.request_id,
        request.session_id.as_deref(),
        json!({
            "status": "started",
            "name": name,
        }),
    ));
    let output = execute_rust_tool(&params.name, &params.args).await?;
    state.writer.emit(base_event(
        "toolFinished",
        &request.request_id,
        request.session_id.as_deref(),
        json!({
            "status": "finished",
            "name": params.name,
            "output": output,
        }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
    Ok(())
}

```


### Rust web_search and web_fetch start

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 2046-2115

```rust
async fn execute_rust_tool(name: &str, args: &Value) -> Result<Value> {
    match name {
        "web_search" => web_search(args).await,
        "web_fetch" => web_fetch(args).await,
        "computer" => Ok(json!({
            "success": false,
            "unsupported": true,
            "error": "The Backboard bridge does not support desktop automation yet."
        })),
        other => Ok(json!({
            "success": false,
            "unsupported": true,
            "error": format!("Tool `{other}` is executed by the host adapter, not the Rust network bridge.")
        })),
    }
}

async fn web_search(args: &Value) -> Result<Value> {
    let query = string_arg(args, &["query"]).context("web_search requires query")?;
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding::encode(&query)
    );
    let text = reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let data = serde_json::from_str::<Value>(&text)?;
    let mut results = Vec::new();
    if let Some(text) = data
        .get("AbstractText")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        results.push(json!({
            "title": data.get("Heading").and_then(Value::as_str).unwrap_or("DuckDuckGo result"),
            "url": data.get("AbstractURL").and_then(Value::as_str).unwrap_or_default(),
            "snippet": text,
        }));
    }
    if let Some(topics) = data.get("RelatedTopics").and_then(Value::as_array) {
        for topic in topics {
            collect_duckduckgo_topic(topic, &mut results);
            if results.len() >= 8 {
                break;
            }
        }
    }
    Ok(json!({
        "success": true,
        "query": query,
        "results": results,
    }))
}

async fn web_fetch(args: &Value) -> Result<Value> {
    let url =
        validate_web_fetch_url(&string_arg(args, &["url"]).context("web_fetch requires url")?)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
        .redirect_policy(reqwest::redirect::Policy::none())
        .build()?;
    let response = client.get(url.clone()).send().await?.error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = stream.next().await {
```


## 13. Models, Tools, And Usage Metadata

### Model Refresh Flow

```text
webview ready or refreshModels
  -> postPanelState(forceModelRefresh?)
  -> bridge.cachedModels()
  -> bridge.listModels(token, forceRefresh)
  -> TypeScript bridge.send('listModels')
  -> Rust list_models()
  -> BackboardClient.list_models() and list_providers()
  -> BackboardClient.list_models_by_provider(provider)
  -> Rust emits models event
  -> TypeScript writes models.json cache
  -> webview receives models
```

### Tool Refresh Flow

```text
webview ready or refreshModels
  -> postPanelState()
  -> bridge.cachedTools(mode)
  -> bridge.listTools(mode)
  -> TypeScript bridge.send('listTools')
  -> Rust list_tools()
  -> Rust tool_definitions(mode)
  -> Rust emits tools event
  -> TypeScript writes tools.json cache
  -> webview receives tools
```

### Cache Table

| Cache | Owner | TTL | Version | Fields |
|---|---|---:|---:|---|
| models.json | TypeScript globalStorageUri | 24h | 2 | env, fetchedAt, models. |
| tools.json | TypeScript globalStorageUri | 24h | 1 | env, mode, fetchedAt, tools. |


### TypeScript model/tool cache

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 5473-5608

```ts
	refreshModels(): void {
		void this.listModels(new vscode.CancellationTokenSource().token, true);
	}

	async cachedModels(): Promise<BridgeModel[] | undefined> {
		const entry = await this.readModelCache();
		return entry?.models;
	}

	async cachedTools(mode: string): Promise<unknown[] | undefined> {
		const entry = await this.readToolCache(mode);
		return entry?.tools;
	}

	async hasFreshPanelMetadata(mode: string): Promise<boolean> {
		const [modelCache, toolCache] = await Promise.all([this.readModelCache(), this.readToolCache(mode)]);
		const now = Date.now();
		return Boolean(
			modelCache && now - modelCache.fetchedAt < BackboardBridge.modelCacheTtl
			&& toolCache && now - toolCache.fetchedAt < BackboardBridge.toolCacheTtl
		);
	}

	async listModels(token: vscode.CancellationToken, forceRefresh = false): Promise<BridgeModel[]> {
		const cached = await this.readModelCache();
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.modelCacheTtl) {
			return cached.models;
		}
		if (this.pendingModelRefresh) {
			return this.pendingModelRefresh;
		}
		this.pendingModelRefresh = this.fetchAndCacheModels(token);
		try {
			return await this.pendingModelRefresh;
		} finally {
			this.pendingModelRefresh = undefined;
		}
	}

	private async fetchAndCacheModels(token: vscode.CancellationToken): Promise<BridgeModel[]> {
		const events = await this.send('listModels', undefined, { config: readSettings().config }, undefined, token);
		const models = (events.find(event => event.type === 'models')?.models ?? []).filter(isVisibleBridgeModel);
		await this.writeModelCache(models);
		return models;
	}

	private modelCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'models.json');
	}

	private async readModelCache(): Promise<ModelCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.modelCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.modelCacheVersion || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
				return undefined;
			}
			return { env, version: parsed.version, fetchedAt: parsed.fetchedAt, models: parsed.models.filter(isBridgeModel).filter(isVisibleBridgeModel) };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeModelCache(models: BridgeModel[]): Promise<void> {
		const cachePath = this.modelCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `models.${process.pid}.${Date.now()}.tmp`);
		const entry: ModelCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.modelCacheVersion,
			fetchedAt: Date.now(),
			models: models.filter(isBridgeModel).filter(isVisibleBridgeModel)
		};
		await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, undefined, '\t')}\n`, 'utf8');
		await fs.promises.rename(tempPath, cachePath);
	}

	async listTools(mode: string, token: vscode.CancellationToken, forceRefresh = false): Promise<unknown[]> {
		const cached = await this.readToolCache(mode);
		if (!forceRefresh && cached && Date.now() - cached.fetchedAt < BackboardBridge.toolCacheTtl) {
			return cached.tools;
		}
		const pending = this.pendingToolRefreshes.get(mode);
		if (pending) {
			return pending;
		}
		const refresh = this.fetchAndCacheTools(mode, token);
		this.pendingToolRefreshes.set(mode, refresh);
		try {
			return await refresh;
		} finally {
			this.pendingToolRefreshes.delete(mode);
		}
	}

	private async fetchAndCacheTools(mode: string, token: vscode.CancellationToken): Promise<unknown[]> {
		const events = await this.send('listTools', undefined, { mode }, undefined, token);
		const tools = events.find(event => event.type === 'tools')?.tools ?? [];
		await this.writeToolCache(mode, tools);
		return tools;
	}

	private toolCachePath(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'tools.json');
	}

	private async readToolCache(mode: string): Promise<ToolCacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(this.toolCachePath(), 'utf8'));
			const env = isObjectRecord(parsed) ? stringValueFromRecord(parsed.env) : undefined;
			if (!isObjectRecord(parsed) || env !== currentBackboardEnv() || parsed.version !== BackboardBridge.toolCacheVersion || parsed.mode !== mode || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.tools)) {
				return undefined;
			}
			return { env, version: parsed.version, mode, fetchedAt: parsed.fetchedAt, tools: parsed.tools };
		} catch (error) {
			if (isFileNotFoundError(error) || error instanceof SyntaxError) {
				return undefined;
			}
			throw error;
		}
	}

	private async writeToolCache(mode: string, tools: unknown[]): Promise<void> {
		const cachePath = this.toolCachePath();
		await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
		const tempPath = path.join(path.dirname(cachePath), `tools.${process.pid}.${Date.now()}.tmp`);
		const entry: ToolCacheEntry = {
			env: currentBackboardEnv(),
			version: BackboardBridge.toolCacheVersion,
			mode,
			fetchedAt: Date.now(),
			tools
		};
```


### Rust list_models/list_tools

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/rust/backboard_bridge/src/main.rs` lines 413-560

```rust
async fn list_models(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let config = serde_json::from_value::<ConfigParams>(
        request.params.get("config").cloned().unwrap_or_default(),
    )
    .unwrap_or(ConfigParams {
        env: None,
        api_url: None,
        access_token: None,
    });
    let provider = request
        .params
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let client = client_from_params(Some(&config))?;
    let models = collect_models(&client, provider.as_deref()).await?;
    state.writer.emit(base_event(
        "models",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "models": models }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
    Ok(())
}

async fn collect_models(
    client: &BackboardClient,
    provider: Option<&str>,
) -> Result<Vec<BridgeModel>> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();

    if let Some(provider) = provider {
        if !is_featherless_provider(provider) {
            add_visible_models(
                &mut models,
                &mut seen,
                client.list_models_by_provider(provider, None).await?,
            );
        }
        return Ok(models);
    }

    let (base_models, providers) = futures::join!(
        client.list_models(None, Some("llm"), None),
        client.list_providers(),
    );
    add_visible_models(&mut models, &mut seen, base_models?);

    let provider_names = providers
        .unwrap_or_default()
        .into_iter()
        .filter(|provider| !is_featherless_provider(provider))
        .collect::<Vec<_>>();
    let provider_concurrency = provider_names.len().max(1);
    let provider_results = stream::iter(
        provider_names
            .into_iter()
            .map(|provider| async move { client.list_models_by_provider(&provider, None).await }),
    )
    .buffer_unordered(provider_concurrency)
    .collect::<Vec<_>>()
    .await;

    for provider_models in provider_results {
        add_visible_models(&mut models, &mut seen, provider_models?);
    }

    Ok(models)
}

fn add_visible_models(
    models: &mut Vec<BridgeModel>,
    seen: &mut HashSet<(String, String)>,
    items: Vec<BackboardModel>,
) {
    for model in items.into_iter().filter(model_is_visible) {
        let key = model_key(&model);
        if seen.insert(key) {
            models.push(to_bridge_model(model));
        }
    }
}

fn model_is_visible(model: &BackboardModel) -> bool {
    !model.name.trim().is_empty()
        && !is_featherless_provider(&model.provider)
        && model
            .model_type
            .as_deref()
            .map(|model_type| model_type.eq_ignore_ascii_case("llm"))
            .unwrap_or(true)
}

fn is_featherless_provider(provider: &str) -> bool {
    normalized_provider_key(provider) == "featherless"
}

fn normalized_provider_key(provider: &str) -> String {
    provider.trim().to_lowercase().replace('_', "-")
}

fn model_key(model: &BackboardModel) -> (String, String) {
    (
        normalized_provider_key(&model.provider),
        model.name.trim().to_lowercase(),
    )
}

fn list_tools(state: &BridgeState, request: &BridgeRequest) {
    let mode = request
        .params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    state.writer.emit(base_event(
        "tools",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "tools": tool_definitions(mode) }),
    ));
    state.writer.emit(base_event(
        "done",
        &request.request_id,
        request.session_id.as_deref(),
        json!({ "stopReason": "end_turn" }),
    ));
}

async fn run_tool(state: BridgeState, request: BridgeRequest) -> Result<()> {
    let params: RunToolParams = serde_json::from_value(request.params.clone())?;
    let name = params.name.clone();
    state.writer.emit(base_event(
        "toolFinished",
        &request.request_id,
        request.session_id.as_deref(),
        json!({
            "status": "started",
            "name": name,
        }),
    ));
    let output = execute_rust_tool(&params.name, &params.args).await?;
```


### Panel metadata and usage snapshot posting

Source: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/src/extension.ts` lines 6659-6718

```ts
async function postPanelState(bridge: BackboardBridge, webview: vscode.Webview, forceModelRefresh = false): Promise<void> {
	const settings = readSettings();
	await webview.postMessage({ type: 'settings', settings: publicSettings(settings), workspace: workspacePath() });
	const cachedModels = forceModelRefresh ? undefined : await bridge.cachedModels();
	const cachedTools = forceModelRefresh ? undefined : await bridge.cachedTools(settings.mode);
	if (cachedModels) {
		await webview.postMessage({ type: 'models', models: cachedModels });
	}
	if (cachedTools) {
		await webview.postMessage({ type: 'tools', tools: cachedTools });
	}
	if (cachedModels && cachedTools && !forceModelRefresh && await bridge.hasFreshPanelMetadata(settings.mode)) {
		await webview.postMessage({ type: 'status', text: 'Ready.' });
		return;
	}
	try {
		await webview.postMessage({ type: 'status', text: cachedModels && !forceModelRefresh ? 'Checking Backboard models.' : 'Loading Backboard models.' });
		const models = await bridge.listModels(new vscode.CancellationTokenSource().token, forceModelRefresh);
		await webview.postMessage({ type: 'models', models });
		await webview.postMessage({ type: 'status', text: 'Ready.' });
	} catch (error) {
		const cachedModels = await bridge.cachedModels();
		if (cachedModels) {
			await webview.postMessage({ type: 'models', models: cachedModels });
			await webview.postMessage({ type: 'status', text: 'Using cached Backboard models.' });
		} else {
				await webview.postMessage({ type: 'append', role: 'error', text: error instanceof Error ? error.message : String(error) });
				if (isBackboardAuthError(error)) {
					await webview.postMessage({ type: 'status', text: 'Sign in with Backboard SSO to load models.' });
				} else {
					await webview.postMessage({ type: 'status', text: 'Could not load models.' });
				}
		}
	}
	try {
		const tools = await bridge.listTools(settings.mode, new vscode.CancellationTokenSource().token, forceModelRefresh);
		await webview.postMessage({ type: 'tools', tools });
	} catch {
		await webview.postMessage({ type: 'tools', tools: cachedTools ?? [] });
	}
}

async function postUsageSnapshot(bridge: BackboardBridge, webview: vscode.Webview): Promise<void> {
	const tokenSource = new vscode.CancellationTokenSource();
	try {
		const [balance, summary, recent] = await Promise.all([
			bridge.callApi('getBillingBalance', {}, tokenSource.token),
			bridge.callApi('getUsageSummary', { query: { range: 'period' } }, tokenSource.token),
			bridge.callApi('getRecentUsage', { query: { page: 1, pageSize: 20 } }, tokenSource.token)
		]);
		await webview.postMessage({ type: 'usageSnapshot', payload: { balance, summary, recent } });
	} catch (error) {
		await webview.postMessage({ type: 'status', text: error instanceof Error ? error.message : String(error) });
	} finally {
		tokenSource.dispose();
	}
}

async function postComposerContext(webview: vscode.Webview, kind: 'activeFile' | 'selection'): Promise<void> {
	const editor = vscode.window.activeTextEditor;
```


## 14. Usage And Billing Endpoints

The panel usage refresh fans out to three direct Rust API commands:

```text
refreshUsage webview message
  -> postUsageSnapshot()
  -> bridge.callApi('getBillingBalance', {})
  -> bridge.callApi('getUsageSummary', { query: { range: 'period' } })
  -> bridge.callApi('getRecentUsage', { query: { page: 1, pageSize: 20 } })
  -> Rust call_api_endpoint()
  -> BackboardClient billing methods
  -> apiResponse events
  -> webview usageSnapshot message
```

| Bridge command | HTTP route | Query fields |
|---|---|---|
| getBillingBalance | GET /billing/balance | none. |
| getUsageSummary | GET /billing/usage/summary | range. |
| getRecentUsage | GET /billing/usage/recent | page, page_size, model, input_tokens, output_tokens, start, end, credit_type, sort_by, sort_order. |

Rust accepts camelCase and snake_case aliases for recent usage query fields, including pageSize/page_size, inputTokens/input_tokens, outputTokens/output_tokens, sortBy/sort_by, and sortOrder/sort_order.

## 15. OAuth And Credentials

OAuth is TypeScript-owned because it needs VS Code URI handling, browser opening, local HTTP callback listening, manual callback input, and user-facing prompts. Rust consumes the resulting config/auth.

### OAuth Constants

| Constant | Value or role |
|---|---|
| backboardOAuthAuthorizeUrl | https://app.backboard.io/api/oauth/authorize |
| backboardOAuthTokenUrl | https://app.backboard.io/api/oauth/token |
| backboardOAuthClientId | Backboard OAuth client id embedded in extension.ts. |
| defaultBackboardOAuthRedirectUri | http://127.0.0.1:49321/auth/callback |
| backboardOAuthScope | openid email profile |

### OAuth Sequence

```text
backboard.extension.signIn or webview signIn
  -> promptBackboardSso()
  -> signInBackboard()
  -> create PKCE verifier/challenge
  -> open Backboard authorize URL
  -> receive local callback or manual callback
  -> exchangeBackboardOAuthCode()
  -> saveBackboardOAuthTokens()
  -> updateBackboardAuthContext()
  -> postPanelState(..., forceModelRefresh=true)
```

## 16. Error Handling And Cancellation

| Failure | TypeScript behavior | Rust behavior | Panel result |
|---|---|---|---|
| Webview cancel | Cancels run token. | Receives cancel command for request id. | runFinished/status Cancelled. |
| Bridge inactivity | Timeout rejects pending and kills child for commands with timeout. | N/A. | Error appended. |
| sendPrompt stream idle | TypeScript has no inactivity timeout. | Rust tries upstream idle recovery once. | Progress/recovery or done. |
| submitToolResult duplicate | N/A. | Emits duplicate/stale completion events. | Continuation stops cleanly. |
| Child process error | Rejects all pending requests. | Process exited. | Next call respawns child. |
| Invalid Rust stdout JSON | TypeScript logs raw line and ignores it. | N/A. | Pending request does not resolve from that line. |
| Invalid TypeScript stdin JSON | N/A. | Rust emits error with null requestId. | Diagnostic only. |
| Missing bridge binary | ensureProcess throws build command. | N/A. | User-visible error. |
| Missing auth | Rust returns MissingAuth/MissingApiKey. | Emits error. | Panel asks sign-in/load models. |

## 17. Real Backboard HTTP Route Reference

| Area | Method/path | Used by |
|---|---|---|
| Assistants | GET /assistants | listAssistants. |
| Assistants | POST /assistants | createAssistant. |
| Assistants | GET /assistants/{assistant_id} | getAssistant. |
| Assistants | PUT /assistants/{assistant_id} | updateAssistant. |
| Assistants | DELETE /assistants/{assistant_id} | deleteAssistant. |
| Assistant threads | POST /assistants/{assistant_id}/threads | createAssistantThread/create_thread. |
| Assistant threads | GET /assistants/{assistant_id}/threads | listAssistantThreads. |
| Assistant documents | GET /assistants/{assistant_id}/documents | listAssistantDocuments. |
| Assistant documents | POST /assistants/{assistant_id}/documents | uploadAssistantDocument. |
| Threads | GET /threads | listThreads. |
| Threads | GET /threads/{thread_id} | getThread. |
| Threads | DELETE /threads/{thread_id} | deleteThread. |
| Messages | POST /threads/messages | sendMessage and sendPrompt streaming. |
| Realtime voice | WS(S) /threads/messages?api_key=... | Reference in bridge docs. |
| Tool outputs simple | POST /threads/tool-outputs | submitToolOutputsSimple. |
| Legacy thread messages | POST /threads/{thread_id}/messages | addThreadMessage. |
| Legacy tool outputs | POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs | submit_tool_outputs. |
| Streaming tool outputs | POST /threads/{thread_id}/runs/{run_id}/submit-tool-outputs?stream=true | submitToolResult. |
| Cancel run | POST /threads/{thread_id}/runs/{run_id}/cancel | cancel_run. |
| Thread documents | GET /threads/{thread_id}/documents | listThreadDocuments. |
| Thread documents | POST /threads/{thread_id}/documents | uploadThreadDocument. |
| Documents | GET /documents/{document_id}/status | getDocumentStatus. |
| Documents | DELETE /documents/{document_id} | deleteDocument. |
| Models | GET /models | listModels. |
| Models | GET /models/{model_name} | getModel. |
| Providers | GET /models/providers | listProviders. |
| Provider models | GET /models/provider/{provider_name} | listModelsByProvider. |
| Embeddings | GET /models/embedding/all | listEmbeddingModels. |
| Embeddings | GET /models/embedding/providers | listEmbeddingProviders. |
| Embeddings | GET /models/embedding/{model_name} | getEmbeddingModel. |
| Billing | GET /billing/balance | getBillingBalance. |
| Billing | GET /billing/usage/recent | getRecentUsage. |
| Billing | GET /billing/usage/summary | getUsageSummary. |
| OAuth | GET /oauth/authorize | TypeScript sign-in. |
| OAuth | POST /oauth/token | TypeScript token exchange. |
| OAuth | GET /oauth/userinfo | API reference in Rust bridge. |
| OAuth | POST /oauth/revoke | API reference in Rust bridge. |

## 18. Bridge Concepts That Are Easy To Mix Up

| Concept | Correct interpretation |
|---|---|
| BackboardPanelProvider | TypeScript object that bridges webview messages into VS Code and BackboardBridge actions. |
| BackboardBridge | TypeScript object that spawns and speaks JSONL with the Rust bridge binary. |
| backboard_bridge | Rust binary that dispatches bridge commands and emits JSON events. |
| backboard crate | Rust library that performs actual HTTP calls. |
| listTools | Local Rust schema generation, not Backboard HTTP. |
| runTool | Rust-owned local/network tool execution, not the whole tool system. |
| sendPrompt | Streaming Backboard message turn. |
| submitToolResult | Continuation after the IDE executes tool calls. |
| callApi | TypeScript helper for direct bridge API commands that return apiResponse. |
| postPanelState | TypeScript UI hydration path for settings/models/tools/status. |

## 19. Adding A New Endpoint

When adding a new Backboard endpoint, update the layers in order:

1. Add BackboardClient method in the Rust client library.
2. Add the command string to is_api_command() if it should be callable as a direct bridge API command.
3. Add a match arm in call_api_endpoint().
4. Add any required request fields to ApiEndpointParams.
5. Add a TypeScript helper only if bridge.callApi() is not sufficient.
6. Add a webview message only if the panel triggers it directly.
7. Add a VS Code command only if the endpoint is user-invokable from command palette/menu.
8. Add settings only if user configuration is needed.
9. Add auth error handling and status text.
10. Update endpoint docs and tests.

## 20. Debugging Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'

# Find command registrations, webview messages, bridge calls.
rg -n "registerCommand|onDidReceiveMessage|vscode.postMessage|postMessage|BackboardBridge|bridge\.send|callApi" extensions/backboard/src/extension.ts extensions/backboard/package.json

# Find Rust bridge command dispatch and API mapping.
rg -n "handle_request|is_api_command|call_api_endpoint|send_prompt|submit_tool_result|execute_rust_tool" extensions/backboard/rust/backboard_bridge/src/main.rs

# Find real HTTP route methods.
rg -n "pub async fn|/assistants|/threads|/models|/billing|/documents|oauth" extensions/backboard/rust/backboard/src/backboard.rs extensions/backboard/rust/backboard/src/endpoints

# Build the Rust bridge binary used by TypeScript.
npm --prefix extensions/backboard run build-bridge
```
