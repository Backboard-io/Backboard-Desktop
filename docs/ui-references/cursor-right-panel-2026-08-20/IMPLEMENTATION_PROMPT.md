# Implementation prompt: Cursor-style chat transcript only

You are working in the `Backboard-Desktop` repository. Redesign **only the scrollable agent-chat transcript** in Backboard's native right-side chat so its messages, live streaming, reasoning/activity rows, tool invocations, and inline file diffs closely match the supplied Cursor references.

This is an implementation task. Inspect the active code, preserve its real state pipeline, make the scoped changes, run focused tests, launch the app, and compare real runtime screenshots before calling the work complete.

## Hard scope boundary

The transcript is the scrolling conversation region **below the existing tabs/header and above the existing composer/review controls**.

Do not change, restyle, move, or rebuild any of the following:

- Header, title bar, agent/session tabs, tab actions, or session navigation.
- Composer/input box, placeholder, mode control, model picker, permission control, attachment, voice, submit, stop, or follow-up controls.
- History, model, mode, permission, or overflow popovers.
- Changed-files review dock above the composer.
- Central review/diff editor.
- Auxiliary-bar frame, width, global workbench layout, editor area, or activity bar.
- Any chat host outside Backboard's right-side auxiliary-bar chat.

Those elements appear in some screenshots only because they surround the conversation. They are context, not implementation targets. If matching the transcript would require changing one of them, leave it unchanged and adapt the transcript within its current bounds.

## Visual references

Use:

- `docs/ui-references/cursor-right-panel-2026-08-20/README.md`
- `docs/ui-references/cursor-right-panel-2026-08-20/cursor-right-panel-contact-sheet.png`
- The 405 × 768 panel crops under `docs/ui-references/cursor-right-panel-2026-08-20/crops/`

Study only the conversation body in these references:

- Streaming lifecycle: `19`, `21`, `22`, `23`
- Completed chat: `01`, `14`, `15`, `20`
- Reasoning and activity: `03`, `04`, `16`, `17`
- Inline diff cards: `05`, `06`
- Shell/tool lifecycle: `24`, `25`, `26`, `28`

Ignore the tabs, header, composer, menus, review dock, and central editor shown around those states. Do not use `07`–`13` or `18` as styling targets except to understand where the transcript boundary begins and ends.

The observed Cursor panel was about 405 px wide. Treat the screenshots as visual and behavioral truth, but never reproduce their literal conversation content or hardcode screenshot-specific DOM.

## Active implementation path

The live chat is the native VS Code workbench chat hosted in the auxiliary bar, not the old Backboard extension webview.

Work primarily in:

- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatListWidget.ts`
- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts`
- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts`
- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatThinkingContentPart.ts`
- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatProgressContentPart.ts`
- `vscode/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.ts`
- Relevant streaming/terminal tool subparts in that directory
- `vscode/src/vs/workbench/contrib/chat/browser/widget/media/chatPanelCursorLook.css`
- Transcript-specific rules in `vscode/src/vs/workbench/contrib/chat/browser/widget/media/chat.css`

`syncBackboardT3TurnTimeline()` in `chatListRenderer.ts` is the current work-log grouping/collapse locus. Build on the existing content parts and renderer state rather than creating a parallel transcript.

Do not implement this in `vscode/extensions/backboard/src/panel/panelHtml.ts`, `backboardExtension.ts`, or `backboardComposer.css`; those are legacy paths. Do not edit `chatInputPart.ts`, picker action items, `chatViewTitleControl.ts`, or their CSS for this task.

Preserve the real stream path:

`cliTsAgent.ts` → `agentHostSessionHandler.ts` → chat model/view model → `ChatWidget` → `ChatListWidget` → `ChatListRenderer`

Only touch the stream bridge if a transcript state is genuinely missing. Styling and disclosure behavior belong in the transcript renderer/content parts and narrowly scoped CSS.

## Behavior that must remain intact

- True token-by-token markdown and reasoning updates.
- Stable row identity across progressive rerenders, with no duplicate messages or reset disclosures.
- Real tool pending, running, approval, success, and error transitions.
- Cancellation and completion behavior, without changing the existing stop control.
- Markdown, links, code blocks, copy actions, selection, and keyboard focus.
- Existing history, persistence, restoration, sessions, subagents, and progress events.
- Existing inline diff actions and file-change state.
- Final assistant prose remains outside the collapsible activity log.
- Running activity remains visible; completed activity becomes a toggleable `Worked for …` summary.
- Bottom-follow only while the reader is already at the bottom. Streaming must not yank a reader who scrolled upward.
- No regression in editor chat, quick chat, inline chat, or other `ChatWidget` hosts.

Reuse existing semantic content parts and events. Do not fake streaming, buffer a completed response and reveal it with timers, flatten all events into markdown, or hardcode sample rows.

## Chat visual system

The transcript should be compact and editor-native. Cursor's defining hierarchy is one restrained user bubble, unboxed assistant prose, flat activity rows, and compact tool/diff disclosures.

Use existing VS Code theme tokens first, with dark fallbacks close to:

- Transcript background: `#181818`
- User/tool surface: `#1f1f1f` to `#202020`
- Borders/dividers: `#303030` to `#3b3b3b`
- Primary text: `#dedede`
- Secondary text: `#989898`
- Tertiary metadata: `#6f6f6f`
- Green only for positive diffs or existing semantic success/active meaning
- Red only for removals, errors, or destructive meaning

Use existing Codicons and workbench primitives. Do not add a third-party icon library. Avoid gradients, glow, glass effects, avatars, assistant bubbles, oversized shadows, status banners, and nested card containers.

Use approximately 16 px transcript gutters, a 4/8 px spacing rhythm, 8–12 px radii, and low-contrast 1 px borders. Assistant prose should be about 14 px with 20–21 px line-height. Metadata can be 12–13 px; commands, code, diffs, and output use the configured editor monospace font.

## Message hierarchy

### User request

- The user request is the only conventional message bubble.
- Use a compact dark surface, 10–12 px padding, roughly 10–12 px radius, and a subtle border only where the theme needs separation.
- Keep it full-width inside the transcript gutters.
- Long requests may use the existing accessible truncation/expansion behavior, but do not alter the surrounding header or input.
- During an active response, preserve the current request near the top of the transcript viewport if the existing transcript architecture can do so without covering content or breaking scroll/focus. This behavior must remain inside the transcript scroller.

### Assistant response

- Render assistant content directly on the transcript background: no bubble, avatar, redundant label, or enclosing response card.
- Final prose is the strongest white content, with disciplined paragraph, list, heading, and code spacing.
- Keep completion metadata/actions quiet and subordinate if they are already part of the transcript row.
- Partial and completed output must share the same semantic row/content parts. Completion must not replace or duplicate the response.

## Streaming lifecycle

Implement and verify the transcript's side of these real states without touching composer or header controls:

1. **Pending:** one muted planning/status row, such as `Planning next moves`.
2. **Partial tokens:** normal assistant typography grows in place, with stable markdown and row identity.
3. **Reasoning/tools:** activity rows and tool cards update in place without layout thrash or scroll jumps.
4. **Completed:** live indicators settle once, final prose remains in the same response, and quiet completion actions may appear if already supported.

References `19`, `22`, and `23` distinguish pending, genuine mid-sentence streaming, and completion. Do not simulate partial streaming by clipping completed text.

## Reasoning and activity

Rework the existing transcript work log into Cursor's flat disclosure system:

- A completed turn has one toggleable `Worked for 1m 34s`-style summary.
- Inside it, use compact textual rows such as `Thought briefly`, `Thought 5s`, searches, reads, and tool actions.
- Reasoning narrative is plain readable text, not another bubble or nested card.
- Group repetitive exploration into summaries such as `Explored 6 files, 2 searches`, with detail disclosures only where useful.
- Use muted icons/labels and minimal dividers.
- Keep active work expanded and visible. Once complete, preserve the user's disclosure state across rerenders.
- Never place the final assistant answer inside `Worked for …`.

References `03`, `04`, `15`, `16`, and `17` define this hierarchy.

## Tool and shell rows

- Use compact bordered disclosures inside the transcript width, with roughly 8 px radius and a low-contrast 1 px border.
- Collapsed form: chevron, human-readable action summary, dim command/detail, and a small status/output preview where useful.
- Expanded shell form: chevron, summary, existing overflow action, divider, syntax-styled command, and monospace output.
- Pending/running/success/error/approval states update in place and keep the same geometry.
- Use a lightweight spinner or progress cue for live work; success becomes quiet metadata rather than a large badge.
- Preserve the existing permission model and actions. Do not modify the permission menu itself in this task.

Use `24`, `25`, `26`, and `28` for the lifecycle. Reference `27` only to ensure the tool row still opens the unchanged existing menu.

## Inline diff cards

Only restyle diff cards that are rendered **inside the transcript**:

- Stack compact file cards with roughly 8 px radius and a thin border.
- Header contains the file icon/name and restrained green addition/red removal counts.
- Expanded body uses dense monospace text, line-number gutter, internal clipping/scrolling where needed, and dark-green/dark-red full-row change backgrounds.
- Expanding a card must not recreate the turn, lose disclosure state, or move the reader unexpectedly.

Use `05` and `06` as the references. Do not change the sticky changed-files review dock or the central review editor.

## Scrolling, sizing, and accessibility

- The 405 px transcript width is the main fidelity target; also verify the unchanged panel at 380, 480, and 600 px widths.
- No horizontal transcript overflow. Code/diff bodies may scroll internally where appropriate.
- Preserve bottom anchoring only while already near the bottom. Never force-scroll someone who moved upward.
- Ensure the last transcript row remains visible above the untouched composer/review area.
- Honor reduced motion, high-contrast themes, zoom, focus-visible rings, ARIA states, logical tab order, and keyboard-operable disclosures.
- Do not rely on green/red alone for status or diff meaning.

## Implementation approach

1. Launch the app and identify the exact auxiliary-bar transcript root and content-part classes.
2. Add or refine semantic transcript state hooks only where the existing renderer lacks them.
3. Keep the model/stream pipeline intact and build on the current content parts.
4. Create a small transcript-only visual vocabulary: user request bubble, flat assistant prose, activity/disclosure row, tool disclosure, and inline diff card.
5. Scope all CSS beneath the Backboard auxiliary-bar transcript root. Do not use broad selectors that affect input, title, tabs, popovers, review UI, or other chat hosts.
6. Verify progressive rendering, disclosure persistence, scroll anchoring, keyboard focus, and session restoration throughout implementation.
7. Capture the real runtime transcript in pending, streaming, tool, diff, and completed states and compare it side-by-side with the specified references.

Do not rewrite large subsystems for styling. Do not create a second transcript or a separate “Cursor mode.” Do not compensate for transcript spacing by editing the composer, tabs, header, or workbench frame.

## Verification and definition of done

Capture live Backboard comparisons for:

- Initial pending (`19`)
- Genuine partial-token stream (`22`)
- Completed form of the same response (`23`)
- Expanded and collapsed `Worked for …` (`03`, `15`)
- Expanded reasoning/activity (`04`, `17`)
- Compact and expanded inline transcript diffs (`05`, `06`)
- Tool pending/running/completed/expanded (`24`, `25`, `26`, `28`)

Run repository-appropriate typechecking/linting plus focused chat renderer, progressive rendering, tool invocation, and interaction tests. Verify:

- No duplicate transcript rows.
- Stable disclosures across token/tool updates.
- Exactly one completion transition.
- Final prose stays outside the work log.
- Tool approvals and existing menus still work unchanged.
- Keyboard-operable transcript disclosures with visible focus.
- No horizontal overflow or upward-scroll jump.
- No visual or behavioral change to the composer, tabs/header, menus, review dock/editor, or non-auxiliary chat hosts.

The task is complete only when the **chat transcript alone** matches the reference hierarchy and density, every lifecycle is driven by real Backboard state, focused checks pass, and side-by-side runtime screenshots demonstrate the result. Do not claim completion from static HTML/CSS inspection or unit tests alone.
