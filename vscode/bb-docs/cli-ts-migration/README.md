# cli-ts Migration — Index

> **Status (July 2026): EXECUTED.** The agent-host cutover is done:
> - cli-ts gained a persistent `--serve` mode (`cli-ts/src/entrypoints/serve.ts`, control parsing in
>   `serveControl.ts`, permission gate in `src/core/tools/ToolPermissionGate.ts`; `bun run validate`
>   green, 586 tests).
> - The IDE's Backboard provider is `CliTsAgent` (`src/vs/platform/agentHost/node/cliTs/`:
>   `cliTsAgent.ts`, `cliTsProcess.ts`, `cliTsProtocol.ts`, shared helpers in
>   `backboardRuntimeShared.ts`); `backboardAgent.ts` + its test were **deleted**;
>   `npm run typecheck-client` green.
> - Packaging: `extensions/backboard` `package-cli-ts` builds `bin/backboard-cli-ts` (Bun compile).
> - Changes/Review needed no extra work: the agent host's git checkpoint + changeset infrastructure
>   is provider-agnostic and picks up cli-ts's disk edits at turn boundaries.
> - **Bridge fully removed (mega-prompt run):** the extension webview's `BackboardBridge` transport
>   was migrated to the cli-ts serve protocol (same `send()`/`BridgeEvent[]` contract, serve wire
>   underneath; panel submits auto-approved with `AskUser` excluded), then
>   `extensions/backboard/rust/`, `bin/backboard-bridge`, the cargo scripts, and the
>   `backboard.bridgePath` setting (now `backboard.cliPath`) were deleted.
> - **Gap wiring (mega-prompt run):** thinking/intensity, plan mode (schema knob + write-tool
>   exclusion), memory, sub-agent nesting, steering (`steer` op + `steering_consumed`), skills
>   (`listSkills` op + per-submit `skills`), binary attachments (`files` on submit), bundled
>   ripgrep on the child PATH, tool summaries in restored history. Todos render via the TodoWrite
>   tool part (no separate protocol part — documented exception). LSP enables via the
>   `BACKBOARD_LSP` env var, which propagates to the serve child automatically.
> - Not yet done: per-platform CI build matrix for the Bun binary.

Plan + prompt for removing the Backboard-native Rust agent bridge from the IDE and replacing it with
**`cli-ts`** (`backboard-r-cli`), now vendored at `ide/vscode/cli-ts/`.

| Doc | Read it for |
|---|---|
| [00-integration-plan.md](00-integration-plan.md) | The architecture decision (cli-ts owns the loop + tools), the full connection map, phased rollout, and risks |
| [01-cli-ts-tool-calls.md](01-cli-ts-tool-calls.md) | Every cli-ts tool, where its code lives, its safety flags, and how each maps into the IDE |
| [02-wire-protocol-and-seam.md](02-wire-protocol-and-seam.md) | The new cli-ts **serve** protocol and the exact IDE files to change / add / delete |
| [PROMPT.md](PROMPT.md) | A single self-contained prompt to hand an agent to execute the migration end to end |

**The one-line seam:** `src/vs/platform/agentHost/node/agentHostMain.ts:185` registers
`BackboardAgent` (which spawns the Rust bridge). Replace that class with a new `CliTsAgent` that
spawns cli-ts in a persistent `--serve` mode and renders its `AgentEvent` JSON stream. Everything
above it — the `agent-host-backboard` session type, providers, send path, chat widget — stays.

**Key difference to internalize:** the Rust bridge was a dumb proxy and the *workbench* ran tools;
**cli-ts runs its own tools** (Read/Edit/Execute/…) directly on the workspace. So the IDE stops
executing tools and instead renders cli-ts's events and diffs the working tree for the Changes/Review
view. See [00 §1–2](00-integration-plan.md).
