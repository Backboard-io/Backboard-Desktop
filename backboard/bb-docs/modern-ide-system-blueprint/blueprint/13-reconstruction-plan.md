# Reconstruction Plan, Package Layout, And Acceptance Gates

## System -> Reconstruction Plan

This chapter converts the architecture into buildable packages and sequencing. A team can implement these packages independently as long as public contracts are respected.

## Module Package Layout

```text
ide/
|
|-- packages/base/
|   |-- cancellation
|   |-- events
|   |-- disposables
|   |-- lifecycle
|   L-- uri
|
|-- packages/platform/
|   |-- ipc
|   |-- storage
|   |-- configuration
|   |-- filesystem
|   |-- processes
|   |-- security
|   L-- telemetry
|
|-- packages/editor/
|   |-- text-model
|   |-- piece-tree
|   |-- cursor
|   |-- tokenization
|   |-- view-model
|   L-- editor-widget
|
|-- packages/workbench/
|   |-- layout
|   |-- commands
|   |-- keybindings
|   |-- explorer
|   |-- editor-groups
|   |-- terminal
|   |-- search
|   |-- debug
|   L-- views
|
|-- packages/languages/
|   |-- registry
|   |-- lsp-client
|   |-- diagnostics
|   |-- completions
|   |-- code-actions
|   L-- ast-cache
|
|-- packages/extensions/
|   |-- host
|   |-- api
|   |-- permissions
|   |-- scanner
|   L-- marketplace
|
|-- apps/desktop-main/
|-- apps/desktop-renderer/
|-- apps/web-client/
|-- apps/remote-agent/
L-- tools/
    |-- extension-dev
    |-- benchmark-runner
    |-- compatibility-tests
    L-- diagnostic-exporter
```

## Module Build Sequence

### Phase 1 Base Runtime

#### Components

- Cancellation tokens.
- Disposable store.
- Typed events.
- URI parser.
- Service container.
- IPC channel.

#### Acceptance Gate

- Unit tests prove cancellation propagation, disposable idempotency, URI round-trips, event ordering, service dependency cycle rejection, and IPC request timeout.

### Phase 2 Files And Storage

#### Components

- File system provider interface.
- Local file provider.
- In-memory provider.
- Storage service.
- Configuration service.
- Workspace schema loader.

#### Acceptance Gate

- Atomic write test passes.
- Watch event coalescing test passes.
- Malformed settings recovery test passes.
- Workspace restore from schema v1 passes.

### Phase 3 Editor Core

#### Components

- Piece tree.
- Text model.
- Cursor controller.
- Undo/redo service.
- Tokenization service.
- Editor view model.

#### Acceptance Gate

- Random edit fuzzer preserves text equivalence.
- Offset-position conversion passes Unicode and end-of-line tests.
- Multi-cursor transactions produce one undo stop.
- Large-file mode opens bounded-memory fixtures.

### Phase 4 Workbench Shell

#### Components

- Layout grid.
- Editor groups.
- Tabs and split state.
- Command registry.
- Keybinding resolver.
- Quick access.
- Explorer view.

#### Acceptance Gate

- Layout restore is pixel-stable within one layout unit.
- Conflicting keybindings produce deterministic winner.
- Missing editor input restore creates recoverable broken input.
- Explorer large directory virtualization stays responsive.

### Phase 5 Language Intelligence

#### Components

- Language registry.
- LSP client.
- Completion engine.
- Diagnostic service.
- Code action and refactor service.
- AST cache.

#### Acceptance Gate

- LSP initialization and incremental sync pass protocol tests.
- Stale diagnostics are dropped.
- Completion provider cancellation is observed.
- AST cache invalidates by edit range and version.

### Phase 6 Extensions

#### Components

- Extension scanner.
- Extension host.
- Public API factory.
- Permission service.
- Marketplace install/update.

#### Acceptance Gate

- Extension host crash does not crash renderer.
- Permission denial blocks file/process/network access.
- Manifest compatibility validation rejects unsupported engines.
- Install verifies checksum before activation.

### Phase 7 Tools And Operations

#### Components

- Terminal PTY broker.
- Search index.
- Debug adapter service.
- Telemetry and log service.
- Secret storage.
- Diagnostic exporter.

#### Acceptance Gate

- Terminal backpressure prevents unbounded memory.
- Search cancellation closes file handles.
- Debug stack and variable paging pass adapter fixture tests.
- Secrets never appear in logs or telemetry exports.

## Module Compatibility Policy

- Public extension API is semver-stable.
- Serialized workspace/layout/storage schemas are migration-versioned.
- IPC protocol has explicit version negotiation.
- Marketplace packages declare engine compatibility.
- Proposed APIs require explicit opt-in and are excluded from stable compatibility promises.

## Module Test Matrix

| Test type | Required scope |
|---|---|
| Unit | Base, editor model, config merge, keybinding resolver, provider registries. |
| Integration | File save, open editor, extension activation, LSP sync, terminal IO, debug session. |
| Browser | Web client without local process spawning. |
| Desktop | Native dialogs, PTY, local file provider, extension host. |
| Remote | Remote files, terminals, language servers, reconnect. |
| Performance | Startup, scroll, typing, search first result, large file open. |
| Security | Permissions, webview CSP, secret access, workspace trust. |
| Recovery | Corrupted storage, plugin crash, language server crash, network loss. |
