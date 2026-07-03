# What Remains of Copilot in the Right Panel & Agents

**Bottom line:** the right panel is NOT built on the Copilot extension. What survives is
(1) naming — `github.copilot.*` command IDs and setting keys owned by Backboard code,
(2) a Backboard-owned provider with a vestigial "Copilot" name, and
(3) a few genuinely Copilot-dependent session flows (CLI / cloud / Claude) that still need the
bundled extension. The repo's own audit at
`bb-docs/backboard-agent-bridge/copilot-right-panel-dependency-audit.md` reaches the same
conclusion.

## Ownership map

```
┌─ Right panel (auxiliary bar) ────────────────────────────────────────────────┐
│  shell + tabs: Launcher / Review / Files / Browser / Terminal                │
│  contrib/rightWorkbench/*, browser/parts/auxiliaryBarPart.ts                 │
│  ██ 100% Backboard core — zero imports from extensions/copilot ██            │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Chat widget ────────────────────────────────────────────────────────────────┐
│  vs/workbench/contrib/chat (Microsoft upstream, generic — not Copilot)       │
│  wrapped by Backboard composers (doc 06)                                     │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Session providers ──────────────────────────────────────────────────────────┐
│                                                                              │
│  LocalAgentHostSessionsProvider          ██ Backboard ██                     │
│    'agent-host-backboard' → Rust bridge → Backboard API                      │
│                                                                              │
│  CopilotChatSessionsProvider (id 'default-copilot')                          │
│    ░░ Backboard CODE, Copilot NAME ░░                                        │
│    ├─ CopilotCLISession      ▓▓ needs Copilot ext (@github/copilot/sdk) ▓▓   │
│    ├─ RemoteNewSession       ▓▓ needs Copilot ext (cloud agents) ▓▓          │
│    ├─ ClaudeCodeNewSession   ▓▓ needs Copilot ext ▓▓                         │
│    └─ AgentSessionAdapter    ░░ adapts chat-layer IAgentSession ░░           │
│                                                                              │
│  ██ = Backboard-owned   ░░ = Backboard code, legacy naming   ▓▓ = Copilot dep│
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1. Naming remnants (Backboard-owned, Copilot-branded)

These `github.copilot.*` identifiers are **registered and handled by Backboard sessions code**,
kept only for backward compatibility — they are not calls into the Copilot extension:

| Identifier | Where | Kind |
|---|---|---|
| `github.copilot.sessions.commit` | `contrib/changes/browser/changesView.ts:26-30` | command |
| `github.copilot.claude.sessions.sync` / `.rename` | `changesView.ts:26-30` | commands |
| `github.copilot.chat.cloudSessions.openRepository` | `contrib/chat/browser/repoPicker.ts:6` | command |
| `github.copilot.cli.sessions.setTitle`, `agents.github.copilot.cli.deleteSessions` | `copilotChatSessionsProvider.ts:142` | commands |
| `github.copilot.chat.claudeAgent.allowAutoPermissions` | `claudePermissionModePicker.ts:13` | setting |
| `github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions` | `claudePermissionModePicker.ts:14` | setting |
| `github.copilot.chat.cli.isolationOption.enabled` | `isolationPicker.ts:47,56` | setting |
| `github.copilot.chat.claudeCode.enabled` | `contrib/configuration/browser/configuration.contribution.ts:5` | setting |
| `sessions.github.copilot.multiChatSessions` | `copilotChatSessions.contribution.ts:19` | setting |
| `Schemas.copilotPr` | `changesView.ts` | URI scheme for PR tree roots |

A grep for `github\.copilot` in `src/vs/sessions` yields ~50 hits — essentially all command
IDs, setting keys, or config inspection; **none are imports of or API calls into the Copilot
extension**.

## 2. The misleadingly named `CopilotChatSessionsProvider`

`contrib/providers/copilotChatSessions/browser/copilotChatSessionsProvider.ts` (3011 lines) is
Backboard code implementing Backboard's `ISessionsProvider` interface:

- Registered as a **core workbench contribution**
  (`copilotChatSessions.contribution.ts:48-62`, imported from
  `sessions.common.main.ts:15`) — no extension activation involved.
- Provider ID `COPILOT_PROVIDER_ID = 'default-copilot'` (`:145`).
- Session facades: `CopilotCLISession` (`:194-508`), `RemoteNewSession` (`:527-765`),
  `ClaudeCodeNewSession` (`:774-901`), `AgentSessionAdapter` (`:922-1252`).

The name is vestigial; the provider exists so legacy CLI/cloud/Claude session types keep
working while Backboard's agent-host provider takes over as the default.

## 3. What still genuinely requires the bundled Copilot extension

From the dependency audit (`copilot-right-panel-dependency-audit.md:114-147`):

| Feature | Needs Copilot ext? |
|---|---|
| Right-panel shell, tabs, Review/Files/Browser/Terminal | **No** |
| Backboard agent-host provider + Rust bridge | **No** |
| Backboard extension webview (`extensions/backboard`) | **No** |
| Copilot CLI / background sessions (`@github/copilot/sdk`) | **Yes** |
| GitHub Copilot cloud / coding-agent flows | **Yes** |
| Copilot-contributed chat participants (`extensions/copilot/package.json`) | **Yes** |
| Copilot-contributed language-model tools | **Yes** |

Audit's guidance: keep Copilot bundled until every default chat/session entry point provably
routes to the Backboard agent-host; then it can become an optional download.

## 4. Customization spec lineage

`src/vs/sessions/copilot-customizations-spec.md` (357 lines) documents customization discovery
(instructions, skills, commands, agents, MCP servers, hooks, plugins). It was derived from
`github/copilot-agent-runtime` (2026-02-25 snapshot) but is now **Backboard's spec**; discovery
paths mix all three ecosystems:

```
 skills      .github/skills/  .agents/skills/  .claude/skills/
 commands    .claude/commands/
 agents      .github/agents/  .claude/agents/
 MCP         ~/.copilot/mcp-config.json  .mcp.json  .vscode/mcp.json  plugins
```

Backboard's own skills live in `src/vs/sessions/skills/` (code-review, commit, create-pr,
fix-ci, merge, sync, …) — not Copilot's.

## 5. Removal checklist (per the audit, :268-296)

Would keep working without Copilot: right panel, review/files/browser/terminal tabs,
agent-host sessions, Backboard webview. Needs migration first: CLI/background flows, cloud
agent flows, Copilot chat participants and LM tools, and any "new session" defaults that still
route to Copilot session types. Validation: confirm model pickers default to Backboard models
and new-session flows create `agent-host-backboard` sessions.
