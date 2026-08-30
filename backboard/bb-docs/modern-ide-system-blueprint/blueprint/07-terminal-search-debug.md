# Terminal, Search, And Debugging

## System -> Terminal

### Module PTY Terminal

```ts
export interface TerminalService {
  createTerminal(options: TerminalCreateOptions): Promise<TerminalInstance>;
  getTerminals(): TerminalInstance[];
  onDidOpenTerminal: Event<TerminalInstance>;
  onDidCloseTerminal: Event<{ id: string; exitCode?: number }>;
}

export interface TerminalInstance {
  id: string;
  title: string;
  processId?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  onData: Event<string>;
  onExit: Event<{ exitCode?: number; signal?: string }>;
}
```

#### Behavior

- Terminal process creation is brokered by authority and permission service.
- PTY output streams to renderer as ordered chunks with sequence numbers.
- Renderer terminal grid applies parser state and renders only dirty rows.
- Shell integration is optional and never required for raw terminal functionality.

#### Edge Case

If terminal output exceeds renderer processing budget, the broker applies backpressure. If the process ignores backpressure and memory rises above limit, terminal enters high-throughput mode: reduce scrollback retention, batch frames, and defer decorations.

## System -> Search

### Module Full Text Search

```ts
export interface SearchService {
  textSearch(query: TextSearchQuery, token: CancellationToken): AsyncIterable<TextSearchResult>;
  fileSearch(query: FileSearchQuery, token: CancellationToken): AsyncIterable<FileSearchResult>;
  symbolSearch(query: SymbolSearchQuery, token: CancellationToken): AsyncIterable<SymbolSearchResult>;
}

export interface TextSearchQuery {
  pattern: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  isWordMatch: boolean;
  includes: GlobPattern[];
  excludes: GlobPattern[];
  maxResults: number;
}
```

#### Behavior

- Search first streams cheap filename and ripgrep-like text results, then enriches results with preview ranges.
- Excludes combine default ignores, workspace excludes, provider excludes, and query excludes.
- Open unsaved models are searched from memory and merged over disk results.
- Results are cancellable and stable-sorted by path and position unless relevance mode is enabled.

#### Indexing Strategy

```text
Workspace file event
  -> debounce path batch
  -> update file metadata index
  -> enqueue content indexing for small text files
  -> enqueue symbol indexing from AST snapshots
  -> persist compact index segment
  -> merge segments during idle time
```

#### Edge Case

For huge workspaces, index only recently opened files, language symbols, and path metadata first. Full content indexing runs in background with IO budget and pauses on battery saver or remote memory pressure.

## System -> Debugging

### Module Debug Adapter Protocol

```ts
export interface DebugService {
  startSession(config: DebugConfiguration, options: DebugSessionOptions): Promise<DebugSession>;
  setBreakpoints(resource: Uri, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]>;
  onDidChangeCallStack: Event<{ sessionId: string; threads: DebugThread[] }>;
}

export interface DebugSession {
  id: string;
  configuration: DebugConfiguration;
  sendRequest<TReq, TRes>(command: string, args: TReq, token: CancellationToken): Promise<TRes>;
  continue(threadId: number): Promise<void>;
  stepOver(threadId: number): Promise<void>;
  pause(threadId: number): Promise<void>;
  terminate(): Promise<void>;
}
```

#### Behavior

- Debug adapter launch is brokered and authority-aware.
- Breakpoints are stored independently from adapter verification state.
- Stack traces are lazily expanded by thread/frame.
- Variable inspection pages child variables to avoid freezing on huge objects.
- Watch expressions execute through adapter evaluate with explicit context.

#### Edge Case

If a debug adapter disconnects unexpectedly, preserve last known stack/variables as stale data, mark controls disabled, and offer restart, stop, and open adapter log actions.

