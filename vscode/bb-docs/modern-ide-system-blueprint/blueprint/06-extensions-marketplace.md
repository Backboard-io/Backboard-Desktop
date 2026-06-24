# Plugin Extension System And Marketplace

## System -> Extensions

### Module Extension Manifest

```ts
export interface ExtensionManifest {
  id: string;
  publisher: string;
  name: string;
  version: string;
  engines: { ide: string };
  activationEvents: string[];
  main?: string;
  browser?: string;
  contributes?: ExtensionContributions;
  permissions?: ExtensionPermissionRequest[];
  extensionKind?: Array<'ui' | 'workspace' | 'web'>;
}

export interface ExtensionContributions {
  commands?: CommandContribution[];
  configuration?: ConfigurationContribution;
  languages?: LanguageDescriptor[];
  grammars?: GrammarContribution[];
  views?: ViewContribution[];
  menus?: MenuContribution[];
  themes?: ThemeContribution[];
  debuggers?: DebuggerContribution[];
}
```

#### Behavior

- Manifest is validated before install and before activation.
- Unknown contribution fields are ignored unless the extension declares a required capability.
- Extension IDs are immutable after publication.
- Activation events are declarative and must not run extension code during scanning.

### Module Extension Host

```ts
export interface ExtensionHost {
  readonly authority: string;
  activate(extensionId: string, reason: ActivationReason): Promise<ExtensionContext>;
  deactivate(extensionId: string, reason: string): Promise<void>;
  restart(reason: string): Promise<void>;
  onDidCrash: Event<ExtensionHostCrashEvent>;
}

export interface ExtensionContext {
  extensionUri: Uri;
  globalState: Memento;
  workspaceState: Memento;
  secrets: SecretStorage;
  subscriptions: Disposable[];
  asAbsolutePath(relativePath: string): string;
}
```

#### Behavior

- One extension host runs per authority and trust boundary.
- Extension activation has timeout budgets by activation reason.
- Extension code receives only public API facades.
- On deactivation, all disposables in `subscriptions` are disposed in reverse registration order.

#### Edge Case

If an extension host crashes, restart it once automatically, mark all extension-owned providers temporarily unavailable, and restore providers only after each extension reactivates successfully.

### Module Public API

```ts
export interface IdeApi {
  commands: CommandsApi;
  workspace: WorkspaceApi;
  window: WindowApi;
  languages: LanguagesApi;
  debug: DebugApi;
  extensions: ExtensionsApi;
  env: EnvApi;
}

export interface CommandsApi {
  registerCommand<TArgs extends readonly unknown[], TResult>(id: string, handler: (...args: TArgs) => TResult | Promise<TResult>): Disposable;
  executeCommand<TResult>(id: string, ...args: unknown[]): Promise<TResult>;
}

export interface WorkspaceApi {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  fs: FileSystemApi;
  getConfiguration(section?: string, scope?: Uri): ConfigurationApi;
  onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
  onDidSaveTextDocument: Event<TextDocument>;
}
```

#### API Principles

- Public APIs use stable data structures, not internal service classes.
- API additions are backward compatible by default.
- API removals require deprecation, telemetry, migration docs, and major version boundary.
- Proposed APIs are gated by explicit extension opt-in and never enabled for marketplace stable extensions by accident.

### Module Permissions Sandbox

```ts
export type ExtensionPermission =
  | { kind: 'fileSystem'; access: 'read' | 'write'; roots: Uri[] }
  | { kind: 'network'; hosts: string[] }
  | { kind: 'process'; commands: string[] }
  | { kind: 'terminal'; access: 'create' | 'write' }
  | { kind: 'secrets'; namespace: string };

export interface PermissionService {
  request(extensionId: string, permission: ExtensionPermission): Promise<'granted' | 'denied'>;
  check(extensionId: string, permission: ExtensionPermission): boolean;
  revoke(extensionId: string, permissionKind: ExtensionPermission['kind']): Promise<void>;
}
```

#### Behavior

- Extensions run with least privilege.
- Workspace trust can deny process, terminal, debug, and arbitrary file write access.
- Web extensions cannot use Node APIs.
- Native extensions run in isolated process with brokered access.

### Module Marketplace

```ts
export interface MarketplaceService {
  search(query: MarketplaceQuery, token: CancellationToken): Promise<MarketplaceSearchResult>;
  getManifest(extensionId: string, version?: string): Promise<ExtensionManifest>;
  install(extensionId: string, options: InstallOptions): Promise<InstalledExtension>;
  uninstall(extensionId: string): Promise<void>;
  checkForUpdates(): Promise<ExtensionUpdate[]>;
}
```

#### Behavior

- Install downloads package to staging, verifies signature/checksum, scans manifest, then atomically moves into extension storage.
- Update never replaces a running extension until reload or host restart boundary.
- Marketplace metadata is cached with expiration and invalidated by explicit refresh.
- Compatibility is checked against IDE engine version, target platform, extension kind, and proposed API gate.

