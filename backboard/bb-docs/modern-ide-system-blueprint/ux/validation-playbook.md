# UX Validation Playbook

## Manual Validation

```sh
# From repository root, inspect blueprint chapters and ensure each required subsystem is present.
find bb-docs/modern-ide-system-blueprint -type f -name '*.md' | sort
rg -n "System ->|export interface|Behavior|Edge Case|Implementation Notes" bb-docs/modern-ide-system-blueprint
```

## Acceptance Criteria

- A senior engineer can find runtime, editor, files, language, rendering, extension, terminal, search, debug, state, input, performance, security, and failure specifications without external context.
- Every major subsystem has typed interfaces or pseudo-code.
- Failure modes are described as required behavior, not merely warnings.

