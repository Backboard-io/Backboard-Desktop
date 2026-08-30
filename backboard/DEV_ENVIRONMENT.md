# Dev environment

One script drives the whole loop: [scripts/dev.sh](scripts/dev.sh).

```bash
./scripts/dev.sh doctor   # what is installed, what is missing
./scripts/dev.sh          # deps -> watcher -> launch, and stay up
```

`./scripts/dev.sh` with no arguments installs anything missing, starts the incremental
watcher, waits for the first build to actually finish, launches Backboard Studio, and then
keeps supervising. Ctrl-C stops the watcher and the app together.

## You should not be rebuilding by hand

Once the watcher is running, `npm run compile` is never the right move:

| You changed | What to do |
| --- | --- |
| Workbench / renderer / any `src/vs/**` UI code | **Cmd+R** in the running window |
| Main-process code (`src/vs/code/electron-main/**`, `src/main.ts`) | nothing — the app relaunches itself |
| An extension under `extensions/**` | Cmd+R (or Developer: Reload Window) |
| `package.json` dependencies | `./scripts/dev.sh setup` |

Renderer code is loaded from `out/` at window-load time, so a reload is enough; the watcher
has already transpiled the file by the time you press Cmd+R. Only the Electron main process
needs a real relaunch, and `dev.sh` does that for you when it sees `out/main.js`,
`out/bootstrap-esm.js`, or `out/vs/code/electron-main/**` change. Pass `--no-restart` if you
would rather relaunch yourself.

## Commands

| Command | What it does |
| --- | --- |
| `./scripts/dev.sh` | Everything: setup if needed, watch, launch, auto-relaunch |
| `./scripts/dev.sh doctor` | Toolchain report with the fix for each missing piece |
| `./scripts/dev.sh setup` | `npm install` plus the Electron download |
| `./scripts/dev.sh watch` | Watcher only, no launch |
| `./scripts/dev.sh run` | Launch against whatever is already built |
| `./scripts/dev.sh logs` | Follow the watcher log |
| `./scripts/dev.sh status` | Is the watcher up, is the app up, is `out/` built |
| `./scripts/dev.sh stop` | Stop both |

Logs live in `.build/dev/` (`watch.log`, `app.log`), which is gitignored.

## Prerequisites

`./scripts/dev.sh doctor` checks all of these and prints the fix for whatever is missing.

- **Node v24.15.0** (pinned in [.nvmrc](.nvmrc)). `dev.sh` finds Node in `~/.local`,
  `~/.nvm`, the Codex runtime cache, or Homebrew, so it works even when your GUI shell has
  no Node on `PATH`.
- **Xcode Command Line Tools.** Required — the build compiles native modules
  (`@vscode/spdlog`, `node-pty`, `native-keymap`, `@vscode/sqlite3`, …) against the macOS
  SDK. Without them `npm install` rolls back and you end up with no `node_modules` at all.

  ```bash
  xcode-select --install
  ```

  This opens a system dialog and needs your admin password; it cannot be scripted. It also
  supplies the working `git` and `python3` that node-gyp needs.

- **Bun**, at `~/.bun/bin/bun`. A dev checkout has no packaged `backboard-cli-ts` binary, so
  the agent host falls back to `bun run cli-ts/src/entrypoints/cli.tsx`
  ([cliTsProcess.ts](src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts#L261-L268)).
  Without it the app launches fine but every agent request fails with
  `BackboardSendFailed`.

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

  The alternative is building the real binary once:
  `npm --prefix extensions/backboard run package-cli-ts`.

## Launching from inside a running Backboard/VS Code window

`dev.sh` scrubs `ELECTRON_RUN_AS_NODE` and the host's `VSCODE_*` variables before starting
the app. If you launch `run-backboard-ide.sh` by hand from a terminal *inside* a running
Backboard Studio, those get inherited and the Electron binary starts as plain Node, which
dies immediately with:

```
SyntaxError: The requested module 'electron' does not provide an export named 'Menu'
```

That is an environment leak, not a build failure. Use `./scripts/dev.sh run`, or
`env -u ELECTRON_RUN_AS_NODE ./run-backboard-ide.sh`.

## First build takes a while

The initial transpile of `src/` is several minutes. `dev.sh` waits for the real completion
marker rather than sleeping a fixed amount, and prints progress every 30s. Every build after
that is incremental.
