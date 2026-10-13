# Backboard Desktop: the open-source AI coding agent IDE

**The open-source alternative to Codex, Devin, Claude Code, Higgsfield, and Manus, in one desktop app.**

Backboard Desktop is a free, MIT-licensed AI agent workspace for macOS, Windows, and Linux. Run autonomous coding agents, review their diffs, generate images and video, and let agents drive a browser or your computer, all from a single desktop IDE built on Code - OSS (the open-source core of VS Code). Bring your own Claude or ChatGPT subscription, use your own API keys for OpenAI, Anthropic, Google, xAI, and OpenRouter, or run hosted models through Backboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-informational)](#getting-started)
[![Built on Code - OSS](https://img.shields.io/badge/built%20on-Code%20--%20OSS-007ACC)](https://github.com/microsoft/vscode)
[![GitHub stars](https://img.shields.io/github/stars/Backboard-io/Backboard-Desktop?style=social)](https://github.com/Backboard-io/Backboard-Desktop/stargazers)

[Why Backboard Desktop](#an-open-source-alternative-to-codex-devin-claude-code-higgsfield-and-manus) · [Getting started](#getting-started) · [Features](#features) · [FAQ](#faq) · [Contributing](#contributing) · [License](#license)

## An open-source alternative to Codex, Devin, Claude Code, Higgsfield, and Manus

Most AI agent tools are closed, tied to one model vendor, and split across separate apps: one for coding, one for autonomous tasks, one for AI video. Backboard Desktop puts them in one open-source IDE you can read, fork, and run yourself.

| If you use... | Backboard Desktop gives you |
| --- | --- |
| **OpenAI Codex** | An open-source coding agent that edits, runs, and tests code in your repository. Use your own **ChatGPT subscription** or an OpenAI API key. |
| **Claude Code** | The same agentic coding loop in a full IDE, with a diff review panel. Use your own **Claude subscription** (Pro or Max) or an Anthropic API key. |
| **Devin** | An autonomous AI software engineer workflow: many agent sessions in parallel, each on its own branch or git worktree, all in one sidebar. |
| **Manus** | A general-purpose AI agent that can use a browser and your computer (computer use), search the web, and work through long multi-step tasks. |
| **Higgsfield** | AI image and video generation in the same chat: create, edit, and iterate on images and video clips next to your code. |

Backboard Desktop is an independent project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Cognition, Anthropic, Higgsfield, or Manus; their names are used only to describe comparable features.

## Work your way

Switch between two modes from the title bar:

| Mode | Purpose |
| --- | --- |
| **Simple** | A focused chat workspace for coding agents, with session navigation, file changes, and review tools. |
| **Editor** | The familiar Code - OSS editing experience, including files, terminals, debugging, and extensions. |

### Features

- **AI coding agents:** agents read, write, and run code in your project, with checkpoints you can rewind and a review panel for every change.
- **Bring your own subscription (BYOS):** run agents on your Claude Pro/Max or ChatGPT Plus/Pro plan instead of paying twice.
- **Bring your own key (BYOK):** OpenAI, Anthropic, Google Gemini, xAI Grok, and OpenRouter keys, stored in your OS keychain.
- **Hosted models through Backboard:** Claude, GPT, Gemini, Kimi, DeepSeek, Qwen, GLM, and more from one model picker.
- **Parallel agent sessions:** organize work by project, branch, and session; run agents side by side in isolated git worktrees.
- **Computer use and browser use:** agents can operate a browser and desktop apps to finish tasks end to end.
- **AI image and video generation:** generate and edit images and video from the chat.
- **Skills, MCP, and memory:** extend agents with reusable skills and Model Context Protocol servers, and let them remember context across chats.
- **A real editor:** the Code - OSS editing experience with files, terminals, debugging, and extensions, in the same window.
- **Shared appearance:** use the same theme in Simple and Editor modes.

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

### Telemetry

- **No analytics keys ship in this repository.** Backboard product analytics (PostHog) and
  ad-conversion reporting stay off unless a build supplies a key: official releases stamp
  `backboardAnalytics.posthogKey` into `backboard/product.json` at build time, and builds
  from source send nothing. When enabled, analytics follow the `telemetry.telemetryLevel`
  setting.
- **Computer use** runs the bundled [cua-driver](backboard/cua-driver/README.md). Its usage
  telemetry key is also supplied at build time (`CUA_DRIVER_POSTHOG_KEY`), so a source build
  sends none. In builds that include it, set `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, or
  `"telemetry_enabled": false` in `~/.cua-driver/config.json`, to turn it off.

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
| [`backboard/src/vs/platform/agentHost/`](backboard/src/vs/platform/agentHost/) | Agent process management and provider integrations. |
| [`backboard/cli-ts/`](backboard/cli-ts/) | The Bun/TypeScript agent runtime, tools, skills, and MCP support. |
| [`scripts/`](scripts/) | Release and packaging scripts. |
| [`docs/`](docs/) | Project documentation, assets, and technical references. |

The desktop app runs `cli-ts` as a child process and exchanges messages over standard input and output. The runtime manages the agent loop and tool execution, while the IDE presents conversations, files, and reviews.

## Documentation

- [Remote agent locations (EC2)](docs/cloud-agent-locations.md)
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

## Contributors

Backboard Desktop is built by the goats:

- **Erin Tomorri** ([@ErinTomorri](https://github.com/ErinTomorri)) 
- **Nihal Kodukula** ([@nkodukula-backboard](https://github.com/nkodukula-backboard))

Contributions are welcome; see [Contributing](#contributing).

## FAQ

**Is Backboard Desktop free and open source?**
Yes. The app is released under the MIT License, and you can build it from source on macOS, Windows, and Linux. Hosted models and subscriptions you connect are billed by their providers.

**Is it an open-source alternative to Claude Code and OpenAI Codex?**
Yes. It runs the same kind of agentic coding loop (read, edit, run, test) in a desktop IDE, and it can use your existing Claude or ChatGPT subscription.

**Can it work like Devin or Manus as an autonomous agent?**
Agents can run many sessions in parallel, each in its own git worktree, and can use a browser and your computer to complete multi-step tasks. You review and approve their changes.

**Does it generate images and video like Higgsfield?**
Yes. Image and video generation runs from the same chat that drives your coding agents.

**Which models does it support?**
Claude (Fable, Opus, Sonnet, Haiku), GPT, Gemini, Grok, Kimi, DeepSeek, Qwen, GLM, and any OpenRouter model, through your subscription, your API keys, or Backboard.

**Is it a fork of VS Code?**
It is built on Code - OSS, the MIT-licensed open-source core of Visual Studio Code, and keeps its editor, terminal, debugger, and extension support.

## Credits

**Thank you to Microsoft and the Visual Studio Code community.** Backboard Desktop builds on their work on the editor, workbench, terminal, debugger, extension infrastructure, and developer tooling. The upstream [Code - OSS repository](https://github.com/microsoft/vscode) is the foundation of this project.

We also thank the maintainers and contributors of the open-source dependencies used throughout the app. See [Third-party notices](backboard/ThirdPartyNotices.txt) and individual source files for acknowledgments and license information.

## License

Released under the [MIT License](LICENSE).

The repository retains Microsoft's upstream copyright and license notice in [backboard/LICENSE.txt](backboard/LICENSE.txt). Third-party components retain their respective licenses and notices; see [ThirdPartyNotices.txt](backboard/ThirdPartyNotices.txt).
