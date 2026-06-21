# Backboard Performance And Copilot Wiring

This document explains where the Backboard IDE wiring is now, why API calls felt slow, what was changed to make them faster, and how the right panel, Agents/Sandbox, tool calls, Rust bridge, and Copilot-named VS Code surfaces fit together.

## Current Status

Backboard is wired as the first-party agent-host provider for the IDE work. The right panel and Agents/Sandbox flow target:

```text
agent-host-backboard
```

The naming is confusing because several VS Code files still use historic `Copilot` names for generic agent-host surfaces. In this branch, those names are mostly UI/framework names. The model request path is Backboard:

```text
Right panel composer
-> VS Code chat/agent-host state
-> BackboardAgent
-> backboard-bridge Rust process
-> Backboard API
-> Backboard model/tool response
-> BackboardAgent
-> VS Code tool cards / chat UI
```

GitHub Copilot is not the backend for this flow.

## Why It Felt Slow

Current working conclusion: treat this as a Copilot setup-plumbing issue first.

It is not being handled as a system-prompt problem or a model-selector problem. Those can still add small overhead, but the suspicious behavior is that VS Code's Copilot-era setup layer can intercept a Backboard chat request, wait for setup/readiness gates, and then forward the request into the real agent path. That makes the IDE feel slow before Backboard even gets a clean shot at the request.

The sections below keep the other checks documented, but the main fix is section 0.

## 0. Copilot Setup-Agent Forwarding Layer

This was the most suspicious path for "it feels like Copilot is in the middle."

VS Code's normal chat setup flow registers temporary default agents with ids like:

```text
setup.chat
setup.edits
setup.agent
```

Those agents are not GitHub Copilot backend calls by themselves, but they are Copilot-era setup shims. If a Backboard prompt starts through one of those setup agents, the request can go through:

```text
SetupAgent.invoke(...)
-> doInvoke(...)
-> doInvokeWithSetup(...) or doInvokeWithoutSetup(...)
-> doForwardRequestToChatWhenReady(...)
-> wait for agent activation
-> wait for default agent readiness
-> wait for language model readiness
-> wait for tools model readiness
-> resend the request
-> only then reach the real chat/backend path
```

That readiness wait has long timeout windows. It can make a Backboard call feel slow even though the final model request still goes to Backboard.

Files:

```text
src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts
src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts
src/vs/workbench/services/chat/common/chatEntitlementService.ts
```

Fix:

- Backboard product mode now starts entitlement/setup state as installed, completed, registered, and business-plan-like.
- Backboard product mode skips registering the setup forwarding agents.
- Backboard product mode skips extension-install probing for the old chat extension path.

Why this helps:

- Right-panel Backboard chat should not begin as a `setup.*` local chat request.
- Requests should go directly to the `agent-host-backboard` session.
- The code no longer waits on Copilot-style readiness gates before reaching Backboard.

Expected request path after this fix:

```text
Right panel composer
-> agent-host-backboard session
-> BackboardAgent.sendMessage(...)
-> backboard-bridge sendPrompt
-> Backboard API
```

Bad path to avoid:

```text
Right panel composer
-> setup.chat/setup.agent
-> wait for activation/model/tools
-> resend request
-> eventually Backboard
```

## 1. Runtime Prompt Payload Check

This is a secondary check, not the current diagnosis.

The Rust bridge wraps every user prompt with `backboard_runtime_system_prompt.md`.

File:

```text
extensions/backboard/rust/backboard_bridge/src/backboard_runtime_system_prompt.md
```

That file contains both normal runtime/tool instructions and a long Backboard API reference. Sending that whole API reference on every coding prompt increases request payload size, token count, model processing time, and log output.

The bridge now trims the API reference out of the prompt sent to the model.

Code:

```text
extensions/backboard/rust/backboard_bridge/src/main.rs
```

Important functions:

```text
augment_prompt(...)
system_prompt_for_request(...)
tool_names_for_prompt(...)
```

Current behavior:

- The bridge still keeps the full reference file in the repo.
- The actual API request uses only the runtime/tool section.
- The long `## Backboard API Reference` section is not inlined into normal model calls.
- Runtime context still includes workspace, mode, and available tool names.
- Exact function/tool schemas still go through the API `tools` array, not prose.

Why this helps:

- Fewer prompt tokens per call.
- Less model time spent reading docs it does not need.
- Lower request body size.
- Less log pressure.

## 2. Startup Model List Request

The Backboard agent loads models from the Backboard API with `listModels`.

File:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

Relevant code:

```text
constructor(...)
_refreshModels(...)
_readCachedModels(...)
_writeCachedModels(...)
BUNDLED_BACKBOARD_MODELS
```

The IDE has a bundled fallback model list, so the UI does not need to block startup on a network call.

Current behavior:

- The agent immediately shows cached models if available.
- If no cache exists, it uses `BUNDLED_BACKBOARD_MODELS`.
- The actual Backboard `/models` refresh is deferred shortly after startup.
- The model list is written to VS Code global storage for future launches.

Why this helps:

- Opening the IDE does not immediately compete with the first chat request.
- The model picker has something usable before network returns.
- Slow `/models` calls no longer make the UI feel stuck at launch.

## 3. Tool List Refresh Before Prompt

Backboard needs to tell the model which tools are available. The VS Code Backboard agent gets Backboard-owned built-in tools from the Rust bridge and sends those tools to the Backboard API.

Important current behavior:

```text
Backboard API tools array = Rust bridge Backboard tools
```

It does not advertise VS Code/Copilot client tools as normal model tools anymore. That avoids the model selecting generic or Copilot-style tool names when this flow is supposed to look and behave like Backboard.

File:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

Relevant code:

```text
BackboardBridgeProcess.listTools(...)
mergeBackboardTools(...)
setClientTools(...)
```

Current behavior:

- Tool definitions are cached for 10 minutes.
- The cache key includes mode, environment, API URL, and a hash of the credential fields.
- If a tool-list fetch is already pending, later calls share the same promise.
- `mergeBackboardTools(...)` now keeps the Rust bridge tool list Backboard-owned.
- `setClientTools(...)` still stores active client tools only so old/fallback client-tool completions can be resolved if one comes back.

Why this helps:

- The right panel does not rebuild tool lists from scratch every turn.
- Switching modes still gets the correct allowed tool set.
- Repeated messages avoid unnecessary setup cost.

## 4. Full Request Logging

The Rust bridge used to print the full message request body. That included the entire augmented prompt and tool schema. Large stderr logs can slow the process and make debugging noisy.

File:

```text
extensions/backboard/rust/backboard_bridge/src/main.rs
```

Relevant function:

```text
log_backboard_request(...)
```

Current behavior:

- Normal logs show:
  - workspace root
  - workspace directory
  - bridge cwd
  - mode
  - provider
  - model
  - content character count
  - tool count
- Full request body is printed only when this environment variable is enabled:

```text
BACKBOARD_BRIDGE_VERBOSE_REQUESTS=1
```

Why this helps:

- Normal API calls do not dump huge prompts into logs.
- Debugging is still possible when explicitly enabled.

## How It Is Connected To Copilot

There are three different things people call “Copilot” in this codebase.

## 1. GitHub Copilot Backend

This is the GitHub/Microsoft Copilot service, Copilot auth, and Copilot extension implementation.

Examples:

```text
extensions/copilot
GitHub.copilot
github.copilot
copilot-auth
```

Backboard should not use this backend for the new flow.

## 2. VS Code Agent-Host Framework

This is the generic framework VS Code uses to host agent sessions. It has providers like Codex, Claude, Copilot CLI, and now Backboard.

Backboard lives here:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

Registration happens through:

```text
src/vs/platform/agentHost/node/agentHostMain.ts
```

The provider id is:

```text
backboard
```

The session type is:

```text
agent-host-backboard
```

## 3. Copilot-Named Chat UI

Some right-panel and chat code still has names like `Copilot`, `AgentHostCopilot`, or `CopilotCLI`. In this branch, some of those names are used as compatibility aliases or old VS Code UI names.

The important distinction:

```text
Name says Copilot
does not automatically mean GitHub Copilot backend
```

The target session is what matters.

Backboard flow should target:

```text
SessionType.AgentHostCopilot -> agent-host-backboard
```

It should not target:

```text
SessionType.CopilotCLI
agent-host-copilotcli
GitHub.copilot-chat
```

## Right Panel Flow

The right panel composer creates or selects an agent-host session.

Expected flow:

```text
User types in right panel
-> chat view asks for default/new session
-> default session type resolves to agent-host-backboard
-> AgentSideEffects forwards the user message
-> BackboardAgent.sendMessage(...)
-> BackboardBridgeProcess.send("sendPrompt", ...)
-> Rust bridge sends POST /threads/messages to Backboard
```

Key files:

```text
src/vs/workbench/contrib/chat/common/constants.ts
src/vs/workbench/contrib/chat/common/chatSessionsService.ts
src/vs/workbench/contrib/chat/browser/chatViewPane.ts
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

## Agents / Sandbox Flow

Agents/Sandbox should also open Backboard sessions.

Expected flow:

```text
Open Agents/Sandbox
-> choose agent-host session target
-> create/open agent-host-backboard session
-> route prompt to BackboardAgent
```

Important check:

```text
No changed Agents/Sandbox path should create agent-host-copilotcli for Backboard work.
```

## Tool Calls

Tool calls are Backboard-owned. Backboard decides to call tools. VS Code executes local tools only when the call is routed back through the agent-host protocol.

Most filesystem and shell tools are Backboard/Rust-owned:

```text
read_file
write_file
create_file
edit_file
bash
grep
glob
```

The integrated browser tools are different. They are workbench client tools registered by:

```text
src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts
```

Backboard intentionally allows only this client-side browser tool family through:

```text
open_browser_page
read_page
screenshot_page
navigate_page
click_element
type_in_page
hover_element
drag_element
handle_dialog
run_playwright_code
```

Those are converted into Backboard function tools in:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
mergeBackboardTools(...)
toBackboardFunctionTool(...)
```

This keeps read/write/shell behavior on Backboard while preserving the IDE's built-in browser workflow.

## Slow Turns And Large Writes

If a turn stalls after a line like:

```text
Now for the main course...
```

and then ends with:

```text
Upstream idle timeout exceeded
```

the model was not actively running a local tool. It was waiting upstream while trying to produce the next model response. In the observed Mario-game trace, the model had already run these tools:

```text
list_dir
read_file index.html
read_file game.js
todo_write
write_file index.html
```

Then it started assistant-visible prose before the expected `game.js` write. That was the wrong path: large generated files must go through file tools, not visible assistant text.

Current fixes:

```text
todo_write is no longer advertised by the Rust bridge
append_file is advertised for chunked large generated files
write/edit tool cards redact content fields in the UI transcript
runtime prompt forbids streaming full file contents as assistant text
```

This reduces extra round trips and prevents huge `write_file` inputs from bloating the chat UI/state.

## Workspace Directory

Backboard tools resolve relative paths against the agent-host session `workingDirectory`.

Expected path:

```text
Open folder in IDE
-> right panel / agent-host creates Backboard session
-> createSession({ workingDirectory: <open folder uri> })
-> BackboardAgent stores session.workingDirectory
-> read/write/bash tools resolve paths under that folder
```

The dangerous bug was that missing `workingDirectory` fell back to `process.cwd()`. In an IDE process, `process.cwd()` is the process launch directory, not necessarily the folder currently open in the editor. That is why files could appear in an unrelated folder.

Current behavior:

```text
If workingDirectory exists:
-> Backboard progress shows "Using workspace <path>"
-> filesystem and shell tools run inside that folder

If workingDirectory is missing:
-> Backboard progress says no workspace folder is attached
-> read/write/bash tools fail with a clear error
-> no fallback write to process.cwd()
```

Important code:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
sendMessage(...) logs and displays the selected workspace
workspaceRoot(...) rejects missing workspaces
```

## Website Build Behavior

Kept and made explicit in the sent runtime prompt.

For website, frontend, web app, and UI implementation tasks, Backboard is instructed to finish by running the project's own build/check command when one exists, such as:

```text
npm run build
npm run lint
npm test
```

If the app needs a dev server to inspect the result, Backboard is instructed to start it after implementation. When `open_browser_page` is available, Backboard should open the running localhost URL or generated `file://` page in the integrated browser instead of only reporting the URL. If a build, server, or browser preview cannot run, it should say exactly why.

Important location:

```text
extensions/backboard/rust/backboard_bridge/src/backboard_runtime_system_prompt.md
```

This instruction is intentionally above `## Backboard API Reference`, because the bridge trims the API-reference section before sending the prompt to the model.

## Why The UI Says "Considering"

`Considering` is a generic VS Code chat thinking phrase. It is rendered when a chat turn is still in progress but the UI has no more specific visible progress, reasoning, or tool-call state to show.

Backboard already emitted bridge progress events such as:

```text
Sending to Backboard.
Connected to model.
Planning next step.
Retrying Backboard request.
```

The problem was that `BackboardAgent` ignored `event.type === "progress"`, and it also waited on tool-list setup before showing any visible status. That made the right panel look stalled on the generic `Considering` phrase.

Current behavior:

```text
BackboardAgent starts turn
-> emits "Backboard: Preparing Backboard request."
-> emits "Backboard: Loading Backboard tools."
-> emits "Backboard: Sending prompt to Backboard with N tools."
-> emits heartbeat messages every few seconds while waiting
-> forwards bridge progress messages as SystemNotification progress outside the reasoning container
-> forwards bridge trace stages such as request_built, post_start, post_stream_open, and stream_first_chunk
-> tool calls show Backboard tool cards when requested
-> per-tool start, finish, and failure messages are appended as visible Backboard progress notifications
-> actual model reasoning still uses the reasoning container
```

Code:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
_appendBackboardProgress(...)
_appendReasoning(...)
```

Important UI mapping:

```text
Backboard status/trace/tool telemetry
-> ResponsePartKind.SystemNotification
-> workbench adapter converts it to progressMessage
-> rendered outside the "Considering" / reasoning container

Backboard model reasoningDelta
-> ResponsePartKind.Reasoning
-> workbench adapter converts it to thinking
-> rendered inside the reasoning container
```

## Built-In Backboard Tools

The Rust bridge advertises Backboard built-in tools.

File:

```text
extensions/backboard/rust/backboard_bridge/src/main.rs
```

Functions:

```text
tool_definitions(...)
tool_definitions_for_request(...)
blocked_tools(...)
```

Examples:

```text
read_file
list_dir
glob
grep
write_file
edit_file
bash
run_code
web_search
web_fetch
```

Mode controls which tools are blocked:

```text
ask    -> read/search only
manual -> blocks high-risk execution tools
free   -> full access
```

## VS Code Composer / Client Tools

The composer can provide client tools. Those come from the VS Code active client state.

Current Backboard rule:

```text
Do not advertise client/Copilot tool definitions to the Backboard model by default.
```

Backboard keeps the client-tool callback path only as a compatibility/fallback path.

Flow:

```text
AgentSideEffects sees active client tools
-> BackboardAgent.setClientTools(...)
-> BackboardAgent stores tools + clientId
-> BackboardAgent does not add those tools to the normal Backboard API tools array
-> if an older/fallback client tool call still comes back, BackboardAgent can resolve it
```

Key Backboard code:

```text
setClientTools(...)
onClientToolCallComplete(...)
mergeBackboardTools(...)
_executeToolCalls(...)
backboardToolDisplay(...)
```

The right-panel loading/tool cards now use Backboard display names and messages such as:

```text
Backboard Terminal
Backboard Read File
Backboard Edit File
Backboard Code Search
Backboard Todo List
Backboard Diagnostics
```

That display wiring is in:

```text
backboardToolDisplay(...)
```

So if the UI still shows generic or Copilot-style loading cards, the request is probably not going through `agent-host-backboard` or the model is receiving a non-Backboard tool list from another path.

## API Call Flow

The main Backboard API request is:

```text
POST /threads/messages
```

The Rust client sends fields like:

```text
content
thread_id
assistant_id
llm_provider
model_name
stream
tools
parallel_tool_calls
web_search
thinking
memory
memory_pro
```

If Backboard requires tool output:

```text
Backboard response status -> REQUIRES_ACTION
bridge event -> toolRequested
VS Code executes tool
bridge command -> submitToolResult
Backboard API -> submit tool outputs
stream continues
```

The bridge command names are:

```text
sendPrompt
submitToolResult
listModels
listTools
runTool
cancel
```

## Performance Checklist

Use this order when debugging slowness.

## Step 1: Check Prompt Size

Look for this in Backboard bridge logs:

```text
contentChars: <number>
toolCount: <number>
```

If `contentChars` is huge, inspect:

```text
extensions/backboard/rust/backboard_bridge/src/backboard_runtime_system_prompt.md
extensions/backboard/rust/backboard_bridge/src/main.rs
```

The API reference should not be inlined into normal requests.

## Step 2: Check Which Model Is Selected

Slow reasoning models make the IDE feel slow even when plumbing is fine.

Fast default:

```text
openrouter/deepseek/deepseek-v4-flash
```

Smoke test model:

```text
openrouter/deepseek/deepseek-r1
```

DeepSeek R1 may emit many reasoning deltas. That can be useful for testing but slower than flash/chat models.

## Step 3: Check Startup Model Refresh

The IDE should not block on `/models`.

Expected:

```text
_refreshModels(true)
```

That means:

- show cached/bundled models now
- refresh network models shortly after startup

## Step 4: Check Tool Cache

Tool definitions should be cached.

Expected:

```text
BACKBOARD_TOOL_CACHE_TTL_MS = 10 * 60 * 1000
```

If every turn logs a slow `list_tools_done`, inspect:

```text
BackboardBridgeProcess.listTools(...)
backboardToolCacheKey(...)
```

## Step 5: Check Tool Loops

One user prompt can require multiple API round trips:

```text
sendPrompt
toolRequested
local tool execution
submitToolResult
possibly another toolRequested
submitToolResult again
done
```

This is normal. Tool-heavy tasks are slower because each tool round requires a continuation request.

## Step 6: Check Full Request Logging

Do not leave this on for normal testing:

```text
BACKBOARD_BRIDGE_VERBOSE_REQUESTS=1
```

That prints the full request body and can make logs enormous.

## Smoke Tests

Backend compile:

```sh
PATH="/Users/erintomorri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
```

Rust bridge tests:

```sh
cargo test
```

Run from:

```text
extensions/backboard/rust/backboard_bridge
```

Rust bridge build:

```sh
cargo build
```

Run from:

```text
extensions/backboard/rust/backboard_bridge
```

Expected binary:

```text
extensions/backboard/rust/target/debug/backboard-bridge
```

## Manual UI Test

Use this order.

## 1. Launch IDE

Start the Backboard VS Code build using the repo launch flow or existing run script.

## 2. Open Right Panel Chat

Send:

```text
reply exactly BACKBOARD_UI_OK
```

Expected:

```text
BACKBOARD_UI_OK
```

## 3. Test Read Tool

Send:

```text
Read package.json and tell me the package name only.
```

Expected:

- tool card appears
- Backboard calls a read tool
- response contains the package name

## 4. Test Tool Mode

Switch mode to `Ask` and request a write.

Expected:

- write/execute tools are blocked or require approval
- read tools still work

Switch mode to `Full Access` and retry only in a throwaway file.

Expected:

- write works
- file changes appear in workspace

## 5. Test Agents/Sandbox

Open Agents/Sandbox and send a tiny prompt.

Expected:

- session is Backboard-backed
- no GitHub Copilot sign-in appears
- no `agent-host-copilotcli` session is created for the Backboard path

## What To Watch In Logs

Good log sequence:

```text
[Backboard latency] turn_start ...
[Backboard latency] list_tools_done ...
[Backboard latency] send_prompt_done ...
```

Tool call sequence:

```text
toolRequested
[Backboard latency] local_tools_done ...
[Backboard latency] submit_tool_result_done ...
```

Slow model symptom:

```text
many reasoningDelta events before assistantTextDelta
```

Payload problem symptom:

```text
contentChars is unexpectedly huge
```

Tool loop symptom:

```text
many toolRequested events in one turn
```

Copilot setup-shim symptom:

```text
[chat setup] ...
Getting chat ready
Chat is almost ready
Backboard took too long to get ready
setup.chat
setup.agent
```

If those appear for normal Backboard right-panel messages, the request is still going through the setup-agent forwarding layer instead of directly through `agent-host-backboard`.

## Bottom Line

The right panel and Agents/Sandbox should be Backboard-backed now. The code still uses some Copilot-shaped VS Code framework names, but the request path is not GitHub Copilot.

The biggest speed fixes are:

- bypass Copilot-era setup-agent forwarding for Backboard builds
- do not inline the Backboard API reference into every prompt
- defer model refresh after startup
- cache tool definitions
- avoid full request logging unless explicitly requested
- use faster default models for normal UI testing
