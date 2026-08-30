# Copilot Dependency Audit For Backboard Right Panel

This document explains what the Backboard IDE right panel needs from the bundled
Copilot extension, what it does not need, and which parts can be removed or made
optional to reduce the macOS DMG size.

The key conclusion is:

```text
The right-panel shell is not built inside extensions/copilot.
The right-panel shell is built in src/vs/sessions.
The bundled Copilot extension is only required for Copilot-style chat/session
features that have not yet been fully replaced by Backboard agent-host routing.
```

## Current Size Context

Measured in the current `aarch64` app bundle:

```text
Backboard Studio.app                                      1.5G
Contents/Resources/app/extensions                         653M
Contents/Resources/app/extensions/copilot                 459M
Contents/Resources/app/extensions/copilot/node_modules    405M
Contents/Resources/app/extensions/copilot/dist             53M
Contents/Resources/app/extensions/backboard                24M old build
Contents/Resources/app/out                                312M
Contents/Resources/app/node_modules                       248M
Contents/Frameworks                                       267M
```

After the Backboard bridge packaging change, the Backboard extension should stage
around `9.7M`, with `bin/backboard-bridge` around `4.9M`. Any remaining large
DMG size is mostly Copilot, app source maps, app-level `node_modules`, and
Electron.

## Right Panel Ownership

The right-panel container and tab shell are core workbench/session code, not
Copilot extension code.

Important files:

- `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.contribution.ts`
- `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.ts`
- `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbenchViewPane.ts`
- `src/vs/sessions/contrib/rightWorkbench/browser/media/rightWorkbenchLauncher.css`

What this code owns:

- Registers the right workbench auxiliary-bar container.
- Registers the right workbench launcher view.
- Defines right-panel modes: `launcher`, `review`, `browser`, `files`, and
  `terminal`.
- Opens the auxiliary bar, hides editor/panel parts for the sessions window,
  and renders the tabbed right-side surface.
- Embeds the review pane, file explorer, browser view, and terminal.

These files import workbench/session/browser/terminal/browserView services. They
do not import `extensions/copilot`.

## Backboard Agent-Host Ownership

Backboard's direct agent-host provider is also not implemented in the Copilot
extension. It is core node-side code:

- `src/vs/platform/agentHost/node/backboard/backboardAgent.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`

`agentHostServerMain.ts` creates and registers `BackboardAgent`. That provider
uses the Rust bridge process and exposes provider id `backboard`. The chat
session type is represented in core as:

```ts
SessionType.AgentHostBackboard = 'agent-host-backboard'
```

Important browser-side session labels and routing live in:

- `src/vs/workbench/contrib/chat/common/chatSessionsService.ts`
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessions.ts`
- `src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts`

The current code aliases old `AgentHostCopilot` naming to
`AgentHostBackboard` for compatibility. That compatibility name is not the same
as needing the Copilot extension at runtime.

## What Copilot Still Provides Today

The bundled extension at `extensions/copilot` is still broad. Its manifest
declares:

- activation on startup, language model chat, URI, and custom filesystems;
- proposed APIs including `chatProvider`, `chatSessionsProvider`,
  `chatParticipants`, `languageModelToolSupportsModel`,
  `chatSessionCustomizationProvider`, and related chat/tool APIs;
- the default chat participant currently branded as Backboard;
- many language-model tools;
- Copilot CLI/background agent session plumbing;
- telemetry and tracing dependencies;
- provider/model integration paths.

Important manifest areas:

- `extensions/copilot/package.json` activation events and `main`.
- `extensions/copilot/package.json` enabled API proposals.
- `extensions/copilot/package.json` `contributes.chatParticipants`.
- `extensions/copilot/package.json` `contributes.languageModelTools`.
- `extensions/copilot/package.json` runtime dependencies.

This means deleting `extensions/copilot` entirely can break anything still using
the extension-host contribution path rather than the Backboard agent-host path.

## Feature Matrix

| Feature | Needs bundled Copilot extension? | Notes |
|---|---:|---|
| Right-panel shell opens | No | Owned by `src/vs/sessions/contrib/rightWorkbench`. |
| Right-panel `Review` tab | No | Uses sessions changes/review code, not Copilot extension. |
| Right-panel `Files` tab | No | Uses sessions files explorer. |
| Right-panel `Browser` tab | No | Uses browserView workbench service and rightWorkbench command. |
| Right-panel `Terminal` tab | No | Uses terminal services and rightWorkbench command. |
| Backboard agent-host provider | No | Owned by `src/vs/platform/agentHost/node/backboard`. |
| Backboard Rust bridge | No | Packaged under `extensions/backboard/bin/backboard-bridge`. |
| Backboard extension webview panel | No | Owned by `extensions/backboard`. |
| Current default chat participant if provided by `extensions/copilot` | Yes | Manifest contributes a branded default participant. |
| Copilot CLI/background sessions | Yes | Uses Copilot extension code and `@github/copilot/sdk`. |
| GitHub Copilot cloud/coding-agent flows | Yes | Extension-specific authentication/session code. |
| Copilot language-model provider paths | Yes | If current chat still relies on `onLanguageModelChat:copilot`. |
| Copilot-contributed tools | Yes | Tools from `contributes.languageModelTools` disappear if extension is absent. |
| Backboard-only `agent-host-backboard` session flow | Should be No | Needs validation that all launch paths select Backboard provider directly. |

## What Is Needed From Copilot For The Right Panel?

For the right-panel shell itself: nothing from the Copilot extension.

For the currently shipped product experience: keep Copilot until all default
chat/session entry points are proven to route to Backboard agent-host directly.
The extension may still be providing the default chat participant and some
session provider behavior that users reach from the right-panel-adjacent chat UI.

The minimum safe statement is:

```text
Copilot is not required to render the right panel.
Copilot may still be required to preserve legacy/default chat entry points.
```

## What Is Not Needed For Backboard Right Panel

These are not needed by the right-panel shell:

- `extensions/copilot/node_modules/@github/copilot/sdk` for Copilot CLI.
- `extensions/copilot/node_modules/@anthropic-ai/claude-agent-sdk`.
- Copilot telemetry exporters and Application Insights packages.
- Copilot prompt assets and skills.
- Copilot notebook/Jupyter-specific tool code.
- Copilot GitHub remote/coding-agent paths.
- Copilot webview assets that only back Copilot-specific panels.
- Copilot test, lint, build, simulation, and dev-only files.

Some of these may still be needed by other product features. They are not needed
by the right workbench itself.

## Current Size Hotspots In Copilot

From the bundled app:

```text
extensions/copilot/node_modules/@microsoft              91M
extensions/copilot/node_modules/@github                 79M
extensions/copilot/node_modules/@opentelemetry          64M
extensions/copilot/node_modules/@anthropic-ai           56M
extensions/copilot/dist                                 53M
extensions/copilot/node_modules/typescript              22M
extensions/copilot/node_modules/@img                    16M
```

From the source checkout, Copilot `node_modules` is much larger because it
contains dev/build dependencies:

```text
extensions/copilot/node_modules                         1.8G
extensions/copilot/node_modules/@github                 879M
extensions/copilot/node_modules/@github/copilot         734M
extensions/copilot/node_modules/@github/copilot-darwin-arm64 144M
extensions/copilot/node_modules/@fluentui               120M
extensions/copilot/node_modules/monaco-editor            88M
```

The source checkout size is not the shipped size, but it explains why packaging
must never copy source `node_modules` wholesale.

## Low-Risk Pruning Candidates

These are usually safe to remove from production packages, provided sourcemap
debugging in production is not required:

- `**/*.map`
- tests and test fixtures
- simulation output
- `.ts`, `.tsx`, `.mts`, `.cts` source files when compiled `dist` is shipped
- Markdown docs except required notices
- wrong-platform native prebuilds
- dev-only binaries such as Playwright, VSIX signing helpers, esbuild, rolldown
- package-manager caches

For Copilot specifically, preserve legal notices such as `LICENSE.txt`,
`ThirdPartyNotices.txt`, and extension metadata unless legal/release policy says
otherwise.

## Medium-Risk Pruning Candidates

These may be removable if the corresponding product feature is disabled:

- `@opentelemetry/*` and `applicationinsights` if Copilot telemetry/tracing is
  disabled or replaced.
- `@anthropic-ai/claude-agent-sdk` if Claude sessions are not shipped through
  the Copilot extension.
- `@google/genai` and provider SDKs if Copilot model-provider paths are disabled.
- `@vscode/tree-sitter-wasm` and parser assets if Copilot codebase/search tools
  are disabled.
- `typescript` if no runtime Copilot feature imports the TypeScript compiler.
- notebook/Jupyter-related Copilot tools if notebook editing is not supported.

These require runtime smoke tests because the extension may dynamically import
modules that static import search does not expose.

## High-Risk Removal Candidates

Do not remove these without first replacing or disabling the feature that uses
them:

- `extensions/copilot/dist/extension.js`
- `extensions/copilot/package.json`
- `extensions/copilot/package.nls*.json`
- assets required by contributed chat participants, tools, or webviews
- `@github/copilot/sdk` while Copilot CLI/background sessions are still enabled
- native prebuilds for the target platform if Copilot CLI/background sessions
  remain enabled
- tokenizer/model files if Copilot language-model routes remain enabled

## Clean Target Architecture

The smallest long-term architecture is:

```text
Right panel shell
  -> src/vs/sessions/contrib/rightWorkbench

Backboard chat/session UI
  -> src/vs/workbench/contrib/chat agent-host session UI
  -> SessionType.AgentHostBackboard

Backboard runtime
  -> src/vs/platform/agentHost/node/backboard/backboardAgent.ts
  -> extensions/backboard/bin/backboard-bridge
  -> Backboard API

Optional legacy/Copilot package
  -> downloaded separately only if user enables legacy Copilot/Copilot CLI
```

In that architecture, the main DMG does not need bundled Copilot. But getting
there requires replacing every default chat entry point that currently depends
on `extensions/copilot`.

## Migration Plan To Remove Copilot From The DMG

1. Add a build flag such as `EXCLUDE_COPILOT_FROM_DMG=1`.
2. Remove `Contents/Resources/app/extensions/copilot` only in the release
   staging app, not from source.
3. Start the app with that staged build.
4. Validate right-panel tabs:
   - launcher opens;
   - review tab opens and shows changes;
   - files tab opens and opens files;
   - browser tab opens a page;
   - terminal tab opens and runs a command.
5. Validate Backboard agent-host:
   - Backboard provider appears;
   - model list loads;
   - a prompt streams;
   - local tools execute;
   - file edit/write flow works;
   - tool-output continuation works.
6. Validate default chat entry points:
   - titlebar/new session button;
   - chat input opens a Backboard session;
   - restored session opens;
   - continue-in/delegation opens `agent-host-backboard`;
   - model picker shows Backboard models.
7. If any default chat path fails because Copilot is missing, port that path to
   Backboard before excluding Copilot permanently.
8. Once all paths pass, keep Copilot as an optional download or remove it from
   production packaging.

## Practical Short-Term Recommendation

Do not delete Copilot immediately. First remove production source maps and other
obvious package bloat, then run the no-Copilot experiment behind a flag.

Recommended order:

1. Keep the stripped Backboard bridge change.
2. Exclude `*.map` from production app/DMG.
3. Add an optional `EXCLUDE_COPILOT_FROM_DMG=1` build flag.
4. Use that flag only for a local smoke-test build.
5. If the right panel and Backboard agent-host pass, make Copilot a separately
   downloadable extension.

## Validation Checklist

Run these before declaring Copilot removable:

- `npm run typecheck-client`
- `npm --prefix extensions/backboard run compile`
- `npm --prefix extensions/backboard run package-bridge`
- Build `aarch64` macOS app.
- Launch the built app from `ide/VSCode-darwin-arm64`.
- Open the sessions window.
- Open right workbench launcher.
- Open right workbench review/files/browser/terminal.
- Start a Backboard session using `agent-host-backboard`.
- Send a prompt that reads a file.
- Send a prompt that edits a file.
- Send a prompt that runs a shell command.
- Restore a previous Backboard session.
- Check DevTools/extension host logs for missing extension contribution errors.

## Decision Rule

If the product goal is "Backboard IDE right panel with Backboard runtime", then
Copilot is not inherently required.

If the product goal is "Backboard IDE plus all Copilot-derived chat participants,
Copilot CLI/background agents, GitHub Copilot model providers, and Copilot tools",
then the bundled Copilot extension remains required unless those features are
ported or moved to an on-demand extension install.

