# Runtime, Client Server Boundaries, And IPC

## System -> Runtime Boundary

### Module Desktop Runtime

#### Subsystem Process Topology

```text
Desktop install
|
|-- Main Process
|   |-- window lifecycle
|   |-- native menus/dialogs
|   |-- update service
|   |-- crash reporter
|   |-- secure storage adapter
|   L-- privileged process spawning broker
|
|-- Renderer Process per window
|   |-- workbench UI
|   |-- editor views
|   |-- webviews in sandboxed frames
|   L-- local service proxies
|
|-- Extension Host Process per authority/trust boundary
|   |-- extension activation
|   |-- extension API facade
|   L-- extension filesystem/network permissions
|
|-- Utility Workers
|   |-- search worker
|   |-- tokenizer worker
|   |-- semantic index worker
|   L-- file watcher broker
|
L-- Remote Agent optional
    |-- remote file service
    |-- remote extension host
    |-- remote terminal broker
    L-- remote language server launcher
```

#### Component RuntimeService

```ts
export interface RuntimeService {
  readonly kind: 'desktop' | 'web' | 'server' | 'remoteAgent';
  readonly processId: string;
  readonly authority: string;
  createChannel(name: string, target: RuntimeTarget): Promise<IpcChannel>;
  spawnUtility(kind: UtilityKind, options: UtilityOptions): Promise<UtilityHandle>;
  getCapabilities(): RuntimeCapabilities;
}

export interface RuntimeCapabilities {
  canSpawnProcesses: boolean;
  canUseNativeDialogs: boolean;
  canAccessLocalFileSystem: boolean;
  canUseSharedArrayBuffer: boolean;
  supportsPty: boolean;
  supportsGpuCanvas: boolean;
}
```

#### Behavior

- Renderer processes never spawn arbitrary OS processes directly.
- File, terminal, debug adapter, and extension host process creation goes through a broker that checks workspace trust, permissions, and authority.
- Browser clients use a server-side agent for process, terminal, and file operations.
- Desktop clients may run local operations in brokered child processes.

#### Edge Case

If the remote agent disconnects, the renderer marks remote-backed editors read-only, pauses terminal input, preserves local UI state, and starts reconnection with exponential backoff capped at 30 seconds.

#### Implementation Notes

- Keep runtime feature checks explicit. Never infer browser vs desktop from user agent strings inside feature code.
- Every remote-capable service receives a URI authority and must route through the correct authority-specific connection.

### Module Protocol Boundaries

#### Subsystem IPC Transport

```ts
export interface IpcChannel {
  readonly name: string;
  send<T>(topic: string, payload: T): void;
  request<TReq, TRes>(topic: string, payload: TReq, options: RequestOptions): Promise<TRes>;
  onMessage<T>(topic: string, listener: (payload: T, meta: MessageMeta) => void): Disposable;
  close(reason: string): Promise<void>;
}

export interface RequestOptions {
  timeoutMs: number;
  token: CancellationToken;
  priority: 'userBlocking' | 'normal' | 'background';
}

export interface MessageMeta {
  correlationId: string;
  protocolVersion: number;
  senderProcessId: string;
  createdAt: number;
}
```

#### Behavior

- User-blocking messages bypass background queue starvation.
- Streaming payloads use chunks with sequence numbers and acknowledgements.
- Request handlers must be idempotent or declare non-idempotent behavior so retry logic does not duplicate mutations.

#### Pseudo-Code

```ts
async function requestWithRetry<TReq, TRes>(channel: IpcChannel, topic: string, payload: TReq, options: RequestOptions): Promise<TRes> {
  const attempts = options.priority === 'userBlocking' ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await channel.request<TReq, TRes>(topic, payload, options);
    } catch (error) {
      lastError = error;
      if (!isTransientTransportError(error) || options.token.isCancellationRequested) {
        throw error;
      }
      await delay(50 + attempt * 100, options.token);
    }
  }
  throw lastError;
}
```

### Module Remote Server

#### Subsystem Remote Agent

```ts
export interface RemoteAgentConnection {
  authority: string;
  protocolVersion: number;
  fileSystem: FileSystemProvider;
  terminal: RemoteTerminalBroker;
  extensions: RemoteExtensionHostBroker;
  languageServers: LanguageServerLauncher;
  heartbeat(): Promise<HeartbeatStatus>;
}

export interface HeartbeatStatus {
  latencyMs: number;
  serverTime: number;
  workspaceRootCount: number;
  memoryPressure: 'normal' | 'high' | 'critical';
}
```

#### Behavior

- Remote agent owns remote filesystem, PTY, extension host, debug adapter, and language server launch.
- The client owns rendering, local UI state, keybindings, command palette, themes, and view layout.
- Remote agent reports memory pressure; the client reduces prefetching and index concurrency when pressure is high.

#### Edge Case

If protocol versions differ but remain compatible, the connection installs shims for renamed fields. If a required field cannot be shimmed, the client displays an actionable incompatibility error and prevents mutating workspace operations.

