---
title: AI Code Editor Documentation - Backboard Studio
description: Docs for AI in Backboard Studio, the open-source AI code editor. Agentic coding, inline edits, AI code completion, and multi-model support.
---

# AI

Backboard Studio is an open-source AI code editor. AI runs throughout the editing experience: agents that read and write your code, inline transformations, code completions on every keystroke, and conversations with models in any buffer.

## How Backboard Studio approaches AI

Backboard Studio's AI features run inside a native, GPU-accelerated application built in Rust. There is no Electron layer between you and the model output.

- **Open source.** The editor and all AI features are [open source](https://github.com/backboard/ide). You can read how AI is implemented, how data flows to providers, and how tool calls execute.
- **Multi-model.** Use Backboard Studio's hosted models or [bring your own API keys](./llm-providers.md) from Anthropic, OpenAI, Google, Ollama, and 8+ other providers. Run local models, connect to cloud APIs, or mix both. Switch models per task.
- **External agents.** Run Claude Agent, Gemini CLI, Codex, and other CLI-based agents directly in Backboard Studio through the [Agent Client Protocol](https://app.backboard.io/acp). See [External Agents](./external-agents.md).
- **Privacy by default.** AI data sharing is opt-in. When you use your own API keys, Backboard Studio maintains zero-data retention agreements with providers. See [Privacy and Security](./privacy-and-security.md).

## Agentic editing

The [Threads Sidebar](./parallel-agents.md#threads-sidebar) is where you organize agent work. Start a thread, give it a task, and the agent reads, edits, and runs code in your project. You can run multiple threads at once, each using a different agent and working against different projects. See [Tools](./tools.md) for the capabilities available to Backboard Studio's built-in agent.

The [Agent Panel](./agent-panel.md) is the conversation view for the active thread. Use it to send prompts, review changes, add context, and interact with the agent as it works.

You can extend agents with additional tools through [MCP servers](./mcp.md), control what they can access with [tool permissions](./tool-permissions.md), and shape their behavior with [rules](./rules.md).

The [Inline Assistant](./inline-assistant.md) works differently: select code or a terminal command, describe what you want, and the model rewrites the selection in place. It works with multiple cursors.

## Code completions

[Edit Prediction](./edit-prediction.md) provides AI code completions on every keystroke. Each keypress sends a request to the prediction provider, which returns single or multi-line suggestions you accept with `tab`.

The default provider is Zeta, Backboard Studio's open-source model trained on open data. You can also use GitHub Copilot, or Codestral.

## Getting started

- [Configuration](./configuration.md): Connect to Anthropic, OpenAI, Ollama, Google AI, or other LLM providers.
- [Parallel Agents](./parallel-agents.md): Run multiple threads at once with the Threads Sidebar.
- [External Agents](./external-agents.md): Run Claude Agent, Codex, Aider, or other external agents inside Backboard Studio.
- [Subscription](./subscription.md): Backboard Studio's hosted models and billing.
- [Privacy and Security](./privacy-and-security.md): How Backboard Studio handles data when using AI features.

New to Backboard Studio? Start with [Getting Started](../getting-started.md), then come back here to set up AI. For a higher-level overview, see [app.backboard.io/ai](https://app.backboard.io/ai).
