# Modern IDE System Blueprint Endpoints

Endpoint means any command ID, service interface, IPC topic, provider method, file URI contract, debug protocol adapter, language server request, extension contribution point, or marketplace API used by the IDE.

## BB-DEEP-DIVE:START

Endpoint specifications are distributed by subsystem:

- Runtime IPC and remote agent endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/01-runtime-client-server.md`
- File system provider endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/03-files-workspaces.md`
- LSP and language provider endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/04-language-intelligence.md`
- Extension APIs and marketplace endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/06-extensions-marketplace.md`
- Terminal, search, and debug endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/07-terminal-search-debug.md`
- Input and command endpoints: `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/modern-ide-system-blueprint/blueprint/09-input-command-keybindings.md`

## BB-DEEP-DIVE:END

## BB-VERIFICATION-MATRIX:START

| Endpoint type | Evidence |
|---|---|
| IPC | `IpcChannel`, `EventBus`, `RemoteAgentConnection` |
| File system | `FileSystemProvider`, `FileWatcherService` |
| Language | `LanguageClient`, `CompletionProvider`, `DiagnosticService` |
| Extensions | `ExtensionManifest`, `ExtensionHost`, `IdeApi` |
| Debug | `DebugService`, `DebugSession` |

## BB-VERIFICATION-MATRIX:END

