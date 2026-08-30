# Implementation Map

```text
System Modern IDE
|
|-- Module Runtime Boundary
|   |-- Subsystem Desktop Shell
|   |-- Subsystem Browser Client
|   |-- Subsystem Remote Agent
|   L-- Subsystem Shared Protocols
|
|-- Module Editor Core
|   |-- Subsystem Text Model
|   |-- Subsystem Tokenization
|   |-- Subsystem Cursor Selection
|   |-- Subsystem View Model
|   L-- Subsystem Undo Redo
|
|-- Module Workspace Files
|   |-- Subsystem Virtual File System
|   |-- Subsystem Explorer Model
|   |-- Subsystem Watcher
|   L-- Subsystem Workspace Restore
|
|-- Module Language Intelligence
|   |-- Subsystem LSP Client
|   |-- Subsystem AST Cache
|   |-- Subsystem Completion Diagnostics Actions
|   L-- Subsystem Multi Language Registry
|
|-- Module UI Rendering
|   |-- Subsystem Retained Workbench Shell
|   |-- Subsystem Virtualized Lists Editors
|   |-- Subsystem Layout Grid
|   L-- Subsystem Theme Animation GPU
|
|-- Module Extensions
|   |-- Subsystem Extension Host
|   |-- Subsystem Public API
|   |-- Subsystem Permissions Sandbox
|   L-- Subsystem Marketplace
|
|-- Module Terminal Search Debug Input
|   |-- Subsystem PTY Terminal
|   |-- Subsystem Full Text Index
|   |-- Subsystem Debug Adapter Protocol
|   L-- Subsystem Commands Keybindings Mouse
|
L-- Module Operations
    |-- Subsystem State Storage Config
    |-- Subsystem Performance Concurrency
    |-- Subsystem Security Secrets
    |-- Subsystem Telemetry Logging
    L-- Subsystem Failure Recovery
```

## Build Order

1. Base utilities, cancellation, event bus, disposable lifecycle.
2. Service container and runtime IPC.
3. URI and virtual file system.
4. Text model and editor view model.
5. Workbench layout and command service.
6. Workspace restore and storage.
7. Extension host and public API facade.
8. Language feature registry and LSP client.
9. Terminal, search, debug services.
10. Marketplace, security policies, telemetry, recovery.

## Acceptance Gate

A module is accepted when it has typed public/internal interfaces, tests for normal and failure behavior, telemetry/logging classification, memory/performance budget, and compatibility notes for serialized state.

