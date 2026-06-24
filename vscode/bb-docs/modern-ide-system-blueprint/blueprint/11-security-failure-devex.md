# Security, Failure Modes, Developer Experience, Logging, And Telemetry

## System -> Security

### Module Threat Model

| Asset | Threat | Control |
|---|---|---|
| User files | Malicious extension writes or exfiltrates files. | Permission service, workspace trust, extension isolation, audit logs. |
| Secrets | Extension or webview reads tokens. | Namespaced secret storage, brokered access, OS keychain, explicit grants. |
| Terminal | Extension runs unsafe commands. | Process permission, workspace trust, command allowlist prompts. |
| Network | Extension sends data to unknown host. | Network permission policy and host allowlist. |
| Renderer | Webview escapes sandbox. | Sandboxed frames, CSP, message validation, no Node integration. |

### Module Secrets

```ts
export interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange: Event<{ key: string }>;
}

export interface SecretStorageBroker {
  forExtension(extensionId: string): SecretStorage;
  rotateEncryptionKey(): Promise<void>;
}
```

#### Behavior

- Secrets are scoped by profile, authority, and extension namespace.
- Renderer never receives raw secret material unless a user-approved command requires it.
- Secret reads are logged as metadata only: extension id, key hash, timestamp, result kind.

### Module Webview Security

#### Behavior

- Webviews run in isolated origin with CSP.
- Webview resource loading goes through signed resource URIs.
- Messages from webview to extension are schema-validated.
- Webviews cannot access workspace file URIs directly.

## System -> Failure Modes

### Module Recovery Matrix

| Failure | Detection | Required behavior |
|---|---|---|
| Corrupted workspace storage | Database open or schema validation failure. | Quarantine, start clean, restore backups, report path. |
| Plugin crash | Extension host exit or heartbeat missed. | Restart once, disable crashing extension if repeated, preserve UI. |
| Language server loop | Restart count threshold. | Stop auto restart and expose logs. |
| Network loss | Remote heartbeat failure. | Read-only remote editors, pause terminals, reconnect with backoff. |
| File watcher overflow | Watcher overflow event. | Rescan affected roots and mark index dirty. |
| Memory leak | Memory sampler trend and heap threshold. | Emit diagnostic, trim caches, identify owner when possible. |
| Large file overload | Open size threshold or render stall. | Large-file mode and feature gating. |

### Module Developer Experience

#### Extension Development Workflow

```text
create extension scaffold
  -> validate manifest
  -> run extension host in development mode
  -> attach debugger to extension host
  -> inspect activation events and API calls
  -> package with manifest validation
  -> run compatibility tests
  -> publish signed package
```

#### Language Onboarding Workflow

```text
register language descriptor
  -> add grammar/tokenizer
  -> add language configuration
  -> add LSP client or providers
  -> add tests for completion diagnostics rename formatting
  -> add sample workspace
  -> publish extension or built-in language package
```

#### IDE Self-Debugging

- Main process, renderer, extension host, workers, and remote agent expose inspect/debug ports in development mode.
- Logs are separated by process and authority.
- Diagnostic command exports configuration, process tree, extension activation times, renderer performance samples, and recent errors.

### Module Telemetry Logging

```ts
export interface TelemetryService {
  publicLog(eventName: string, data: Record<string, TelemetryValue>, classification: TelemetryClassification): void;
  flush(): Promise<void>;
}

export interface LogService {
  trace(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
}
```

#### Behavior

- Telemetry is disabled by policy and user setting.
- No file contents, secrets, prompts, terminal output, or source snippets are logged.
- Error telemetry uses hashed identifiers and classified fields.
- Logs are local-first and rotate by size and age.

