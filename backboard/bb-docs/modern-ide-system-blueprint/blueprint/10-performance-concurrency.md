# Performance Engineering, Concurrency, Memory, Startup, And Large Files

## System -> Performance

### Module Startup

#### Startup Phases

```text
phase 0 native process boot target < 300 ms
phase 1 first window shell target < 900 ms
phase 2 restore visible layout target < 1500 ms
phase 3 restore active editor target < 2000 ms
phase 4 extension scan target background after interactive
phase 5 language intelligence warmup target idle or demand loaded
```

#### Behavior

- Load only shell, layout, command registry, active editor type, theme, and keybindings before first paint.
- Defer extension activation until activation event fires.
- Defer full explorer expansion until visible.
- Defer search index warmup until idle.

### Module Concurrency

```ts
export interface WorkScheduler {
  schedule<T>(task: WorkTask<T>): Promise<T>;
  cancel(groupId: string): void;
  setResourceBudget(resource: 'cpu' | 'io' | 'memory', budget: ResourceBudget): void;
}

export interface WorkTask<T> {
  id: string;
  groupId: string;
  priority: 'userBlocking' | 'foreground' | 'background' | 'idle';
  run(token: CancellationToken): Promise<T>;
}
```

#### Behavior

- User-blocking tasks preempt background tasks.
- CPU-heavy work goes to workers: search, tokenization, AST, extension scanning, compression.
- IO-heavy work uses bounded concurrency per authority and per disk root.
- Cancellation is mandatory for all background tasks.

### Module Memory Management

#### Behavior

- Text model memory is tracked by URI, buffer size, token cache, decorations, AST snapshot, and view state.
- Inactive editor views dispose DOM and retain only model plus serialized view state.
- Token caches use LRU per model and are aggressively trimmed under memory pressure.
- Extension host memory is sampled; runaway extension warnings include extension activation and provider ownership data.

#### Edge Case

When memory pressure is critical, the IDE closes idle workers, drops background indexes, disables minimaps, trims terminal scrollback, and asks large inactive custom editors to serialize and unload.

### Module Large File Virtualization

#### Behavior

- Files above 50 MB or 300,000 lines open in large-file mode by default.
- Large-file mode uses chunked reads and visible-window line map.
- Edits are allowed only when edit budget can be proven safe.
- Search in large file streams chunks and reports progressive matches.
- Syntax tokenization is limited to viewport lexical tokenization.

### Module Rendering Budgets

| Operation | Budget |
|---|---:|
| Keypress to visible character | 16 ms target, 50 ms worst accepted before warning sample. |
| Scroll frame | 16 ms target with dropped-frame telemetry above 3 consecutive missed frames. |
| Completion trigger visible list | 100 ms for first result, 500 ms for enriched results. |
| Explorer expand normal directory | 100 ms for first paint. |
| Search first result | 500 ms local, 1500 ms remote. |

### Module Lazy Loading

#### Behavior

- Feature modules register lightweight descriptors during boot.
- Implementation modules load on first command/view/editor/provider activation.
- Chunk boundaries are aligned with feature ownership.
- Lazy module load failures surface command-specific error and do not break global command registry.

