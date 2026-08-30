# Language Intelligence Layer

## System -> Language Intelligence

### Module Language Registry

#### Subsystem Multi-Language Support

```ts
export interface LanguageDescriptor {
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  firstLinePatterns: RegExp[];
  configuration: LanguageConfiguration;
}

export interface LanguageFeatureRegistry<TProvider> {
  register(selector: DocumentSelector, provider: TProvider, metadata: ProviderMetadata): Disposable;
  ordered(model: TextModel): TProvider[];
}

export interface ProviderMetadata { extensionId?: string; priority: number; supportsCancellation: boolean; }
```

#### Behavior

- Language detection combines filename, extension, first line, modeline, and user override.
- User override wins and persists per resource.
- Providers are ordered by selector specificity, priority, and extension activation order.

#### Edge Case

If two languages claim the same file extension, the detection service chooses the language with highest confidence and exposes a status-bar switcher. It records the user's choice per workspace when changed.

### Module LSP Client

#### Subsystem Transport And Synchronization

```ts
export interface LanguageClient {
  readonly id: string;
  readonly languageIds: string[];
  start(options: LanguageClientOptions): Promise<void>;
  stop(reason: string): Promise<void>;
  sendRequest<TReq, TRes>(method: string, params: TReq, token: CancellationToken): Promise<TRes>;
  sendNotification<T>(method: string, params: T): void;
}

export interface LanguageClientOptions {
  transport: 'stdio' | 'socket' | 'webWorker' | 'messagePort';
  command?: string;
  args?: string[];
  workspaceFolders: Uri[];
  initializationOptions: unknown;
  documentSync: 'none' | 'full' | 'incremental';
}
```

#### Behavior

- The client sends initialize, initialized, workspace folders, configuration, and capability data.
- Text synchronization is incremental unless the server declares full sync only.
- Diagnostics are version-gated: diagnostics for old model versions are discarded or mapped only when an edit transform exists.
- Requests are cancelled when the editor closes, model version changes materially, or the workspace authority disconnects.

#### Edge Case

If a language server restarts more than three times in five minutes, disable automatic restart for that workspace and show server logs with restart action.

### Module Completion Engine

#### Subsystem Aggregation Ranking Commit

```ts
export interface CompletionProvider {
  provideCompletions(model: TextModel, position: Position, context: CompletionContext, token: CancellationToken): Promise<CompletionList>;
  resolveCompletion?(item: CompletionItem, token: CancellationToken): Promise<CompletionItem>;
}

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  insertText: string;
  filterText?: string;
  sortText?: string;
  detail?: string;
  documentation?: string;
  additionalTextEdits?: EditOperation[];
  command?: CommandReference;
  commitCharacters?: string[];
  source: string;
}
```

#### Behavior

- Completion requests fan out to ordered providers with a latency budget.
- Results are scored by prefix match, locality, language rank, recency, kind, and provider confidence.
- The selected item is resolved lazily before documentation and expensive edits are displayed.
- Commit applies primary edit, additional edits, snippet tab stops, and follow-up command in one undo stop.

#### Pseudo-Code

```ts
async function provideCompletionItems(model: TextModel, position: Position, token: CancellationToken): Promise<CompletionItem[]> {
  const providers = completionRegistry.ordered(model);
  const lists = await limitedParallel(providers, 4, provider => provider.provideCompletions(model, position, buildContext(model, position), token));
  return rankCompletionItems(lists.flatMap(list => list.items), {
    prefix: getCompletionPrefix(model, position),
    languageId: model.languageId,
    recentSelections: completionHistory.forLanguage(model.languageId)
  });
}
```

### Module Diagnostics Code Actions Refactors

#### Subsystem Diagnostic Pipeline

```ts
export interface Diagnostic {
  resource: Uri;
  range: Range;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
  source: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInfo[];
  modelVersionId?: number;
}

export interface DiagnosticService {
  set(owner: string, resource: Uri, diagnostics: Diagnostic[]): void;
  get(resource: Uri): Diagnostic[];
  onDidChangeDiagnostics: Event<{ resources: Uri[] }>;
}
```

#### Behavior

- Diagnostics are partitioned by owner so linter, compiler, and LSP results can update independently.
- Problems view consumes diagnostic events through a debounced projection index.
- Editor squiggles render only visible ranges plus a prefetch buffer.
- Code actions query providers by diagnostic and selection context.

#### Edge Case

If diagnostics arrive for a file with unsaved local edits, display them only when version-compatible. Otherwise hold them in stale state and request fresh diagnostics.

#### Refactor Engine Interface

```ts
export interface RefactorProvider {
  provideRefactors(model: TextModel, range: Range, token: CancellationToken): Promise<RefactorAction[]>;
  resolveRefactor(action: RefactorAction, token: CancellationToken): Promise<WorkspaceEdit>;
}

export interface WorkspaceEdit {
  edits: Array<{ resource: Uri; edits: EditOperation[] }>;
  creates?: Uri[];
  renames?: Array<{ oldUri: Uri; newUri: Uri }>;
  deletes?: Uri[];
  metadata?: { label: string; requiresConfirmation?: boolean };
}
```

### Module AST Cache

#### Subsystem Incremental Parser

```ts
export interface AstService {
  parse(model: TextModel, options: ParseOptions, token: CancellationToken): Promise<AstSnapshot>;
  getCached(uri: Uri, versionId: number): AstSnapshot | undefined;
  invalidate(uri: Uri, changes: TextChange[]): void;
}

export interface AstSnapshot {
  uri: Uri;
  languageId: string;
  versionId: number;
  root: AstNode;
  symbols: SymbolIndexEntry[];
}

export interface AstNode { type: string; range: Range; children: AstNode[]; error?: string; }
```

#### Behavior

- AST cache stores latest snapshot per open model and compact symbol index for workspace search.
- Parsers run in workers and support incremental edits when grammar supports it.
- Parse errors produce recoverable nodes so outline and symbol search remain useful.

