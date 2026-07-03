# How API Calls Are Sent from the Right Panel

The "right panel" of the Backboard IDE is two related things:

1. **The right workbench / auxiliary bar** (`src/vs/sessions/contrib/rightWorkbench/`,
   `src/vs/sessions/browser/parts/auxiliaryBarPart.ts`) — the shell hosting the Launcher,
   Review, Files, Browser and Terminal tabs.
2. **The session chat composer** rendered inside the sessions window — where messages are
   actually typed and sent.

This document traces a message from the send button all the way to the network.

## End-to-end flow

```
 USER PRESSES SEND
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. UI: newChatInSessionWidget.ts                                │
│    src/vs/sessions/contrib/chat/browser/newChatInSessionWidget.ts│
│    :93   submitHandler → _sendFromSharedComposer(query)         │
│    :183  collects model id, mode info, enabled tools            │
│    :175  sessionsManagementService.sendRequest(session, chat, o)│
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. SESSIONS MANAGEMENT                                          │
│    src/vs/sessions/services/sessions/browser/                   │
│      sessionsManagementService.ts                               │
│    :451-481 sendRequest()                                       │
│      :461 fire _onWillSendRequest                               │
│      :463 provider = _getProvider(session)                      │
│      :472 provider.sendRequest(sessionId, chat.resource, opts)  │
│      :480 fire _onDidSendRequest                                │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. SESSION PROVIDER (per session type)                          │
│    src/vs/sessions/contrib/providers/…                          │
│    ├─ agentHost/browser/baseAgentHostSessionsProvider.ts        │
│    │    (AgentHostSessionAdapter → _chatService.sendRequest)    │
│    ├─ copilotChatSessions/browser/copilotChatSessionsProvider.ts│
│    └─ localChatSessions/browser/localChatSessionsProvider.ts    │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. CHAT SERVICE (upstream workbench)                            │
│    src/vs/workbench/contrib/chat/common/chatService/            │
│      chatServiceImpl.ts                                         │
│    :935  sendRequest(sessionResource, request, options)         │
│    :1020 parseChatRequest()                                     │
│    :1030 _sendRequestAsync()   ← returns immediately            │
│          → ChatSendResult: 'sent' | 'rejected' | 'queued'       │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. TRANSPORT: agent-host protocol over WebSocket                │
│    src/vs/platform/agentHost/browser/                           │
│    ├─ remoteAgentHostProtocolClient.ts:158                      │
│    │    RemoteAgentHostProtocolClient (IAgentConnection)        │
│    │    routes ActionEnvelopes, sends `initialize` on connect   │
│    └─ webSocketClientTransport.ts                               │
│         :65-170 connect()  ws(s)://host?connectionToken=<UUID>  │
│         :178    send()     JSON.stringify(ProtocolMessage)      │
│         :111    message → JSON.parse → _onMessage               │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
                 Agent host process (node)
                 ├─ local:  in-process IAgentHostService, which for
                 │          Backboard sessions drives backboardAgent.ts
                 │          → spawns the Rust bridge (see doc 04)
                 └─ remote: tunneled/remote agent host over wss://
                            ▼
                 Backboard API (https://app.backboard.io/api)
```

## Layer-by-layer details

### 1. UI layer

`newChatInSessionWidget.ts` builds the composer using the shared upstream `ChatWidget`.
`ISendRequestOptions` (declared around line 23) carries:

```ts
interface ISendRequestOptions {
	query: string;
	attachments?: IChatRequestVariableEntry[];
	userSelectedModelId?: string;
	userSelectedModelConfiguration?: IStringDictionary<unknown>;
	modeInfo?: IChatRequestModeInfo;                  // ask / agent mode
	instructionContext?: { modeKind; enabledTools?; enabledSubAgents? };
	background?: boolean;                             // fire-and-forget
	agentHostSessionConfig?: Record<string, unknown>; // agent-specific config
}
```

### 2. Sessions management

`sessionsManagementService.ts:451` is the single funnel for all outgoing chat requests. It only
does bookkeeping (events, provider lookup) — the provider decides what the network actually
looks like. This is what makes the right panel transport-agnostic.

### 3. Providers

| Provider | File | Transport |
|---|---|---|
| Local agent host | `providers/agentHost/browser/localAgentHostSessionsProvider.ts` | in-process `IAgentHostService` → Backboard agent → Rust bridge (stdio) → HTTPS |
| Remote agent host | `providers/remoteAgentHost/browser/remoteAgentHostSessionsProvider.ts` | WebSocket (`wss://`) to a tunneled agent host |
| Copilot chat sessions | `providers/copilotChatSessions/browser/copilotChatSessionsProvider.ts` | extension host → Copilot CLI SDK / cloud |
| Local chat | `providers/localChatSessions/browser/localChatSessionsProvider.ts` | in-process VS Code chat, no background agent |

### 4. Chat service

The upstream `ChatService` (`chatServiceImpl.ts:935`) parses the request, resolves the chat
model, and kicks off `_sendRequestAsync()` (`:1083`), which streams `IChatProgress` items back
into the model via a progress callback. Result type:

```ts
type ChatSendResult =
	| { kind: 'sent'; data: IChatSendRequestData; newSessionResource?: URI }
	| { kind: 'rejected'; reason: string }
	| { kind: 'queued'; deferred: Promise<ChatSendResult> };
```

### 5. WebSocket transport

`webSocketClientTransport.ts`:

- **URL construction** (`:72-79`): address is used verbatim if it starts with `ws://`/`wss://`,
  otherwise prefixed with `ws://`; a `?connectionToken=<UUID>` query parameter authenticates
  the connection.
- **Send** (`:178-195`): checks `readyState === OPEN`, `JSON.stringify(message)`, native
  `ws.send(text)`. Optional AHP logger records `c2s`/`s2c` traffic.
- **Receive** (`:111-151`): parses each frame as JSON and fires `_onMessage`.

`remoteAgentHostProtocolClient.ts:158` wraps the transport with the agent-host protocol:
it sends `initialize` on connect, correlates requests, and decodes `ActionEnvelope`s that it
routes to session listeners.

## Response streaming back into the panel

Responses do not come back as a single payload. The agent host emits protocol messages that are
translated into `IChatProgress` items appended to the live chat model:

```
  WebSocket frame ──► ProtocolMessage ──► ActionEnvelope ──► IChatProgress[]
                                                              │
      { kind: 'markdownContent', content }   text chunks ◄────┤
      { kind: 'treeData', … }                file trees  ◄────┤
      { kind: 'usage', promptTokens, … }     token stats ◄────┤
      { kind: 'reference', … }               code refs   ◄────┘
                             │
                             ▼
              chat model observables mutate
                             │
                             ▼
        ChatListRenderer re-renders affected rows (see doc 06)
```

## Endpoints & configuration

- Agent host addresses come from the `agentHost.addresses` setting (default dev value
  `localhost:3000`); format `ws://host:port` or `wss://host:443`.
- Remote agent hosts are resolved by `remoteAgentHostSessionsProvider.ts` (SSH tunnels /
  WebSocket proxies).
- For Backboard-native sessions the actual LLM traffic goes through the Rust bridge to
  `https://app.backboard.io/api` — see [04-rust-typescript-bridge.md](04-rust-typescript-bridge.md).
