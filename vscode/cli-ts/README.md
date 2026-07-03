# Backboard R-CLI

Backboard R-CLI is a coding agent that runs in your terminal.

You type what you want. `backboard` can look at files, edit files, run commands, and help you work on a project.

It uses Backboard, so sign in before it can talk to the model.

## What You Need

You need these things:

- A terminal
- [Bun](https://bun.sh)
- A Backboard account
- This repo on your computer

## Quick Start

Go into the repo folder:

```sh
cd q-cli
```

Install the packages:

```sh
bun install
```

Create your `.env` file from the example:

```sh
cp .env.example .env
```

Open `.env` and replace `your_key_here` with your real Backboard API key:

```sh
BACKBOARD_API_KEY=your_real_key
```

Do not share this key. Do not commit `.env` to git.

Now run Backboard R-CLI from source:

```sh
bun run dev
```

You should see the terminal app start.

To use `backboard` from another project, export `BACKBOARD_API_KEY` in that shell or save it in `~/.backboard/config.json`.

Sign out:

```sh
backboard logout
```

You can also type `/login` or `/logout` inside the interactive app. Login updates saved credentials and exits so the next `backboard` start uses the right key; logout removes saved credentials, ends the current Backboard R-CLI session, and keeps the terminal app open for `/login`, `/help`, `/clear`, or `/exit`.

## Build the `backboard` Command

If you want a local `./backboard` command, build it:

```sh
bun run build
```

`backboard login` works out of the box with the built-in first-party client id, so the compiled binary needs no OAuth configuration. Set `BACKBOARD_OAUTH_CLIENT_ID` only if you want to override it; `bun run build` embeds that override when present.

Then run it:

```sh
./backboard
```

Check that it works:

```sh
./backboard --help
```

Check the version:

```sh
./backboard --version
```

## Basic Use

Run `backboard` inside the project you want help with:

```sh
cd /path/to/your/project
/path/to/q-cli/backboard
```

Before you do this, make sure this terminal has `BACKBOARD_API_KEY` set:

```sh
export BACKBOARD_API_KEY=your_key_here
```

Or tell `backboard` which folder to use:

```sh
./backboard --cwd /path/to/your/project
```

Then type a normal request:

```text
find the bug in the login page
```

Another example:

```text
add tests for the user settings form
```

Another example:

```text
explain what this repo does in simple words
```

Backboard R-CLI may read files, edit files, or run commands. Watch what it is doing. If you care about the files, use git so you can review changes.

## Skills

Backboard R-CLI can load reusable agent skills from three places. Skills are not discovered at startup.

A skill folder must contain `SKILL.md`:

```text
.agents/skills/my-skill/SKILL.md
```

The `name` in `SKILL.md` must match the folder name. Run `/skills` in interactive mode to open a picker with three tabs:

- `Repo`: skills from this repo's `.agents/skills`
- `Personal`: skills from `~/.agents/skills`, plus repo skills marked `active`
- `skills.sh`: skills from the public `skills.sh` directory

Use left/right arrows to switch tabs, up/down arrows to choose a skill, type to search the current tab, and Enter to load the selected skill. For `skills.sh` entries, Backboard R-CLI imports the selected skill into this repo with the official `npx skills add ...` command, normalizes the result into `.agents/skills`, then loads it from there. Only selected skills are added to the compact skill catalog for future prompts. Full skill instructions are added only when you explicitly invoke a loaded skill. If a skill ships extra files, activated prompts list those files relative to the skill directory so the agent can read them on demand.

The `skills.sh` tab does not require a Vercel OIDC token. It reads public skills.sh leaderboard pages and caches them for the current `backboard` process. Importing a remote skill needs network access and `npx`.

Invoke a loaded skill directly with a slash command:

```text
/my-skill do the task
```

You can also invoke a skill inside a normal message with `$my-skill`.

## Hooks

Backboard R-CLI can run command hooks at key points in a session. Hook config loads from:

```text
<repo-root>/.backboard/hooks.json
~/.backboard/hooks.json
```

User hooks are trusted by default. Project hooks are skipped until their computed hash is added to `trustedProjectHookHashes` in `~/.backboard/hooks.json`; startup warnings print the hash to trust.

Run `/hooks` in interactive mode to open the hook manager. It shows hook events with configured counts, lets you inspect matchers and hook details, and lets you add or remove personal and project hooks interactively. You can also edit `hooks.json` directly.

Supported events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SessionEnd`

A `PreToolUse` or `PostToolUse` hook whose matcher matches a tool forces that
tool to run serially (hooks carry no concurrency metadata), so a broad matcher
like `*` disables parallel tool execution.

Example:

```json
{
  "trustedProjectHookHashes": ["sha256:..."],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Execute",
        "hooks": [
          {
            "type": "command",
            "name": "shell-policy",
            "command": "node ~/.backboard/hooks/shell-policy.js",
            "timeoutMs": 60000
          }
        ]
      }
    ]
  }
}
```

Hooks receive JSON on stdin and may print JSON on stdout. A hook can block work with:

```json
{ "decision": "deny", "reason": "Blocked by local policy" }
```

`PreToolUse` can also return `hookSpecificOutput.updatedInput` to rewrite a tool input before execution. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` can return `hookSpecificOutput.additionalContext` to add model-visible context. `PostToolUse` can return `hookSpecificOutput.replacementOutput` to replace the tool output sent back to the model.

## MCP Servers

Backboard R-CLI can expose tools from configured Model Context Protocol servers. MCP config is JSON and loads from:

```text
<repo-root>/.backboard/mcp.json
~/.backboard/mcp.json
```

When both files define the same server, user config fields win. Use user config for secrets and personal overrides.

Example:

```json
{
  "timeoutMs": 60000,
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "enabledTools": ["resolve-library-id", "get-library-docs"]
    },
    "linear": {
      "type": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "timeoutMs": 120000
    }
  }
}
```

Supported server types are local `stdio` servers (`command`, `args`, `env`) and Streamable HTTP servers (`type: "http"` or `"streamable-http"`, `url`, `headers`). SSE and MCP resources are not part of v1.

HTTP MCP servers that require OAuth open the system browser, receive the callback through a `localhost` redirect, and store OAuth client/tokens under `~/.backboard/mcp-oauth/` with restrictive file permissions.

Run `/mcp` in interactive mode to manage MCP config. You can add a server from the curated MCP catalog or enter one manually as `name=https://host/mcp` or `name=npx -y package`. The catalog is local data in Backboard R-CLI; it does not fetch the official registry or Glama at runtime. The manager writes new entries to `<repo-root>/.backboard/mcp.json`, connects the new server immediately, and registers its tools for the current session. Server actions can authenticate HTTP servers, disable a server in its owning config file, or remove it from the config file(s) where it was loaded; disable/remove close the live connection and unregister its tools immediately. When a connected server advertises `tools.listChanged`, Backboard R-CLI listens for `notifications/tools/list_changed` and re-lists that server with paginated `tools/list` calls before the next turn so changed tool sets are reflected in the per-turn tool override.

`enabledTools` is an allowlist. If it is present, only those exact MCP tool names are registered. `disabledTools` is a blocklist used only when `enabledTools` is absent. Filtered tools are not sent to the model.

Backboard R-CLI expands `${VAR}` and `${VAR:-fallback}` in `command`, `args`, `env`, `url`, and `headers` when config loads. Missing variables stay unexpanded and produce a warning. The JSON file is never rewritten with expanded values.

MCP tools are registered as `mcp__server__tool` function names. Review project MCP config before running `backboard`; stdio servers start local commands.

## One-Shot Mode

Use `--print` when you want one answer and then exit.

```sh
./backboard --print "summarize this repo"
```

Ask it to work in another folder:

```sh
./backboard --cwd /path/to/your/project --print "find the TODO comments"
```

Use JSON output when another program will read the output:

```sh
./backboard --format json --print "summarize this repo"
```

You can also pipe a prompt into JSON mode:

```sh
echo "summarize this repo" | ./backboard --format json
```

## Commands Inside Backboard R-CLI

These commands start with `/`.

```text
/help
```

Shows the command list.

```text
/model
```

Lets you pick a provider-filtered model, then a thinking mode.

```text
/mcp
```

Opens the MCP server manager.

```text
/hooks
```

Opens the hook manager.

```text
/skills
```

Opens the skill picker.

```text
/cua
```

Enables local computer use for the current session. This exposes the `Computer` tool to Backboard and can capture local screenshots under `~/.backboard/screenshots/<session-id>/`.

```text
/browser
```

Enables the `Browser` tool for the current session. It controls a Chromium tab through Chrome DevTools with browser-specific actions such as navigate, screenshot, click, type, and key. The browser is opened lazily on the first `Browser` tool call, not when `/browser` runs.

Browser mode connects to an existing Chrome/Chromium DevTools endpoint when available, or launches a temporary browser profile when needed. You can override discovery with `Q_BROWSER_CDP_URL`, `Q_BROWSER_WS_URL`, or `Q_BROWSER_PATH`. Backboard R-CLI closes browsers it launches at the end of the turn. `/browser` and `/cua` can both be enabled; they expose separate `Browser` and `Computer` tools.

```text
/clear
```

Clears the visible chat in the terminal.

```text
/exit
```

Quits Backboard R-CLI.

Loaded skills can also be invoked as `/skill-name`.

You can also press `Ctrl+C` twice to quit.

## Common Options

Use a different model:

```sh
./backboard --model openai/gpt-5.5
```

Use a different working folder:

```sh
./backboard --cwd /path/to/project
```

Turn memory on:

```sh
./backboard --memory on
```

Turn memory off:

```sh
./backboard --memory off
```

Set thinking level:

```sh
./backboard --thinking high
```

Hide tools from the agent:

```sh
./backboard --excluded-tools Execute,WebSearch
```

Use the default coding profile:

```sh
./backboard --profile coding
```

Show all options:

```sh
./backboard --help
```

## What Backboard R-CLI Can Do

Backboard R-CLI has tools for common coding work:

- Read files
- Create files
- Edit files
- Run shell commands
- Search files
- Find files by glob
- Fetch a URL
- Search the web
- Ask you a question
- Keep a todo list while it works
- Load reusable skills when you run `/skills`
- Run configured hooks around prompts and tools
- Use configured MCP server tools

Some tools can change your files. Read the terminal output before you accept the result.

## Where Logs Go

Each run writes logs inside the project folder:

```text
.backboard/sessions/<session-id>/
```

The folder contains:

```text
client.jsonl
server.jsonl
meta.json
```

`.backboard/` is ignored by git in this repo. If you use `backboard` inside another project, keep `.backboard/sessions/` ignored unless you want to commit logs. If you intentionally share project MCP or hook config, commit only reviewed `.backboard/mcp.json` or `.backboard/hooks.json` files and keep secrets in `~/.backboard/` or environment variables.

If you want to remove local logs:

```sh
rm -rf .backboard
```

## Environment Variables

`BACKBOARD_API_KEY` is required for normal use. You can set it in `.env` or save it in `~/.backboard/config.json`.

`backboard login` signs in with the OAuth 2.0 device-authorization flow: it prints a
verification URL and a short user code, you open the URL in any browser and
approve, and the CLI saves the returned personal API key in
`~/.backboard/config.json`. It works with no configuration via the built-in
first-party client id.

```sh
backboard login
```

To point at a different OAuth client, set `BACKBOARD_OAUTH_CLIENT_ID`. There is
no client secret — the device flow does not use one.

```sh
BACKBOARD_OAUTH_CLIENT_ID=your_oauth_client_id_here
```

Optional API URL override:

```sh
BACKBOARD_API_URL=https://app.backboard.io/api
```

Most people should not set `BACKBOARD_API_URL`. The default is the production Backboard API.

## Troubleshooting

### `bun: command not found`

Bun is not installed, or your terminal cannot find it.

Install Bun, then close and reopen your terminal.

### `BACKBOARD_API_KEY is not set`

Backboard R-CLI cannot find your API key. Set it in `.env`:

```sh
BACKBOARD_API_KEY=your_key_here
```

Or export it in the shell:

```sh
export BACKBOARD_API_KEY=your_key_here
```

### `Backboard rejected BACKBOARD_API_KEY (HTTP 401)`

Backboard found a key, but it did not accept it.

Check your `.env`:

```sh
BACKBOARD_API_KEY=your_real_key_here
BACKBOARD_API_URL=https://app.backboard.io/api
```

If your key came from the normal Backboard app, use the normal API URL:

```sh
BACKBOARD_API_URL=https://app.backboard.io/api
```

If your shell exports another key, it may override `.env`.

Check with:

```sh
printenv BACKBOARD_API_KEY
```

Stop using the exported key in this terminal:

```sh
unset BACKBOARD_API_KEY
```

### `./backboard: no such file or directory`

You have not built the local command yet.

Run:

```sh
bun run build
```

Then try again:

```sh
./backboard
```

### File search does not work

The search tool uses `rg`, also called ripgrep.

On macOS with Homebrew:

```sh
brew install ripgrep
```

On Ubuntu or Debian:

```sh
sudo apt install ripgrep
```

### The agent changed a file and you do not like it

Use git to inspect the change:

```sh
git diff
```

If you are sure you want to undo one file:

```sh
git restore path/to/file
```

Be careful with undo commands. They can delete work.

## Development

Install packages:

```sh
bun install
```

Run the app from source:

```sh
bun run src/entrypoints/cli.tsx
```

Before you hand back a change, run these:

```sh
bun run validate
bun run build
```

`bun run validate` runs:

```sh
bun run lint
bun run typecheck
bun test
```

Run one check at a time:

Lint:

```sh
bun run lint
```

Apply safe linter fixes:

```sh
bunx biome check --write .
```

Format files:

```sh
bun run format
```

Type check:

```sh
bun run typecheck
```

Test:

```sh
bun test
```

Build:

```sh
bun run build
```

Set up the git pre-commit hook:

```sh
bun run prepare
```

After that, every commit runs:

```sh
bun run precommit
```

That checks lint, typecheck, and tests before git creates the commit.

The package scripts are:

```sh
bun run dev
bun run prepare
bun run precommit
bun run validate
bun run lint
bun run format
bun run typecheck
bun test
bun run build
```
