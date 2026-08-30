# System Map And Architectural Contract

## System -> Module -> Subsystem -> Component -> Behavior -> Edge Case -> Implementation Notes

### System Modern IDE

The system is a multi-process, event-driven, extensible desktop/browser IDE. It supports local workspaces, remote workspaces, web-hosted workspaces, language intelligence, terminals, debugging, source control, notebooks, tasks, and third-party extensions.

### Module Boundary Table

| Module | Owns | Must not own | Primary interfaces |
|---|---|---|---|
| Runtime Boundary | Process topology, IPC, remote agent protocol, crash isolation. | Editor semantics or extension public API design. | `RuntimeService`, `IpcChannel`, `RemoteAgentConnection`. |
| Editor Core | Text models, tokenization, cursor state, editor rendering model, undo/redo. | File watching, LSP transport, extension marketplace. | `TextModel`, `EditorViewModel`, `EditOperation`. |
| Workspace Files | URI schemes, virtual file systems, explorer tree, watchers, workspace restore. | Syntax analysis or terminal PTY internals. | `FileSystemProvider`, `WorkspaceService`, `FileWatcher`. |
| Language Intelligence | LSP clients, AST caches, completion ranking, diagnostics, refactoring. | Workbench layout or plugin install UI. | `LanguageClient`, `LanguageFeatureRegistry`, `DiagnosticService`. |
| UI Rendering | Component tree, retained layout model, theme tokens, virtual lists. | File IO and process spawning. | `WorkbenchLayoutService`, `ThemeService`, `ViewRegistry`. |
| Extensions | Extension host lifecycle, public APIs, permissions, marketplace metadata. | Private workbench services. | `ExtensionHost`, `ExtensionApiFactory`, `PermissionService`. |
| Terminal Search Debug Input | PTY processes, search indexes, debug sessions, command dispatch. | Core text buffer mutation. | `TerminalService`, `SearchService`, `DebugService`, `CommandService`. |
| Operations | State, config, storage, performance, security, logging, telemetry, recovery. | User-facing feature rendering. | `StorageService`, `ConfigurationService`, `TelemetryService`. |

### Global Event Bus Contract

```ts
export interface IdeEventEnvelope<TPayload> {
  topic: string;
  version: number;
  source: 'renderer' | 'main' | 'extensionHost' | 'remoteAgent' | 'worker' | 'server';
  target?: string;
  correlationId: string;
  timestamp: number;
  workspaceId?: string;
  payload: TPayload;
}

export interface EventBus {
  publish<T>(event: IdeEventEnvelope<T>): void;
  subscribe<T>(topic: string, listener: (event: IdeEventEnvelope<T>) => void): Disposable;
  request<TReq, TRes>(topic: string, payload: TReq, token: CancellationToken): Promise<TRes>;
}
```

#### Behavior

- All cross-process messages use versioned envelopes.
- Internal events are synchronous only inside one process and one service boundary.
- Cross-process requests must support cancellation, correlation IDs, timeout, and structured error payloads.
- Broadcast events are never used for commands requiring acknowledgement. Use request/response for mutating operations.

#### Edge Case

If a receiver does not support an event version, it returns `UnsupportedProtocolVersionError` with the highest supported version. The sender either downgrades through a registered adapter or disables the feature for that connection.

#### Implementation Notes

- Use binary encoding for high-volume editor deltas and terminal data.
- Use JSON-compatible encoding for extension API calls and marketplace metadata.
- Never pass object instances across process boundaries; pass plain serializable records.

### Module Dependency Graph

```text
Base Utilities
  ^
  |
Platform Services <---------------- Operations
  ^                                ^
  |                                |
Workspace Files <--- Editor Core --+-- Language Intelligence
  ^                 ^              |
  |                 |              |
Commands/Input ----+--------------+
  ^
  |
UI Rendering <---- Extensions through Public API Facade only

Forbidden edges:
- Extension code -> private workbench implementation.
- Editor Core -> UI framework components.
- Platform Services -> Workbench services.
- Language server process -> raw disk access through IDE internals; it must use documented workspace URIs or normal OS access when permitted.
```

### Service Registration Interface

```ts
export interface ServiceDescriptor<T> {
  id: string;
  lifecycle: 'singleton' | 'workspace' | 'window' | 'session';
  dependencies: string[];
  factory(container: ServiceContainer): T;
}

export interface ServiceContainer {
  get<T>(id: string): T;
  tryGet<T>(id: string): T | undefined;
  register<T>(descriptor: ServiceDescriptor<T>): void;
  disposeScope(scopeId: string): Promise<void>;
}
```

#### Behavior

- Services are registered during bootstrap in dependency order.
- Cycles are rejected at startup with a dependency path report.
- Window-scoped services die with a window.
- Workspace-scoped services die when the workspace closes or changes identity.
- Session-scoped services die when the user logs out, disconnects remote, or clears trusted session state.

