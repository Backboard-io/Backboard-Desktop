# Simple Mode and Its Agents

## What "Simple mode" actually is

Simple mode is **the Agents/Sessions window** — a dedicated workbench layer
(`src/vs/sessions/`) that replaces the classic editor chrome with a chat-first UI. It is
toggled from the title bar against "Editor" mode.

- Switcher implementation:
  `src/vs/workbench/contrib/chat/electron-browser/backboardModeSwitcher/backboardModeSwitcherActions.ts`
  - `BackboardModeSwitcherAction` (lines 35-56) — the command
  - `BackboardModeTitleBarWidget` (lines 70-247) — the title-bar widget
  - Labels/icons: **"Simple"** (`codicon-robot`) vs **"Editor"** (`codicon-window`)
- Visibility gated by `config.${ChatConfiguration.TitleBarOpenInAgentsWindowEnabled}` (line 49)
- Remembers which panels the user closed in Editor mode under the storage key prefix
  `backboard.editorMode.panelClosed.{PART}` (line 72, `StorageScope.PROFILE`)

```
┌─ Title bar ──────────────────────────────────────────────┐
│   [ 🤖 Simple ]  [ 🪟 Editor ]        ← mode switcher     │
└──────────┬───────────────────────────────────┬───────────┘
           ▼                                   ▼
┌─ Simple (Agents) window ─────┐   ┌─ Editor window ────────────┐
│ src/vs/sessions workbench    │   │ classic VS Code workbench  │
│ ┌────────┬─────────┬───────┐ │   │ explorer / editor / panel  │
│ │sessions│  chat   │ right │ │   └────────────────────────────┘
│ │  list  │composer │ panel │ │
│ │(sidebar)│(center)│(files,│ │
│ │        │         │browser│ │
│ │        │         │review)│ │
│ └────────┴─────────┴───────┘ │
└──────────────────────────────┘
```

Layout is driven by `src/vs/sessions/browser/workbench.ts` (~2161 lines,
`IAgentWorkbenchLayoutService`), which persists:

| Storage key | Scope | Purpose |
|---|---|---|
| `workbench.sessions.partVisibility` | WORKSPACE | which parts are visible (`workbench.ts:329`) |
| `workbench.sessions.partSizes` | WORKSPACE | grid sizes across reloads (`workbench.ts:330`) |

CSS layout classes (LayoutClasses enum, `workbench.ts:98-111`): `nosidebar`, `nopanel`,
`noauxiliarybar`, `nosessionspart`, `sessions-auxiliary-files-active`,
`sessions-auxiliary-browser-active`; root class `agent-sessions-workbench` (`:749`).
Phone layouts (`IsPhoneLayoutContext`) collapse the sidebar into a drawer and use
`MobileTitlebarPart` (`workbench.ts:795`).

## The agents: session providers & session types

Everything the user can chat with in Simple mode is a **session type** supplied by a
**sessions provider** registered with `ISessionsProvidersService`
(`src/vs/sessions/services/sessions/browser/sessionsProvidersService.ts`).

```
                    ISessionsProvidersService
                              │
      ┌───────────────┬───────┴────────┬──────────────────┐
      ▼               ▼                ▼                  ▼
┌────────────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────────────┐
│ local-     │ │ agenthost-*  │ │ default-    │ │ local-chat       │
│ agent-host │ │ (remote:     │ │ copilot     │ │                  │
│            │ │ tunnel/WSL/  │ │ (vestigial  │ │ in-process chat, │
│ in-process │ │ SSH hosts)   │ │ name — see  │ │ no background    │
│ IAgentHost │ │              │ │ doc 07)     │ │ agent            │
│ Service    │ │              │ │             │ │                  │
└─────┬──────┘ └──────┬───────┘ └──────┬──────┘ └──────┬───────────┘
      │               │                │               │
      ▼               ▼                ▼               ▼
 'copilotcli'    dynamic types   CLI / cloud /    'local'
 "Background     from remote     Claude Code      "Local" (vm icon)
  Agent" (✨)    host            session types
 + 'agent-host-backboard'
```

| Provider | ID | File | Session types |
|---|---|---|---|
| Local Agent Host | `local-agent-host` | `contrib/providers/agentHost/browser/localAgentHostSessionsProvider.ts:27-244` | `copilotcli` "Background Agent" (`Codicon.sparkle`, `baseAgentHostSessionsProvider.ts:87-91`), `agent-host-backboard` |
| Remote Agent Host | `agenthost-*` | `contrib/providers/remoteAgentHost/browser/remoteAgentHostSessionsProvider.ts` | dynamic, from the remote host |
| Copilot Chat Sessions | `default-copilot` | `contrib/providers/copilotChatSessions/browser/copilotChatSessionsProvider.ts` | `copilot-cli`, cloud, `claude-code` |
| Local Chat | `local-chat` | `contrib/providers/localChatSessions/browser/localChatSessionsProvider.ts:36-84` | `local` "Local" (`Codicon.vm`) |

The user's choice is made in `sessionTypePicker.ts`
(`src/vs/sessions/contrib/chat/browser/sessionTypePicker.ts`) and remembered under
`sessions.userSelectedSessionType` (`:29`, PROFILE scope). Local chat history persists under
`sessions.localChat.sessions` (`localChatSessionsProvider.ts:47`).

## Agent modes (per session, distinct from Simple mode)

Inside an agent-host session, "mode" is a session-config property — how autonomously the agent
acts:

- Picker: `contrib/providers/agentHost/browser/agentHostModePicker.ts:286-311`
  (property `SessionConfigKey.Mode`)
- Well-known values (lines 35-37):

```
 interactive  💬 Codicon.comment    — ask/answer, confirm as it goes
 plan         ☑  Codicon.checklist — produce a plan first
 autopilot    🚀 Codicon.rocket    — iterate autonomously to completion
```

Read via `provider.getSessionConfig(sessionId)`; written via
`provider.setSessionConfigValue(sessionId, SessionConfigKey.Mode, value)` (`:260`).
(The Rust bridge separately has its own tool-access "mode": `free` / `ask` / `manual` — see doc 04.)

## Agent lifecycle

```
 user picks session type + workspace
        │
        ▼
 provider.createSession(options)
        │            localAgentHostSessionsProvider.ts connects to the
        │            in-process IAgentHostService and wires listeners
        │            (_attachConnectionListeners, :95)
        ▼
 SessionState → SessionStatus mapping (baseAgentHostSessionsProvider.ts:303-326)
   Untitled → InProgress → NeedsInput → Completed
        │
        ▼
 sendRequest(sessionId, options)  ← per message (see doc 01)
        │
        ▼
 streaming responses mutate the chat model observables → UI updates
```

## Customization & feedback services

| Service | File | Purpose |
|---|---|---|
| `IAgentHostCustomizationService` | `services/agentHost/browser/agentHostCustomizationService.ts` | customization bundles (skills, instructions) for agents |
| AI customization tree | `contrib/aiCustomizationTreeView/browser/aiCustomizationTreeView.ts` | browse customizations in the UI |
| Agent delegation | `contrib/chat/browser/agentHostDelegation.ts` | delegation between agents |
| Input completions | `contrib/chat/browser/agentHostInputCompletions.ts` | slash/@ completions in the composer |

Backboard also ships its own skill set under `src/vs/sessions/skills/` (act-on-feedback,
code-review, commit, create-pr, fix-ci, merge, sync, …) which are loaded through the
customization system — these are Backboard skills, not Copilot's.
