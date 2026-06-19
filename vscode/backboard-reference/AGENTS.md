# Backboard Rewire Agent Instructions

Use this file as the starting point for future agent work on the Backboard/Copilot/Sandbox rewire.

This folder is a reference pack, not the source of truth for product code. Read the docs here to understand the plan, then edit the original source files under:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode
```

## Read These First

Start with the simple checklist:

```text
docs/SIMPLE_BACKBOARD_REWIRE_CHECKLIST.md
```

Then read the detailed implementation plan:

```text
docs/BACKBOARD_COPILOT_REWIRE_PLAN.md
```

Then read the wiring map:

```text
docs/SANDBOX_COPILOT_WIRING.md
```

Then read the Zed workspace mapping when implementing the new agents/editor page:

```text
docs/BACKBOARD_AGENT_WORKSPACE_FROM_ZED.md
```

Use the other docs for deeper context:

```text
docs/TOOL_CALLS_AND_API.md
docs/ENDPOINTS.md
docs/SSO.md
docs/CREDENTIALS.md
docs/EXTENSION.md
```

## What Each Doc Is For

### `SIMPLE_BACKBOARD_REWIRE_CHECKLIST.md`

Use this when you need the short order of operations.

It says:

1. Prove Backboard works alone.
2. Wire Sandbox to Backboard.
3. Wire normal Chat to Backboard.
4. Update `product.json`.
5. Clean up UI text.
6. Compile and smoke test after every step.

### `BACKBOARD_COPILOT_REWIRE_PLAN.md`

Use this when you are ready to implement.

It gives phase-by-phase details:

- goals
- files to touch
- checks to run
- exit criteria before moving on

Follow this doc when deciding whether a section is actually done.

### `SANDBOX_COPILOT_WIRING.md`

Use this when deciding what code owns what behavior.

It maps:

- Sandbox/Agents
- classic Copilot Chat
- Backboard agent host
- Copilot CLI agent host
- Backboard Rust bridge
- bridge commands
- bridge events
- Backboard HTTP endpoint families
- tool ownership

This is the main architecture map.

### `BACKBOARD_AGENT_WORKSPACE_FROM_ZED.md`

Use this when building the new Backboard workspace page with the center 3-by-N
agent grid and the right Backboard detail panel.

It maps Zed's Agent Workspace into VS Code:

- Copilot is the product shell, not the backend.
- The center of the page should be agent cards/panels, not the code editor.
- The right panel composer/detail should use the Backboard agent host.
- Agent cards should wrap Backboard sessions with local run metadata.
- Tool calls should stay in the Backboard bridge and VS Code client-tool loop.
- Editor context should be added as actions/context after the grid and right panel work.
- Worktrees and apply flows should come after one normal thread works.

This is the main doc for the next UI/workspace implementation.

### `TOOL_CALLS_AND_API.md`

Use this to understand the Backboard turn loop.

It explains:

- how a prompt reaches Backboard
- how tool calls are requested
- how TypeScript executes tools
- how `submitToolResult` continues a run
- what the bridge emits back to the host

### `ENDPOINTS.md`

Use this when working with Backboard HTTP/API surfaces.

It covers endpoint families like:

- assistants
- threads
- tool outputs
- models
- memories
- documents
- billing/usage

### `SSO.md`

Use this when working on Backboard sign-in.

It explains the Backboard SSO flow, where the code lives, and how the extension opens/completes auth.

### `CREDENTIALS.md`

Use this when working on API key or credential storage.

The important path is:

```text
~/.backboard_ide/config.json
```

Backboard credentials should not be routed through GitHub Copilot auth services.

### `EXTENSION.md`

Use this only for Backboard extension context.

The current rewire target is not "talk about the extension"; it is making the Copilot-style product experience use Backboard. Treat extension notes as supporting context.

## Source Areas And What Goes Where

### Backboard Rust bridge

Original source:

```text
extensions/backboard/rust/crates/backboard_bridge/src/main.rs
```

Owns:

- bridge protocol commands
- Backboard system prompt injection
- Backboard API request construction
- Backboard SSE parsing
- Rust-owned network tools such as `web_search` and `web_fetch`

Do not put VS Code UI logic here.

### Backboard Rust API client

Original source:

```text
extensions/backboard/rust/crates/backboard/src/endpoints
```

Owns:

- Backboard base URLs
- API key loading
- `X-API-Key` header
- assistants/thread/model/memory/document/billing endpoint wrappers

Do not put workbench routing here.

### Backboard agent-host provider

Original source:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

Owns:

- provider id `backboard`
- session type `agent-host-backboard`
- spawning the Backboard bridge
- sending `sendPrompt`
- handling `assistantTextDelta`
- handling `toolRequested`
- executing local tools
- sending `submitToolResult`
- mapping bridge errors to session errors
- Backboard model list integration

This is the main TypeScript integration point.

### Agent-host registration

Original sources:

```text
src/vs/platform/agentHost/node/agentHostMain.ts
src/vs/platform/agentHost/node/agentHostServerMain.ts
```

Own:

- registering available agent providers
- making Backboard visible to local/standalone agent-host clients

Backboard should register before Copilot CLI.

### Sandbox/Agents routing

Original sources:

```text
src/vs/workbench/contrib/chat/common/chatSessionsService.ts
src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts
src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts
```

Own:

- `SessionType.AgentHostCopilot`
- opening a new agent-host session
- opening Sandbox/Agents window
- handoff tips
- dynamic `agent-host-${provider}` session registration

For Backboard-first Sandbox routing, use:

```ts
SessionType.AgentHostCopilot
```

because it should resolve to:

```text
agent-host-backboard
```

Avoid using:

```ts
SessionType.CopilotCLI
```

unless intentionally launching the GitHub Copilot SDK-backed CLI session.

### Classic Copilot Chat

Original sources:

```text
extensions/copilot/package.json
extensions/copilot/src/extension/extension/vscode-node/extension.ts
extensions/copilot/src/platform/authentication
extensions/copilot/src/platform/endpoint
```

Owns:

- classic `GitHubCopilot` participant
- GitHub/Copilot auth
- GitHub Copilot endpoint logic
- Copilot tools and prompts
- `copilotcli` extension-host session support

Do not blindly rewrite this first.

Recommended approach:

```text
Create a Backboard participant or adapter that targets agent-host-backboard.
```

Only after that works should product defaults be changed.

### Product defaults

Original source:

```text
product.json
```

Owns:

- `defaultChatAgent`
- default chat extension ids
- setup provider metadata
- terms/privacy/plan URLs
- default sign-in/setup assumptions

Do not change this first. Change it only after normal Chat can actually route to Backboard.

## Correct Implementation Order

Follow this order:

```text
1. Backboard agent core works alone.
2. Sandbox/Agents opens Backboard.
3. Normal Chat opens Backboard.
4. product.json defaults point to Backboard.
5. UI text and UX are cleaned up.
6. Compile and smoke test after every step.
```

## Must-Pass Checks Before Moving On

Before moving from one section to the next:

- Backboard provider is registered.
- One prompt works.
- One tool call works.
- Missing API key flow is clear.
- The changed route does not accidentally launch `copilotcli`.
- User-facing copy in the changed route says Backboard when it launches Backboard.
- TypeScript compile check passes.

Use:

```sh
PATH="/Users/erintomorri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
```

## Search Before Declaring Done

Search changed areas for stale Copilot routing/copy:

```sh
rg -n "Copilot CLI|GitHub Copilot|copilotcli|agent-host-copilotcli|github.copilot|GitHub.copilot" src/vs/workbench/contrib/chat src/vs/platform/agentHost product.json extensions/copilot/package.json
```

Do not delete every hit blindly. Some hits are valid if GitHub Copilot remains as a separate feature. Investigate the changed flow.

## Important Rules

- Do not edit files inside `backboard-reference/source-copies` when changing product behavior.
- Edit original source files in the VS Code repo.
- Do not route Backboard credentials through GitHub Copilot auth services.
- Do not make workbench code import from `src/vs/sessions`.
- Do not hand-edit generated AHP protocol files unless a real protocol change is required.
- Do not update `product.json` until Backboard Chat routing works.
- Keep user-facing strings localized in VS Code source.
- Keep changes phase-scoped and verify each phase before moving on.
