# User Journeys

## Journey Open Workspace

```text
User selects folder/workspace
  -> runtime resolves authority
  -> workspace schema loads
  -> storage scope opens
  -> layout restores
  -> explorer roots hydrate lazily
  -> active editor input restores
  -> backup service restores dirty content
  -> extensions activate by visible views and opened documents
```

## Journey Edit Code

```text
Keypress
  -> keyboard resolver
  -> command or text input dispatch
  -> text model edit transaction
  -> undo element push
  -> token and AST invalidation
  -> viewport render
  -> diagnostics/completions refresh asynchronously
```

## Journey Install Extension

```text
Search marketplace
  -> fetch signed manifest
  -> compatibility and permission check
  -> download to staging
  -> verify checksum and signature
  -> install atomically
  -> scan contributions
  -> activate only on activation event
```

## Journey Debug Program

```text
Start debug command
  -> resolve launch config
  -> permission and trust check
  -> spawn debug adapter through broker
  -> initialize DAP session
  -> set breakpoints
  -> launch or attach
  -> stream stack/variables lazily
```

