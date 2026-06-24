# Endpoint Registry

| Endpoint | Kind | Owner | Contract |
|---|---|---|---|
| `EventBus.publish` | Event | Platform | Versioned envelope, no acknowledgement. |
| `IpcChannel.request` | IPC | Runtime | Request/response with timeout and cancellation. |
| `FileSystemProvider.readFile` | Provider | Files | Reads bytes for URI scheme. |
| `FileSystemProvider.watch` | Provider | Files | Emits created/changed/deleted events. |
| `LanguageClient.sendRequest` | Protocol | Language | Sends LSP-compatible request. |
| `CompletionProvider.provideCompletions` | Provider | Language | Returns completion list for model position. |
| `CommandRegistry.executeCommand` | Command | Input | Runs command with source and cancellation. |
| `TerminalService.createTerminal` | Service | Terminal | Creates brokered PTY. |
| `SearchService.textSearch` | Service | Search | Streams text search results. |
| `DebugService.startSession` | Service | Debug | Starts DAP-backed debug session. |
| `MarketplaceService.install` | Service | Extensions | Installs verified extension package. |
| `PermissionService.request` | Security | Extensions | Grants or denies extension permission. |

