# IDE Endpoints Docs

This folder is for internal notes about the IDE-side agent/runtime boundary.

- We eventually need local IDE-owned endpoints and should stop relying on the CLI runtime.
- Reasons:
  - Faster startup and less indirection.
  - Web installs should not depend on a separately available CLI runtime.
  - The runtime could be bundled directly into the app/binary.
- For the broader replacement plan, see `ide/docs/BACKBOARD_IDE_EMBEDDED_CLI_NEXT_STEPS.md`.

Could also be bullshit ^ 
