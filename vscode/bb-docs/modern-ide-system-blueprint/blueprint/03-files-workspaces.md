# Files, Explorer, Tabs, Splits, Panes, Workspace, And Session Management

## System -> Workspace Files

### Module Virtual File System

#### Subsystem Provider Contract

```ts
export interface FileSystemProvider {
  readonly scheme: UriScheme;
  stat(uri: Uri): Promise<FileStat>;
  readFile(uri: Uri, options?: ReadOptions): Promise<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array, options: WriteOptions): Promise<void>;
  readDirectory(uri: Uri): Promise<DirectoryEntry[]>;
  createDirectory(uri: Uri): Promise<void>;
  delete(uri: Uri, options: DeleteOptions): Promise<void>;
  rename(source: Uri, target: Uri, options: RenameOptions): Promise<void>;
  watch(uri: Uri, options: WatchOptions): Disposable;
  onDidChangeFile: Event<FileChangeEvent[]>;
}

export interface FileStat { type: 'file' | 'directory' | 'symlink'; ctime: number; mtime: number; size: number; etag: string; readonly?: boolean; }
export interface DirectoryEntry { name: string; type: FileStat['type']; uri: Uri; }
export interface FileChangeEvent { uri: Uri; type: 'created' | 'changed' | 'deleted'; etag?: string; }
```

#### Behavior

- All workspace file access goes through URI providers.
- Providers define capabilities: case sensitivity, atomic rename, recursive watch support, readonly support, and streaming support.
- The file service normalizes URI identity and handles retry for transient remote errors.
- Writes are atomic where possible: write temp file, fsync, rename, then emit change.

#### Edge Case

If a provider cannot perform atomic writes, it advertises `atomicWrite: false`; the editor enables backup-before-save for that scheme and records a recovery entry before writing.

### Module Explorer

#### Subsystem Tree Model

```ts
export interface ExplorerNode {
  uri: Uri;
  name: string;
  parent?: ExplorerNode;
  stat?: FileStat;
  children?: ExplorerNode[];
  isExpanded: boolean;
  isLoading: boolean;
  error?: FileError;
}

export interface ExplorerService {
  roots(): ExplorerNode[];
  resolveChildren(node: ExplorerNode, token: CancellationToken): Promise<ExplorerNode[]>;
  refresh(uri: Uri): Promise<void>;
  reveal(uri: Uri, options: { select: boolean; focus: boolean }): Promise<void>;
}
```

#### Behavior

- Explorer children are loaded lazily.
- Directory listings are cached by URI plus etag plus provider authority.
- Large directories render with list virtualization and chunked sorting.
- File decorations are computed asynchronously and never block tree expansion.

#### Edge Case

For directories with more than 20,000 children, the explorer shows a bounded first page, enables filter mode, and disables full client-side sorting until the user narrows results or requests full load.

### Module File Watching

#### Subsystem Watcher Broker

```ts
export interface FileWatcherService {
  watch(request: WatchRequest): Disposable;
  onDidChangeWatchedFiles: Event<FileChangeBatch>;
}

export interface WatchRequest {
  root: Uri;
  recursive: boolean;
  excludes: GlobPattern[];
  correlationId: string;
}

export interface FileChangeBatch {
  changes: FileChangeEvent[];
  createdAt: number;
  overflow: boolean;
}
```

#### Behavior

- Watchers coalesce events in 50 ms windows for UI refresh.
- A provider may emit overflow when native watchers drop events; overflow triggers targeted rescan.
- Search index, explorer, opened editors, and diagnostics subscribe through one broker rather than each creating independent watchers.

#### Edge Case

If watcher setup fails for a network mount, fall back to polling with adaptive interval. Polling starts at 5 seconds, backs off to 30 seconds when idle, and returns to 5 seconds when a focused editor belongs to that root.

### Module Tabs Splits Panes

#### Subsystem Editor Groups

```ts
export interface WorkbenchLayoutState {
  windows: WindowState[];
  workspaces: WorkspaceState[];
}

export interface EditorGroupState {
  id: string;
  orientation: 'horizontal' | 'vertical';
  sizeRatio: number;
  children: Array<EditorGroupState | EditorLeafState>;
  activeChildId: string;
}

export interface EditorLeafState {
  id: string;
  editors: EditorInputState[];
  activeEditorId?: string;
  previewEditorId?: string;
}

export interface EditorInputState {
  id: string;
  typeId: string;
  resource?: Uri;
  viewState?: unknown;
  dirty: boolean;
  pinned: boolean;
}
```

#### Behavior

- Split layout is stored as a tree with ratios, not pixels.
- Restore rehydrates editor inputs before views; failed editors become recoverable broken-input entries.
- Dirty untitled files serialize content into backup storage before shutdown.
- Preview tabs are replaced by navigation unless pinned.

#### Edge Case

If workspace restore references a deleted file, create an editor input with missing-file state, preserve the tab label, and offer remove, create, or locate actions.

