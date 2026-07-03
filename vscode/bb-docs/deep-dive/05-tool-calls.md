# Tool Calls — Lifecycle, State Machine, Permissions

## The tool invocation data model

Tool calls are modeled as `IChatToolInvocation`
(`src/vs/workbench/contrib/chat/common/chatService/chatService.ts`) — an observable-driven
state machine that the chat renderer subscribes to:

```
IChatToolInvocation
├── toolId / toolCallId / subAgentInvocationId
├── invocationMessage / pastTenseMessage / originMessage   (user-facing strings)
├── toolSpecificData: terminal | input | extension | PR | todo |
│                     subagent | simple | search | resources | confirmation
├── toolSpecificDataKind: IObservable<string>     (reactive re-render key)
└── state: IObservable<IChatToolInvocation.State>  ← THE state machine
```

## State machine

```
              agent emits tool_call over the stream
                             │
                             ▼
                     ┌──────────────┐   partialInput / streamingMessage
                     │  Streaming   │   observables update as args arrive
                     └──────┬───────┘
                            │ input complete
                            ▼
                 ┌────────────────────────┐
                 │ WaitingForConfirmation │◄─── permission level decides whether
                 └──────┬──────────┬──────┘     this state is entered at all
              approve   │          │  deny
        confirm(reason) │          └────────────► ┌───────────┐
                        ▼                         │ Cancelled │ {Denied|Skipped,
                 ┌─────────────┐                  └───────────┘  reasonMessage?}
                 │  Executing  │  progress: IObservable<{message?, progress?}>
                 └──────┬──────┘
                        │ finished
            ┌───────────┴────────────┐
            ▼ (post-review needed)   ▼
 ┌────────────────────────┐   ┌───────────┐
 │ WaitingForPostApproval │──►│ Completed │ {postConfirmed, contentForModel}
 └────────────────────────┘   └───────────┘
```

`StateKind` enum: `Streaming(0)`, `WaitingForConfirmation(1)`, `Executing(2)`,
`WaitingForPostApproval(3)`, `Completed(4)`, `Cancelled(5)`.

## Where tool calls come from (Backboard sessions)

For Backboard agent-host sessions, tool calls arrive from the Rust bridge as `toolRequested`
events (see doc 04). `backboardAgent.ts:1053-1067` then:

1. Parses tool name + arguments per call.
2. Executes **in parallel** iff there are multiple calls, all read-only, and mode ≠ `manual`;
   otherwise sequentially.
3. Collects `[{ tool_call_id, output }]` and submits via the bridge's `submitToolResult`,
   which continues the run on the backend.

Approvals are tracked in per-session `pendingToolApprovals` / `pendingClientToolCalls`
registries (`backboardAgent.ts:171-188`).

## Permission / approval system

The chance a tool call pauses at `WaitingForConfirmation` is governed by a per-session
**permission level**, surfaced by pickers in the composer.

### Permission levels (`ChatPermissionLevel`)

`src/vs/sessions/contrib/providers/copilotChatSessions/browser/permissionPicker.ts:166-203`:

```
 Default      🛡  Codicon.shield   — use configured approval settings
 AutoApprove  ⚠  Codicon.warning  — all tool calls auto-approved (policy can disable)
 Autopilot    🚀 Codicon.rocket   — autonomous iteration until done (preview, policy-gated)
```

Selection flow (`:253-280`): picker → `_selectLevel(level)` →
`maybeConfirmElevatedPermissionLevel()` (confirmation dialog for elevated levels) →
`_delegate.setPermissionLevel(level)` → telemetry.

### Delegates — who stores the level

```
                      PermissionPicker (UI trigger + ActionList)
                         │  reads currentPermissionLevel (observable)
        ┌────────────────┴───────────────────┐
        ▼                                    ▼
 CopilotPermissionPickerDelegate      AgentHostPermissionPickerDelegate
 (permissionPicker.ts:323-366)        (agentHostPermissionPickerDelegate.ts:58-146)
 reads/writes session option          reads provider.getSessionConfig(id)
 'permissionLevel' via                    .values[SessionConfigKey.AutoApprove]
 chatSessionsService                  writes provider.setSessionConfigValue(...)
                                      applicable only when the session's autoApprove
                                      schema is "well-known" (:33-40: string enum
                                      containing 'default' + only known values)
```

### Claude permission modes

Claude Code sessions have their own five-mode picker
(`claudePermissionModePicker.ts:36-69`):

```
 default            🛡  Ask Before Edits
 acceptEdits        ✏  Edit Automatically
 plan               💡 Plan Mode
 auto               (logo) AI classifier approves/denies      ← gated by
                    github.copilot.chat.claudeAgent.allowAutoPermissions
 bypassPermissions  ⚠  everything runs unconfirmed           ← gated by
                    github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions
```

### Mobile

`mobilePermissionPicker.ts` subclasses `PermissionPicker` and swaps the dropdown for a
bottom sheet (`showMobilePickerSheet()`, `:91-106`) when the viewport is phone-sized.

## Rendering the states

Renderers live in
`src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/`:

| State | Part |
|---|---|
| Streaming | shimmer + partial input via `streamingMessage` (`chatToolInvocationPart.ts`) |
| WaitingForConfirmation | `chatToolConfirmationCarouselPart.ts` — approve/deny carousel |
| Executing | `chatToolProgressPart.ts` — progress bar from the `progress` observable |
| Completed | `chatToolOutputPart.ts` — result content (+ post-approval if required) |
| Cancelled | reason + optional message |

## File-edit tools → Changes & Review

Tool calls that edit files feed two Backboard views:

```
 file-edit tool result
        │  ISessionChangeset
        ▼
 ┌─ Changes view ──────────────────────────┐   ┌─ Review tab (right panel) ──────┐
 │ contrib/changes/browser/changesView.ts  │   │ contrib/rightWorkbench/browser/ │
 │ file tree grouped by folder             │   │   reviewTree.ts:20-154          │
 │ (buildTreeChildren, renderer at :74)    │   │ IReviewResource {sourceUri,     │
 │ + additions/deletions stats             │   │   status, additions, deletions, │
 │ commit action:                          │   │   open()}                       │
 │  'github.copilot.sessions.commit'       │   │ buildReviewTreeChildren (:41-64)│
 └──────────────────────────────────────────┘   │ ReviewTreeRenderer (:99-154)    │
                                                │ SCM/git fallback source         │
                                                └─────────────────────────────────┘
```

Terminal tool calls carry `IChatTerminalToolInvocationData` and render an embedded command
preview/output instead.
