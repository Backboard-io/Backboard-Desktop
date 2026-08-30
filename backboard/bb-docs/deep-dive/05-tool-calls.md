# Tool Calls — Data Model, State Machine, Permissions, Execution, Rendering

> **Status (July 2026):** for Backboard agent-host sessions, tool **execution** moved into the
> cli-ts serve process (`ToolScheduler` in `cli-ts/src/core/tools/`), which runs Read/Write/Edit/
> ApplyPatch/Execute/Grep/Glob/FetchUrl/WebSearch/AskUser/TodoWrite (+ MCP) itself in the session
> cwd. The IDE-side sections below on the *data model, state machine, and rendering* still apply —
> `CliTsAgent` (`node/cliTs/cliTsAgent.ts`) translates cli-ts `tool:*` events into the same
> `ChatToolCallStart/Ready/Complete` actions. Approvals: cli-ts emits `permission:request`
> (answered via `respondPermission`); AskUser flows through `ChatInputRequested`. The
> "Where tool calls come from" / parallel-execution sections below describe the retired Rust-bridge
> path (kept for the extension webview) — cli-ts's own scheduler now owns parallelism rules.

## The tool-invocation data model

Tool calls are modeled as `IChatToolInvocation`
(`src/vs/workbench/contrib/chat/common/chatService/chatService.ts:702-726`) — an observable-driven
state machine the chat renderer subscribes to (verbatim):

```ts
export interface IChatToolInvocation {
    readonly presentation: IPreparedToolInvocation['presentation'];
    readonly toolSpecificData?: IChatTerminalToolInvocationData | ILegacyChatTerminalToolInvocationData
        | IChatToolInputInvocationData | IChatExtensionsContent | IChatPullRequestContent
        | IChatTodoListContent | IChatSubagentToolInvocationData | IChatSimpleToolInvocationData
        | IChatSearchToolInvocationData | IChatToolResourcesInvocationData
        | IChatModifiedFilesConfirmationData | IChatAgentFeedbackReviewConfirmationData;
    readonly toolSpecificDataKind: IObservable<string | undefined>;   // reactive re-render key
    readonly originMessage: string | IMarkdownString | undefined;
    readonly invocationMessage: string | IMarkdownString;
    readonly pastTenseMessage: string | IMarkdownString | undefined;
    readonly source: ToolDataSource;
    readonly toolId: string;
    readonly toolCallId: string;
    readonly subAgentInvocationId?: string;
    readonly icon?: ThemeIcon;
    readonly state: IObservable<IChatToolInvocation.State>;           // ← THE state machine
    generatedTitle?: string;
    isAttachedToThinking: boolean;
    kind: 'toolInvocation';
    toJSON(): IChatToolInvocationSerialized;
}
```

### `toolSpecificData` variants (the 12-member union, `:704`)

| kind | Interface | Line |
|---|---|---|
| `terminal` | `IChatTerminalToolInvocationData` | 541 |
| `terminal` (legacy) | `ILegacyChatTerminalToolInvocationData` | 628 |
| `input` | `IChatToolInputInvocationData` (`rawInput`, `mcpAppData?`) | 677 |
| `extensions` | `IChatExtensionsContent` | 1000 |
| `pullRequest` | `IChatPullRequestContent` | 1005 |
| `subagent` | `IChatSubagentToolInvocationData` | 1018 |
| `todoList` | `IChatTodoListContent` | 1045 |
| `simpleToolInvocation` | `IChatSimpleToolInvocationData` (`input`, `output`) | 1054 |
| `search` | `IChatSearchToolInvocationData` | 1060 |
| `resources` | `IChatToolResourcesInvocationData` (`values: Array<URI\|Location>`) | 1064 |
| `modifiedFilesConfirmation` | `IChatModifiedFilesConfirmationData` | 1069 |
| `agentFeedbackReviewConfirmation` | `IChatAgentFeedbackReviewConfirmationData` | 1100 |

## State machine

`StateKind` enum (verbatim, `:729-737`): `Streaming(0)`, `WaitingForConfirmation(1)`, `Executing(2)`,
`WaitingForPostApproval(3)`, `Completed(4)`, `Cancelled(5)`. The `State` union is at `:794-800`.

```
                              (LM streams tool args)
  ┌───────────┐   parameters complete + confirmation gate
  │ Streaming │──────────────────────────────────────────────┐
  └───────────┘  state.partialInput / streamingMessage        │
                                                               ▼
                                            ┌────────────────────────────┐
              confirm(ConfirmedReason)      │   WaitingForConfirmation    │
        ┌───────────────────────────────────│  state.confirm(reason) :759 │
        │ (Setting / UserAction /            │  parameters, confirmationMsgs│
        │  LmServicePerTool /                └────────────────────────────┘
        │  ConfirmationNotNeeded)                 │ confirm(Denied|Skipped)
        ▼                                         ▼
  ┌───────────┐                            ┌───────────┐
  │ Executing │                            │ Cancelled │  reason + reasonMessage
  └───────────┘  state.progress:IObservable└───────────┘
        │  result produced                      ▲
        ▼                                       │ deny
  ┌────────────────────────┐  confirm(deny)     │
  │ WaitingForPostApproval  │────────────────────┘
  │  contentForModel        │  (optional 2nd gate — many tools skip it)
  └────────────────────────┘
        │ confirm(approve)
        ▼
  ┌───────────┐
  │ Completed │  postConfirmed, contentForModel, resultDetails
  └───────────┘
```

`ConfirmedReason` / `ToolConfirmKind` enum (`:685-692`): `Denied, ConfirmationNotNeeded, Setting,
LmServicePerTool, UserAction, Skipped`. When no confirmation is needed the model synthesizes a
`ConfirmationNotNeeded`/`Setting` reason and passes straight from `Streaming` to `Executing`.

`Executing`, `Cancelled`, and the terminal path have **no explicit `StateKind` case** in the
renderer dispatch — they reach a fall-through part that differentiates internally via `state.progress`
/ `state.reasonMessage` (see the renderers table below).

## Where tool calls come from (Backboard sessions)

For Backboard agent-host sessions, tool calls arrive from the Rust bridge as `toolRequested` events
(doc 04). `backboardAgent.ts` handles them in `_handleBridgeEvent case 'toolRequested'` (`:962`):
flush assistant text, dedupe on `toolResultRequestKey` vs `seenToolRequests` (`:967`), queue onto the
`toolRequests` array. The round-trip loop (`:526-560`) then runs each batch and submits results via
`_bridge.send('submitToolResult', …, { threadId, runId, toolOutputs, tools })` (`:540`).

### Parallel-vs-sequential execution rule

`_executeToolCalls` (`:1083`):

```ts
if (preparedCalls.length > 1 && preparedCalls.every(p => this._canExecuteToolCallInParallel(p, accessMode))) {
    return Promise.all(preparedCalls.map(p => this._executePreparedToolCall(...)));   // parallel :1088
}
// else sequential for-await loop, re-reading accessMode each iteration           :1090-1096
```

`_canExecuteToolCallInParallel` (`:1109`) requires: **not a client tool**, **`accessMode !== manual`**,
**and `isParallelSafeBackboardTool(name)`**. The parallel-safe set (`:3852`) is read-only:
`read_file, list_dir, glob, grep, codebase_search, backboard_read_attachment`. So *multiple
read-only, non-client calls in a non-manual session* run concurrently; everything else runs one at a
time.

### Per-call lifecycle & the wire shape

`_executePreparedToolCall` (`:1146`) fires AHP actions as the call progresses: `ChatToolCallStart`
(`:1151`), `ChatToolCallDelta` (`:1160`, carries `toolInput`), `ChatToolCallReady` (`:1197`/`:1308`),
`ChatToolCallContentChanged` (`:1319`), `ChatToolCallComplete` (`:1361` success / `:1377` failure).
File-edit tools (`isFileEditTool`, `:3849`) snapshot before-content via
`FileEditTracker.trackEditStart` (`:1328`) and append a `ToolResultFileEditContent` diff pill on
success (`:1345`).

Each branch returns the wire object from `toolOutput(toolCallId, output)` (`:4128`):

```ts
{ tool_call_id: toolCallId, toolCallId, output: JSON.stringify(output) }
```

These become the `toolOutputs` array submitted at `:540`.

## Permission / approval system

### Level axis — `permissionPicker.ts` (`ChatPermissionLevel`)

`src/vs/sessions/contrib/providers/copilotChatSessions/browser/permissionPicker.ts`. Levels
(`constants.ts:119-125`): `Default='default'`, `AutoApprove='autoApprove'`, `Autopilot='autopilot'`.

```
 Default      🛡  "Default Approvals"  — use configured approval settings   (item :166)
 AutoApprove  ⚠  "Bypass Approvals"   — all tool calls auto-approved         (item :179)
 Autopilot    🚀 "Autopilot (Preview)"— autonomous iteration until done      (item :192)
```

`_selectLevel(level)` (`:253`) → `maybeConfirmElevatedPermissionLevel(...)` (`:254`,
`chatPermissionWarnings.ts:72` — warning dialog for `Autopilot`/`AutoApprove` with a "Don't show
again" checkbox) → set `_currentLevel` + label → `this._delegate.setPermissionLevel(level)` (`:279`)
→ telemetry. Initial level clamps to `Default` when the `GlobalAutoApprove` policy is `false`
(`:92-97`).

### Delegates — who stores the level

```
                      PermissionPicker (UI trigger + ActionList)
                         │  reads currentPermissionLevel (observable)
        ┌────────────────┴───────────────────┐
        ▼                                    ▼
 CopilotPermissionPickerDelegate      AgentHostPermissionPickerDelegate
 (permissionPicker.ts)                (agentHostPermissionPickerDelegate.ts:58)
 reads/writes session option          setPermissionLevel → provider.setSessionConfigValue(
 'permissionLevel'                       id, SessionConfigKey.AutoApprove, level)   :100
                                      isApplicable ⇔ isWellKnownAutoApproveSchema   :118,:128
```

### Claude permission modes (5) — `claudePermissionModePicker.ts`

`ClaudePermissionModePicker` (`:71`, default `acceptEdits`):

```
 default            🛡  "Ask Before Edits"                                   (:38)
 acceptEdits        ✏  "Edit Automatically"                                  (:44)
 plan               💡 "Plan Mode"                                           (:50)
 auto               (logo) model-classifier approval    ← gated by            (:57)
                    github.copilot.chat.claudeAgent.allowAutoPermissions      (:26,:131)
 bypassPermissions  ⚠  everything runs unconfirmed      ← gated by            (:64)
                    github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions (:27,:134)
```

### Manual approval & the registries

- `pendingClientToolCalls: PendingRequestRegistry<ToolCallResult>` and
  `pendingToolApprovals: PendingRequestRegistry<boolean>` on each session (`backboardAgent.ts:188`).
- Manual approval: `_awaitManualToolApproval` (`:1115`) → `pendingToolApprovals.registerAndFire`; a
  250ms interval auto-approves with reason `Setting` if `accessMode` changes away from `manual`
  mid-wait (`:1131`). Answered by `respondToPermissionRequest` (`:616`) → `.respond`.
- Client-tool completion arrives via `onClientToolCallComplete` (`:686`) →
  `pendingClientToolCalls.respondOrBuffer(toolCallId, result)`.
- `PendingRequestRegistry` (`pendingRequestRegistry.ts:21`): `registerAndFire` parks a
  `DeferredPromise` **before** invoking `fire()` (atomic register-then-fire); `respondOrBuffer`
  (`:88`) buffers into `_earlyResults` when completion beats the awaiter (race guard); `rejectAll`
  (`:122`) rejects all on cancel/dispose.

### Mobile

`mobilePermissionPicker.ts` subclasses `PermissionPicker` (`:31`) and renders an "Approvals" bottom
sheet with the same three `ChatPermissionLevel` options, routing through the inherited `_selectLevel`
so it inherits the elevated-level confirmation.

## Rendering the states

Dispatch: `chatToolInvocationPart.ts` → `createToolInvocationSubPart()`, explicit `StateKind`
branches at `:186 / :190 / :203`, else fall-through to result-type handlers (`:208-269`).

| State | Renderer part | file:line |
|---|---|---|
| `Streaming` | `ChatToolStreamingSubPart` | dispatch :187; class chatToolStreamingSubPart.ts:21 |
| `WaitingForConfirmation` (generic) | `ToolConfirmationSubPart` | dispatch :200; chatToolConfirmationSubPart.ts:39 |
| `WaitingForConfirmation` (terminal) | `ChatTerminalToolConfirmationSubPart` | dispatch :194; chatTerminalToolConfirmationSubPart.ts:66 |
| `WaitingForConfirmation` (sandbox prereq) | `ChatSandboxPrerequisiteConfirmationSubPart` | dispatch :192 |
| `WaitingForConfirmation` (modified files) | `ChatModifiedFilesConfirmationSubPart` | dispatch :196 |
| `WaitingForConfirmation` (agent feedback) | `ChatAgentFeedbackReviewConfirmationSubPart` | dispatch :198 |
| `WaitingForPostApproval` | `ChatToolPostExecuteConfirmationPart` | dispatch :204; chatToolPostExecuteConfirmationPart.ts:25 |
| `Executing` (terminal) | `ChatTerminalToolProgressPart` | dispatch :209; chatTerminalToolProgressPart.ts:269 |
| `Executing` (default) | `ChatToolProgressSubPart` | fall-through :269; chatToolProgressPart.ts:25 |
| `Completed` | result-type: `ChatToolOutputSubPart` / `ChatResultListSubPart` / `ChatInputOutputMarkdownProgressPart` / `ChatSimpleToolProgressPart` | :208-269 |
| `Cancelled` | `ChatToolProgressSubPart` (default) — shows `state.reasonMessage` | chatToolProgressPart.ts:25 |

Streaming shimmer: `shouldShimmerForTool` (`chatToolPartUtilities.ts:21`) returns true only for the
askQuestions tool while incomplete.

## File-edit tools → Changes & Review views

`ISessionChangeset` — the canonical interface — lives in
`src/vs/sessions/services/sessions/common/session.ts:154-192` (not a `changeTracking` file):
`id`, `label`, `isEnabled: IObservable<boolean>`, `isDefault`, `isLoadingChanges`,
`changes: IObservable<readonly ISessionFileChange[]>` (`:178`), `operations` (`:180`),
`originalCheckpointRef`/`modifiedCheckpointRef`, `invokeOperation(operationId, target?)`.

```
 file-edit tool result → ToolResultFileEditContent (backboardAgent.ts:1345)
        │  agent-host state protocol → AgentHostChangeset → ISessionChangeset
        ▼
 ┌─ Changes view ──────────────────────────┐   ┌─ Review tab (right panel) ──────┐
 │ contrib/changes/browser/changesView.ts  │   │ contrib/rightWorkbench/browser/ │
 │ ChangesViewPane extends ViewPane (:304) │   │   reviewTree.ts                 │
 │ reads viewModel.activeSessionChangesets │   │ IReviewResource {key, sourceUri,│
 │   Obs (:1374) → file items (:1377)      │   │   status, additions, deletions, │
 │ tree via changesViewRenderer            │   │   open()}                (:20)   │
 │   .buildTreeChildren                    │   │ buildReviewTreeChildren  (:42)   │
 │ commit: github.copilot.sessions.commit  │   │ ReviewTreeRenderer/Delegate      │
 │   (toolbar ref :151)                    │   │ (folder tree via ResourceTree)  │
 └──────────────────────────────────────────┘   └─────────────────────────────────┘
```

The `github.copilot.sessions.commit` / `commitAndSync` commands are *referenced* in the Changes
toolbar (`changesView.ts:151`/`:165`) but their **handlers are registered in the Copilot CLI
extension** (`extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts`) —
one of the genuine extension dependencies (see doc 07).

## End-to-end: bridge event → DOM → `submitToolResult`

```
 1. Rust bridge streams `toolRequested` → _handleBridgeEvent (:962), deduped & queued
 2. Loop (:526-560) → _executeToolCalls (:1083) → _executePreparedToolCall (:1146)
       fires ChatToolCallStart/Delta/Ready/ContentChanged/Complete
 3. agentHostSessionHandler.ts consumes those actions and mutates
       IChatToolInvocation.state observable (autorun flips WaitingForConfirmation→Executing,
       dispatches ChatToolCallConfirmed :1979; auto-approves client tools when configured)
 4. chatToolInvocationPart.createToolInvocationSubPart() reads state.type and instantiates
       the mapped renderer; re-renders on every state / toolSpecificDataKind change
 5. Confirmation UI calls state.confirm(reason) (:759); on completion each call returns
       { tool_call_id, toolCallId, output } (:4128); the loop batches these into toolOutputs
       and calls _bridge.send('submitToolResult', …) (:540) — closing the loop until the model
       stops requesting tools
```

Terminal tool calls carry `IChatTerminalToolInvocationData` (`chatService.ts:541`) — `commandLine`,
`cwd`, `confirmation`, `terminalCommandUri/Output/State/Theme` — and render an embedded terminal
emulator (`ChatTerminalToolProgressPart`) that restores decorations after reload.
