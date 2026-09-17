# Backboard Desktop

An open-source desktop IDE for working with coding agents, reviewing their changes, and editing code in one workspace.

Backboard Desktop is built on **[Visual Studio Code — Code - OSS](https://github.com/microsoft/vscode)**, created by Microsoft and the VS Code community. It extends that foundation with agent workflows, multiple work modes, and the Backboard runtime. This is an independently maintained fork.

[Getting started](#getting-started) · [Documentation](#documentation) · [Contributing](#contributing) · [Credits](#credits) · [License](#license)

## Work your way

Switch between three modes from the title bar:

| Mode | Purpose |
| --- | --- |
| **Simple** | A focused chat workspace for coding agents, with session navigation, file changes, and review tools. |
| **Editor** | The familiar Code - OSS editing experience, including files, terminals, debugging, and extensions. |
| **Advanced** | A workspace for supervising concurrent agent sessions in grid or kanban views. |

### Features

- **Multiple agent sessions:** organize work by project, branch, and session, with saved layouts.
- **Backboard integration:** run coding agents through the Backboard API and the bundled TypeScript runtime.
- **Agent providers:** integrations for Backboard, Claude, Codex, and Copilot. Availability depends on provider setup and authentication.
- **Review tools:** inspect changed files and diffs alongside the conversation.
- **Integrated tools:** work with an editor, terminal, and browser inside the app.
- **Skills and MCP:** extend agent workflows with reusable instructions and external tools.
- **Shared appearance:** use the same theme across Simple, Editor, and Advanced modes.

Agent integrations require the credentials or accounts for the services you choose. Access to hosted services is separate from this repository's source-code license.

### Security and credentials

- **Backboard API key:** stored in `~/.backboard_ide/config.json`. The agent never reads it
  from disk — the host injects it as `BACKBOARD_API_KEY` / `BACKBOARD_API_URL` into the
  spawned `cli-ts` environment, and `cli-ts` checks `process.env` before touching any file.
- **BYOK (bring your own key) for OpenAI, Anthropic, Google, xAI, and OpenRouter:** keys are
  added on the API Keys page (account menu, or "Backboard: API Keys" in the command
  palette). The Electron main process is the single owner: it validates a key through the
  runtime, then saves it as an encrypted `secret://` entry in application storage — the
  same keychain-backed store `ISecretStorageService` uses — and activates it in the agent
  host. The host hands the key set to each `cli-ts` serve process over stdin, never through
  argv, the environment, or a file.
- **Key-billed models** appear in the model picker as their own sections next to the
  Backboard-routed and subscription models. The selected model is the billing route:
  adding or removing a key never silently changes what an existing session bills to.
- Every Backboard credential can be overridden via environment variables for CI or local
  development. Provider keys deliberately cannot.

## Getting started

### Run from source on macOS

The development launcher below uses the macOS toolchain. Platform packaging instructions are linked under [Documentation](#documentation).

Install these prerequisites:

- **Git** to clone the repository.
- **Node.js 24.15.0**, pinned in [`.nvmrc`](backboard/.nvmrc), with npm.
- **Bun** to run the TypeScript agent runtime in a development checkout.
- **Xcode Command Line Tools** for native dependencies. Install them with `xcode-select --install`.

```bash
git clone https://github.com/Backboard-io/Backboard-Desktop.git
cd Backboard-Desktop/backboard

# If you use nvm:
nvm install
nvm use

# Install the agent runtime's separate dependencies.
(cd cli-ts && bun install)

# Check prerequisites, then build and launch the app.
./scripts/dev.sh doctor
./scripts/dev.sh
```

If you manage Node with another tool, select the version in `.nvmrc` before running the commands above and skip the two `nvm` commands.

The launcher installs editor dependencies when needed, downloads Electron, starts the incremental build, and waits for it to finish before opening the app. The first build can take several minutes. Press **Ctrl+C** to stop the supervised app and watcher.

### Run from source on Windows

Use native Windows PowerShell. Install **Git**, **Node.js 24.15.0** with npm, **Bun**, and **Python 3** on your `PATH`. Install **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload, a Windows SDK, and the MSVC, ATL, and MFC Spectre-mitigated libraries for your architecture. Reopen PowerShell after installing the tools.

This fork's install script detects Visual Studio 2022 or 2019; use 2022. The [upstream build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites) describe the native dependencies, but may target a newer compiler than this checkout.

```powershell
git clone https://github.com/Backboard-io/Backboard-Desktop.git
Set-Location Backboard-Desktop\backboard

node --version  # should print v24.15.0
python --version
bun --version
npm ci

Push-Location cli-ts
bun install
Pop-Location

# Keep this terminal open while developing.
npm run watch
```

Wait for the initial client, extension, and Copilot builds to finish without errors. In a **second PowerShell terminal**, from the repository root:

```powershell
Set-Location backboard
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\scripts\code.bat
```

The launcher downloads Electron and prepares built-in extensions. For UI changes, wait for the watcher and run **Developer: Reload Window** in the app. Restart the app after main-process changes. Stop the watcher with **Ctrl+C** when finished.

### Run from source on Linux

The following native dependency command targets **Ubuntu 22.04 x86_64**, matching the repository's [Linux build image](scripts/linux-release/Dockerfile). Other distributions and Ubuntu versions may use different package names. Use a graphical desktop session to launch the app.

```bash
sudo apt-get update
sudo apt-get install -y \
  git build-essential pkg-config python3 python-is-python3 \
  libx11-dev libx11-xcb-dev libxkbfile-dev libxkbcommon-dev \
  libxkbcommon-x11-dev libsecret-1-dev libkrb5-dev \
  libgtk-3-0 libnss3 libasound2 libatk-bridge2.0-0 libdrm2 \
  libgbm1 libnotify4 libxdamage1 libxrandr2 libxss1 libu2f-udev \
  dbus-x11 xdg-utils
```

Install **Node.js 24.15.0** with npm and **Bun**, then clone and build:

```bash
git clone https://github.com/Backboard-io/Backboard-Desktop.git
cd Backboard-Desktop/backboard

# If you use nvm; otherwise select the version in .nvmrc yourself.
nvm install
nvm use

npm ci
(cd cli-ts && bun install)

# Keep this terminal open while developing.
npm run watch
```

Wait for the initial client, extension, and Copilot builds to finish without errors. In a **second terminal**, from the repository root:

```bash
cd backboard
env -u ELECTRON_RUN_AS_NODE ./scripts/code.sh
```

The launcher downloads Electron and prepares built-in extensions. For UI changes, wait for the watcher and run **Developer: Reload Window** in the app. Restart the app after main-process changes. Stop the watcher with **Ctrl+C** when finished.

### Connect an agent

Open the app and complete the sign-in or provider setup for your chosen integration. For local Backboard development, you can supply credentials through environment variables in the launch terminal:

macOS:

```bash
export BACKBOARD_API_KEY="your-api-key"
./scripts/dev.sh
```

Linux (with the watcher running):

```bash
export BACKBOARD_API_KEY="your-api-key"
env -u ELECTRON_RUN_AS_NODE ./scripts/code.sh
```

Windows PowerShell (with the watcher running):

```powershell
$env:BACKBOARD_API_KEY = "your-api-key"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\scripts\code.bat
```

The IDE passes resolved Backboard credentials to the agent process. The standalone CLI also supports environment variables; see the [CLI runtime guide](backboard/cli-ts/README.md) for its configuration and provider options.

## Development

Run these commands from `backboard/`. The `dev.sh` supervisor is for macOS; Windows and Linux use `npm run watch` with the launch commands above.

| Command | Purpose |
| --- | --- |
| `./scripts/dev.sh` | Set up, build, launch, and watch for changes. |
| `./scripts/dev.sh doctor` | Check the local toolchain. |
| `./scripts/dev.sh setup` | Install editor dependencies and download Electron. |
| `./scripts/dev.sh logs` | Follow build output. |
| `./scripts/dev.sh status` | Inspect the development processes. |
| `./scripts/dev.sh stop` | Stop the app and watcher. |
| `npm run watch` | Watch client and extension builds on any platform. |
| `npm run typecheck-client` | Type-check the main application sources. |

After changing renderer code, wait for the watcher to finish and run **Developer: Reload Window** (**Cmd+R** on macOS). The macOS supervisor relaunches after main-process changes; restart manually on Windows and Linux. See the [development guide](backboard/DEV_ENVIRONMENT.md) for the full workflow and troubleshooting.

To work on the agent runtime separately:

```bash
cd backboard/cli-ts  # from the repository root
bun install
bun run dev
bun run validate
```

### Repository layout

| Path | Contents |
| --- | --- |
| [`backboard/`](backboard/) | The Code - OSS fork, application source, built-in extensions, and build tooling. |
| [`backboard/src/vs/sessions/`](backboard/src/vs/sessions/) | Agent workspace UI, session navigation, and chat surfaces. |
| [`backboard/src/vs/optimus/`](backboard/src/vs/optimus/) | Advanced mode's session grid and kanban UI. |
| [`backboard/src/vs/platform/agentHost/`](backboard/src/vs/platform/agentHost/) | Agent process management and provider integrations. |
| [`backboard/cli-ts/`](backboard/cli-ts/) | The Bun/TypeScript agent runtime, tools, skills, and MCP support. |
| [`scripts/`](scripts/) | Release and packaging scripts. |
| [`docs/`](docs/) | Project documentation, assets, and technical references. |

The desktop app runs `cli-ts` as a child process and exchanges messages over standard input and output. The runtime manages the agent loop and tool execution, while the IDE presents conversations, files, and reviews.

## Documentation

- [Documentation index](docs/README.md)
- [Development environment](backboard/DEV_ENVIRONMENT.md)
- [CLI runtime and configuration](backboard/cli-ts/README.md)
- [Sessions architecture and layering](backboard/src/vs/sessions/LAYERS.md)
- [Session layout](backboard/src/vs/sessions/LAYOUT.md)
- [Windows packaging](scripts/windows-release/README.md)
- [Linux packaging](scripts/linux-release/README.md)
- [macOS installer assets](scripts/dmg-assets/README.md)

## Contributing

Bug reports, documentation improvements, and code contributions are welcome.

1. Search this repository's [issues](https://github.com/Backboard-io/Backboard-Desktop/issues) for an existing report. Include your operating system, app version or commit, reproduction steps, and expected behavior when filing a bug.
2. For substantial changes, open an issue first to discuss the approach.
3. Fork the repository, create a branch, and keep each pull request focused on one change.
4. Follow the surrounding code style and [layering rules](backboard/src/vs/sessions/LAYERS.md). Run the relevant checks and describe what you tested in your pull request.
5. Submit your pull request to [Backboard Desktop](https://github.com/Backboard-io/Backboard-Desktop/pulls).

Report Backboard-specific issues here. The inherited [VS Code contribution guide](backboard/CONTRIBUTING.md) documents upstream practices and links to Microsoft's project; use those channels for issues or contributions that belong upstream.

## Credits

**Thank you to Microsoft and the Visual Studio Code community.** Backboard Desktop builds on their work on the editor, workbench, terminal, debugger, extension infrastructure, and developer tooling. The upstream [Code - OSS repository](https://github.com/microsoft/vscode) is the foundation of this project.

We also thank the maintainers and contributors of the open-source dependencies used throughout the app. See [Third-party notices](backboard/ThirdPartyNotices.txt) and individual source files for acknowledgments and license information.

## License

Released under the [MIT License](backboard/LICENSE.txt).

The repository retains Microsoft's upstream copyright and license notice. Third-party components retain their respective licenses and notices; see [ThirdPartyNotices.txt](backboard/ThirdPartyNotices.txt).
