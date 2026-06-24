# State, Storage, Configuration, Serialization, And Persistence

## System -> State Storage Config

### Module Workspace Schema

```ts
export interface WorkspaceFileSchemaV1 {
  version: 1;
  id: string;
  folders: WorkspaceFolderEntry[];
  settings?: Record<string, unknown>;
  extensions?: { recommendations?: string[]; unwantedRecommendations?: string[] };
  launch?: unknown;
  tasks?: unknown;
}

export interface WorkspaceFolderEntry {
  uri: string;
  name?: string;
}
```

#### Behavior

- Workspace identity is derived from workspace file URI or stable folder root set.
- Multi-root workspace order is user-visible and persisted.
- Workspace file writes are atomic and schema-versioned.
- Unknown fields are preserved during save when possible.

### Module Configuration Hierarchy

```text
Default configuration
  -> Product configuration
  -> Machine configuration
  -> User global configuration
  -> Remote user configuration
  -> Workspace configuration
  -> Workspace folder configuration
  -> Language override configuration
  -> Resource-specific in-memory override
```

```ts
export interface ConfigurationService {
  getValue<T>(key: string, scope?: ConfigurationScope): T;
  updateValue(key: string, value: unknown, target: ConfigurationTarget, scope?: ConfigurationScope): Promise<void>;
  inspect<T>(key: string, scope?: ConfigurationScope): ConfigurationInspection<T>;
  onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
}
```

#### Behavior

- Lower layers override higher layers by key path.
- Language overrides apply only for matching language ID and resource scope.
- Configuration change events include affected keys and scopes.
- Invalid configuration is preserved as text but ignored by runtime with diagnostics.

#### Edge Case

If settings JSON is malformed, keep last known valid configuration active, surface parse diagnostics in settings editor, and block saving through structured settings UI until the file is valid.

### Module Storage Engines

```ts
export interface StorageService {
  get<T>(scope: StorageScope, key: string, defaultValue: T): T;
  set<T>(scope: StorageScope, key: string, value: T): Promise<void>;
  delete(scope: StorageScope, key: string): Promise<void>;
  flush(): Promise<void>;
}

export type StorageScope = 'application' | 'profile' | 'workspace' | 'folder' | 'extensionGlobal' | 'extensionWorkspace';
```

#### Behavior

- Application and profile state use durable local database storage.
- Workspace state uses storage under workspace identity.
- Extension state is namespaced by extension ID and scope.
- Writes are batched but flush synchronously on shutdown and before update.

### Module Persistence Restore

#### Restore Order

```text
startup
  -> product config
  -> user profile
  -> workspace identity
  -> storage database open
  -> layout state restore
  -> editor input restore
  -> backup dirty content restore
  -> extension scan
  -> extension activation by restored views/editors
  -> language services warmup
```

#### Edge Case

If storage database is corrupted, move it to a quarantine path, start with empty state, restore dirty files from backup service, and write a diagnostic report path into logs.

