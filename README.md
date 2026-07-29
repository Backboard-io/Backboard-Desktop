# Backboard Desktop

Backboard Desktop is an agent-first IDE. It is a fork of VS Code whose workbench has been
extended with three additional top-level UI layers built specifically for running coding
agents, plus a TypeScript agent runtime (`cli-ts`) that the IDE spawns as a child process.

The short version of the architecture: **the IDE is the surface, `cli-ts` is the brain, and
the Backboard API is the model gateway.** Everything below expands on that.

---

## Repository layout

| Path | What it is |
| --- | --- |
| [vscode/](vscode/) | The product. A VS Code fork (`code-oss-dev` 1.126.0, Electron 42) containing the workbench, the three custom UI layers, and the agent host. |
| [vscode/cli-ts/](vscode/cli-ts/) | **The Backboard backend.** A standalone Bun/TypeScript agent runtime (`backboard-r-cli`) — the agent loop, tool scheduler, MCP client, skills, and hooks. |
| [zed/](zed/) | A Zed checkout (Rust) kept alongside for reference on editor/agent-panel design. Not part of the Backboard build. |
| [backboard-reference/](backboard-reference/) | Read-only snapshot of runtime files grouped by responsibility, so the VS Code host ↔ API ↔ tool-call loop can be read without navigating the whole tree. Edit the originals, not these. |
| [docs/](docs/) | Handoff notes, design docs, test cases. |

Inside `vscode/src/vs/`, beyond the stock VS Code layers (`base`, `platform`, `editor`,
`workbench`, `code`):

| Layer | Purpose |
| --- | --- |
| [sessions/](vscode/src/vs/sessions/) | The **Agents Window** — the Simple mode workbench. Its own layout, parts, and session-provider model. |
| [optimus/](vscode/src/vs/optimus/) | The **Advanced** window — a grid/kanban of many concurrent sessions. |
| [jarvis/](vscode/src/vs/jarvis/) | The **Jarvis** canvas — a cinematic, voice-driven surface with free-floating glass cards. |
| [platform/agentHost/](vscode/src/vs/platform/agentHost/) | The agent host: process management, changesets, checkpoints, git integration, and one subdirectory per agent backend (`cliTs`, `claude`, `codex`, `copilot`, `opencode`). |

Layering rule: `vs/sessions` may import from `vs/workbench` and below, but **`vs/workbench`
must never import from `vs/sessions`**. Enforced by ESLint — see
[LAYERS.md](vscode/src/vs/sessions/LAYERS.md).

---

## Running it

### Prerequisites

| Requirement | Why |
| --- | --- |
| **Node v24.15.0** | Pinned in [.nvmrc](vscode/.nvmrc). The major version must match exactly. |
| **Xcode Command Line Tools** (macOS) | `@vscode/spdlog`, `node-pty`, `native-keymap` and `@vscode/sqlite3` compile through `node-gyp`. Without a compiler `npm install` **rolls back completely** — you get no `node_modules` at all, not a partial one. |
| **Bun** | `cli-ts` is a Bun project. In a dev checkout there is no packaged binary, so the agent host shells out to `bun run cli-ts/src/entrypoints/cli.tsx`. Without Bun the app launches but every agent request fails with `BackboardSendFailed`. |

### One command

```bash
cd vscode
./scripts/dev.sh
```

That installs what is missing, fetches Electron, starts the incremental watcher, waits for
the first build to genuinely finish, launches the app, and then supervises it. Ctrl-C stops
the watcher and the app together.

```bash
./scripts/dev.sh doctor   # check every prerequisite, with the fix for each
./scripts/dev.sh watch    # watcher only
./scripts/dev.sh run      # launch against the current build
./scripts/dev.sh logs     # follow the build log
./scripts/dev.sh status
./scripts/dev.sh stop
```

Full details in [vscode/DEV_ENVIRONMENT.md](vscode/DEV_ENVIRONMENT.md).

### You do not rebuild by hand

With the watcher running, `npm run compile` is never the right move:

| Changed | Do this |
| --- | --- |
| Workbench / renderer / any `src/vs/**` UI code | **Cmd+R** in the window |
| Main-process code (`src/vs/code/electron-main/**`) | Nothing — `dev.sh` relaunches automatically |
| An extension under `extensions/**` | Cmd+R |
| `cli-ts` source | Nothing — it is spawned fresh per session and Bun transpiles on the fly |
| `package.json` dependencies | `./scripts/dev.sh setup` |

### Two gotchas that will cost you an hour

**Launching from inside a running Backboard/VS Code window.** The child inherits
`ELECTRON_RUN_AS_NODE=1`, so the Electron binary starts as plain Node and dies with a
misleading `SyntaxError: The requested module 'electron' does not provide an export named
'Menu'`. It is an environment leak, not a build failure. `./scripts/dev.sh run` scrubs it;
for a manual launch use `env -u ELECTRON_RUN_AS_NODE ./run-backboard-ide.sh`.

**`cli-ts` is a separate workspace.** It has its own `bun.lock` and is *not* covered by the
root `npm install`. A missing `bun install` there surfaces as
`Cannot find package 'ink'`:

```bash
cd vscode/cli-ts && bun install
```

---

## The four modes

The app is really four different windows over the same workspace. Internally they are window
*kinds* — `'editor' | 'agents' | 'jarvis' | 'optimus'`
([jarvisBridge.ts:109](vscode/src/vs/jarvis/electron-browser/jarvisBridge.ts#L109)).

| Mode | Window kind | Layer | For |
| --- | --- | --- | --- |
| **Simple** | `agents` | `vs/sessions` | Talking to one or a few agents. The default agent experience. |
| **Editor** | `editor` | `vs/workbench` | Ordinary VS Code. Files, terminal, debugger, extensions. |
| **Advanced** | `optimus` | `vs/optimus` | Supervising many concurrent sessions at once. |
| **Jarvis** | `jarvis` | `vs/jarvis` | Voice-driven, spatial canvas. |

The title-bar switcher exposes three of them — Editor, Advanced, Simple — in a fixed order so
each keeps its position regardless of which window you are in
([backboardModeSwitcherActions.ts:174-193](vscode/src/vs/workbench/contrib/chat/electron-browser/backboardModeSwitcher/backboardModeSwitcherActions.ts#L174-L193)).
Jarvis is the fourth kind and is reached through the Jarvis bridge rather than that menu.

You can also boot straight into Simple mode:

```bash
./run-backboard-ide.sh   # passes --agents
```

`--agents` is a real CLI flag ([argv.ts:111](vscode/src/vs/platform/environment/node/argv.ts#L111)).

### Simple — the Agents Window

A deliberately reduced workbench: no activity bar, no status bar, no banner, and a layout
that is **not** user-configurable.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                  Titlebar                                   │
├─────────┬───────────────────────────┬───────────────┬──────────────────────┤
│         │       Sessions Part       │ Editor (hid.) │    Auxiliary Bar     │
│ Sidebar ├───────────────────────────┴───────────────┴──────────────────────┤
│         │                              Panel                               │
└─────────┴──────────────────────────────────────────────────────────────────┘
```

| Part | Default | Holds |
| --- | --- | --- |
| Titlebar | Always visible | Session picker, toggles, account widget |
| Sidebar (300px) | Visible | The sessions list |
| **Sessions Part** | Visible | The primary surface — an *internal* grid of one or more session views |
| Editor | **Hidden** | Only for explicit editor workflows; opens as a **modal overlay** |
| Auxiliary Bar (340px) | Visible | Changes view, file tree |
| Panel (300px) | Hidden | Terminal, debug output |

The Sessions Part never renders a chat itself — it owns a `SerializableGrid` of session
views, each rendering the active chat of its own session. That inner grid is private to the
part and is not part of the workbench grid.

The titlebar is a standalone `TitlebarPart` (it does not extend `BrowserTitlebarPart`) with
three menu-driven sections:

- **Left** — sidebar toggle, and an agent-host filter pill that scopes the window to one
  remote host when several are known.
- **Center** — the session picker, showing provider icon, session title, workspace name, git
  branch or worktree in parentheses, and a `+insertions -deletions` summary when the session
  has pending changes. It hides its chrome entirely when no session is active.
- **Right** — Run Script split button, Open Terminal / Open in VS Code, auxiliary-bar toggle,
  and the account widget.

Layout state is **per session**: the auxiliary bar, panel, and editor working set are
captured and restored as you switch sessions — see
[LAYOUT_CONTROLLER.md](vscode/src/vs/sessions/LAYOUT_CONTROLLER.md).

Reference: [LAYOUT.md](vscode/src/vs/sessions/LAYOUT.md),
[SESSIONS.md](vscode/src/vs/sessions/SESSIONS.md).

### Editor — stock VS Code

The unmodified workbench. Switching *into* Editor mode restores the left, bottom, and right
panels unless you previously closed them yourself while in Editor mode — that intent is
remembered per part in profile storage, so the mode switcher does not fight your layout. When
the bottom panel is restored, the Terminal view is made active rather than Problems or Output.

### Advanced — Optimus

A multi-session command surface with two view modes, persisted across restarts:

- **Grid** — every session as a card, running side by side.
- **Kanban** — the same sessions bucketed by status:

  | Bucket | Status |
  | --- | --- |
  | Running | `InProgress` |
  | Needs Attention | `NeedsInput`, `Error` |
  | Done | everything else |

Commands: `optimus.newSession`, `optimus.focusSession`, `optimus.deleteSession`,
`optimus.closeSession`, `optimus.toggleViewMode`, `optimus.setViewMode`. The current mode is
exposed as the `optimusViewMode` context key so chrome buttons mirror it.

### Jarvis — the canvas

A cinematic surface of free-floating glass cards over a cycling backdrop, driven by voice as
much as by clicking. The launcher offers six tiles:

| Tile | Does |
| --- | --- |
| Backboard Agent | Starts a native Backboard coding agent |
| **BYOS Agent** | Pick any connected non-Backboard agent provider |
| Terminal | Attaches a live shell to a glass card |
| Browser | Opens a real integrated browser view |
| File | Opens a file and reveals the editor |
| Backdrop | Cycles the canvas worlds |

Jarvis runs its own main-process bridge (`IJarvisBridge`) over dedicated IPC channels for
terminal I/O, workspace-folder selection, window-kind switching, voice transcription
(`vscode:jarvisVoiceTranscribe`), and natural-language command interpretation
(`vscode:jarvisInterpretCommand`). It manages four terminal slots with their own lifecycle
and tab bar. See [JARVIS.md](vscode/src/vs/jarvis/JARVIS.md).

---

## BYOS — Bring Your Own Session

BYOS is how non-Backboard agents plug in. Backboard's own agent is the native, first-class
path; **BYOS is everything else** — Claude, Codex, OpenCode, and any future external or
remote agent host.

The important design point: *BYOS is a presentation category, not a hard-coded provider
list.* It is built at runtime from `ISessionsProvidersService.getProviders()` and
`ISessionsManagementService.getSessionTypesForFolder(...)`, filtered to agent-host session
types with Backboard itself excluded. New providers appear automatically, and generic Cloud
or Local session modes never leak into the picker
([JARVIS_UNLIMITED_CANVAS_SPEC.md:455](vscode/src/vs/jarvis/JARVIS_UNLIMITED_CANVAS_SPEC.md)).

Backends live under [platform/agentHost/node/](vscode/src/vs/platform/agentHost/node/) — one
directory each for `cliTs`, `claude`, `codex`, `copilot`, and `opencode`. Sessions can run
locally, over SSH, through a tunnel, or in WSL
(`sshRemoteAgentHostService.ts`, `tunnelAgentHostService.ts`, `wslRemoteAgentHostService.ts`).

Do not confuse BYOS with **BYOK** (bring your own key), which is about model providers and
API keys rather than agent backends.

---

## The Backboard backend (`cli-ts`)

[`vscode/cli-ts/`](vscode/cli-ts/) is `backboard-r-cli`: a self-contained Bun + React/Ink
agent runtime. It is a real standalone CLI that also happens to be what the IDE drives.

### How the IDE talks to it

The IDE spawns it as a child process and speaks line-delimited JSON over stdio. Resolution
order for the executable
([cliTsProcess.ts:245-271](vscode/src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts#L245-L271)):

1. `BACKBOARD_CLI_TS_PATH` / `VSCODE_BACKBOARD_CLI_TS_PATH` env override
2. The packaged binary at `extensions/backboard/bin/backboard-cli-ts`
3. **Dev fallback:** `<bun> run cli-ts/src/entrypoints/cli.tsx`

Bun itself is looked up via `BACKBOARD_BUN_PATH` / `BUN_PATH`, then `$BUN_INSTALL/bin/bun`,
`~/.bun/bin/bun`, `node_modules/.bin/bun`, Homebrew paths, then `PATH`.

It is launched with `--serve --cwd <workspace>` and replies `serve:ready`. Per-session logs
and scratch files are forced to `~/.backboard_ide/cli-ts-sessions` via
`BACKBOARD_SESSION_ROOT` so agent scratch never shows up as file edits in the Changes view.

To skip the Bun path entirely, build the real binary once:

```bash
npm --prefix extensions/backboard run package-cli-ts
```

### What is inside it

```
cli.tsx ──> config ──> bus ──> AgentController ──> AgentLoop ──> providers/backboard
                                     │                  │
                                     │                  └──> ToolScheduler ──> tools
                                     ├──> SkillController ──> skills
                                     ├──> MCPController ──> mcp
                                     └──> hooks
                                              bus ──> session ──> state ──> ui
```

The agent loop calls the Backboard provider for completions and hands tool calls to
`ToolScheduler`, which runs hooks before and after each tool. Everything flows through an
event bus that feeds session logging, state, and the Ink UI. Full detail in
[ARCHITECTURE.md](vscode/cli-ts/ARCHITECTURE.md); user-facing docs including skills, hooks,
MCP servers, and one-shot mode in [README.md](vscode/cli-ts/README.md).

Working on it directly:

```bash
cd vscode/cli-ts
bun install
bun run dev          # interactive
bun run validate     # lint + typecheck + test
```

> Note: running `cli-ts` standalone reads credentials from a **different** directory than the
> IDE does. See the caveat below.

---

## Where API keys live on your machine

Two separate stores, for two separate purposes.

### 1. Backboard credentials — `~/.backboard_ide/config.json`

Created at sign-in (SSO or manual key entry) with mode `0600`. Shape is snake_case:

```jsonc
{
  "env": "prod",
  "api_key": "…",
  "env_keys": { "prod": "…" },   // per-environment keys
  "oauth":    { "access_token": "…" }
}
```

Resolution order in `bridgeConfig()`
([backboardRuntimeShared.ts:583-647](vscode/src/vs/platform/agentHost/node/cliTs/backboardRuntimeShared.ts#L583-L647)):

```
BACKBOARD_API_KEY  →  VSCODE_BACKBOARD_API_KEY  →  config.api_key  →  config.apiKey  →  config.env_keys[env]
```

with `oauth.access_token` resolved separately as the access token, and the API URL falling
back to `https://app.backboard.io/api`.

**The key is never read from disk by the agent.** The host resolves it and *injects* it as
`BACKBOARD_API_KEY` / `BACKBOARD_API_URL` into the spawned `cli-ts` environment
([cliTsCredentialEnv()](vscode/src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts#L316-L326)),
and `cli-ts` checks `process.env` before touching any file
([env.ts:57](vscode/cli-ts/src/config/env.ts#L57)).

> **Caveat worth knowing.** `cli-ts`'s own on-disk fallback points at `~/.backboard/`, not
> `~/.backboard_ide/` ([backboardConfig.ts:18](vscode/cli-ts/src/config/backboardConfig.ts#L18),
> [paths.ts:5](vscode/cli-ts/src/config/paths.ts#L5)). Inside the IDE this never fires,
> because env injection always wins. But run `cli-ts` standalone and it will insist
> `BACKBOARD_API_KEY is not set` even though you are signed in. The same split applies to
> user-level `mcp.json` and `hooks.json`, which resolve under `~/.backboard/`.

Also under `~/.backboard_ide/`: `cli-ts-sessions.json` and `cli-ts-sessions/` (session
history and scratch), `models-cache.json`, and `workspace/`.

### 2. Model provider keys (BYOK) — OS keychain

Third-party model keys do **not** go in a dotfile. They are held by
`ISecretStorageService`, which is backed by the OS credential store
([languageModels.ts:759](vscode/src/vs/workbench/contrib/chat/common/languageModels.ts#L759)).

### Overriding without storing anything

Every credential can be supplied as an environment variable instead, which takes priority
over both stores. `run-backboard-ide.sh` sources a `.env` from the **repository root** (one
level above `vscode/`), so a local `.env` there is the least invasive way to point a dev
build at a different environment:

```bash
BACKBOARD_API_KEY=...
BACKBOARD_API_URL=https://app.backboard.io/api
BACKBOARD_ENV=prod
```

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `npm error gyp ERR! find Python` and no `node_modules` afterwards | No Xcode Command Line Tools. npm rolled the install back. `xcode-select --install`. |
| `does not provide an export named 'Menu'` | `ELECTRON_RUN_AS_NODE=1` inherited from a parent IDE. Use `./scripts/dev.sh run`. |
| `BackboardSendFailed` + `Cannot find package 'ink'` | `cli-ts` deps not installed. `cd vscode/cli-ts && bun install`. |
| `BackboardSendFailed` + "Bun is not available" | Install Bun, set `BACKBOARD_BUN_PATH`, or run `npm --prefix extensions/backboard run package-cli-ts`. |
| `BACKBOARD_API_KEY is not set` while running `cli-ts` standalone | The `.backboard` vs `.backboard_ide` split above. Export the key, or run through the IDE. |
| App launches against a half-built `out/` | Something used a fixed `sleep` instead of waiting for the build. `dev.sh` waits for the real completion marker. |

---

## License

[MIT](vscode/LICENSE.txt).
