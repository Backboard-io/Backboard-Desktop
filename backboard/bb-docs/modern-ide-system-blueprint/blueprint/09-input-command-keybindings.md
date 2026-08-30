# Input, Commands, Keybindings, Menus, Palette, Mouse, And Gestures

## System -> Input

### Module Keyboard Pipeline

```text
Native keydown
  -> keyboard layout resolver
  -> scan code and key code normalization
  -> focused widget pre-handler
  -> keybinding resolver
  -> command dispatch
  -> command result and telemetry
  -> default browser/native behavior cancellation if handled
```

```ts
export interface KeybindingService {
  registerKeybinding(rule: KeybindingRule): Disposable;
  resolve(event: KeyboardEventLike, context: ContextKeySnapshot): KeybindingResolution;
  dispatch(event: KeyboardEventLike): Promise<boolean>;
  inspect(commandId: string): ResolvedKeybinding[];
}

export interface KeybindingRule {
  command: string;
  key: string;
  when?: string;
  weight: number;
  source: 'default' | 'user' | 'workspace' | 'extension';
}
```

#### Behavior

- Keybindings resolve by key chord, context expression truth, weight, and source precedence.
- User keybindings override defaults and extensions.
- Chords have timeout and visible status feedback.
- Text input widgets can consume keys before global command dispatch when editing text.

#### Conflict Resolution

- Exact same key and context with same weight is conflict.
- More specific context expression wins over broader expression.
- User-defined unbinding removes lower-precedence bindings for the same command/key/context.
- Conflict UI shows command, source extension, when-clause, and effective winner.

### Module Command Palette

```ts
export interface CommandRegistry {
  registerCommand<TArgs extends readonly unknown[], TResult>(descriptor: CommandDescriptor<TArgs, TResult>): Disposable;
  executeCommand<TResult>(id: string, args: unknown[], source: CommandSource, token: CancellationToken): Promise<TResult>;
  getCommands(filter?: CommandFilter): CommandDescriptor<readonly unknown[], unknown>[];
}

export interface CommandDescriptor<TArgs extends readonly unknown[], TResult> {
  id: string;
  title: string;
  category?: string;
  precondition?: string;
  handler(invocation: CommandInvocation<TArgs, TResult>): Promise<TResult> | TResult;
}
```

#### Behavior

- Command palette queries command registry plus recently used commands.
- Commands hidden by preconditions are omitted unless developer mode is active.
- Command execution records source, duration, cancellation, error type, and extension owner when applicable.

### Module Mouse And Pointer

#### Behavior

- Pointer events route to the focused workbench part first, then active widget, then editor contribution handlers.
- Editor mouse handling distinguishes single click, double click, triple click, drag selection, column selection modifier, definition hover modifier, and multi-cursor modifier.
- Tree/list controls use roving tab index and aria-activedescendant for accessibility.
- Context menus are command-backed; menu items evaluate context keys at open time.

### Module Gesture Support

#### Behavior

- Touch scroll maps to native scroll containers.
- Pinch zoom is available only for editor zoom when enabled by setting.
- Swipe navigation is disabled when it conflicts with horizontal editor scrolling.
- Gesture commands are registered through the same command service and can be disabled by accessibility settings.

