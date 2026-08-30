# Simple Mode and Its Agents

## What "Simple mode" actually is

Simple mode is **the Agents/Sessions window** — a dedicated workbench layer (`src/vs/sessions/`)
that replaces the classic editor chrome with a chat-first UI. It is toggled from the title bar
against "Editor" mode. The display label is **"Simple"**, but the code internally calls it
**"agents"**.

Switcher: `src/vs/workbench/contrib/chat/electron-browser/backboardModeSwitcher/backboardModeSwitcherActions.ts`

| Element | Value | Line |
|---|---|---|
| Command id | `workbench.action.backboardModeSwitcher` | :38 |
| Menu placement | `MenuId.TitleBarLeft`, group `navigation`, order 0 | :44-51 |
| Gating config | `config.${ChatConfiguration.TitleBarOpenInAgentsWindowEnabled}` (`chat.titleBar.openInAgentsWindow.enabled`) | :49 |
| Widget class | `BackboardModeTitleBarWidget` | :70 |
| panelClosed storage prefix | `backboard.editorMode.panelClosed.` + partId, `StorageScope.PROFILE` (`'1'`=closed) | :72, :139-144 |
| Tracked parts | `PANEL_PARTS = [SIDEBAR_PART, PANEL_PART, AUXILIARYBAR_PART]` | :73 |

Menu items (`showMenu`, `:169-186`): `workbench.action.mode.editor` labelled **"Editor"** and
`workbench.action.mode.agents` labelled **"Simple"**. `openAgents()` (`:189`) executes
`workbench.action.openAgentsWindow`; `openEditor()` (`:194`) restores SIDEBAR/PANEL/AUXILIARYBAR
visibility unless the user previously closed them (tracked via the `panelClosed` keys) and focuses
the Terminal view. `isAgentsActive()` (`:229`) is true when the active editor pane id ===
`agentSessionsWelcomePage`. `updateState()` (`:237`) swaps icon `codicon-window` (Editor) ↔
`codicon-robot` (Simple).

```
┌─ Title bar ──────────────────────────────────────────────┐
│   [ 🤖 Simple ]  [ 🪟 Editor ]        ← mode switcher     │
└──────────┬───────────────────────────────────┬───────────┘
           ▼                                   ▼
┌─ Simple (Agents) window ─────┐   ┌─ Editor window ────────────┐
│ src/vs/sessions workbench    │   │ classic VS Code workbench  │
│ ┌────────┬─────────┬───────┐ │   │ explorer / editor / panel  │
│ │sessions│  chat   │ right │ │   └────────────────────────────┘
│ │  list  │composer │workb. │ │
│ │(sidebar)│(SESSIONS│(Review│ │
│ │        │  _PART) │Files, │ │
│ │        │         │Browser│ │
│ └────────┴─────────┴───────┘ │
└──────────────────────────────┘
```

## The layout service

`src/vs/sessions/browser/workbench.ts` — the `Workbench` class *is* `IAgentWorkbenchLayoutService`
(a refinement of `IWorkbenchLayoutService`, `:135`). It is the layout engine for the Agents window,
separate from the regular workbench.

`LayoutClasses` enum (`:98-111`): `nosidebar`, `nomaineditorarea`, `nopanel`, `noauxiliarybar`,
`nosessionspart`, `nostatusbar`, `shell-gradient-background`, `fullscreen`, `maximized`,
`phone-layout`, `sessions-auxiliary-files-active`, `sessions-auxiliary-browser-active`.

| Storage key | Scope | Purpose | Line |
|---|---|---|---|
| `workbench.sessions.partVisibility` | WORKSPACE / MACHINE | `{editor, auxiliaryBar, sidebar}` visibility | :329, :665-675 |
| `workbench.sessions.partSizes` | WORKSPACE | `{sidebar, auxiliaryBar, sessions, editor, panel}` grid sizes | :330, :690-715 |

Default visibility (`:297-303`): sidebar/auxiliaryBar/sessions default `true`, editor/panel default
`false`. The dedicated **`SESSIONS_PART`** (the chat bar) is unique to this window.

**Phone layout** is driven by `SessionsLayoutPolicy` (`:307`): when `viewportClass === 'phone'`,
part-visibility persistence is skipped (`:649`), a `MobileTitlebarPart` is prepended (`:793`), a
hamburger toggles a full-width sidebar drawer (`:813-848`), and a `MobileNavigationStack` (`:308`)
pops open parts. Context key `IsPhoneLayoutContext` bound at `:474`.

## The agents: providers → session types

Everything the user can chat with is a **session type** supplied by a **sessions provider**
registered with `ISessionsProvidersService`
(`src/vs/sessions/services/sessions/browser/sessionsProvidersService.ts:19`). `getProviders()`
returns providers sorted by `order` (lower first, stable).

```
ISessionsProvidersService (registry, sorted by order)
│
├── CopilotChatSessionsProvider           id = 'default-copilot'
│     transport: in-process ext-host chat + optional cloud agents
│     ├── CopilotCloudSessionType   id='copilot-cloud-agent'  label="Cloud"   icon=Codicon.cloud
│     └── ClaudeCodeSessionType     id='claude-code'          label="Claude"  icon=Codicon.claude
│            (Claude type conditionally pushed — copilotChatSessionsProvider.ts:1375)
│
├── LocalChatSessionsProvider             id = 'local-chat'
│     transport: in-process IChatService only (no agent host, no worktree)
│     └── LocalSessionType          id='local'  label="Local"  icon=Codicon.vm
│
├── LocalAgentHostSessionsProvider        id = 'local-agent-host'   order = -1 | 1*
│     transport: in-process IAgentHostService (IAgentConnection), always present
│     └── types synced dynamically from the local agent host rootState
│           e.g. CopilotCLISessionType id='copilotcli' "Background Agent" (Codicon.sparkle)
│           + 'agent-host-backboard' (the Backboard-native agent)
│
└── RemoteAgentHostSessionsProvider(s)    id = `agenthost-${authority}`  (one per remote)
      transport: remote agent-host connection (tunnel/WSL/web), IAgentConnection
      └── types discovered from remote rootState
```
`*` LocalAgentHost `order` is `-1` (sorts first) when `LocalAgentHostDefaultProviderSettingId` is
enabled, else `1` (`localAgentHostSessionsProvider.ts:67`).

| Provider (const → value) | Session type: id / label / icon | Transport | File:line |
|---|---|---|---|
| `COPILOT_PROVIDER_ID` = `default-copilot` | `copilot-cloud-agent` / "Cloud" / `Codicon.cloud` | ext-host + cloud | copilotChatSessionsProvider.ts:145, :63 |
| " | `claude-code` / "Claude" / `Codicon.claude` | ext-host | copilotChatSessionsProvider.ts:56, :1377 |
| `LOCAL_PROVIDER_ID` = `local-chat` | `local` / "Local" / `Codicon.vm` | in-proc IChatService | localChatSessionsProvider.ts:46, :37 |
| `LOCAL_AGENT_HOST_PROVIDER_ID` = `local-agent-host` | `copilotcli` / "Background Agent" / `Codicon.sparkle`; `agent-host-backboard` | in-proc agent host | localAgentHostSessionsProvider.ts:47; baseAgentHostSessionsProvider.ts:87 |
| `agenthost-${authority}` (prefix `REMOTE_AGENT_HOST_PROVIDER_PREFIX` = `agenthost-`) | dynamic from remote rootState | remote tunnel | remoteAgentHostSessionsProvider.ts:~229 |

`CopilotCLISessionType` (verbatim, `baseAgentHostSessionsProvider.ts:87-91`):

```ts
export const CopilotCLISessionType: ISessionType = {
    id: 'copilotcli',
    label: localize('copilotCLI', "Background Agent"),
    icon: Codicon.sparkle,
};
```

Type guard (`agentHostSessionsProvider.ts:208`):
`isAgentHostProviderId(id)` ⇔ `id === LOCAL_AGENT_HOST_PROVIDER_ID || id.startsWith('agenthost-')`.

**Session-type picker** (`sessionTypePicker.ts`): the user's choice is stored under
`sessions.userSelectedSessionType` (`:29`, PROFILE) as JSON `{providerId?, sessionTypeId}` (legacy
raw-string tolerated, `:377`). Picking the *preferred* (default) type **clears** the stored pick
(`:365`); any other pick is stored.

## Three orthogonal "mode" axes (do not confuse)

```
 (A) WINDOW mode        Editor ⟷ Simple(Agents)      backboardModeSwitcherActions.ts
       │  which workbench you are in; tracked by active editor pane + panelClosed keys
       │
 (B) SESSION mode       interactive | plan | autopilot    agentHostModePicker.ts
       │  a per-session config value (SessionConfigKey.Mode) chosen in the composer
       │  controls how autonomously the agent acts
       ▼
 (C) BRIDGE tool-access free | manual              backboardAgent.ts (derived from B)
          coarse backend setting the Rust bridge actually sees
```

### (B) Per-session execution mode — `agentHostModePicker.ts`

`AgentHostModePicker` (`:286`) renders whatever enum the session schema advertises for `mode` and
writes `provider.setSessionConfigValue(id, SessionConfigKey.Mode, value)` (`:260`). Icons
(`getModeIcon`, `:33-40`): `interactive` → `Codicon.comment`, `plan` → `Codicon.checklist`,
`autopilot` → `Codicon.rocket`.

`SessionConfigKey` (verbatim, `sessionConfigKeys.ts:18-29`):

```ts
export const enum SessionConfigKey {
    AutoApprove  = 'autoApprove',
    Permissions  = 'permissions',
    Isolation    = 'isolation',
    Branch       = 'branch',
    Mode         = 'mode',
}
```

A parallel **Claude** picker (`agentHostClaudePermissionModePicker.ts`) drives
`ClaudeSessionConfigKey.PermissionMode` with `default`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`
(see doc 05).

### (C) Bridge tool-access mode — `backboardAgent.ts`

The UI `mode` (B) is **normalized** in the Backboard agent before it reaches the Rust bridge:

`normalizeBackboardMode` (`:2825-2836`):

| UI `mode` | → access mode |
|---|---|
| `interactive` / `agent` | `default` (`BACKBOARD_ACCESS_DEFAULT`) |
| `plan` / `ask` | `manual` (`BACKBOARD_ACCESS_MANUAL`) |
| `free` | `fullAccess` (`BACKBOARD_ACCESS_FULL`) |

`bridgeModeFromAccessMode` (`:2854`): `manual` → `'manual'`, everything else → `'free'`. So the Rust
bridge only ever sees **two** tool-access modes, while the UI exposes a richer enum that funnels into
them. (The `ChatPermissionLevel` axis — `default`/`autoApprove`/`autopilot` — feeds
`SessionConfigKey.AutoApprove`; see doc 05.)

## Session lifecycle & status mapping

`baseAgentHostSessionsProvider.ts`. New sessions live as `NewSession` skeletons (status `Untitled`)
until the first `sendRequest` graduates them into an `AgentHostSessionAdapter`:

```
createNewSession(workspace, sessionTypeId)                         :1501
  └─ _createNewSession → new NewSession({...})  status=Untitled    :716,:791
  └─ _startNewSessionBackend(newSession, connection)               :1574
        └─ NewSession.eagerCreate(connection)                      :985
              └─ connection.createSession({provider, session, workingDirectory, config, agent?})
                 (must createSession BEFORE subscribing to avoid AHP_SESSION_NOT_FOUND, :966)

sendRequest(chatId, chatResource, options)                        :2186   (see doc 01)
  ├─ newSession.graduate()  (release sub WITHOUT disposeSession)   :2298
  └─ backend reports session in list → _onDidReplaceSession fires (skeleton → real adapter)
```

`graduate()` (`:1053`) hands off cleanly on success; `dispose()` (`:1067`) fires
`connection.disposeSession` on abandonment. In-flight new sessions live in a `DisposableMap`
`_newSessions` (`:1188`). Both local and remote committed sessions are the **same** class,
`AgentHostSessionAdapter` (`:131`); the only variation is `IAgentHostAdapterOptions` (`:99`).

**Status mapping** — the protocol status is a bitset; the UI status is a small enum:

```
 PROTOCOL SessionStatus (bitflags, channels-session/state.ts:37)
   Idle=1  Error=1<<1  InProgress=1<<3  InputNeeded=(1<<3)|(1<<4)  IsRead=1<<5  IsArchived=1<<6
                                │  mapProtocolStatus (agentHostDiffs.ts:17, priority order)
                                ▼
 UI SessionStatus (session.ts:38):  Untitled=0  InProgress=1  NeedsInput=2  Completed=3  Error=4

   (protocol & InputNeeded)==InputNeeded ──► NeedsInput (2)
    protocol & InProgress                ──► InProgress (1)
    protocol & Error                     ──► Error (4)
    else                                 ──► Completed (3)
   [pre-send skeleton, set directly]     ──► Untitled (0)
```

Applied in the adapter constructor (`:233`) and on every `update()` (`:498-504`).

## Customization / delegation / completion services

| Service | File | Purpose |
|---|---|---|
| `IAgentHostCustomizationService` | `services/agentHost/browser/agentHostCustomizationService.ts:20` | bridges active session → provider for `getCustomAgents`/`getCustomizations`/`getWorkingDirectory`/`getMcpServers` |
| Agent delegation | `contrib/chat/browser/agentHostDelegation.ts:22` | "Continue in…" — command `CHAT_DELEGATE_TO_AGENT_HOST_SESSION_COMMAND_ID`; creates a new session and forwards the transcript |
| Input completions | `contrib/chat/browser/agentHostInputCompletions.ts:99` | slash/@ completions in the composer, bridged to the agent host's `completions` command |
| AI customization tree | `contrib/aiCustomizationTreeView/browser/*` | unified tree of agents / skills / instructions / prompts / MCP servers / plugins (`workbench.view.aiCustomization`) |

## Backboard's own skills

`src/vs/sessions/skills/` — each a directory with a `SKILL.md`, loaded through the customization
system (these are **Backboard** skills, not Copilot's):

`act-on-feedback`, `code-review`, `commit`, `create-draft-pr`, `create-pr`, `fix-ci`,
`generate-run-commands`, `merge`, `sync`, `sync-upstream`, `update-pr`, `update-skills`.
