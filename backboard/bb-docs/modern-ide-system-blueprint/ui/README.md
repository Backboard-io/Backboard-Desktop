# Modern IDE System Blueprint UI

## System -> UI Rendering -> Workbench Surface

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

## Component Hierarchy

```text
WorkbenchRoot
|
|-- Command surfaces: menu bar, command palette, context menus, keybinding labels
|-- Navigation surfaces: activity bar, sidebar, breadcrumbs, outline, search
|-- Editing surfaces: editor groups, tabs, splits, diff editors, custom editors
|-- Tool surfaces: terminal, problems, output, debug console, search results
|-- Auxiliary surfaces: notifications, quick pick, hover, suggest widget, inline completions
L-- Extension surfaces: contributed views, webviews, status bar items, menus, commands
```

## BB-DEEP-DIVE:START

The canonical implementation chapters for UI are:

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/05-rendering-ui.md`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/09-input-command-keybindings.md`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/10-performance-concurrency.md`

The UI must be retained-state at the workbench level and virtualized at high-cardinality surfaces. Editor lines, terminal rows, explorer nodes, search results, notebook cells, and extension tree views must render by visible range rather than full dataset size.

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| Claim | Evidence file |
|---|---|
| Rendering strategy is specified | `blueprint/05-rendering-ui.md` |
| Input pipeline is specified | `blueprint/09-input-command-keybindings.md` |
| Performance budgets are specified | `blueprint/10-performance-concurrency.md` |
| Component hierarchy is defined | This file and `ui/screen-map.md` |

## BB-VERIFICATION-MATRIX:END

