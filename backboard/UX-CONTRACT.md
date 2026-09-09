# Editor chat behavior contract

Scope: the existing local Backboard provider in Editor mode. Source: the user's approved file-navigation, rewind, and API-context requirements, plus the Backboard `context_usage` response schema documented in `cli-ts/src/providers/backboard/types.ts`.

| Capability | Canonical owner | Observable behavior |
| --- | --- | --- |
| File navigation | `chatEditNavigation.ts`, `ChatMultiDiffContentPart`, `IEditorService` | Filename activation opens the full live file, preserving editor options. View Change and Open Changes retain historical comparisons. A deleted edit-card file uses its before snapshot when the live path is absent. |
| Restore boundary | `AgentHostSnapshotController`, `AgentHostRewind`, CLI `EditorRewind` | Restore the state before the selected request, including its and subsequent requests' captured file changes. Advance the chat boundary only after restoration succeeds. |
| Recovery | Text-file/autosave services and CLI checkpoint journal | Preserve affected disk files and unsaved buffers before overwrite. A partial failure recovers them; pending editor refresh persists through reopen and blocks new submissions until acknowledged. |
| Continue after rewind | `CliTsAgent` | Archive the discarded local tail. Start a fresh provider thread seeded with the retained visible transcript. Keep the local conversation identity. |
| Context usage | Backboard stream mapper, state adapter, shared context widget | Use API `used_tokens`, `context_limit`, `percent`, `summary_tokens`, and `model`. Accept zero and compaction decreases. Missing/invalid API counts display unavailable. Never substitute billing totals or catalog capacity for this API measurement. |
| Pending context | Shared context widget | Previous response measurements may remain labeled as such during the next response. Clear on session switch and rewind. |
| Accessibility | Native buttons, WorkbenchList, hover and localization services | Preserve Enter/Space activation, focus indication, accessible names, and modifier-based editor groups. |

Existing confirmation settings remain authoritative. Later manual edits in affected files are overwritten with recoverable backups as approved by the user. Remote-provider rewind, unsupported files, and legacy conversations without durable boundaries must not claim successful file restoration. See `docs/editor-chat-restoration.md` for implementation and recovery limits.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| File navigation | IEditorService and chatEditNavigation | User-approved full-file behavior | Explicit View Change and Open Changes | chatEditNavigation.test.ts |
| Rewind | AgentHostSnapshotController and AgentHostRewind | User-approved before-request boundary | Active rewind recovery and redo | agentHostRewind.test.ts, EditorRewind.test.ts |
| Context usage | ChatContextUsageWidget and ChatContextUsageDetails | Backboard context_usage API schema | Other provider usage remains provider-owned | chatContextUsageWidget.test.ts, mappers.test.ts |
