# Zed Right AI Panel UI Analysis

This document describes the visible UI structure of Zed's right-side AI chat area, focusing on the Agent Panel while intentionally excluding the bottom composer/message editor.

## Scope

This analysis covers:

- The right dock container
- Panel toolbar and thread header
- Thread transcript
- User and assistant message containers
- Tool activity rows
- Permission and checkpoint states
- Review changes surface
- Thread navigation affordances
- Settings and empty states

This analysis does not cover:

- Prompt input field behavior
- Send controls
- Model selector inside the composer
- Add-context controls inside the composer

## Overall Impression

Zed's AI panel is not styled like a consumer chat app. It is a native IDE panel with chat, tool execution, code review, and thread management combined into one compact vertical workspace.

The design language is restrained:

- Dark, editor-native backgrounds
- Thin separators instead of heavy cards
- Compact typography
- Minimal icons
- Low-radius rectangular containers
- Sparse visual hierarchy
- Dense information layout

The panel feels closer to a code review surface or terminal-adjacent workflow than to a conversational messaging product. Its main job is to let the developer understand what the agent is doing, inspect its reasoning/output, and review code changes without leaving the editor.

## Right Dock Container

The Agent Panel usually appears as a vertical docked panel on the right side of the editor in a classic layout. It occupies the full available height of the IDE window.

Structurally, the panel can be understood as:

```text
┌────────────────────────────────────┐
│ Toolbar / Thread Header            │
├────────────────────────────────────┤
│                                    │
│ Scrollable Thread Transcript       │
│                                    │
│ User Message                       │
│ Assistant Response                 │
│ Tool Activity                      │
│ Checkpoints                        │
│                                    │
├────────────────────────────────────┤
│ Review Changes / Diff Summary      │
└────────────────────────────────────┘
```

The panel is visually separated from the main editor by a thin vertical divider. This divider is important because the Agent Panel is not presented as an overlay. It is part of the IDE layout.

The outer container has no decorative treatment. It does not need a shadow, gradient, or prominent border. Its identity comes from placement, density, and panel chrome.

## Layout Behavior

The panel is vertically organized:

1. A fixed-height top toolbar.
2. A flexible, scrollable transcript region.
3. Optional fixed surfaces near the bottom, such as changed-file summaries or review controls.

The transcript region absorbs most resizing. When the panel gets narrower, content wraps instead of switching to a different visual model. Code blocks and file references may become horizontally scrollable or clipped depending on theme and implementation.

The right panel should feel stable during agent activity. Tool events, streaming responses, and review summaries should not cause major horizontal layout shifts.

## Top Toolbar

The top toolbar is a compact horizontal strip. It functions like IDE panel chrome rather than a chat header.

Common elements:

- Current thread title
- New thread control
- Thread or agent menu
- Options menu
- Settings entry point
- Thread actions such as opening as Markdown, renaming, archiving, or regenerating title

The title is usually the main text element in the toolbar. It is small, single-line, and truncated when necessary. Thread titles are auto-generated from the conversation, but can be edited manually.

The toolbar has a utilitarian appearance:

- Tight vertical padding
- Icon buttons aligned to the right
- No avatar
- No large product branding
- No oversized status banner

The toolbar should communicate "active work thread", not "chat room".

## Thread Title Treatment

The thread title is a compact label. It should behave like a file tab title or panel title:

- Single-line by default
- Truncated with ellipsis if too long
- Editable on interaction
- Regenerable through menu action

The title should not dominate the panel. It is secondary to the transcript and review state.

## New Thread Menu

The new thread control opens a menu for starting different thread types.

Expected entries include:

- Zed Agent thread
- External Agent thread
- New from Summary
- Terminal thread

Visually, this menu should be a compact popover:

- Anchored to the top toolbar
- Dark theme surface
- Thin border
- Small row height
- Agent names with optional icons
- Keyboard shortcut hints aligned to the right where applicable

The menu reinforces that the panel is a thread/session manager, not only a single chat conversation.

## Transcript Region

The transcript is the main content area. It is vertically scrollable and contains the history of interaction between the user, agent, and tools.

The transcript is document-like:

- Messages are stacked vertically.
- Most content aligns to a common left edge.
- There is no strong left/right alternating bubble layout.
- Markdown and code are first-class.
- Agent output can include structured sections, tool statuses, and file changes.

The transcript should feel editable/scannable, not decorative.

## Message Spacing

Spacing between message groups is moderate. Zed's AI UI benefits from being dense because the user often needs to scan:

- Prompt history
- Agent plan
- Tool calls
- File references
- Code snippets
- Change summaries

Large conversational whitespace would reduce usefulness. Message groups should have enough separation to identify turns, but not so much that the panel feels sparse.

## User Message Containers

User messages appear as contained prompt blocks. In modern Zed, they are closer to compact editable cards than to chat bubbles.

Visual properties:

- Subtle background difference from panel background
- Low-radius rectangle
- Thin border or low-contrast outline
- Compact internal padding
- Text aligned with the rest of transcript
- No avatar requirement
- Role label may appear as text, depending on version/theme

The user message container should support:

- Plain prompt text
- File references
- Context mentions
- Attached context summaries
- Edited/resubmitted prompt states
- Queued message states when the agent is already generating

The user block should be visually identifiable, but not highly saturated. Zed's default aesthetic keeps user and assistant messages relatively close in treatment.

## Assistant Response Containers

Assistant responses are usually less bubble-like than user messages. They often render as markdown output inside the transcript.

Visual properties:

- Minimal outer framing
- Clear markdown typography
- Code blocks with editor-style syntax highlighting
- Lists, paragraphs, and headings rendered compactly
- Tool activity embedded near the relevant response
- Feedback/action icons available near response boundaries

The assistant response should read like a working note or generated review document. It should not look like a large branded AI card.

## Role Differentiation

Zed's role differentiation is intentionally subtle. User and assistant messages are not separated by strong color coding by default.

Useful differentiators:

- Small role label
- Slight background contrast for user prompt blocks
- Different vertical spacing before assistant responses
- Action controls appearing on assistant output
- Tool rows attached to assistant work

Avoid:

- Bright role colors
- Large avatars
- Speech-bubble tails
- Left/right chat alignment
- Large rounded message balloons

## Markdown Rendering

Assistant output supports markdown-like content. The transcript should support:

- Paragraphs
- Ordered and unordered lists
- Inline code
- Fenced code blocks
- File paths
- Headings
- Tables where needed

Markdown should be styled like an editor preview:

- Monospace for code
- Tight line-height
- Clear but compact heading scale
- Muted separators

The visual hierarchy should prioritize readability during code work, not presentation polish.

## Code Blocks

Code blocks are important in the right panel. They should resemble editor surfaces:

- Monospace font
- Syntax highlighting
- Dark background slightly distinct from message background
- Small padding
- Optional horizontal scroll
- Low-radius border

Code blocks should not have large decorative headers unless there is useful metadata such as language or file path.

## File References

File references appear throughout the transcript when the agent reads, edits, or cites files.

Recommended visual treatment:

- Small file icon
- Path text in monospace or compact UI font
- Muted foreground color
- Clickable row or inline chip
- Truncated middle or end for long paths

File references should look like IDE objects, not tags from a social UI.

## Tool Activity Rows

Tool activity is a defining part of the Agent Panel. The agent can search the codebase, read files, edit files, and run terminal commands.

Tool activity should appear as compact status rows or grouped blocks inside the transcript.

Common row types:

- Searching files
- Reading file
- Editing file
- Running terminal command
- Applying patch
- Waiting for permission
- Completed tool call
- Failed tool call

Visual treatment:

- Small icon at the left
- Verb-first label
- Target path or command
- Muted status text
- Expand/collapse affordance for verbose output
- Subtle border or indentation to show grouping

The tool UI should communicate progress without taking over the panel.

## Tool Output Containers

Some tools produce larger output, especially terminal commands or diagnostics.

These outputs should be rendered in contained blocks:

- Monospace text
- Scrollable or collapsible body
- Clear boundary from surrounding prose
- Compact header row
- Status indicator for success/failure

Long outputs should default to a summarized or collapsed presentation where possible. The panel is narrow, so raw terminal logs can quickly overwhelm the transcript.

## Permission Prompts

When tool permissions require approval, the panel surfaces an authorization UI.

Expected visual structure:

```text
┌────────────────────────────────────┐
│ Tool wants to run command          │
│ command or path summary            │
│                                    │
│ [Allow once] [Allow always] [Deny] │
└────────────────────────────────────┘
```

Permission prompts should be more visually prominent than passive tool rows because they block progress.

Recommended treatment:

- Slightly stronger border
- Warning or lock icon
- Clear action buttons
- Command/path shown in monospace
- Permission granularity dropdown where applicable

The prompt should still follow Zed's restrained style. It should not become a modal unless the action is especially disruptive.

## Checkpoint Controls

Zed shows a Restore Checkpoint button when the model performs edits. The checkpoint allows the user to return the codebase to the state before a message.

Checkpoint UI usually appears near the top of the relevant user message or turn.

Visual treatment:

- Compact button
- Utility-style label such as "Restore Checkpoint"
- Placed close to the message that caused the edit
- Muted but discoverable

This control is important because it connects chat turns to workspace state. It should be visually tied to the corresponding turn, not placed globally.

## Changed Files Summary

When the agent edits files, Zed surfaces a changed-files summary above the bottom area of the panel.

The summary behaves like a persistent review strip:

```text
┌────────────────────────────────────┐
│ Changed 4 files, +120 -32          │
│ [Review Changes]                   │
└────────────────────────────────────┘
```

This strip is one of the most important non-composer elements in the panel.

It should communicate:

- Number of changed files
- Approximate inserted/deleted lines
- Review action
- Expandability

Visual treatment:

- Horizontal accordion bar
- Thin top border
- Slightly elevated background
- Small file/change icon
- Review button aligned right or inline

This area bridges conversation and code review.

## Review Changes Entry Point

The Review Changes button opens a multi-buffer diff view where the user can accept or reject edits.

Inside the right panel, the button should be:

- Easy to find after edits
- Visually more prominent than passive transcript controls
- Not as loud as a primary app CTA
- Persistent until changes are handled

The right panel itself does not need to show the full diff. Its job is to summarize and route the user into review.

## Accept / Reject State References

Although full diff review happens outside the transcript, the panel can expose change state through:

- Changed-file count
- Review button
- Inline summaries from the agent
- Keep/reject action availability after opening review

The panel should avoid pretending edits are final. The visual model should make it clear that agent changes are pending developer review.

## Scroll Navigation

Long conversations need transcript navigation controls. Zed supports jump controls for moving to the top, bottom, or between messages.

Visual treatment:

- Small arrow buttons
- Located near the lower part of the transcript
- Low emphasis until needed
- Possibly overlayed or docked to the panel edge

Navigation controls should not compete with review controls. They are secondary utilities.

## Context Menu on Responses

Right-clicking an agent response opens a context menu with actions such as:

- Copy selection
- Copy this agent response
- Scroll to top
- Scroll to bottom
- Open thread as Markdown

The menu should match Zed's native popover styling:

- Compact rows
- Dark surface
- Thin border
- Keyboard shortcut hints if available
- Disabled rows for unavailable actions

This context menu reinforces that responses are treated as document/editor content.

## Feedback Controls

Assistant responses can expose feedback controls such as thumbs up/down. Zed warns that rating a response can send conversation data to Zed, so feedback is a deliberate action.

Visual treatment:

- Small icon buttons near assistant response footer/header
- Muted until hover
- Not part of the main reading flow

Feedback controls should be visually secondary to thread, tool, and review actions.

## Empty State

When no active conversation exists, the panel shows a new-thread or welcome state.

Expected content:

- Welcome to Zed AI or equivalent title
- Available agent options
- Provider or plan setup if needed
- New thread choices
- External agent entries if installed

The empty state should be practical and compact. It should not look like a marketing landing page.

The panel's empty state can include plan or setup information, but it should remain constrained inside the IDE panel style.

## Agent Settings State

Agent Settings is an in-panel configuration view for:

- LLM providers
- External Agents
- MCP servers

This view replaces or overlays the transcript area.

Visual structure:

```text
┌────────────────────────────────────┐
│ Agent Settings                     │
├────────────────────────────────────┤
│ LLM Providers                      │
│ Provider row                       │
│ Provider row                       │
│                                    │
│ External Agents                    │
│ Agent row                          │
│                                    │
│ MCP Servers                        │
│ Server row                         │
└────────────────────────────────────┘
```

The settings state should feel like a native settings panel:

- Section headings
- Row-based configuration
- Compact buttons
- Provider logos where useful
- No large modals unless required for authentication

## External Agent Threads

External Agent threads may have slightly different capabilities from Zed Agent threads.

UI differences can include:

- Different agent name/icon
- Missing checkpoint support
- Missing token usage
- Different tool availability
- Different permission behavior

The panel should expose these differences through small labels or unavailable states rather than changing the entire layout.

## Terminal Threads

The Agent Panel can host Terminal Threads alongside agent threads. In the right panel, a terminal thread should look more terminal-like:

- Monospace output
- Command-line interaction
- Terminal icon in thread identity
- Thread status in the same session framework

The important design point is that terminal threads are still part of the same Agent Panel thread model. They are not visually unrelated terminals.

## Thread Status

Thread status can communicate:

- Idle
- Generating
- Waiting for permission
- Running tool
- Completed
- Error

Status should be visible but compact:

- Small spinner while generating
- Muted status text
- Warning icon for blocked/error states
- Thread/sidebar status indicator where applicable

The status UI should avoid large banners unless the user must act.

## Error States

Errors may occur during model calls, tool execution, provider setup, or permissions.

Good error presentation:

- Inline with the relevant turn or tool row
- Clear summary first
- Expandable details
- Retry or settings action if relevant
- Error color used sparingly

An error should not destroy the transcript structure. The user needs to preserve context and recover.

## Density and Sizing

The right panel should be optimized for a width where code is readable but not expansive. Good sizing decisions:

- Compact toolbar height
- Tight message padding
- Code blocks with horizontal scroll if needed
- Truncated paths
- Collapsible long outputs
- Fixed review strip height

Avoid:

- Large message bubbles
- Wide margins
- Multi-column layouts inside the panel
- Oversized headings
- Chat avatars
- Decorative cards inside cards

## Visual Hierarchy

The strongest hierarchy should be:

1. Blocking permission prompts
2. Changed-files/review state
3. Current assistant response and active tool calls
4. User prompt blocks
5. Historical assistant prose
6. Secondary controls and feedback icons

This hierarchy matches developer workflow: know whether the agent is blocked, know whether files changed, then inspect what happened.

## Interaction Model

The panel supports a workflow loop:

1. User starts or selects a thread.
2. Agent response streams into transcript.
3. Tool calls appear inline.
4. Permission prompts may interrupt.
5. File edits generate checkpoint and review state.
6. User reviews changes.
7. Thread remains available for follow-up or history.

The UI should make this loop clear without instructional text.

## Design Summary

The right AI panel in Zed is best described as a compact agent workbench.

It combines:

- Chat transcript
- Tool execution timeline
- Code context references
- Permission controls
- Checkpoints
- Review routing
- Thread/session management

It should not look like a generic AI chatbot. The ideal UI is dense, editor-native, calm, and oriented around code changes. The panel's visual design should help the user answer four questions quickly:

1. What did I ask?
2. What is the agent doing?
3. What files changed?
4. What do I need to review or approve?

## References

- [Zed Agent Panel documentation](https://zed.dev/docs/ai/agent-panel)
- [Zed AI Overview](https://zed.dev/docs/ai/overview)
- [Zed Agent Settings documentation](https://zed.dev/docs/ai/agent-settings)
- [Zed All Actions reference](https://zed.dev/docs/all-actions)
- [Zed Parallel Agents documentation](https://zed.dev/docs/ai/parallel-agents)
- [Zed Agent Skills documentation](https://zed.dev/docs/ai/skills)
