# Data Flows, Sequences, And Event Contracts

## System -> Data Flow Contracts

Every cross-module flow uses a typed command, request, event, or provider call. UI code never mutates model state directly; it dispatches commands or invokes services. Services emit versioned events. Views subscribe to projections of state.

## Module Open File Flow

```text
User selects explorer item
  -> CommandRegistry.executeCommand("workbench.action.openResource")
  -> WorkspaceService resolves URI authority
  -> FileService selects FileSystemProvider
  -> TextFileService checks dirty model cache
  -> FileSystemProvider.readFile streams bytes
  -> EncodingService decodes bytes
  -> TextModelService creates TextModel
  -> EditorService creates EditorInput
  -> EditorGroup opens input
  -> EditorViewModel renders viewport
  -> LanguageService attaches language providers
```

### Interface

```ts
export interface OpenResourceCommandArgs {
  resource: Uri;
  options?: {
    preserveFocus?: boolean;
    pinned?: boolean;
    selection?: Range;
    preview?: boolean;
  };
}

export interface OpenResourceResult {
  editorId: string;
  groupId: string;
  modelVersionId?: number;
}
```

### Behavior

- If a dirty model already exists for the URI, open the dirty model and skip disk read.
- If the provider is remote, display an editor loading state after 150 ms.
- If decoding fails, open binary/hex view with explicit reopen-as-text action.

### Edge Case

If the file changes on disk while opening, compare etag after read. If etag changed, retry once; if it changes again, open the latest bytes and show an external-change warning.

## Module Typing Flow

```text
KeyboardEvent
  -> KeyboardLayoutService normalizes key
  -> Focused editor accepts text input
  -> CursorController converts selections into EditOperation[]
  -> TextModel.applyEdits transaction
  -> UndoRedoService.pushElement
  -> TokenizationService.invalidate
  -> AstService.invalidate
  -> EditorViewModel recomputes visible lines
  -> Renderer paints changed line layers
  -> Language features schedule diagnostics/completions
```

### Event Payload

```ts
export interface EditorTypedEvent {
  resource: Uri;
  versionId: number;
  editCount: number;
  affectedLineRange: LineRange;
  source: 'keyboard' | 'paste' | 'composition' | 'snippet';
}
```

### Implementation Notes

- IME composition events are buffered until composition commit.
- Undo grouping starts at first typed character and closes on cursor move, command execution, focus loss, or grouping timeout.
- Diagnostics and semantic tokens run after a debounce and must be cancelled when the model version changes.

## Module Save Flow

```text
Save command
  -> EditorService gets active dirty editor
  -> TextFileService creates save participant transaction
  -> Format-on-save and code-action-on-save providers run with timeout
  -> TextModel applies participant edits
  -> BackupService writes recovery snapshot
  -> EncodingService encodes text
  -> FileSystemProvider.writeFile writes atomically
  -> Dirty flag clears only after provider success
  -> File watcher echo event is correlated and ignored
```

### Edge Case

If save participants modify the model while the user is still typing, re-check model version before write. If the version changed, restart save participants once; if it changes again, save the latest model without more participants and notify that save actions were skipped.

## Module Completion Flow

```text
Trigger suggest command or trigger character
  -> CompletionService builds context
  -> LanguageFeatureRegistry orders providers
  -> Providers run with cancellation and latency budget
  -> CompletionModel merges and ranks items
  -> SuggestWidget renders first page
  -> Selected item resolves lazily
  -> Accept command applies workspace edit
  -> UndoRedoService records one undo stop
```

### Edge Case

If slow providers return after the suggest widget has moved to a newer model version, discard the results. If a provider repeatedly exceeds budget, mark it slow and lower its background priority for the session.

## Module Extension Activation Flow

```text
Activation event fires
  -> ExtensionService selects extension host by authority/kind
  -> PermissionService checks manifest grants
  -> ExtensionHost loads extension entrypoint
  -> ExtensionApiFactory creates isolated API facade
  -> activate(context) runs with timeout
  -> Contributions register commands/providers/views
  -> ExtensionService records activation duration and failures
```

### Edge Case

If activation succeeds but registration throws after partial registration, dispose every contribution registered in that activation transaction and mark the extension activation failed.

## Module Terminal IO Flow

```text
Terminal create command
  -> TerminalService asks ProcessBroker for PTY
  -> PTY process starts under workspace authority
  -> Output chunks stream to renderer with sequence numbers
  -> Terminal parser updates grid buffer
  -> Dirty rows render on animation frame
  -> User input writes to PTY through broker
```

### Backpressure Rule

Renderer acknowledges processed sequence numbers. If unacknowledged bytes exceed threshold, broker pauses reads when supported or buffers to bounded memory. When buffer limit is reached, terminal trims oldest scrollback before dropping live output.

## Module Search Flow

```text
Search query submitted
  -> SearchService resolves includes/excludes
  -> Open dirty models searched in memory
  -> File index provides candidate paths
  -> Text search worker streams matches
  -> Search view appends virtualized results
  -> AST symbol index enriches symbol search
  -> Cancellation stops workers and closes file handles
```

### Edge Case

If the search provider reports too many results, stop traversal at max results, return partial status, and let the UI offer narrowing filters rather than continuing unbounded work.

## Module Debug Flow

```text
Debug start command
  -> LaunchConfigResolver merges config, variables, tasks
  -> Trust and permission checks run
  -> DebugAdapterBroker starts adapter
  -> DebugSession sends initialize
  -> BreakpointService sends breakpoints
  -> Adapter launch/attach starts target
  -> StackTraceService lazily loads threads and frames
  -> VariablesService pages scopes and children
```

### Edge Case

If a breakpoint is not verified, keep it in the UI and attach adapter-provided message. Do not delete user breakpoints because an adapter cannot bind them in the current run.

## Module Remote Reconnect Flow

```text
Heartbeat missed
  -> RemoteAgentConnection enters reconnecting
  -> Remote-backed editors become read-only
  -> Terminal input pauses
  -> File watchers and language clients suspend
  -> Reconnect loop negotiates protocol
  -> File etags and model versions reconcile
  -> Services resume or report conflicts
```

### Edge Case

If local dirty text conflicts with remote file changes after reconnect, preserve dirty model, open a diff against remote content, and require explicit user choice before overwrite.
