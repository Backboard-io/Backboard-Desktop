# Backboard Workspace Layout Notes

This note maps the current Advanced / Workspace page implementation by the three surfaces that keep coming up in UI work: tiles, header, and right panel. It is based on the current TypeScript and CSS in this folder.

## Source Files

- `src/vs/workbench/contrib/chat/electron-browser/backboardWorkspace/backboardWorkspacePage.ts`
  - Builds the DOM, owns page state, opens chat sessions, renders cards, and wires interactions.
- `src/vs/workbench/contrib/chat/electron-browser/backboardWorkspace/media/backboardWorkspace.css`
  - Owns layout, sizing, theme colors, card styling, header spacing, right panel styling, and scoped chat-widget overrides.

The page is not an editor tab. It is a workbench overlay/surface created by `BackboardWorkspacePage`; the overlay is shown/hidden by the contribution and the page itself manages its internal header, card grid, and right-side detail panel.

## Overall Page Shape

The page is created in `BackboardWorkspacePage.create()` in `backboardWorkspacePage.ts`.

Important construction points:

- The outer page root is `.backboard-workspace-editor`.
- The top bar is `.backboard-workspace-header`.
- The main page grid is `.backboard-workspace-page`.
- The left/main content column is `.backboard-workspace-main`.
- The tile container is `.backboard-workspace-cards`.
- The draggable divider is `.backboard-workspace-sash`.
- The right panel is `.backboard-workspace-detail`.
- The real chat surface lives inside `.backboard-workspace-detail-chat`.

The matching CSS grid is in `backboardWorkspace.css` under `.backboard-workspace-page`. It uses:

```css
grid-template-columns: minmax(0, 1fr) 1px clamp(340px, 21.875vw, var(--detail-width, 420px));
```

That means the main workspace fills available width, the sash is a fixed 1px divider, and the right panel is clamped around the Figma-sized 420px target. When the right panel is collapsed, `.backboard-workspace-page.no-detail` switches the grid to one column and hides the sash.

The root surface defines the theme-dependent variables in `.backboard-workspace-surface`, including the workspace background, card background, borders, muted text, success/warning/error tones, and active/focus colors. Most of the design work should use those variables instead of hardcoded colors.

## Tiles / Cards

### TypeScript Ownership

Tiles are rendered from `renderSessions()` in `backboardWorkspacePage.ts`.

The render path is:

- `renderSessions()`
  - clears `.backboard-workspace-cards`;
  - reads real sessions from `agentSessionsService.model.sessions`;
  - updates the header count;
  - renders placeholder cards if there are no real sessions;
  - renders real session cards when sessions exist;
  - adds shadow tiles so the grid still has quick-start affordances.
- `renderPlaceholderAgentCard()`
  - creates Figma-style representative cards for the default empty/demo state.
- `renderSessionCard()`
  - creates cards backed by real `IAgentSession` records.
- `renderShadowTile()`
  - creates the lighter empty tile used to start another session.

The placeholder card data is defined near the top of the file:

- `IBackboardWorkspacePlaceholderAgent`
- `IBackboardWorkspacePlaceholderActivity`
- `WORKSPACE_VIEW_STATES`
- `basePlaceholderAgents`

The internal state ids currently include:

- `activeAgents`
- `mixedStatus`
- `completed`
- `chatClosed`
- `chatOpen`
- `chatRunning`
- `chatReview`

These states mostly change the representative card data and counts. They are not a visible demo switcher. The default is still `activeAgents`.

### Placeholder Tile Structure

`renderPlaceholderAgentCard()` creates this structure:

- `article.backboard-workspace-card.backboard-workspace-placeholder-card`
  - `data-tone` for live, queued, done, warning, etc.
  - header:
    - `.backboard-workspace-card-header`
    - `.backboard-workspace-card-title`
    - `.backboard-workspace-status-dot`
    - `.backboard-workspace-card-name`
    - `.backboard-workspace-card-actions`
    - status pill from `createStatusPill()`
    - menu button
  - command row:
    - `.backboard-workspace-command-row`
    - `.backboard-workspace-command-label`
    - `.backboard-workspace-command-description`
  - activity list:
    - `.backboard-workspace-card-activity`
    - `.backboard-workspace-activity-row`
    - tone-specific codicon
  - file chips:
    - `.backboard-workspace-card-files`
    - `.backboard-workspace-file-chip`
    - `.backboard-workspace-file-dot`
  - footer:
    - stop/action button
    - spacer
    - `.backboard-workspace-card-model-pill`
    - external-link icon

Clicking a placeholder card, or pressing Enter/Space on it, calls `openNewAgentSession()`.

### Real Session Tile Structure

`renderSessionCard()` creates real cards from `IAgentSession`.

It sets:

- `.selected` when the card matches `selectedSessionResource`;
- `.running` when the session is currently running;
- status tone from `getSessionStatusInfo()`;
- output preview from `getOutputPreview()`;
- activity rows from `renderActivityRows()`;
- changed-file chips from `getChangedFileLabels()`;
- provider/model footer metadata.

Clicking a real session card calls `openExistingSession(session)`, which loads that session into the right panel chat widget.

### Tile CSS Ownership

The main tile layout is in `backboardWorkspace.css`:

- `.backboard-workspace-cards`
  - scrollable card grid;
  - padding and grid gap;
  - fixed card row height through `grid-auto-rows: 430px`;
  - columns from `repeat(auto-fit, minmax(320px, 360px))`.
- `.backboard-workspace-card`
  - card shell, border, background, hover, selected, running states.
- `.backboard-workspace-card-header`
  - top row layout for title, status, and actions.
- `.backboard-workspace-status-dot`
  - status color dot.
- `.backboard-workspace-status-pill`
  - compact status badge.
- `.backboard-workspace-card-body`
  - real-session body region.
- `.backboard-workspace-card-output`
  - output preview for real sessions.
- `.backboard-workspace-card-activity`
  - activity row area.
- `.backboard-workspace-card-files`
  - changed-file chip row.
- `.backboard-workspace-card-footer`
  - model/provider/actions footer.
- `.backboard-workspace-shadow-tile`
  - empty quick-start tile.

There is also a later section marked `/* === Figma workspace pass === */`. That block overrides the earlier card styling for the current Figma-inspired visual pass: tighter card header spacing, 10px card radius, stronger status-pill styling, command row treatment, updated file chips, and a fixed footer band.

### Tile Gotchas

- The tile grid is fully rerendered by `renderSessions()`. That is simple and fine for the current number of sessions, but card-level changes should avoid adding expensive work inside each render.
- Some older empty-state CSS still exists, but the current no-session path renders placeholder cards instead of the old centered empty state.
- The card selected state is tied to `selectedSessionResource`, not to DOM focus.
- The placeholder internal states exist for future data wiring, but the production path is still real sessions from `IAgentSessionsService`.

## Header

### TypeScript Ownership

The header is built in `BackboardWorkspacePage.create()`.

Current header structure:

- `.backboard-workspace-header`
  - `.backboard-workspace-header-left`
    - `.backboard-workspace-switcher`
      - workspace/layout icon
      - current workspace filter label, currently `All Workspaces`
      - chevron
    - `.backboard-workspace-title-row`
      - `h1` title, currently `Advanced`
      - `.backboard-workspace-count`
  - `.backboard-workspace-header-right`
    - refresh icon button
    - `.backboard-workspace-detail-new-button`, visible as `New`
    - `.backboard-workspace-detail-expand`, shown only when the right panel is collapsed

The workspace dropdown is opened by `showWorkspaceSwitcherMenu(anchor)`. That method builds `.monaco-workspace-switcher-menu` as a floating menu and uses `selectedWorkspaceFilter` to decide which item is active. Changing the filter rerenders the cards.

The title/count are updated by:

- `renderSessions()` for the count;
- `updateWorkspaceSwitcherLabel()` for the workspace dropdown label.

### Header CSS Ownership

Header styling lives in `backboardWorkspace.css`:

- `.backboard-workspace-header`
  - 36px titlebar-like height;
  - grid with left flexible content and right actions;
  - VS Code titlebar background and foreground;
  - bottom border;
  - Mac traffic-light compensation through `padding-left`.
- `.backboard-workspace-header-left`
  - left-side flex row.
- `.backboard-workspace-header-right`
  - right-side action row.
- `.backboard-workspace-title-row`
  - compact title/count alignment.
- `.backboard-workspace-title-row h1`
  - small titlebar-scale heading.
- `.backboard-workspace-count`
  - muted count text.
- `.backboard-workspace-switcher`
  - compact dropdown button.
- `.monaco-workspace-switcher-menu`
  - floating dropdown menu styling.

The CSS also contains rules that hide adjacent workbench titlebar controls while the workspace surface is visible:

```css
.monaco-workbench.backboard-workspace-visible .part.titlebar > .titlebar-container > .titlebar-right,
.monaco-workbench.backboard-workspace-visible .part.titlebar .command-center-center,
.monaco-workbench.backboard-workspace-visible .part.titlebar .agent-status-container {
	display: none !important;
}
```

Those rules are important because the Advanced page has its own header. If duplicate titlebar controls appear, first check these selectors and the active titlebar DOM class.

### Header Gotchas

- The old three-section `Sandbox / Editor / Workspace` navbar should not be duplicated here. The current desired header is the dropdown-style header, not the segmented switch.
- The macOS traffic-light overlap is handled by `.monaco-workbench.mac:not(.fullscreen) .backboard-workspace-header { padding-left: 320px; }`, with a smaller fallback inside the narrow-width media query.
- The right panel collapse/expand behavior touches the header because the collapsed-panel expand button lives in `.backboard-workspace-header-right`.
- The `New` button is part of the page header, not the right-panel header.

## Right Panel

### TypeScript Ownership

The right panel is built in `BackboardWorkspacePage.create()` after the sash:

- `.backboard-workspace-detail`
  - `.backboard-workspace-detail-header`
    - `h2.backboard-workspace-detail-title`
    - `button.backboard-workspace-detail-toggle`
  - `.backboard-workspace-detail-chat`
    - real `ChatWidget` render target

The chat widget is created by `createChatWidget(detailElement)`.

Important options passed to `ChatWidget`:

- `location: ChatAgentLocation.Chat`
- `renderFollowups: true`
- `renderInputToolbarBelowInput: false`
- `supportsFileReferences: true`
- `enableWorkingSet: 'explicit'`
- `supportsChangingModes: true`
- `dndContainer: detailElement`

That means the right panel is no longer a custom fake chat panel. It is a scoped, real Backboard/Copilot-style chat widget.

### Right Panel Behavior

The main panel behavior is split across these methods:

- `openNewAgentSession()`
  - clears the selected session resource;
  - rerenders cards;
  - calls `loadSession(undefined)` to create/load a new chat model.
- `openExistingSession(session)`
  - records the selected session resource;
  - rerenders cards so selection updates;
  - loads the matching chat session into the right panel.
- `loadSession(session)`
  - cancels any prior load;
  - acquires or creates a chat model;
  - updates the widget model;
  - marks sessions read;
  - updates the detail header;
  - opens the detail panel if needed.
- `updateWorkspaceDetailState()`
  - decides whether the right panel is visible;
  - toggles `.no-detail` on `.backboard-workspace-page`;
  - toggles `.hidden` / `.collapsed` on `.backboard-workspace-detail`;
  - toggles the chat container;
  - clears the widget model when there is no visible detail.
- `toggleDetailCollapsed()`
  - flips `detailCollapsed`.
- `syncToggleIcon()`
  - changes the collapse/expand icon and accessibility labels.
- `applyDetailWidth()`
  - writes `--detail-width` to the page and relayouts the chat widget.
- `layoutChatWidget()`
  - reads the chat container dimensions and calls `chatWidget.layout(height, width)`.

The sash drag handler in `create()` updates `detailWidth` and calls `applyDetailWidth()`. That is the only intentional layout measurement loop for this panel.

### Right Panel CSS Ownership

Right panel styling lives in these CSS sections:

- `.backboard-workspace-detail`
  - flex column;
  - full-height panel;
  - left border;
  - card/background color.
- `.backboard-workspace-detail.hidden`
  - removes the panel from layout when collapsed/closed.
- `.backboard-workspace-detail-header`
  - 36px compact header;
  - title and collapse button alignment.
- `.backboard-workspace-detail-title`
  - ellipsis and muted title text.
- `.backboard-workspace-detail-toggle`
  - close/collapse icon button inside the right panel header.
- `.backboard-workspace-detail-expand`
  - page-header icon button used to reopen the right panel.
- `.backboard-workspace-detail-chat`
  - flex child that hosts the chat widget.

There are scoped overrides for the chat widget inside `.backboard-workspace-detail-chat`:

- `.interactive-session`
  - forces the chat session to full height.
- `.interactive-list`
  - controls message list padding.
- `.interactive-input-part`
  - controls composer padding.
- `.chat-input-container`
  - makes the composer match the workspace card surface.
- `.chat-input-toolbars`
  - pins toolbar height and prevents the model selector/actions from wrapping.
- `.chat-input-toolbar`, `.monaco-action-bar`, `.actions-container`
  - prevent duplicated/wrapped toolbar rows.
- `.chat-secondary-toolbar:empty`
  - removes empty secondary toolbar space.

These scoped chat overrides are where model-selector, composer, and toolbar overlap problems usually belong. If there are two model selector buttons or the toolbar appears twice, inspect the widget option `renderInputToolbarBelowInput` and the `.chat-input-toolbars` / `.actions-container` CSS before changing unrelated panel layout.

### Right Panel Gotchas

- The right panel close/collapse button should live in `.backboard-workspace-detail-header`, not on the same visual row as the page-level `New` button.
- The `New` button is a page-header action that opens a new agent session. It should not be treated as the right-panel close/new-chat button.
- When there is no visible detail panel, `updateWorkspaceDetailState()` clears the chat widget model. This avoids keeping the panel visually closed while a stale model is still shown.
- The right panel uses real chat session models. If placeholder or Figma-only panel states are needed later, they should not break `ChatWidget` session loading.
- At widths below 800px, the CSS hides the right panel and sash entirely.

## Where To Change Things Safely

### Change Tile Content

Use `backboardWorkspacePage.ts`:

- placeholder card content: `basePlaceholderAgents` and `WORKSPACE_VIEW_STATES`;
- placeholder card DOM: `renderPlaceholderAgentCard()`;
- real card DOM: `renderSessionCard()`;
- real status text/tone: `getSessionStatusInfo()`;
- real file chips: `getChangedFileLabels()`;
- real activity rows: `renderActivityRows()`.

Use `backboardWorkspace.css`:

- grid sizing: `.backboard-workspace-cards`;
- card shell: `.backboard-workspace-card`;
- header/actions: `.backboard-workspace-card-header` and related classes;
- Figma-specific polish: the `/* === Figma workspace pass === */` section.

### Change Header Layout

Use `backboardWorkspacePage.ts`:

- header DOM is in `create()`;
- dropdown menu is in `showWorkspaceSwitcherMenu()`;
- selected dropdown label is in `updateWorkspaceSwitcherLabel()`.

Use `backboardWorkspace.css`:

- `.backboard-workspace-header`;
- `.backboard-workspace-header-left`;
- `.backboard-workspace-header-right`;
- `.backboard-workspace-switcher`;
- `.monaco-workspace-switcher-menu`;
- macOS padding rules.

### Change Right Panel Layout

Use `backboardWorkspacePage.ts`:

- panel DOM is in `create()`;
- chat widget setup is in `createChatWidget()`;
- panel opening/loading is in `openNewAgentSession()`, `openExistingSession()`, and `loadSession()`;
- panel visibility is in `updateWorkspaceDetailState()`;
- panel resizing is in the sash handler plus `applyDetailWidth()`.

Use `backboardWorkspace.css`:

- `.backboard-workspace-page` for panel column width;
- `.backboard-workspace-sash` for drag divider styling;
- `.backboard-workspace-detail` and `.backboard-workspace-detail-header` for panel shell/header;
- `.backboard-workspace-detail-chat` and descendant chat selectors for composer/chat-widget fixes.

## Current Design Boundary

The Advanced / Workspace page currently has one custom page header and one real chat right panel. The old segmented page switch should not be reintroduced unless the product direction changes. The old custom right-panel mock should also stay out; the right panel is now meant to be backed by `ChatWidget` so model selection, context chips, session history, and composer behavior stay consistent with the rest of Backboard.
