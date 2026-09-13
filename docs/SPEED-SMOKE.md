# Speed smoke map

Scope: Electron desktop and its native Backboard chat route. Paths are repository-relative; `:N` is a verified, one-based source line (2026-09-10). The canonical product source directory is `backboard/`. Other agent backends share the host protocol but have their own implementations.

## Entry point

- `backboard/package.json:9` selects `./out/main.js`; its source, `backboard/src/main.ts:216`, bootstraps ESM and imports the Electron main module at line 219.
- `backboard/src/vs/code/electron-main/main.ts:699` calls `code.main()`; startup constructs `CodeApplication` at line 158.
- `backboard/src/vs/platform/windows/electron-main/windowImpl.ts:1289` selects Advanced (`optimus`), Simple (`sessions`), or Editor (`workbench`) HTML, then loads it at line 1298. This checkout's product directory is `backboard/`.

## Send → provider → response

1. **UI submission:** `backboard/src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2937` exposes `acceptInput`; line 3237 calls `chatService.sendRequest` with the text, selected model/configuration, and request context. Simple-mode new chats use `backboard/src/vs/sessions/contrib/chat/browser/newChatWidget.ts:1152` to collect selection/context, then line 1097 calls session management. `backboard/src/vs/sessions/services/sessions/browser/sessionsManagementService.ts:389` calls the selected provider; `backboard/src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts:2269` reaches the same chat service.
2. **Chat service → host:** `backboard/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1427` invokes the agent with a progress callback. `backboard/src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts:855` registers the invocation handler; line 1398 synchronizes model selection and line 1455 dispatches `ChatTurnStarted` through the host connection.
3. **Host → native agent:** `backboard/src/vs/platform/agentHost/node/agentHostMain.ts:211` registers `CliTsAgent`. `backboard/src/vs/platform/agentHost/node/agentSideEffects.ts:804` handles turn start, resolves the session agent at line 820, and calls `agent.sendMessage` at line 1105. `backboard/src/vs/platform/agentHost/node/cliTs/cliTsAgent.ts:823` queues the send; line 1104 submits prompt, attachments, settings, thread context, and `provider/model` to the runtime.
4. **Process boundary:** `backboard/src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts:140` resolves an override, packaged executable, or Bun development entry point. Line 305 adds `--serve`, line 324 spawns the child, and line 274 writes the control as newline-delimited JSON to stdin. `backboard/cli-ts/src/entrypoints/cli.tsx:182` enters serve mode.
5. **Runtime → provider:** `backboard/cli-ts/src/entrypoints/serve.ts:385` calls `controller.submit`; line 398 applies the submitted model when the turn starts. `backboard/cli-ts/src/core/agent/AgentController.ts:487` runs the agent loop. `backboard/cli-ts/src/core/agent/AgentLoop.ts:245` calls `client.runMessage`; line 305 processes tool rounds before completion. `backboard/cli-ts/src/providers/ClientRouter.ts:101` routes that call to the chosen client.
6. **Backboard HTTP call:** `backboard/cli-ts/src/providers/backboard/BackboardClient.ts:187` implements streaming `runMessage`: line 195 targets `/threads/messages` with `stream: true`; line 408 POSTs to the configured API URL; line 455 reads SSE frames and line 472 maps provider events. Tool results can continue the run via `runToolOutputs` at line 202. The remote gateway's internal implementation is beyond this local trace.
7. **Stream → host state:** `backboard/cli-ts/src/core/agent/ProviderStreamConsumer.ts:232` appends text; `backboard/cli-ts/src/core/agent/AssistantAccumulator.ts:67` emits `assistant:delta`. `backboard/cli-ts/src/entrypoints/serve.ts:95` attaches `JsonEventStream`; `backboard/cli-ts/src/core/session/JsonEventStream.ts:47` writes events to stdout. `backboard/src/vs/platform/agentHost/node/cliTs/cliTsProcess.ts:402` forwards decoded events; `backboard/src/vs/platform/agentHost/node/cliTs/cliTsAgent.ts:2663` emits `ChatDelta`, and line 1194 emits turn completion after finalization.
8. **State → visible answer:** `backboard/src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts:1957` observes markdown parts and sends incremental `markdownContent` at line 1973. `backboard/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1142` applies progress to the chat model; `backboard/src/vs/workbench/contrib/chat/common/model/chatModel.ts:2941` updates response content. `backboard/src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2726` subscribes to view-model changes. `backboard/src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts:1071` renders rows and line 4216 creates `ChatMarkdownContentPart`; `backboard/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts:492` renders markdown, including its code-block handling.

## Model and provider selection

- **Default and API fields:** `backboard/src/vs/platform/agentHost/node/cliTs/backboardRuntimeShared.ts:25-29` defines the native default as `openrouter/deepseek/deepseek-v4-flash`; `backboard/src/vs/platform/agentHost/node/cliTs/backboardRuntimeShared.ts:285-294` splits selection at the first slash, retaining publisher namespaces in the model name. `backboard/cli-ts/src/core/agent/RunMessageRequestBuilder.ts:33-71` constructs the API payload, including `thread_id`, `assistant_id`, `llm_provider`, `model_name`, system prompt, memory, thinking and tools. An optional OpenRouter upstream pin sets `allow_fallbacks: false`.
- **UI:** `backboard/src/vs/workbench/contrib/chat/browser/widget/input/combinedModelProviderPickerActionItem.ts:1047` validates the choice; lines 1059 and 1061 commit the session provider and model. `backboard/src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts:1131` wires the model delegate; line 1995 updates the current model and line 2007 persists the preference.
- **Per-turn model:** `backboard/src/vs/platform/agentHost/node/cliTs/backboardRuntimeShared.ts:729` derives turn settings; line 735 parses the selected model or default, and lines 748–749 supply provider/model. `backboard/src/vs/platform/agentHost/node/cliTs/cliTsAgent.ts:1115` transmits them as `provider/model`.
- **Actual model backend:** `backboard/cli-ts/src/providers/createAgentClient.ts:39` constructs Backboard/BYOK clients, optional subscription clients follow, and line 77 creates the router. `backboard/cli-ts/src/providers/ClientRouter.ts:67` selects subscription explicitly, otherwise an enabled supported provider key takes precedence over Backboard authentication. Line 268 routes existing threads by origin; new requests route by requested provider/model. BYOK selects an adapter at `backboard/cli-ts/src/providers/byok/ByokClient.ts:113` and streams through it at line 362. Session provider and model vendor are distinct choices.

## Existing verification commands

Run from the stated directory with dependencies/build outputs already present. Commands were inspected, not executed; this documentation-only task installs nothing and changes no application code.

| Directory | Command | Source / purpose |
| --- | --- | --- |
| `backboard/` | `npm run typecheck-client` | `backboard/package.json:34` — no-emit client TypeScript check. |
| `backboard/` | `npm run eslint` | `backboard/package.json:81` — code lint. |
| `backboard/` | `npm run stylelint` | `backboard/package.json:82` — stylesheet lint. |
| `backboard/` | `npm run test-node` | `backboard/package.json:23` — Node unit tests; uses compiled `out` by default (`backboard/test/unit/node/index.js:68`). |
| `backboard/` | `npm run test-browser-no-install` | `backboard/package.json:22` — browser unit tests; requires existing browser/build artifacts. |
| `backboard/` | `npm run test-extension` | `backboard/package.json:24` — extension test runner. |
| `backboard/` | `npm run smoketest-no-compile` | `backboard/package.json:65` — smoke runner using an existing compiled test suite. |
| `backboard/` | `npm run perf:chat` / `npm run perf:chat-leak` | `backboard/package.json:93` / `backboard/package.json:94` — chat performance / memory regression scripts. |
| `backboard/build/` | `npm run typecheck` / `npm test` | `backboard/build/package.json:70` / `backboard/build/package.json:72` — build TypeScript check / Node test runner. |
| `backboard/cli-ts/` | `bun run typecheck` | `backboard/cli-ts/package.json:35` — `bunx tsc --noEmit`; use only with existing local TypeScript to avoid fetching it. |
| `backboard/cli-ts/` | `bun run lint` | `backboard/cli-ts/package.json:37` — `biome check .`, without write mode. |
| `backboard/cli-ts/` | `bun test` | `backboard/cli-ts/package.json:36` — runtime tests. |
| `backboard/cli-ts/` | `bun run validate` | `backboard/cli-ts/package.json:32` — lint → typecheck → tests. |

Main-package `npm test` only prints guidance (`backboard/package.json:20`). `npm run test-browser` explicitly installs Playwright (`backboard/package.json:21`); use the no-install variant above for this constraint. Typecheck before running tests. No application test, lint, or typecheck pass is claimed by this source-tracing report.

Documentation verification: source citations and line ranges checked against the checkout; whitespace checked with `git diff --no-index --check /dev/null docs/SPEED-SMOKE.md` from the repository root. Existing shared document content was preserved and supplemented; no application code was modified.
