# How a Chat Request Is Sent from the Right Panel

The "right panel" is two things: the **auxiliary-bar shell** that hosts the Launcher/Review/Files/
Browser/Terminal tabs (documented separately in [08-right-workbench-tabs.md](08-right-workbench-tabs.md)),
and the **chat composer** where messages are typed. This doc traces a message from the send button
all the way to the network, then the streamed response back. Seven layers.

## Layer map

```
┌─ 1. COMPOSER ─────────────────────────────────────────────────────────────┐
│ NewChatInSessionWidget  (sessions/contrib/chat/browser/newChatInSessionWidget.ts)│
│   ChatWidget submitHandler → _sendFromSharedComposer(query)   :93, :183    │
│     builds ISendRequestOptions from the live input part       :194-205     │
│     → _send(options)                                          :168-181     │
└──────────────────────────────┬─────────────────────────────────────────────┘
              sessionsManagementService.sendRequest(session, chat, options)
┌─ 2. MANAGEMENT FUNNEL ───────▼─────────────────────────────────────────────┐
│ SessionsManagementService.sendRequest()   (services/sessions/browser/…)  :451│
│   discardNewSession() · _onWillSendRequest.fire(session)     :454,:461      │
│   provider = _getProvider(session)                           :463          │
│   _pendingSendChatResources.add(key)   ← dedupe guard        :469          │
│   updated = await provider.sendRequest(id, chat.resource, o) :472          │
│   _onDidSendRequest.fire({...})                              :480          │
└──────────────────────────────┬─────────────────────────────────────────────┘
              provider.sendRequest(sessionId, chatResource, options)
┌─ 3. SESSION PROVIDER ────────▼─────────────────────────────────────────────┐
│ BaseAgentHostSessionsProvider.sendRequest()  (contrib/providers/agentHost/…) :2186│
│   builds IChatSendRequestOptions `sendOptions`               :2213-2241    │
│     agentIdSilent = contribution.type  ← routes to AgentHost chat agent    │
│   result = await _chatService.sendRequest(chatResource, query, sendOptions):2275│
│   _waitForNewSession() → newSession.graduate() → _onDidReplaceSession       │
│  (local & remote subclasses differ ONLY by the `connection` accessor)      │
└──────────────────────────────┬─────────────────────────────────────────────┘
              chatService.sendRequest(resource, request, options)
┌─ 4. CHAT SERVICE (upstream) ─▼─────────────────────────────────────────────┐
│ ChatServiceImpl.sendRequest()  (workbench/contrib/chat/common/chatService/…) :935│
│   parseChatRequest() :1044 · _sendRequestAsync() :1083                      │
│   returns ChatSendResult { kind:'sent'|'rejected'|'queued' } :1026          │
│   invokeAgent(agent.id, props, progressCallback, history, token) :1422      │
└──────────────────────────────┬─────────────────────────────────────────────┘
              AgentHostSessionHandler._invokeAgent → connection.dispatch(...)
┌─ 5. AGENT-HOST HANDLER ──────▼─────────────────────────────────────────────┐
│ agentSessions/agentHost/agentHostSessionHandler.ts                          │
│   ChatTurnStartedAction { turnId, message } → connection.dispatch()  :1328  │
│   "server calls sendMessage on the provider as a side effect"       :1326  │
└──────────────────────────────┬─────────────────────────────────────────────┘
              JSON-RPC (remote) / direct method call (local)
┌─ 6. PROTOCOL CLIENT ─────────▼─────────────────────────────────────────────┐
│ RemoteAgentHostProtocolClient  (platform/agentHost/browser/…)               │
│   _dispatchRequest(): {jsonrpc:'2.0',id,method,params} → transport.send :1284│
│   (LOCAL sessions: IAgentHostService IS the in-process IAgentConnection —   │
│    layers 6 & 7 are bypassed, dispatch is a direct call)                    │
└──────────────────────────────┬─────────────────────────────────────────────┘
              transport.send(JSON.stringify(message))
┌─ 7. WEBSOCKET TRANSPORT ─────▼─────────────────────────────────────────────┐
│ WebSocketClientTransport  (platform/agentHost/browser/webSocketClientTransport.ts)│
│   url = ws://<address>?tkn=<connectionToken>            :72-79              │
│   ws.send(JSON.stringify(message))   (only if OPEN)     :178-182           │
└─────────────────────────────────────────────────────────────────────────────┘
              ▲ s2c 'action' notifications → observables → renderer re-render
```

## Layer 1 — Composer: `NewChatInSessionWidget`

`src/vs/sessions/contrib/chat/browser/newChatInSessionWidget.ts` wraps an upstream `ChatWidget`
and routes its `submitHandler` (`:93`) into `_sendFromSharedComposer(query)` (`:183-210`). That
method reads the live input part, pushes the selected model onto the provider, and assembles the
options (`:194-205`):

```ts
const sent = await this._send({
    query,
    attachedContext: input.getAttachedAndImplicitContext().asArray(),
    userSelectedModelId: input.currentLanguageModel,
    userSelectedModelConfiguration: input.currentLanguageModel
        ? input.getModelConfiguration(input.currentLanguageModel) : undefined,
    modeInfo: input.currentModeInfo,
    instructionContext: {
        modeKind,
        enabledTools:     modeKind === ChatModeKind.Agent ? input.selectedToolsModel.userSelectedTools.get() : undefined,
        enabledSubAgents: modeKind === ChatModeKind.Agent ? input.currentModeObs.get().agents?.get()        : undefined,
    },
});
if (sent) { input.acceptInput(true); }   // composer only clears after a successful send
```

`submitHandler` always returns `true` (`:209`) so the upstream widget does **not** run its own
default submit — sending is fully delegated to Backboard. `_send(options)` (`:168-181`) resolves the
active session + chat and funnels into the management service (`:175`); errors are logged and return
`false` (which is why the composer isn't cleared on failure).

### `ISendRequestOptions` (verbatim)

`src/vs/sessions/services/sessions/common/sessionsProvider.ts:27-40`:

```ts
export interface ISendRequestOptions {
    readonly query: string;
    readonly attachedContext?: IChatRequestVariableEntry[];
    readonly userSelectedModelId?: string;
    readonly userSelectedModelConfiguration?: IChatSendRequestOptions['userSelectedModelConfiguration'];
    readonly modeInfo?: IChatRequestModeInfo;                 // ask / agent, permission, instructions
    readonly instructionContext?: IChatSendRequestOptions['instructionContext']; // enabled tools/subagents
}
```

> Note: there is **no `background` field** on this interface. The fire-and-forget path lives on a
> different method (`sendNewChatRequest`, below), not on the composer's `sendRequest` path.

## Layer 2 — The funnel: `SessionsManagementService`

`src/vs/sessions/services/sessions/browser/sessionsManagementService.ts` — the single point every
outgoing chat request passes through. `sendRequest(session, chat, options)` (`:451-481`):

1. `discardNewSession()` (`:454`) — abandon any in-progress new-session draft.
2. `_onWillSendRequest.fire(session)` (`:461`).
3. `provider = _getProvider(session)` by `p.id === session.providerId` (`:463`, `:485`).
4. Dedupe guard: `_pendingSendChatResources.add(key)` (`:469`) → `await provider.sendRequest(...)`
   (`:472`) → cleared in `finally`.
5. `_onDidSendRequest.fire({ session, chat, isNewSession:false, isNewChat, options })` (`:480`).

**Event-ordering subtlety:** `provider.sendRequest` calls into `_chatService.sendRequest`, which
fires `chatService.onDidSubmitRequest` **synchronously**. The service subscribes to that (`:93-107`)
to mirror *follow-up* requests onto `onDidSendRequest`, but skips any resource currently in
`_pendingSendChatResources` (`:94-96`) so an explicitly-initiated send isn't double-counted. Mirror
and explicit-fire are mutually exclusive per resource.

**Background / fire-and-forget** lives in `sendNewChatRequest` (`:331-380`) +
`_sendNewChatRequestInBackground` (`:427-449`): when `options.background` is truthy (`:343`) the send
runs detached, the composer resets immediately, and a stranded draft is disposed via
`provider.deleteNewSession` on failure. `createAndSendNewChatRequest` (`:396-409`) creates a fresh
session purely for one request without navigating into it.

## Layer 3 — Provider: `BaseAgentHostSessionsProvider`

`src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`. `sendRequest`
(`:2186-2350`) is implemented **once** on the base; the local/remote subclasses only override the
`connection` accessor and the not-connected error message. It builds an upstream
`IChatSendRequestOptions` (`:2213-2241`):

```ts
const sendOptions: IChatSendRequestOptions = {
    location: ChatAgentLocation.Chat,
    userSelectedModelId: selectedModelId,
    userSelectedModelConfiguration: options.userSelectedModelConfiguration,
    modeInfo: options.modeInfo ?? {/* Agent mode default */},
    agentIdSilent: contribution?.type,          // ← binds the request to the AgentHost chat agent
    attachedContext,
    instructionContext: options.instructionContext,
    agentHostSessionConfig: this.getCreateSessionConfig(chatId),
};
```

Then `const result = await this._chatService.sendRequest(chatResource, query, sendOptions)` (`:2275`).
Afterward it waits for the *committed backend session* via `_waitForNewSession()` and calls
`newSession.graduate()` (`:2298`/`:2322`), firing `_onDidReplaceSession` (`:2330`) to swap the
skeleton for the real session. **This is different from response completion** — `sendRequest`
returns once the backend session is committed, not when the answer finishes streaming.

- **Local** (`localAgentHostSessionsProvider.ts:154`): `connection` is `this._agentHostService`, the
  in-process `IAgentConnection`. No socket.
- **Remote** (`remoteAgentHostSessionsProvider.ts:271`): `connection` is the wired
  `RemoteAgentHostProtocolClient`; `setConnection` (`:380`) attaches the live client.

## Layer 4 — `ChatServiceImpl.sendRequest` (upstream)

`src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:935-1038`:

- Empty message → `{ kind:'rejected', reason:'Empty message' }` (`:939`).
- Untitled contributed sessions are materialized to a real resource before dispatch (`:956-988`).
- Queue/pending handling (`:991-1002`): `options.queue` → `{ kind:'queued' }`; already-pending →
  `{ kind:'rejected', reason:'Request already in progress' }`.
- `parseChatRequest` (`:1044`) resolves the silent agent for `agentIdSilent` and runs
  `ChatRequestParser.parseChatRequest`.
- Returns `{ kind:'sent', data, newSessionResource? }` as soon as the request is **accepted**
  (`:1026`) — completion is `data.responseCompletePromise`.
- `_sendRequestAsync` (`:1083`) creates the `ChatRequestModel`, defines the `progressCallback`
  (`:1116-1141`), and invokes the agent: `chatAgentService.invokeAgent(agent.id, props, progressCallback, history, token)` (`:1422`).

### `ChatSendResult` (verbatim)

`src/vs/workbench/contrib/chat/common/chatService/chatService.ts:1522-1546`:

```ts
export type ChatSendResult = ChatSendResultRejected | ChatSendResultSent | ChatSendResultQueued;

export interface ChatSendResultRejected { readonly kind: 'rejected'; readonly reason: string; }
export interface ChatSendResultSent {
    readonly kind: 'sent';
    readonly data: IChatSendRequestData;
    readonly newSessionResource?: URI;   // set when untitled → real contributed session
}
export interface ChatSendResultQueued {
    readonly kind: 'queued';
    readonly deferred: Promise<ChatSendResult>;   // resolves to 'sent' | 'rejected'
}
```

## Layer 5 — Agent-host handler

`src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts`.
`invokeAgent` reaches `_invokeAgent` (`:821`), which converts the turn into a protocol action
(`:1328`):

```ts
const turnAction: ChatTurnStartedAction = {
    type: ActionType.ChatTurnStarted, turnId, message: userOriginMessage(request.message, attachments),
};
this._config.connection.dispatch(session.toString(), turnAction);   // server calls sendMessage as a side effect
```

It then installs an observable graph and awaits terminal turn state (`:1341-1346`), emitting progress
through the `progressCallback` from Layer 4.

## Layer 6 — `RemoteAgentHostProtocolClient` (JSON-RPC)

`src/vs/platform/agentHost/browser/remoteAgentHostProtocolClient.ts`:

- **Connect handshake** (`:389-422`): opens the transport, sends `initialize` with
  `{ channel: ROOT_STATE_URI, protocolVersions:[PROTOCOL_VERSION], clientId, initialSubscriptions:[ROOT_STATE_URI] }`
  (`:394`), hydrates root state from snapshots, transitions to `Connected`.
- **Outgoing** — `_dispatchRequest` (`:1284-1321`): assigns an id, parks a `DeferredPromise`, writes
  `{ jsonrpc:'2.0', id, method, params }` to the transport (`:1315`). Concrete methods:
  `createSession`, `resolveSessionConfig`, `disposeSession`, `listSessions`, plus the dispatched
  turn actions.
- **Inbound** — `_handleMessage` (`:997-1051`): JSON-RPC responses complete the pending deferred;
  **`'action'` notifications** bump `_serverSeq` and fire `_onDidAction` (`:1030-1035`) — *this is the
  streamed-turn channel*.

**Local sessions bypass this layer entirely** — `IAgentHostService` is the in-process
`IAgentConnection`, so `dispatch` is a direct method call, not a socket write.

## Layer 7 — `WebSocketClientTransport`

`src/vs/platform/agentHost/browser/webSocketClientTransport.ts` (used for **remote** hosts only):

- **URL + auth** (`:72-79`): a bare address is prefixed with **`ws://`** (not `wss://`); the
  connection token is appended as query param **`tkn`** (`connectionTokenQueryName`), URL-encoded.
  Auth is query-string only — no header.

  ```ts
  let url = this._address.startsWith('ws://') || this._address.startsWith('wss://')
      ? this._address : `ws://${this._address}`;
  if (this._connectionToken) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}${connectionTokenQueryName}=${encodeURIComponent(this._connectionToken)}`;
  }
  ```
- **Send** (`:178-195`): only when `readyState === OPEN`; a dead socket is force-closed with code
  `4001 'send-on-dead-socket'` to trigger reconnection (fire-and-recover, not a silent drop).
- **Receive** (`:111-152`): non-string frames counted as malformed; force-close at threshold with
  `4002 'malformed-frames'`; string frames `JSON.parse`d and fired on `_onMessage`.

## Response streaming back into the panel

The return path is push-based through observables — no polling:

```
 s2c 'action' notification ──► _onDidAction (remoteAgentHostProtocolClient.ts:1034)
      │  AgentHostSessionHandler's observable graph drives the turn's progress sink
      ▼
 progressCallback(progress: IChatProgress[])   chatServiceImpl.ts:1116-1141
      │  model.acceptResponseProgress(request, item, !isLast)   :1137
      ▼
 ChatResponseModel.updateContent(progress)     chatModel.ts:818
      │  fires _onDidChangeValue → _onDidChange (onDidChange: Event<...>)
      ▼
 ChatWidget (bound in setChat via acquireOrLoadSession) subscribes to onDidChange
      │
      ▼
 ChatListItemRenderer re-renders the affected response row  (see doc 06)
```

`IChatProgress` is a wide union (`chatService.ts:1248-1288`): `markdownContent`, `thinkingPart`,
`toolInvocation` (doc 05), `usedContext`, `progressMessage`, `task`/`taskResult`, `confirmation`,
`elicitationRequest`, `multiDiffData`, `textEdit`/`notebookEdit`/`workspaceEdit`, `pullRequest`,
`mcpServersStarting`, `hookPart`, `undoStop`, and more. Because the composer and the message list
share the same `IChatService` session model (via `acquireOrLoadSession`,
`newChatInSessionWidget.ts:221`), progress streamed by the handler updates the exact model the panel
renders — no extra plumbing between send and display.

## Configuration

- Remote agent-host addresses are resolved in `remoteAgentHostServiceImpl.ts` (`_connectTo(address,
  connectionToken)`, `:462`), which builds the transport via a factory (`:481`) so the protocol
  client can swap transports across reconnects.
- Backboard-native LLM traffic ultimately flows through the Rust bridge to
  `https://app.backboard.io/api` — see [04-rust-typescript-bridge.md](04-rust-typescript-bridge.md).
