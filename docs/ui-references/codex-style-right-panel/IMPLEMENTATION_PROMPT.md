# Exact Codex chat UI implementation prompt

Rebuild the Backboard IDE secondary-sidebar chat so its conversation UI matches the attached Codex desktop screenshots with near pixel-level fidelity. Treat the screenshots as visual truth. Copy their information hierarchy, density, spacing, typography, disclosure behavior, tool-call presentation, diff presentation, and restrained dark theme—not the literal conversation text shown inside them.

## Visual references

Inspect every image before changing code:

1. `docs/ui-references/codex-style-right-panel/codex/01-running-chat-tool-summary.png` — assistant prose followed by a compact grouped tool summary.
2. `docs/ui-references/codex-style-right-panel/codex/02-shell-tool-expanded.png` — expanded shell call with command/output card.
3. `docs/ui-references/codex-style-right-panel/codex/03-shell-tool-success.png` — scrollable tool output and bottom-right success state.
4. `docs/ui-references/codex-style-right-panel/codex/04-completed-chat-file-review.png` — final response and edited-files review card.
5. `docs/ui-references/codex-style-right-panel/codex/05-running-activity-feed.png` — elapsed-time disclosure and live event timeline.
6. `docs/ui-references/codex-style-right-panel/codex/06-created-file-diff.png` — expanded created-file diff/code surface.

## Scope

Implement this inside the existing Backboard chat UI. Preserve all current data flow and behavior: streaming, reasoning, tool events, file changes, links, markdown, model selection, permissions, cancellation, history, persistence, and keyboard shortcuts. Reuse the current event types and components; do not build a static mock, replace the backend, or hard-code the screenshot content.

Likely code lives under:

- `vscode/src/vs/workbench/contrib/chat/browser/widget/`
- `vscode/src/vs/workbench/contrib/chat/browser/agentSessions/`
- the existing chat response renderers, tool renderers, input/composer, and model picker

## Overall visual system

- Use a flat near-black canvas close to `#111111`; the chat transcript itself has no enclosing card.
- Use elevated surfaces around `#1B1B1B`, hover surfaces around `#222222`, hairline borders around `#3A3A3A`, primary text around `#F2F2F2`, secondary text around `#A4A4A4`, and tertiary text around `#727272` in dark mode. Map these to existing workbench theme tokens wherever possible.
- Success green is restrained but clear, around `#00B85A`; destructive/error red is around `#FF3B30`; the only live-running accent is a small muted blue dot.
- No gradients, glow, glassmorphism, drop-shadow stacks, colored chat bubbles, oversized badges, or decorative empty cards.
- Use the native system/editor sans font for UI and prose, and the editor monospace font for commands, code, paths, and inline code.
- Target CSS sizing, not retina screenshot pixels: 15–16px prose, 14–15px activity text, 13px metadata, 15–16px card titles, 1.45–1.6 line-height.
- Use 18–20px horizontal transcript padding, 20–28px between major response blocks, 10–14px between timeline rows, and 8–12px internal card gaps.
- Icons are monochrome 16–18px thin-outline icons in a fixed 24px gutter. Use existing Codicons; do not use emoji or add another icon library.

## Transcript and assistant prose

- Assistant updates and final answers sit directly on the near-black background with no bubble.
- Keep prose left aligned, readable, and full width. Paragraph spacing should match screenshot 1: generous enough to scan but still dense.
- Links are visibly interactive using a subtle underline; file links use the same treatment and preserve hover/focus states.
- Inline code uses a charcoal pill, 5–7px radius, compact horizontal padding, and the editor monospace font, matching screenshot 4.
- Use thin `#2A2A2A` horizontal rules only to separate meaningful phases, such as elapsed work from the event stream.

## Work-duration disclosure

- Render `Worked for …` as a quiet, clickable disclosure row in secondary text with a small downward chevron.
- It spans the content width and sits directly above a thin divider, as in screenshot 5.
- Collapsing it hides or summarizes the detailed activity timeline without removing the final answer.
- Preserve live duration updates without changing row height or causing scroll jumps.

## Collapsed tool/activity summary

- Group consecutive tool actions into one disclosure row like `Loaded a tool, ran a command, searched the web`.
- Use a semantic leading icon, muted text, and a trailing chevron immediately after the summary—not pushed into a separate floating control.
- The row has no card background in its collapsed state.
- Clicking it expands the activity timeline in place with a short 120–160ms ease-out transition; respect reduced-motion.

## Expanded live activity timeline

- Match screenshot 5: a vertical stack of compact rows with a fixed icon gutter and aligned labels.
- Provide semantic icons for tool loaded, file read, search, web request, shell command, file edited, and file created.
- Use secondary gray for completed entries. Underline clickable file names and search targets.
- Summarize file changes inline as `+2 -3`, with green additions and muted/red deletions.
- A currently running entry ends with one 5–6px blue dot; do not add a large spinner or progress bar.
- Keep completed activity quiet so final prose remains the visual focus.

## Expanded shell/tool card

- The parent event row remains above the card with its icon, one-line command summary, ellipsis truncation, and chevron.
- The expanded detail is a single rounded rectangle: 12–14px radius, 1px low-contrast border, `#1B1B1B` fill, and no shadow.
- Add a compact header label such as `Shell` with 14–16px padding.
- Render command and output as selectable monospace text. Prefix the command with `$`, preserve whitespace, allow horizontal overflow inside the code area only, and use a subtle internal scrollbar.
- Long output scrolls inside a bounded card rather than growing the whole sidebar indefinitely.
- Put a quiet `✓ Success` status at bottom right. Errors use the same layout with a restrained red icon/label and readable failure details.
- Do not wrap each output line in its own surface.

## File edit and review summary

- Match screenshot 4 with one consolidated card after the final answer.
- Card: 12–14px radius, 1px border, elevated dark fill, no shadow, overflow clipped.
- Header contains a dark rounded-square edit/files icon, `Edited N files`, green/red aggregate totals below, then `Undo` and an outlined `Review` button aligned right.
- Separate header and file list with one hairline divider.
- Each file row is one line: ellipsized path on the left and `+N -N` totals aligned right. Keep numeric columns stable while resizing.
- `Undo` uses the existing reversible operation and `Review` opens the existing review/diff flow; do not fake either action.
- At narrow widths, preserve the title and actions, truncate paths, and never create horizontal page scrolling.

## Created/edited file disclosure and diff

- A collapsed file event is a plain timeline row such as `Edited filename.ts +2 -3` or `Created file`, matching screenshots 5–6.
- Expanded state shows one bordered code surface with a compact header containing filename, additions/deletions, and a copy button.
- Use a dark green-tinted added-line background, a saturated green 3–4px edge marker, green line numbers, and syntax highlighting that stays readable on the tint.
- Deleted lines use the corresponding restrained red treatment. Context lines remain neutral.
- Use the editor monospace font, stable line-number gutter, selectable text, copy support, and horizontal scrolling inside the diff only.
- Cap tall diffs and allow internal vertical scrolling or an explicit expand action.

## Composer and surrounding panel

- Keep the transcript styling above authoritative. Make the existing composer visually compatible: near-black/elevated neutral fill, subtle 1px border, 12–14px radius, no shadow, compact context chips, auto-growing textarea, model control at lower left, and voice/send/cancel controls at lower right.
- Do not make the composer visually heavier than the tool/diff cards.
- Keep the header compact and flat with icon-only actions and the existing task title/history behavior.

## Interaction and accessibility

- Entire disclosure rows are clickable, with clear hover and `focus-visible` states but no permanent button boxes.
- Preserve keyboard activation with Enter/Space, logical tab order, screen-reader names, selectable command output, link behavior, and focus restoration after collapse.
- Maintain scroll anchoring during streaming: follow new content only when the user is already near the bottom; never yank a user away from an expanded tool or diff.
- Support loading, running, success, error, cancelled, permission-required, and partially streamed states using the same quiet visual language.
- Respect high-contrast themes and reduced-motion. Do not hard-code colors where a workbench token can express the same relationship.

## Implementation process

1. Inspect the six references and the current Backboard render path.
2. Inventory every response part and event state before editing.
3. Create or consolidate reusable primitives for activity rows, disclosure rows, tool cards, file summaries, and diffs instead of styling every tool separately.
4. Implement the dark Codex treatment with theme-token fallbacks.
5. Run typecheck and focused tests for rendering, keyboard interaction, disclosure state, and streaming updates.
6. Launch the IDE and capture the same six states at sidebar widths of 380px, 480px, and 600px.
7. Compare screenshots side by side and iterate on spacing, typography, borders, truncation, icon alignment, and scroll behavior until the result is visually faithful.

## Acceptance criteria

- A side-by-side comparison immediately reads as the same UI system as the Codex references.
- Collapsed and expanded tool calls match the hierarchy shown in screenshots 1–3 and 5.
- Final file review and expanded diffs match screenshots 4 and 6.
- Real links, tools, commands, reasoning, running states, errors, file changes, Undo, Review, and copy actions still work.
- No nested-card clutter, oversized controls, clipped labels, layout jumps, or sidebar-level horizontal scrolling.
- The implementation is responsive, keyboard accessible, theme safe, and verified with before/after screenshots rather than declared complete from code alone.
