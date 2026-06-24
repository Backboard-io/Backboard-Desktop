# Commands Settings Services

## Core Commands

| Command | Behavior |
|---|---|
| `workbench.action.openWorkspace` | Resolve authority, open workspace schema, restore layout. |
| `workbench.action.files.save` | Save active dirty editor through file service. |
| `workbench.action.quickOpen` | Open command/file/symbol quick access. |
| `editor.action.triggerSuggest` | Invoke completion engine. |
| `workbench.action.terminal.new` | Create brokered terminal. |
| `workbench.action.debug.start` | Resolve config and start debug session. |
| `workbench.extensions.install` | Install extension through marketplace service. |

## Settings Families

| Setting family | Scope | Examples |
|---|---|---|
| `editor.*` | user/workspace/folder/language | font, tab size, minimap, large-file behavior. |
| `files.*` | user/workspace/folder | excludes, watcher excludes, encoding, auto-save. |
| `terminal.*` | user/workspace | shell, environment, scrollback. |
| `search.*` | user/workspace | excludes, follow symlinks, index settings. |
| `security.*` | machine/user/workspace | workspace trust, network policy. |
| `extensions.*` | user/workspace | auto update, allowed extensions. |

## Services

```ts
export type UriScheme = 'file' | 'vfs' | 'remote' | 'mem' | 'untitled';

export interface Uri {
  scheme: UriScheme;
  authority: string;
  path: string;
  query: Record<string, string>;
  fragment: string;
}

export interface Disposable {
  dispose(): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

export interface Event<T> {
  subscribe(listener: (event: T) => void, options?: { once?: boolean; priority?: number }): Disposable;
}

export interface CommandInvocation<TArgs extends readonly unknown[], TResult> {
  id: string;
  source: 'user' | 'extension' | 'system' | 'restore' | 'test';
  args: TArgs;
  token: CancellationToken;
  correlationId: string;
}
```

