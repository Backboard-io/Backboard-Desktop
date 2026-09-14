# Backboard folder audit

Reviewed September 14, 2026. This is a top-level dependency and clutter audit, not a claim that every source file or extension is necessary.

| Folder | Decision and reason |
| --- | --- |
| `.agents/` | Keep the isolated UI launcher and paste helper; remove captured screenshots. |
| `.backboard/` | Remove the committed old session; ignore local runtime state. |
| `.build/` | Keep local Electron, toolchain, and development state; already ignored. |
| `.chat-simulation-data/` | Keep ignored simulation data. |
| `.claude/` | Keep ignored local agent configuration. |
| `.config/` | Keep pipeline baselines and the Guardian suppression file referenced by Windows CI; remove obsolete Node 20 WinGet setup. |
| `.devcontainer/` | Keep optional container development setup. It provides a reproducible development environment. |
| `.eslint-plugin-local/` | Keep; imported by `eslint.config.js`. |
| `.github/` | Keep coding instructions, skills, and upstream engineering configuration. Nested workflows are not root GitHub Actions workflows; relocating or removing their associated engineering system needs a separate migration. |
| `.tmp/` | Keep ignored scratch directory. |
| `.vscode/` | Keep debugging, build tasks, schemas, snippets, and development extensions. Remove Microsoft issue-triage notebooks, old saved searches, and their extension recommendation. |
| `backboard-reference/` | Remove obsolete Rust-bridge snapshots and associated walkthrough. Current runtime documentation is in `cli-ts/README.md` and the root `docs/`. |
| `bb-docs/` | Remove the unreferenced generated documentation snapshot. |
| `build/` | Keep compilation, lint, packaging, platform installers, and CI support. |
| `cli/` | Keep the Rust `code-cli` launcher; distinct from the AI runtime in `cli-ts/`. |
| `cli-ts/` | Keep the active AI runtime, tests, benchmark tools, and current ignored benchmark results/cache. |
| `docs/` | Keep the four recent UI implementation documents. |
| `extensions/` | Keep product extensions, language support, and their build tooling. Disabling individual extensions would change product behavior. |
| `node_modules/` | Keep installed development dependencies; already ignored. |
| `out/`, `out-build/`, `out-vscode-min/` | Keep local compilation and packaging outputs; already ignored. |
| `remote/` | Keep remote extension-host/server dependencies. |
| `resources/` | Keep platform icons, shell completions, and server assets consumed by packaging. |
| `screenshots/` | Keep local ignored captures. |
| `screenshots-vibrancy/` | Remove old tracked UI experiments and ignore future captures. |
| `scripts/` | Keep development, launch, test, and protocol-generation scripts. |
| `src/` | Keep application source, declarations, and compiler configuration. |
| `test/` | Keep unit, integration, smoke, automation, and component-fixture infrastructure. |

The existing `product.json` edit was left untouched. Full application and release builds were not run for these documentation/configuration deletions.
