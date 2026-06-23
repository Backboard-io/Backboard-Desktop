# Right Panel Rework Plan

## Goal

Rework the current right-side UI into a single mode-based workbench surface. The current split between the right panel and the optional panel feels disconnected. The new design should feel like one clean right-side work area where each feature owns the full surface when active.

The target behavior is based on the screenshots:

- A launcher state with large rows for each feature.
- A Review mode for diffs and changed files.
- A Browser mode with real browser chrome.
- A Files mode with code and file tree visible side by side.
- A Terminal mode that can fill the same right-side surface.

## Core Idea

The right panel should no longer behave like:

```text
Right Panel
Optional Panel
```

It should behave like:

```text
Right Workbench
├── Launcher
├── Review
├── Terminal
├── Browser
└── Files
```

Only one mode is active at a time. The active mode owns the right-side surface.

## Feature 1: Launcher

The launcher is the default or empty state.

It should show large selectable rows:

```text
┌──────────────────────────────────────────────┐
│ Review                                ⇧⌘G   │
│ Terminal                                     │
│ Browser                                ⌘T   │
│ Files                                  ⌘P   │
│ Side chat                              ⌥⌘S  │
└──────────────────────────────────────────────┘
```

Each row should include:

- Icon
- Feature label
- Optional shortcut pill
- Hover state
- Click action to switch modes

This replaces the feeling of a hidden optional panel. The user can clearly choose what the right workbench should become.

## Feature 2: Review Mode

Review mode is for inspecting agent changes.

Layout:

```text
┌────────────────────────────────────────────────────────────┐
│ Review  +                                                   │
├───────────────────────────────┬────────────────────────────┤
│ Last turn  +89 -53            │ Filter files...             │
│                               │                              │
│ Diff viewer                   │ Changed files tree           │
│ Red/green inline changes      │ Grouped folders/files        │
│ Collapsed unchanged lines     │ Selected file highlight      │
└───────────────────────────────┴────────────────────────────┘
```

Review mode should include:

- Turn selector, such as `Last turn`
- Additions/deletions summary
- Inline diff viewer
- Changed files tree
- File filter
- Actions for opening files, toggling views, or filtering changes

Purpose:

Review is the place to answer: "What did the agent change?"

## Feature 3: Browser Mode

Browser mode should feel like a real browser, not a small URL form.

Layout:

```text
┌────────────────────────────────────────────────────────────┐
│ Review   New tab   +                                      │
├────────────────────────────────────────────────────────────┤
│ ←  →  ↻   [ Enter a URL                         ↗ ]   ⋮   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│                         ◎                                  │
│                    Start browsing                         │
│              Enter a URL to open a page                   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Browser mode should include:

- Browser tab label, such as `New tab`
- New tab button
- Back button
- Forward button
- Reload button
- URL input
- Go/open button
- More menu
- Empty state with globe icon

URL handling should support:

- Full URLs, such as `https://example.com`
- `localhost:5173`
- `5173`
- `:5173`
- `5173/path`
- Pasted terminal output containing a URL

Purpose:

Browser is the place to preview local apps and web pages.

## Feature 4: Files Mode

Files mode should show code and files at the same time.

Layout:

```text
┌────────────────────────────────────────────────────────────┐
│ Review   New tab   current_file.py   +                    │
├────────────────────────────────────────┬───────────────────┤
│ Breadcrumbs / file toolbar             │ Filter files...    │
├────────────────────────────────────────┤                   │
│                                        │ File tree          │
│ Code editor                            │                   │
│                                        │ folders            │
│                                        │ files              │
│                                        │ selected file      │
└────────────────────────────────────────┴───────────────────┘
```

Files mode should include:

- Code editor on the left
- File tree on the right
- File filter
- Breadcrumbs
- Current file tab
- `Open` button or open-in-editor action
- Folder/file icons
- Selected file highlight

Important behavior:

Selecting a file should open code beside the file tree. It should not replace or hide the file tree.

Purpose:

Files is the place to inspect and navigate project files while keeping code visible.

## Feature 5: Terminal Mode

Terminal mode should use the same right workbench surface.

Layout:

```text
┌────────────────────────────────────────────────────────────┐
│ Terminal   +                                               │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ Terminal output/input                                      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Terminal mode should include:

- Terminal tab or title
- New terminal action
- Kill/close terminal action if available
- Full-height terminal body

Purpose:

Terminal is the place for commands, logs, dev servers, and process output.

## Side Chat

Side chat appears in the launcher, but it should be treated carefully.

It may be:

- A separate right workbench mode
- A layout toggle
- A companion panel that can appear beside another mode

It should not block the first implementation. The first implementation should focus on Review, Terminal, Browser, and Files.

## Architecture Plan

### 1. Create a Right Workbench Shell

Add a single shell component/container for the right side.

Responsibilities:

- Own active mode state
- Render the launcher when no mode is active
- Render the active mode
- Provide shared frame styling
- Provide shared top-right layout controls

State:

```text
activeMode: "launcher" | "review" | "terminal" | "browser" | "files" | "sideChat"
isCollapsed: boolean
```

### 2. Move Existing Views Into Modes

Reuse existing systems where possible:

- Existing Files tree logic should become the Files mode tree.
- Existing editor part should become the Files mode code area.
- Existing Browser service/input logic should become Browser mode.
- Existing changes/review logic should become Review mode.
- Existing terminal contribution should become Terminal mode.

Avoid rewriting mature VS Code pieces unless the layout requires it.

### 3. Replace Visual Tab Strip With Mode Header

The current `Changes / Files / Browser` tab row should become part of the new mode system.

The new header should support:

- Active mode pill
- Other open mode tabs if needed
- `+` launcher/open button
- Collapse button
- Layout controls

### 4. Make Files Mode Side By Side

The current stacked layout should be replaced with:

```text
Files mode
├── Editor area
└── File tree
```

This is the key behavior for the optional panel:

The optional/editor area should be beside the file tree, not underneath it.

### 5. Rework Browser Mode Into Browser Chrome

Replace the small URL row with a full browser toolbar:

```text
Back | Forward | Reload | URL input | Go | Menu
```

The empty state should say:

```text
Start browsing
Enter a URL to open a page
```

### 6. Rework Review Mode

Review mode should combine:

- Diff viewer
- Changed files tree
- Additions/deletions summary
- Turn selector

This mode should answer what changed and where.

## Implementation Order

1. Create the right workbench shell and active mode state.
2. Add the launcher UI.
3. Move Files into a side-by-side editor/tree layout.
4. Rework Browser mode with browser chrome and better URL input.
5. Add Review mode layout.
6. Add Terminal mode layout.
7. Add collapse/expand behavior.
8. Polish spacing, icons, shortcuts, empty states, and selected states.

## Validation Plan

Run:

```bash
npm run typecheck-client
npm run compile-client
```

Then verify in the Agents window:

- Launcher appears when no mode is selected.
- Review opens as diff plus changed-files tree.
- Browser opens with real browser chrome.
- Browser URL input supports localhost ports and pasted URLs.
- Files opens with editor and file tree side by side.
- Terminal opens in the same right workbench surface.
- Collapse/expand works from the right-side controls.

## Non-Goals For First Pass

- Do not rewrite the file explorer from scratch.
- Do not rewrite the browser service from scratch.
- Do not redesign the entire chat area.
- Do not make Side chat block the first implementation.
- Do not build a new standalone IDE shell outside the existing VS Code workbench pieces.

