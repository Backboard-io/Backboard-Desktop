# Why the IDE Feels Faster Than the CLI

The IDE feels faster because its native path removes client-side overhead, not because it does lower-quality work. It still uses the same Backboard model stream and keeps the important workspace/tool context, but it sends and renders it through a simpler runtime.

## Short Version

- The IDE does less client-side work around the same model stream.
- The CLI prepares more before the model call.
- The CLI does more work while every stream chunk arrives.
- Rust helps, but the bigger win is the thinner IDE runtime path.
- Result quality should stay strong because the model, endpoint, and core agent workflow are still the same.

## CLI Cost Centers

**Before the request**

- Builds richer per-turn context.
- Adds OS, shell, workspace, git status, recent files, terminals, and todos.
- Injects task-specific workflow guidance.
- Carries a heavier system prompt for autonomy, tools, persistence, and answer format.

**During streaming**

- Parses every SSE chunk.
- Updates Rich Live UI, Markdown previews, thinking panels, spinner state, and scrollback.
- Tracks diagnostics, token estimates, reasoning state, recovery state, and stream health.
- Handles provider quirks, stream stalls, cancellation, and retry safety.

**Compatibility surface**

- Supports broader tools, MCP, skills, subagents, terminal behavior, sessions, and CLI-only workflows.
- Keeps extra guardrails because terminal UX has more failure modes than the native IDE UI.

## IDE Fast Path

- Uses the native Rust runtime.
- Sends a focused workspace wrapper instead of the CLI's larger terminal/session bundle.
- Uses a focused native tool set.
- Forwards streamed chunks directly into Zed's agent thread state.
- Lets Zed/GPUI render native state instead of repainting a terminal surface per chunk.
- Keeps the model focused on the same task without extra CLI-only compatibility instructions.

## Why Results Are Still Good

- Same Backboard API path: the IDE is still streaming through Backboard, not using a weaker local shortcut.
- Same model selection: quality is driven mostly by the selected provider/model, not by whether the caller is CLI or IDE.
- Same core agent loop: prompt, stream, tool calls, tool outputs, and continuation still happen.
- Less overhead can help quality on focused tasks because the model sees fewer CLI-only instructions and less terminal/session noise.
- The IDE keeps the context that matters most for coding: workspace path, native tools, file reads/searches, edits, terminal commands, and concise progress.

## Bottom Line

The IDE is faster because the client path is smaller and more direct, not because it is cutting corners on answer quality. The CLI carries more compatibility and terminal UX machinery; the IDE removes that extra work while keeping the important model and tool flow intact.
