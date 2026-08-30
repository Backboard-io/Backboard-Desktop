# Simple mode right panel — ChatGPT reference

These eight screenshots were supplied from the ChatGPT desktop app on 2026-08-05 and are the visual source of truth for Backboard Simple mode's right panel. The captures are Retina-resolution; divide measured image pixels by two for CSS pixels.

| State | Reference |
| --- | --- |
| Empty panel / launcher | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-1.png` |
| Review | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-2.png` |
| Review options | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-3.png` |
| Browser empty state | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-4.png` |
| Files / rendered Markdown | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-5.png` |
| Terminal | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-6.png` |
| New-tab menu | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-7.png` |
| Tab strip | `/Users/erintomorri/.codex/attachments/c55935c2-44c3-49a5-9288-edf8f1a81e02/image-8.png` |

## Shared shell

- Main surface: `#181818` family with 8% white borders/hover and 5% white active fills.
- Top toolbar is 46 CSS px high. Tabs are 28 px high, 8 px radius, 12 px labels, 16 px icons, and 8 px icon/label gap.
- Inactive tabs are transparent. Thin 12 px separators appear between unselected tabs. The selected tab is a subtle pill and shows its close button.
- The right edge always carries expand/restore, compact-window, and panel visibility controls. New-tab `+` remains adjacent to the final tab.

## Empty panel / launcher

- No content tab opens by default.
- Five rows, in this order: Review, Terminal, Browser, Files, Side chat.
- Row size is approximately 536 × 40 CSS px with 4 px vertical gaps and 8 px radius.
- Shortcuts: Review `⌃⇧G`, Browser `⌘T`, Files `⌘P`, Side chat `⌥⌘S`; Terminal has no badge.
- The centered stack is capped at 536 px and sits on the plain panel surface.

## Review

- Review is a full diff workspace, not only an editor/tree split.
- A two-row header shows branch selection, aggregate additions/deletions, upstream branch, review actions, changed-files toggle, and Commit or push.
- The selected file has its own 34 px header above the diff. Changed files occupy a right rail with a rounded Filter files field.
- Review options use a dark floating menu with Refresh, word wrap, full-file loading, rich preview, word diffs, whitespace, and git-apply actions.

## Browser

- A 40 px browser toolbar sits below the 46 px tabs.
- Back, forward, and refresh are left aligned. The rounded URL field spans the center and includes a submit/open arrow at its right edge; more actions sit at the far right.
- Empty state uses a plain 32 px globe, 16 px medium title, and 12 px secondary description with no icon tile.

## Files

- A selected Markdown file renders as a document preview by default, with breadcrumb, View source, Open controls, and a right file tree.
- The file tree has an 8 px outer inset and a 28 px rounded filter field. Selected rows use the 5% active fill.

## Terminal

- Terminal content begins 16 px from the left under the tab strip, using a 12 px monospace font and 1.2 line height.
- The tab title is the workspace/folder name rather than the shell executable.

## New-tab menu

- Once Review exists, the menu offers Terminal, Browser, Files, and Side chat; Review is omitted.
- Menu width is approximately 280 CSS px with 32 px rows, 8 px radius, 8 px icon/label gap, and shortcut labels aligned right.

## Backboard implementation map

| Responsibility | File |
| --- | --- |
| Modes, requests, and command IDs | `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.ts` |
| View registration and open-mode commands | `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.contribution.ts` |
| Launcher, tabs, Review, Browser, Files, Terminal, and Side chat DOM/behavior | `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbenchViewPane.ts` |
| Shared right-panel layout and component styling | `src/vs/sessions/contrib/rightWorkbench/browser/media/rightWorkbenchLauncher.css` |
| Simple-mode theme-token styling | `src/vs/sessions/browser/media/codexTheme.css` |
| Changed-files tree model and rows | `src/vs/sessions/contrib/rightWorkbench/browser/reviewTree.ts` |
| Simple-mode grid, panel visibility, and expand/restore behavior | `src/vs/sessions/browser/workbench.ts` |
| Simple-mode default part visibility | `src/vs/sessions/browser/layoutPolicy.ts` |
| Base Simple-mode theme import/order | `src/vs/sessions/browser/media/t3Theme.css` |
