# What Remains of Copilot in the Right Panel & Agents

**Bottom line (re-verified):** the right panel is NOT built on the Copilot extension. What survives
is (1) **naming** — `github.copilot.*` command IDs, setting keys, and a URI scheme owned by Backboard
code; (2) a Backboard-owned provider with a vestigial "Copilot" name; and (3) a few genuinely
Copilot-dependent flows (CLI / cloud / Claude, plus the commit/sync command handlers) that still need
the bundled extension. **No source file under `src/vs/sessions` imports `extensions/copilot`** — every
`github.copilot.*` reference is a string resolved dynamically at runtime.

## Ownership map

```
   RIGHT PANEL + AGENTS UI  (all core workbench/sessions — NOT extensions/copilot)
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │ Right-panel shell → src/vs/sessions/contrib/rightWorkbench/*   (no copilot import)  │
 │   ██ 100% Backboard core (see doc 08) ██                                            │
 │ Chat widget     → vs/workbench/contrib/chat (MS upstream, generic — not Copilot)    │
 │ Sessions provider → CopilotChatSessionsProvider  (misleading NAME; core code)       │
 └────────────────────────────────┬────────────────────────────────────────────────────┘
   github.copilot.* strings are ONE of three kinds — NONE import extensions/copilot:
     (1) COMMAND IDs   → commandService.executeCommand('github.copilot.…')  ── late-bound
     (2) SETTING KEYS  → configurationService.getValue('github.copilot.…')  ── plain strings
     (3) URI SCHEME    → Schemas.copilotPr = 'copilot-pr'  (base/common/network.ts:166 — CORE)
                              │  resolved at runtime by whatever extension registers them
                              ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ extensions/copilot (bundled)  — GENUINELY still needed for:                    │
   │   • the command HANDLERS behind github.copilot.* (CLI/cloud PR, commit, sync) │
   │   • Copilot CLI / background agent (@github/copilot/sdk)                       │
   │   • cloud coding-agent auth/session flows                                     │
   │   • default chat participant + languageModelTools contributions              │
   └──────────────────────────────────────────────────────────────────────────────┘
```

## 1. Naming remnants (Backboard-owned, Copilot-branded)

`github.copilot.*` occurrences in `src/vs/sessions` fall into exactly three categories — **all
strings, none imports**:

**(1) Command IDs** — passed to `executeCommand`, resolved by whatever extension registers the
handler (late-bound):

| Identifier | Where |
|---|---|
| `github.copilot.chat.cloudSessions.openRepository` | copilotChatSessionsProvider.ts:142, repoPicker.ts:17 |
| `github.copilot.cli.sessions.setTitle` | copilotChatSessionsProvider.ts:1822 |
| `github.copilot.claude.sessions.rename` | copilotChatSessionsProvider.ts:1826 |
| `agents.github.copilot.cli.deleteSessions` | copilotChatSessionsProvider.ts:1907 |
| `github.copilot.cli.sessions.commitToRepository` / `commitToWorktree` | aiCustomizationWorkspaceService.ts:186,208 |
| `github.copilot.sessions.commit` / `commitAndSync` | changesView.ts:151,165 (referenced; handler in the extension) |

**(2) Setting keys** — plain config strings:

| Key | Where |
|---|---|
| `sessions.github.copilot.multiChatSessions` | copilotChatSessionsProvider.ts:148 |
| `github.copilot.chat.claudeCode.enabled` | configuration.contribution.ts:42 |
| `github.copilot.chat.cli.isolationOption.enabled` | isolationPicker.ts:58 |
| `github.copilot.chat.claudeAgent.allowAutoPermissions` | claudePermissionModePicker.ts:26 |
| `github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions` | claudePermissionModePicker.ts:27 |

**(3) URI scheme** — `Schemas.copilotPr = 'copilot-pr'` defined in **core**
`base/common/network.ts:166`, used at `changesView.ts` for PR-tree roots. This is a workbench-core
scheme, not an extension export. (Related routing strings `agent-host-copilot`, `copilotcli`,
`copilot-cloud-agent` are core agent-host session-type identifiers.)

## 2. The misleadingly-named `CopilotChatSessionsProvider`

`src/vs/sessions/contrib/providers/copilotChatSessions/browser/copilotChatSessionsProvider.ts`
(~3011 lines) is Backboard code implementing Backboard's `ISessionsProvider` interface — a **core
workbench contribution**, not an extension activation:

- Registered via `registerWorkbenchContribution2(..., WorkbenchPhase.AfterRestored)` in
  `copilotChatSessions.contribution.ts` — `DefaultSessionsProviderContribution` (`:47`)
  `createInstance(CopilotChatSessionsProvider)` (`:57`) then `registerProvider` (`:58`). No
  `activationEvents`, no extension manifest.
- Provider ID `COPILOT_PROVIDER_ID = 'default-copilot'` (`:145`) — the name is vestigial branding.
- Session facades (all defined **in-file**, all implement `ICopilotChatSession`):
  - `CopilotCLISession` (`:194`) — local background/CLI agent; worktree/branch/isolation config.
  - `RemoteNewSession` (`:527`, exported) — cloud agent session; reactive option groups.
  - `ClaudeCodeNewSession` (`:774`) — Claude local agent; no-op isolation/branch (Claude manages its
    own worktrees).
  - `AgentSessionAdapter` (`:922`) — adapts an existing chat-layer `IAgentSession` into the facade;
    extracts GitHub PR metadata.
- Session types declared here: `ClaudeCodeSessionType` (`claude-code`, `Codicon.claude`, `:56`),
  `CopilotCloudSessionType` (`copilot-cloud-agent`, `:63`), plus imported `CopilotCLISessionType`.

The provider coexists with the local agent-host provider; they list disjoint session sets. Its name
is vestigial and it reaches the bundled extension only indirectly — by executing `github.copilot.*`
commands when the extension is present.

## 3. What genuinely still requires the bundled Copilot extension

The extension is needed wherever the provider **delegates to command handlers or SDKs it does not
implement itself**:

| Feature | Needs Copilot ext? |
|---|---|
| Right-panel shell, Review/Files/Browser/Terminal tabs (doc 08) | **No** |
| Backboard agent-host provider + Rust bridge (docs 01, 04) | **No** |
| Backboard extension webview (`extensions/backboard`) | **No** |
| Command handlers behind `github.copilot.*` (openRepository, setTitle/rename, deleteSessions, commit/commitAndSync, commitTo*) | **Yes** |
| Copilot CLI / background agent (`@github/copilot/sdk`) | **Yes** |
| GitHub Copilot cloud / coding-agent flows | **Yes** |
| Copilot-contributed chat participants (`extensions/copilot/package.json`) | **Yes** |
| Copilot-contributed `languageModelTools` | **Yes** |

Concretely: the commit buttons in the Changes view invoke `github.copilot.sessions.commit`, whose
handler lives in
`extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts` (parses the
session id → `commit(sessionId, false)`; `commitAndSync` passes `true` to also pull/push). Absent the
extension, those `executeCommand` calls no-op/fail.

Guidance from the repo's audit
(`bb-docs/backboard-agent-bridge/copilot-right-panel-dependency-audit.md`): keep Copilot bundled
until every default chat/session entry point provably routes to the Backboard agent-host and the
commit/sync handlers are reimplemented Backboard-side; then it can become an optional download.

## 4. Customization spec lineage

`src/vs/sessions/copilot-customizations-spec.md` is a **reference doc** (not code) titled "Copilot
Agent Runtime — Customization Surface Spec", sourced from `github/copilot-agent-runtime`
(2026-02-25). Its instruction-file table is already **provider-agnostic** — it lists
`.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `GEMINI.md` — i.e.
it spans Copilot/Codex/Claude/Gemini conventions, matching Backboard's multi-agent posture. It is
lineage/design documentation, not a runtime dependency.

Backboard's own skills live in `src/vs/sessions/skills/` (12 dirs: act-on-feedback, code-review,
commit, create-draft-pr, create-pr, fix-ci, generate-run-commands, merge, sync, sync-upstream,
update-pr, update-skills) — Backboard-authored, independent of `extensions/copilot`.

## 5. Removal checklist (per the audit)

Would keep working without Copilot: the right-panel shell, Review/Files/Browser/Terminal tabs,
agent-host sessions, the Backboard webview. Needs migration first: CLI/background flows, cloud-agent
flows, the commit/sync command handlers, Copilot chat participants and LM tools, and any "new
session" defaults that still route to Copilot session types. Validation: confirm model pickers
default to Backboard models and new-session flows create `agent-host-backboard` sessions.
