# cli-ts Tool Calls — Inventory, Code Locations, and IDE Mapping

This is the answer to "which tool calls are used, where the code is, and how we connect it." All
paths are under `ide/vscode/cli-ts/`.

## How tools work in cli-ts

```
 createDefaultTools(deps)                     src/tools/index.ts:54
   └─ createBaseTools() → 13 base tools       src/tools/index.ts:31
   └─ + AgentTool (sub-agents) when deps set  src/tools/index.ts:57
        │
 ToolRegistry(tools)                          src/core/tools/ToolRegistry.ts   (registered in cli.tsx:184)
   + McpToolRegistrar.register(mcp)           src/core/mcp/MCPToolRegistrar.ts  → mcp__server__tool adapters
        │
 AgentLoop  (turn)                            src/core/agent/AgentLoop.ts
   provider says requires_action → calls →    ToolScheduler.run(calls)         src/core/tools/ToolScheduler.ts
        │
 ToolScheduler                                src/core/tools/ToolScheduler.ts
   • read-only + concurrency-safe → parallel  (ARCHITECTURE.md §Tool Scheduling)
   • write/destructive/interactive → serial
   • PreToolUse hook can deny/rewrite input   src/core/hooks
   • PostToolUse hook can rewrite output
        │
 Tool.execute(input, ToolContext)             src/core/tools/Tool.ts / ToolContext.ts:24
   ctx = { sessionId, turnId, toolCallId, cwd, bus, signal, askUser, lsp, … }
   emits tool:start / tool:progress / tool:result / tool:error on the bus
```

Every tool `extends Tool<I, O>` (`src/core/tools/Tool.ts`), has a **case-sensitive `name`** (part of
the model contract — never rename), a Zod `inputSchema` (converted to JSON schema via
`zod-to-json-schema`), and implements `execute` + the three truthful safety predicates
(`isReadOnly` / `isConcurrencySafe` / `isDestructive`). Prompt copy for each tool lives separately in
`src/prompts/profiles/*/tools/`.

## The 14 built-in tools

| Tool `name` | File | Safety (RO / conc-safe / destructive) | What it does | IDE mapping (Strategy B) |
|---|---|---|---|---|
| `Read` | `src/tools/ReadTool.tsx` | read-only, conc-safe | read a file (with `ReadTool.constants.ts`) | render read pill; no side effects |
| `Write` | `src/tools/WriteTool.tsx` | write, serial | create/overwrite a file | **file-edit → changeset** (§File edits) |
| `Edit` | `src/tools/EditTool.tsx` | write, serial | string-replacement edit (`fileEdits/textReplacements.ts`) | **file-edit → changeset** |
| `ApplyPatch` | `src/tools/ApplyPatchTool.tsx` | write, serial | apply a unified patch (`fileEdits/patch.ts`) | **file-edit → changeset** |
| `Execute` | `src/tools/ExecuteTool.tsx` | write, serial | run a shell command (`ExecuteTool.constants.ts`) | terminal tool part; approvals |
| `Grep` | `src/tools/GrepTool.tsx` | read-only, conc-safe | ripgrep content search | search result pill |
| `Glob` | `src/tools/GlobTool.tsx` | read-only, conc-safe | filename glob | search result pill |
| `FetchUrl` | `src/tools/FetchUrlTool.tsx` | read-only, conc-safe | fetch a URL (`FetchUrlTool.constants.ts`) | output pill |
| `WebSearch` | `src/tools/WebSearchTool.tsx` | read-only, conc-safe | web search | output pill |
| `AskUser` | `src/tools/AskUserTool.tsx` | interactive, serial | ask the user a question | **`input:request` → IDE confirm/elicit** |
| `TodoWrite` | `src/tools/TodoWriteTool.tsx` | state, serial | update the todo list | `todos:updated` → todo part |
| `Computer` | `src/tools/ComputerTool.tsx` | destructive, serial | local computer use (screenshots/clicks) | v1: **exclude**, use IDE computer-use |
| `Browser` | `src/tools/BrowserTool.tsx` | destructive, serial | drive a Chromium tab over CDP | v1: **exclude**, use IDE Browser tab |
| `Agent` | `src/tools/AgentTool.tsx` | conc-safe wrapper | spawn a sub-agent (`SubAgentRunner`, RLM loop) | nested `subagent` tool rows via `agent:child_tool_*` |

> Safety flags read from each tool's `isReadOnly` / `isConcurrencySafe` / `isDestructive` overrides.
> `Read`, `Grep`, `Glob`, `FetchUrl`, `WebSearch` are read-only+concurrency-safe → cli-ts runs them
> in parallel. `Write`/`Edit`/`ApplyPatch`/`Execute`/`AskUser`/`TodoWrite` run serially. `Computer`
> and `Browser` are destructive+serial.

### Plus: MCP tools

MCP server tools are wrapped by `src/tools/MCPToolAdapter.tsx` and registered as
`mcp__<server>__<tool>` (`src/core/mcp/MCPToolRegistrar.ts`, `MCPToolDefinitions.ts`). Read-only /
concurrency behavior comes from MCP annotations (`readOnlyHint`, `destructiveHint`). Config lives in
`.backboard/mcp.json` (project) and `~/.backboard/mcp.json` (user). These become available to the
agent the same way built-in tools do.

## File-edit tools → the IDE Changes/Review view

The three write tools share edit plumbing under `src/tools/fileEdits/`:

- `patch.ts` — unified-patch application (ApplyPatch)
- `textReplacements.ts` — string-replacement edits (Edit)
- `diffPreview.ts` — builds a diff preview for `tool:result.detailLines`
- `diagnosticsFeedback.ts` — post-edit LSP diagnostics (via `ToolContext.lsp`)
- `eol.ts` — EOL normalization

**Connection:** cli-ts writes the file to disk and emits `tool:result` with a diff summary in
`detailLines`. On the IDE side, `CliTsAgent` feeds the IDE's `ISessionChangeset`
(`bb-docs/deep-dive/05` §File-edit tools) from a **filesystem diff against a per-turn checkpoint** —
snapshot the working tree (git tree / stash) at `turn:start`, diff at `turn:result`/`turn:end`. The
Changes view and the right-panel Review tab (`bb-docs/deep-dive/08`) then render exactly as today,
just sourced from FS diff instead of AHP changeset events. Post-edit diagnostics can also come from
cli-ts's own LSP service (`src/core/lsp/`) if the IDE doesn't re-run them.

## The AskUser bridge (interactive round-trip)

`AskUserTool` calls `ToolContext.askUser(question, options)` (`ToolContext.ts:6`). In
`AgentController` (`src/core/agent/AgentController.ts`):

- `askUser(...)` (`:435`) emits `{ type: "input:request", request: { id, question, options } }`
  (`:442`) and returns a promise.
- The answer is delivered by `{ type: "input:response", response: { id, answer } }` (`:402`).

In the interactive Ink UI, the UI answers. **In serve mode there is no UI**, so `CliTsAgent` must
map `input:request` → the IDE's confirmation/elicitation UI and answer via the control-channel
`respondInput(id, answer)` op (doc 02). Without this, any `AskUser` (or approval routed through it)
hangs the turn.

## Approvals / permission gate (to add)

cli-ts today gates writes/execution through **hooks** (`PreToolUse` can deny/rewrite) and the
scheduler's serial rules — there is no interactive per-call approval like the IDE's
`WaitingForConfirmation`. To preserve the IDE's approval UX (`ChatPermissionLevel`,
`bb-docs/deep-dive/05`), Phase 2 adds a **permission gate** in `ToolScheduler`/`ToolPolicy`:

- serve mode passes a permission policy at `submit` (from the IDE's mode + permission level);
- before executing a non-approved write/destructive tool, cli-ts emits `permission:request`
  (new event) and awaits a control-channel `respondPermission(id, decision)`;
- `autoApprove`/`autopilot` policies short-circuit to approved without emitting.

This can reuse the existing `input:request`/`askUser` machinery (emit a yes/no AskUser) for a minimal
v1, or be a dedicated event for cleaner UI. Doc 02 specs both the event and the control op.

## Tool policy, exclusion, and sub-agents

- **Exclusion:** `--excluded-tools <names>` (`src/config/flags.ts`) hides tools from the model via
  `config.toolPolicy` / `config.isToolEnabled` (`src/config/modelProfiles/tools.ts`,
  `ToolPolicy.ts`). Use this to implement plan mode (hide writes) and to disable `Browser`/`Computer`
  in favor of the IDE's own.
- **Sub-agents:** `AgentTool` (`src/tools/AgentTool.tsx`) runs a nested agent via `SubAgentRunner`
  (`src/core/agent/SubAgentRunner.ts`) and an optional RLM loop (`src/core/agent/rlm/`). It emits
  `agent:child_tool_start` / `agent:child_tool_result` for nested tool calls
  (`events.ts:96-106`), which the IDE renders as nested `subagent` tool rows. `NON_DELEGATABLE_AGENT_TOOLS`
  (`src/tools/AgentToolConstants.ts`) controls which tools sub-agents may use.

## Where tool prompts live (do not put wording in executors)

Per-tool model-facing text is in `src/prompts/profiles/<profile>/tools/*.tsx` (e.g.
`anthropic/tools/edit.tsx`, `execute.tsx`, `read.tsx`, …) and the shared set in
`src/prompts/profiles/_shared/tools/`. If the IDE needs to alter tool descriptions (e.g. to reflect
IDE-side rendering), change them there, not in the tool classes.

## Quick reference — adding/using a tool from the IDE

- To **hide** a tool for a session: pass its exact name in `--excluded-tools` (or the `submit`
  op's `excludedTools`).
- To **list** available tools for a picker: serve-mode `listTools` op → `ToolRegistry.list()`.
- To **approve/deny** a tool call: answer `permission:request` (or `input:request`) via the control
  channel.
- Tool names are a **model contract** — the IDE must display/track them by these exact strings:
  `Read Write Edit ApplyPatch Execute Grep Glob FetchUrl WebSearch AskUser TodoWrite Computer Browser
  Agent` and `mcp__<server>__<tool>`.
