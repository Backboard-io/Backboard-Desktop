# Backboard Copilot Rewire Plan

This plan lays out the safest order for rewiring the Copilot-style experience to Backboard. Each section has a clear goal, files to touch, checks to run, and exit criteria. Do not move to the next section until the current section works end to end.

## Guiding Principle

Do not start with broad rebranding or `product.json` changes.

First prove Backboard works as an agent-host provider. Then route Sandbox/Agents to it. Then route classic Chat to it. Only after those flows work should product metadata and UI polish be cleaned up.

Recommended order:

1. Backboard agent core
2. Agents/Sandbox routing
3. Classic Copilot Chat rewire
4. Product defaults
5. UI/UX cleanup
6. Validation and regression pass

## Phase 1: Backboard Agent Core

### Goal

Make sure `BackboardAgent` works by itself before touching classic Copilot Chat.

### Main Files

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
src/vs/platform/agentHost/node/agentHostMain.ts
src/vs/platform/agentHost/node/agentHostServerMain.ts
extensions/backboard/rust/crates/backboard_bridge/src/main.rs
extensions/backboard/rust/crates/backboard/src/endpoints
```

### What To Verify

- `BackboardAgent` registers as provider `backboard`.
- Dynamic session type exists:

```text
agent-host-backboard
```

- Backboard bridge binary is found from one of:

```text
extensions/backboard/bin/backboard-bridge
extensions/backboard/rust/target/debug/backboard-bridge
```

- `listModels` returns Backboard models.
- A simple prompt streams assistant text through `assistantTextDelta`.
- A tool request emits `toolRequested`.
- TypeScript host executes the tool.
- `submitToolResult` continues the Backboard run.
- The turn ends with `done`.
- Missing API key produces a Backboard-specific error.
- API key/SSO config is read from:

```text
~/.backboard_ide/config.json
```

### Tool Call Checks

Test read-only tools first:

```text
read_file
list_dir
glob
grep
codebase_search
web_search
web_fetch
```

Then test write/execute tools in the right mode:

```text
write_file
edit_file
bash
run_code
```

### Exit Criteria

Do not move on until:

- Backboard agent appears in agent-host root state.
- A Backboard session can answer a prompt.
- A read-only tool call works.
- A write/execute tool call is blocked or allowed according to mode.
- `submitToolResult` continuation works.
- TypeScript compile check passes.

## Phase 2: Agents/Sandbox Routing

### Goal

Make every Sandbox/Agents entry point land on Backboard, not `copilotcli`.

### Main Files

```text
src/vs/workbench/contrib/chat/common/chatSessionsService.ts
src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts
src/vs/workbench/contrib/chat/electron-browser/agentSessions/agentSessionsActions.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts
```

### What To Wire

The historic `AgentHostCopilot` alias should resolve to:

```text
agent-host-backboard
```

The static open commands should wait for provider:

```text
backboard
```

The empty-session Sandbox fallback should use:

```ts
SessionType.AgentHostCopilot
```

not:

```ts
SessionType.CopilotCLI
```

### What To Verify

- Open Sandbox Window creates/selects a Backboard session.
- Open in Sandbox Window on an existing Backboard chat session passes the same session resource.
- Empty/no-real-session handoff preselects Backboard.
- Sandbox session list shows Backboard sessions.
- Existing Backboard sessions restore from shared state.
- No changed Sandbox path starts the GitHub Copilot SDK-backed `copilotcli` provider.
- User-facing Sandbox copy says Backboard/Sandbox, not Copilot CLI.

### Exit Criteria

Do not move on until:

- Sandbox can start a new Backboard session.
- Sandbox can reopen an existing Backboard session.
- Empty state handoff routes to `agent-host-backboard`.
- No accidental `SessionType.CopilotCLI` route remains in the changed Sandbox flow.
- TypeScript compile check passes.

## Phase 3: Classic Copilot Chat Rewire

### Goal

Make the normal Chat panel use Backboard intentionally.

### Recommended Approach

Create a Backboard chat participant or adapter that opens/targets:

```text
agent-host-backboard
```

Do not start by heavily mutating GitHub Copilot auth, endpoint, and prompt internals.

### Main Files

Likely workbench-side files:

```text
src/vs/workbench/contrib/chat/common/participants
src/vs/workbench/contrib/chat/browser/widget
src/vs/workbench/contrib/chat/browser/chatSetup
src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts
```

Existing Copilot extension boundary:

```text
extensions/copilot/package.json
extensions/copilot/src/extension/extension/vscode-node/extension.ts
extensions/copilot/src/platform/authentication
extensions/copilot/src/platform/endpoint
```

### What To Decide

Choose one:

1. Keep GitHub Copilot Chat and Backboard Sandbox separate.
2. Add Backboard as a new first-party chat participant.
3. Replace the default Copilot participant with a Backboard participant.
4. Fork the Copilot extension deeply so it speaks Backboard instead of GitHub Copilot.

Recommended:

```text
Add Backboard as a first-party chat participant or adapter first.
```

### What To Verify

- New Chat can start a Backboard-backed chat/session.
- Prompt text reaches `BackboardAgent.sendMessage()`.
- Prompt attachments still resolve.
- Model picker shows Backboard models.
- Tool calls render in the normal Chat panel.
- Chat setup does not call GitHub/CAPI paths for Backboard.
- Errors mention Backboard, not GitHub Copilot.

### Exit Criteria

Do not move on until:

- Classic Chat can route one prompt to Backboard.
- Backboard tool call rendering works in classic Chat.
- Missing credential flow opens Backboard setup.
- GitHub Copilot auth is not required for Backboard chat.
- TypeScript compile check passes.

## Phase 4: Product Defaults

### Goal

Only after Backboard chat works, make product-level defaults point at Backboard.

### Main File

```text
product.json
```

### What To Update

Review and replace GitHub-specific values under:

```json
"defaultChatAgent"
```

Current risky values include:

```text
GitHub.copilot
GitHub.copilot-chat
github.copilot.*
GitHub provider metadata
GitHub terms/privacy/plan URLs
```

### What To Verify

- Product default chat metadata points to Backboard.
- Setup/sign-in flow opens Backboard SSO/API-key setup.
- Account/menu/status copy says Backboard.
- Output channel lookup does not assume GitHub Copilot.
- Terms/privacy/provider copy is no longer GitHub-specific.
- Missing auth produces Backboard setup, not GitHub sign-in.

### Exit Criteria

Do not move on until:

- Product starts with Backboard as the intended chat agent.
- No default setup path requires GitHub Copilot for Backboard.
- No broken extension lookup occurs from stale `GitHub.copilot-chat` ids.
- TypeScript compile check passes.

## Phase 5: UI/UX Cleanup

### Goal

Make the product feel coherent after the wiring works.

### Main Areas

```text
src/vs/workbench/contrib/chat/browser/agentSessions
src/vs/workbench/contrib/chat/browser/chatSetup
src/vs/workbench/contrib/chat/browser/widget
src/vs/workbench/contrib/chat/browser/chatStatus
src/vs/workbench/contrib/chat/browser/chatTipCatalog.ts
extensions/copilot/package.json
```

### What To Clean Up

- Labels
- Empty states
- Setup dialogs
- Account/sign-in copy
- Handoff tips
- Command titles
- Menu labels
- Model picker labels
- Usage/billing UI
- Memory UI
- Error messages

### Important UX Rules

- Do not expose AI UI when `chat.disableAIFeatures` hides AI features.
- Keep Sandbox and Chat labels consistent.
- Do not call a Backboard session "Copilot CLI".
- Do not mention Copilot plans unless the product intentionally still uses them.
- Keep Backboard API-key storage clear:

```text
~/.backboard_ide/config.json
```

### Exit Criteria

Do not move on until:

- No user-facing changed path says Copilot CLI when it is launching Backboard.
- Setup and missing-auth flows are understandable.
- Normal Chat and Sandbox feel like one Backboard product.
- AI feature hiding still works.
- TypeScript compile check passes.

## Phase 6: Validation And Regression Pass

### Always Run After Each Phase

Direct TS compile check:

```sh
PATH="/Users/erintomorri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
```

If npm is available:

```sh
npm run compile-check-ts-native
```

### Smoke Tests

Run these manually or through the available harness after each phase:

1. Start app with valid Backboard API key.
2. Start app with missing Backboard API key.
3. Open Sandbox Window.
4. Start a Backboard session.
5. Send a simple prompt.
6. Trigger a read-only tool call.
7. Trigger a write tool call in restricted mode.
8. Trigger a write tool call in full-access mode.
9. Cancel a running turn.
10. Reopen an existing Backboard session.
11. Switch models.
12. Verify no GitHub Copilot sign-in is required for Backboard.

### Regression Searches

Search changed areas for stale route/copy:

```sh
rg -n "Copilot CLI|copilotcli|GitHub Copilot|GitHub\\.copilot|github\\.copilot|agent-host-copilotcli" src/vs/workbench/contrib/chat src/vs/platform/agentHost product.json extensions/copilot/package.json
```

Do not blindly delete every hit. Some hits are legitimate if GitHub Copilot remains installed as a separate feature. Investigate each changed flow.

## Stop/Go Checklist

Use this checklist before moving from one phase to the next:

- The current flow starts the expected provider.
- The current flow does not hit GitHub/CAPI auth unless intentionally testing GitHub Copilot.
- Backboard credential errors are clear.
- One prompt works.
- One tool call works.
- Cancellation works if the phase touched turn execution.
- Session restore works if the phase touched sessions.
- TypeScript compile check passes.
- No unrelated changes were made.

