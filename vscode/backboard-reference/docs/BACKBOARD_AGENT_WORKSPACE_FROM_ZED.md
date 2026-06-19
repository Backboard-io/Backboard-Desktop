# Backboard Agent Workspace From Zed

This document maps the Zed Backboard Agent Workspace into the VS Code/Copilot-style workbench. The goal is a new Backboard workspace page that combines:

- a brand-new agents workspace page
- a center 3-by-N grid of Backboard agent panels/cards
- the existing right-panel Backboard chat/composer as the selected-agent detail surface

Use this as the implementation guide after the basic Backboard right-panel chat path works.

## Current Direction

Use Copilot as the product shell, not as the backend.

In this repo, "Copilot workspace" should mean the VS Code chat/agent workbench surfaces that users already recognize:

- right-side chat panel
- composer
- model selector
- mode/config chips
- tool-call cards
- agent session lifecycle

The backend should stay Backboard:

```text
VS Code UI / Copilot-style shell
  -> agent-host-backboard
  -> BackboardAgent
  -> backboard-bridge
  -> Backboard API
```

Do not route prompts, credentials, models, or tool calls through GitHub Copilot or `copilotcli`.

## Zed Reference Files

Read these Zed files when building the VS Code page:

```text
../zed/crates/agent_ui/src/agent_workspace_ui.rs
../zed/crates/agent_ui/src/agent_panel.rs
../zed/crates/agent_servers/src/backboard.rs
../zed/crates/agent_servers/src/backboard_native/mod.rs
../zed/crates/agent_servers/src/backboard_native/stream.rs
../zed/crates/agent_servers/src/backboard_native/tools.rs
../zed/crates/agent_servers/src/backboard_native/tool_schemas.rs
../zed/crates/agent_servers/src/backboard_native/workspace.rs
```

Design references:

```text
../docs/design/Agent Workspace/
../docs/design/chat_window/
```

The important Zed pattern is not the Rust UI code itself. The important pattern is the ownership model:

```text
Agent Workspace page
  -> displays cards for retained Backboard agent threads
  -> opens selected thread in a right-side detail/chat panel
  -> starts normal Backboard chat sessions with extra run metadata
  -> keeps tool execution centralized in the Backboard runtime
```

## What Zed Does

Zed's Agent Workspace is a dashboard/detail shell around normal Backboard agent threads.

It has:

- a header with agent count and a New Agent action
- an empty state made of preview cards
- real agent cards once runs exist
- per-card status, activity, changed files, model/cost metadata, and quick actions
- a right-side chat/detail panel for the selected agent
- a draft composer state before a chat is promoted into a workspace run

The agent cards are not separate from chat. They are normal AgentPanel conversation threads plus `BackboardAgentWorkspaceRunMetadata`.

Zed run metadata includes:

```text
title
task
created_at
kind
scope
mode
base_workspace_path
worktree_path
branch_name
base_commit
changed_paths
apply_state
current_workspace
batch_id
batch_index
batch_size
```

Zed run status is derived into:

```text
Queued
Running
Done
Blocked
Failed
```

The card UI then shows:

- title
- kind/scope/mode labels
- latest activity
- changed file chips
- token/cost/speed data when available
- review/apply/open-worktree actions
- inline "message agent" composer

## Target VS Code Shape

Build one new Backboard workspace page in VS Code with two major regions:

```text
Backboard Workspace Page
  Center:
    3-by-N grid of Backboard agent panels/cards

  Right:
    Backboard Copilot-style chat/detail composer
```

The center is the workspace. It is not the normal code editor area.

The right panel is the Copilot implementation surface. It is where the selected
agent's chat, composer, model/tool controls, transcript, and tool-call details
appear.

The practical first version should be:

```text
Backboard Workspace Page
  Header
  Center agent card grid
  Right panel detail/chat using existing agent-host-backboard session UI
```

Visual target:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                         BACKBOARD AGENT WORKSPACE PAGE                       │
├──────────────────────────────────────────────────────────────┬───────────────┤
│                                                              │               │
│  CENTER: 3 x N AGENT GRID                                    │  RIGHT PANEL  │
│                                                              │  COPILOT UI   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │               │
│  │ Agent Card A │  │ Agent Card B │  │ Agent Card C │        │  Selected     │
│  │ running      │  │ done         │  │ blocked      │        │  Agent Chat   │
│  │ files: 3     │  │ files: 1     │  │ needs input  │        │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │  Composer     │
│         │                 │                 │                │  Model        │
│         │ click           │ click           │ click          │  Tools        │
│         ▼                 ▼                 ▼                │  Transcript   │
│   selectedRunId=A   selectedRunId=B   selectedRunId=C        │               │
│                                                              │               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │               │
│  │ Agent Card D │  │ Agent Card E │  │ Agent Card F │        │               │
│  └──────────────┘  └──────────────┘  └──────────────┘        │               │
│                                                              │               │
└──────────────────────────────────────────────────────────────┴───────────────┘
```

Selection drives the right panel:

```text
No selected card
  -> right panel shows New Agent / draft composer

User clicks card A
  -> selectedRunId = A
  -> right panel shows card A's Backboard chat session

User clicks card B
  -> selectedRunId = B
  -> right panel swaps to card B's Backboard chat session
```

The normal editor still matters, but as context and navigation. Do not make the
first workspace page depend on embedding the code editor in the center. The page
can later add editor-aware actions like opening changed files, using the active
file as context, and reviewing/applying diffs.

Communication between the main surfaces:

```text
NORMAL EDITOR PAGE
  │
  │ provides context:
  │ active file, selected text, diagnostics, git changes, open tabs
  ▼

BACKBOARD AGENT WORKSPACE PAGE
  │
  │ owns:
  │ agent cards, selectedRunId, run metadata, statuses, batch grouping
  │
  │ when card clicked:
  │ selectedRunId changes
  ▼

RIGHT COPILOT/BACKBOARD PANEL
  │
  │ shows selected agent session:
  │ chat transcript, composer, model selector, tool calls
  │
  │ sends prompt/tool results through:
  ▼

BackboardAgent -> Rust bridge -> Backboard API
```

Simple ownership model:

```text
Editor = context source
Agents Workspace = mission control grid
Right Panel = selected agent conversation
Backboard = actual backend
```

The new page should not invent a second Backboard backend. It should create and display `agent-host-backboard` sessions.

## VS Code Source Areas

Use these current VS Code areas:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
src/vs/workbench/contrib/chat/common/chatSessionsService.ts
src/vs/workbench/contrib/chat/common/constants.ts
src/vs/workbench/contrib/chat/browser/chatViewPane.ts
src/vs/workbench/contrib/chat/browser/agentSessions/
src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/
src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts
src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatInputPicker.ts
src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts
```

Current Backboard backend entry point:

```text
src/vs/platform/agentHost/node/backboard/backboardAgent.ts
```

Current Backboard session type:

```text
agent-host-backboard
```

Current Backboard credentials:

```text
~/.backboard_ide/config.json
```

## Backend Ownership

Keep this ownership split:

| Area | Owner |
| --- | --- |
| Prompt/model/mode config | `BackboardAgent` |
| Backboard API calls | Rust `backboard-bridge` |
| Credential lookup | `~/.backboard_ide/config.json` through Rust and SSO bootstrap |
| Local workspace file tools | TypeScript host |
| Web/network bridge tools | Rust bridge |
| Composer/client tools | VS Code client tool protocol, routed through BackboardAgent |
| Agent cards and metadata | New Backboard workspace page service/store |
| Chat detail UI | Existing agent-host Backboard chat widgets |

Do not put agent-card state in the Rust bridge. The bridge should only know how to run a Backboard turn.

## Data Model For VS Code

Create a lightweight run metadata model similar to Zed:

```ts
interface BackboardWorkspaceRun {
	id: string;
	sessionUri: URI;
	title: string;
	task: string;
	createdAt: number;
	kind: 'build' | 'review' | 'test' | 'docs';
	scope: 'wholeProject' | 'selectedFiles' | 'gitChanges' | 'testsOnly';
	mode: 'agent' | 'ask' | 'manual' | 'free';
	workspacePath?: string;
	worktreePath?: string;
	branchName?: string;
	baseCommit?: string;
	changedPaths: string[];
	applyState: 'pending' | 'applying' | 'applied' | 'blocked';
	blockedReason?: string;
	batchId?: string;
	batchIndex?: number;
	batchSize?: number;
	status: 'queued' | 'running' | 'done' | 'blocked' | 'failed';
}
```

Persist it separately from the Backboard bridge. The initial storage can be JSON under:

```text
~/.backboard_ide/workspace-runs.json
```

or VS Code storage, if the page is implemented fully inside the workbench.

## New Page Responsibilities

The new Backboard workspace page should own:

- listing runs
- creating a draft agent
- promoting a draft into a run
- showing a selected run
- dismissing a run
- stopping a run
- retrying a run
- opening the underlying Backboard chat session
- showing recent activity from the session
- showing changed files and apply/review actions

It should not own:

- Backboard API calls
- credential loading
- model list fetches
- direct tool execution
- chat turn streaming

Those already belong to the Backboard agent-host path.

## Session Flow

### New Agent

```text
User clicks New Agent
  -> create draft Backboard chat session
  -> open right-side composer/detail
  -> user enters task
  -> promote draft to workspace run metadata
  -> send initial prompt through agent-host-backboard
  -> card appears in dashboard
```

### Batch Agents

```text
User enters multiple tasks or picks a batch action
  -> parse tasks
  -> create batch id
  -> create one Backboard session per task
  -> create one run metadata object per session
  -> auto-submit each initial prompt
  -> dashboard cards update independently
```

### Selected Agent Detail

```text
User clicks agent card
  -> selectedRunId = card id
  -> right detail opens
  -> existing Backboard session chat is shown
  -> composer messages go to the same session
```

### Tool Calls

```text
Backboard API requests tool
  -> Rust bridge emits toolRequested
  -> BackboardAgent maps it to VS Code tool-call UI
  -> local/VS Code/client tool executes
  -> BackboardAgent sends submitToolResult
  -> continuation streams into same session
  -> workspace card updates latest activity
```

The workspace page only observes these events. It does not execute tools.

## Prompt Shape For Workspace Agents

When creating workspace agents, prepend a short workspace-worker instruction like Zed does:

```text
You are running as a Backboard Agent Workspace worker.
Agent type: <kind> - <kind guidance>
Scope: <scope> - <scope guidance>
Mode: <mode> - <mode guidance>
Workspace: <current workspace or isolated worktree guidance>
Task: <task>

Work independently and stream concise progress as you go.
Use tools when needed. Preserve unrelated user changes.
Call out conflicts with other active agents.
```

Do not replace the main Backboard system prompt. This text is user/task context for this run.

## Modes

Match Zed's modes:

| UI label | Mode id | Behavior |
| --- | --- | --- |
| Agent | `agent` | normal agent approval flow |
| Ask | `ask` | read/search/explain, no file writes or shell mutation |
| Manual | `manual` | focused edits with explicit review |
| Full Access | `free` | autonomous tool access for routine actions |

These already map to Backboard config values in the VS Code Backboard agent.

## Agent Kinds

Start with Zed's set:

| Kind | Prompt guidance |
| --- | --- |
| Build | Write or refactor production code |
| Review | Analyze behavior, risks, bugs, regressions, missing tests |
| Test | Generate, repair, and run focused tests |
| Docs | Write or update docs and examples |

## Agent Scopes

Start with Zed's set:

| Scope | Prompt guidance |
| --- | --- |
| Whole Project | Use the whole project as context |
| Selected Files | Focus on currently relevant files |
| Git Changes | Focus on current git changes and preserve unrelated work |
| Tests Only | Focus on tests, coverage, and verification |

## Editor Integration

For the first implementation, keep the center of the new page as the 3-by-N
agent grid. The editor should remain the normal VS Code editor experience
outside the page, with contextual actions from cards and the right detail panel.

Then add:

- open touched file from card
- open changed-file diff
- reveal selected agent's working directory
- show current editor file as suggested context
- create agent from selected files
- create review agent from current git changes

Do not block the first page on isolated worktrees. Start with current-workspace agents.

## Worktree Support

Zed creates linked git worktrees when a repository is available. That is useful, but it is not required for the first VS Code page.

Recommended order:

1. Current-workspace agents only.
2. Add metadata for worktree fields, but leave them empty.
3. Add "Open worktree" only after worktree creation exists.
4. Add apply/review/merge flow last.

This avoids mixing UI, git state, and Backboard chat rewire risk in one step.

## Implementation Phases

### Phase 1: Reuse Existing Backboard Chat

Goal:

```text
One Backboard session can be shown as the detail chat for the new page.
```

Build:

- command: `Backboard: Open Agent Workspace`
- page shell with header and empty card state
- "New Agent" button
- right-side detail that opens an `agent-host-backboard` session

Do not add batch agents yet.

Exit criteria:

- page opens
- New Agent opens composer/detail
- sending a prompt reaches Backboard
- tool calls still render in the detail chat

### Phase 2: Run Metadata And Cards

Goal:

```text
Every promoted agent task has a card.
```

Build:

- run metadata store
- card list
- selected card state
- status mapping from session activity
- latest event rows
- changed path chips if available

Exit criteria:

- create task -> card appears
- click card -> detail opens same session
- stop/retry basic actions work

### Phase 3: Batch Agents

Goal:

```text
Multiple Backboard sessions can run from one page.
```

Build:

- task parser
- batch id
- `batchIndex` / `batchSize`
- dashboard counters
- per-card running/done/blocked status

Exit criteria:

- create 2-3 tasks
- each gets its own Backboard session
- each streams independently
- selecting one does not lose another

### Phase 4: Editor And Context Actions

Goal:

```text
The page works with the editor through context and actions, while the center
remains the 3-by-N agent grid.
```

Build:

- create agent from selected files
- create review agent from git changes
- open touched file from card
- open diff/review for a run
- show active editor context in composer

Exit criteria:

- selected-file agent receives file context
- git-change review agent receives changed files context
- card file chips navigate correctly

### Phase 5: Worktrees And Apply Flow

Goal:

```text
Agent runs can isolate changes and apply them back.
```

Build:

- linked worktree creation
- branch naming
- base commit tracking
- apply state
- conflict detection
- review/apply UI

Exit criteria:

- one run creates isolated worktree
- agent edits there
- review shows diff
- apply succeeds or reports blocked conflict

## What To Copy From Zed Conceptually

Copy these ideas:

- cards wrap normal chat sessions
- new workspace page observes the chat/session backend
- run metadata is separate from the model runtime
- modes/kinds/scopes are explicit
- batch agents use one thread per task
- dashboard and detail use the same underlying conversation
- tool execution stays centralized

Do not copy these directly:

- GPUI rendering code
- Rust entity patterns
- Zed-specific ACP traits
- Zed worktree implementation details before VS Code has the page working

## Current VS Code Status

As of this reference update:

- right-panel Backboard backend plumbing exists
- Backboard credentials load from `~/.backboard_ide/config.json`
- `agent-host-backboard` is registered
- Backboard tool calls work at bridge/backend level
- composer/client tools are routed through BackboardAgent
- DeepSeek R1 smoke test passed through the rebuilt Rust bridge
- first Backboard Agent Workspace shell is implemented in:

```text
src/vs/sessions/browser/parts/sessionsPart.ts
src/vs/sessions/browser/parts/media/sessionsPart.css
src/vs/sessions/browser/parts/mobile/mobileSessionsPart.ts
src/vs/sessions/test/browser/mobileSessionsPart.test.ts
```

The implemented shell:

- renders the center as a 3-by-N card grid over existing visible sessions
- uses one right-side `SessionView` as the selected agent's Backboard detail/chat
- swaps the right panel when an agent card is clicked
- shows the new-session composer on the right when no card is selected
- keeps prompts, tools, models, and streaming on the existing Backboard session path

Remaining work:

- actual workbench UI click-through
- richer card metadata store beyond existing session fields
- batch agents
- editor/context actions
- worktree/apply flow

## Simple Rule

The new page should be a workspace over Backboard chat sessions, not a second chat system.

If a feature needs to talk to the model, route through `agent-host-backboard`.

If a feature needs to display agents, store workspace-run metadata and observe existing session state.
