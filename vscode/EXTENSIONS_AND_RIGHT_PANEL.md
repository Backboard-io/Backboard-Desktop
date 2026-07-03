# How Extensions, the Right Panel, and Backboard Chat Fit Together

This is a map of three things that are easy to conflate in this repo: the VS Code
extension model, the "right panel" (auxiliary bar), and how the Backboard-branded
chat experience is really just the built-in `copilot-chat` extension wearing a
different name.

## 1. How extensions work

Extensions never run inside the main workbench renderer. They run in a separate
**extension host process**, and everything they do crosses a process boundary via
an RPC (remote procedure call) protocol.

- **RPC transport**: [`src/vs/workbench/services/extensions/common/rpcProtocol.ts`](src/vs/workbench/services/extensions/common/rpcProtocol.ts)
  serializes/deserializes messages (including URIs and binary buffers) between the
  two sides.
- **Protocol surface**: [`src/vs/workbench/api/common/extHost.protocol.ts`](src/vs/workbench/api/common/extHost.protocol.ts)
  declares every callable identifier as two registries:
  - `MainContext` — proxies the extension host calls *into* the workbench
    (e.g. `MainThreadCommands`, `MainThreadChatAgents2`).
  - `ExtHostContext` — proxies the workbench calls *into* the extension host
    (e.g. `ExtHostCommands`, `ExtHostChatAgents2`).
- **Proxy pattern in practice**: an `ExtHost*` class gets an `IMainContext` in its
  constructor and calls `mainContext.getProxy(MainContext.MainThreadXyz)` to get a
  proxy object it can call methods on — see
  [`extHostAiSettingsSearch.ts:21-46`](src/vs/workbench/api/common/extHostAiSettingsSearch.ts)
  for a small, readable example of the whole round trip.
- **Contribution points**: what an extension can plug into is declared in its
  `package.json` under `contributes` (views, commands, chat participants, language
  models, etc.). VS Code reads that manifest, and at activation time the
  extension's code registers the actual implementation over RPC.
- **Activation**: for the built-in Copilot extension, activation starts at
  [`extensions/copilot/src/extension/extension/vscode/extension.ts`](extensions/copilot/src/extension/extension/vscode/extension.ts)
  (`baseActivate`), which builds an `IInstantiationService` and loads a
  `ContributionCollection` — each contribution registers itself with the main
  thread through the protocol described above.

So: **extension code and workbench code never call each other directly** — they
only ever talk through the `MainContext`/`ExtHostContext` proxy tables.

## 2. How the right panel (auxiliary bar) works

The "right panel" is called the **auxiliary bar** in the code.

- Implementation: [`AuxiliaryBarPart`](src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts)
  extends `AbstractPaneCompositePart` — the same base used by the primary
  sidebar and the bottom panel. It's just a composite-view host anchored to the
  right edge of the window.
- What goes into it is decided by **view container location**, not by the
  auxiliary bar itself. Any feature registers a view container and says where it
  wants to live:

  ```ts
  // src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts:39-47
  const chatViewContainer = Registry.as<IViewContainersRegistry>(...).registerViewContainer({
      id: ChatViewContainerId,               // 'workbench.panel.chat'
      ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ChatViewContainerId, ...]),
      storageId: ChatViewContainerId,
      ...
  }, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });
  ```

  `ChatViewContainerId` and `ChatViewId` are defined in
  [`chat.ts:472-473`](src/vs/workbench/contrib/chat/browser/chat.ts). This is the
  entire mechanism by which chat ends up on the right instead of, say, the
  bottom panel (where the terminal lives) — it's a single enum value.
- The registered view is rendered by
  [`ChatViewPane`](src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts),
  which instantiates the actual `ChatWidget`. `ChatWidget` delegates message
  rendering to
  [`ChatListRenderer`](src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts),
  a tree renderer that dispatches each message part (thinking blocks, edited-file
  summaries, tool calls, etc.) to a dedicated "content part" class — this is
  where [`chatThinkingContentPart.ts`](src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatThinkingContentPart.ts)
  and [`chatTurnEditedFilesContentPart.ts`](src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatTurnEditedFilesContentPart.ts)
  plug in (both currently touched on this branch).
- Separately, [`src/vs/sessions/`](src/vs/sessions/) is its own workbench layer
  for the agent-sessions window (per this repo's CLAUDE.md: "sits alongside
  `vs/workbench`, may import from it but not vice versa"). It has its own
  view-container IDs (`SESSIONS_FILES_CONTAINER_ID`,
  `SESSIONS_BROWSER_VIEW_CONTAINER_ID` in
  [`src/vs/sessions/browser/workbench.ts`](src/vs/sessions/browser/workbench.ts))
  and is a parallel UI shell, not a panel inside the normal workbench auxiliary
  bar.

## 3. Where Copilot/Backboard fits in

There is no separate "Backboard extension" — **Backboard is a rebrand of the
built-in GitHub Copilot Chat extension plus product-level branding overrides**.

- The extension itself, at `extensions/copilot/package.json:2-3`:
  ```json
  "name": "copilot-chat",
  "displayName": "Backboard Chat",
  ```
  Same extension, same chat participants/tools/commands as upstream Copilot
  Chat — only the display name changed.
- Product-level branding lives in [`product.json`](product.json):
  - `nameShort: "Backboard Studio"`, `urlProtocol: "backboard"` (lines 2, 35)
  - `defaultChatAgent` block (from line 100) rewires the default provider id to
    `"backboard"` for every auth path (enterprise/Google/Apple all map to it,
    lines 115-127), points documentation/terms/plan-management URLs at
    `app.backboard.io`, and remaps setting/context/command IDs
    (`backboard.apiUrl`, `backboard.chat.quotaExceeded`, `backboard.signIn`,
    etc.) that the chat UI reads to decide what to show for quota, sign-in, and
    settings links.
- Nothing about the auxiliary-bar placement is Backboard-specific — it's the
  same `ChatViewContainerId` → `ViewContainerLocation.AuxiliaryBar` registration
  described in section 2. Backboard branding only changes strings and URLs the
  chat UI reads from `product.json`; the plumbing (extension host, RPC, view
  container, widget, renderer) is stock VS Code chat architecture.

## End-to-end flow

```
copilot-chat extension activates (extension host process)
  → registers chat participants/tools over RPC (MainThreadChatAgents2)
  → chatParticipant.contribution.ts registers 'workbench.panel.chat'
      view container at ViewContainerLocation.AuxiliaryBar
  → AuxiliaryBarPart hosts the ViewPaneContainer for that container
  → ChatViewPane instantiates ChatWidget
  → ChatWidget's ChatListRenderer renders each message via content parts
      (ChatThinkingContentPart, ChatTurnEditedFilesContentPart, ...)
  → product.json's defaultChatAgent block supplies the "Backboard" branding,
      URLs, and setting IDs the widget reads for sign-in/quota/plan links
```
