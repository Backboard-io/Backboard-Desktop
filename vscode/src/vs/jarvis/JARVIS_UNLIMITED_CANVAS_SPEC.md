# Jarvis Unlimited Canvas — Visual and Implementation Specification

Status: implementation-ready design specification  
Reference set: six screenshots supplied on 2026-07-27  
Target: Backboard Studio Jarvis window

## 1. Product thesis

Jarvis should feel like a living desktop for agents, not like another VS Code layout.

The wallpaper is the room. Agent chats, terminals, browser previews, and files are movable pieces of glass furniture inside that room. A user can zoom out to see the whole operation, zoom in to work inside one card, or ask the global command bar to create and arrange the workspace for them.

The reference experience is defined by five ideas:

1. A borderless, effectively unlimited two-dimensional canvas.
2. Full-bleed scenic backgrounds with strong personality.
3. Large translucent work cards that borrow color from the scene behind them.
4. Minimal screen-fixed controls: a command capsule, two edge rails, and a presence pill.
5. Live tools on the canvas: agents, terminals, browsers, files, notes, and task views.

This is not a dashboard and it is not a grid-first board. Grid layouts are useful presets, but the persistent model is freeform world-space geometry.

## 2. What is visible in the screenshots

### Screenshot 1 — mixed work surface

Dimensions: 1199 × 721.

- Windows XP's green hill wallpaper fills the entire window.
- Two agent chat cards sit in the middle-left and overlap slightly.
- A tall embedded browser is the foreground object on the right.
- The browser has custom chrome: platform toggle, back, forward, reload, URL field, and utility actions.
- A compact command capsule is fixed near the top center.
- Thin vertical launch rails float close to the left and right edges.
- Cards use dark, blue-green glass; the wallpaper remains clearly visible through them.
- Large colorful collaborator cursors make the space feel shared and playful.

The important lesson is the overlap. Cards are not forced into editor groups or columns.

### Screenshot 2 — the system at normal laptop scale

Dimensions: 675 × 1200 portrait photograph; the visible app is a landscape laptop display.

- A Mount Fuji and lake wallpaper covers the Jarvis window.
- Two simple glass cards are arranged with substantial empty space around them.
- The top command capsule, side rails, and small bottom-right presence control remain in screen space.
- The visual hierarchy is wallpaper first, work cards second, controls third.
- Even with only two cards, the screen does not feel empty because the room itself has personality.

The important lesson is restraint. Jarvis should not generate placeholder panels merely to fill space.

### Screenshot 3 — zoomed-out operations room

Dimensions: 4096 × 2671.

- The camera is zoomed out far enough to reveal many agent cards at once.
- Cards have different widths and heights and may be partially outside the viewport.
- A note card floats independently near the top.
- An embedded browser runs a game preview in the lower-right region.
- A dark task drawer is docked over the right side of the room.
- The task drawer groups work by named agent and shows per-agent progress and state.
- A smaller “Rooms” drawer is visible underneath the browser.
- The right edge rail remains independent from the task drawer.
- The top command capsule can show a secondary status/result row.
- Cards expose real chat content, tool calls, code change summaries, timers, and composers.

The important lesson is semantic zoom. At overview scale, status, title, progress, and card silhouettes must remain legible even when transcript text is too small to read.

### Screenshot 4 — focused agent

Dimensions: 3680 × 2188.

- A pixel-art city wallpaper is darkened slightly for contrast.
- One large agent card is centered and dominates the scene.
- The card is a full interactive chat, not a summary tile.
- The user message appears as a rounded bubble aligned right.
- Tool progress streams vertically below the response.
- The composer is anchored inside the bottom of the card.
- A model/provider label appears in both the global command bar and the card composer.
- The left rail contains creation and view controls.
- The right rail contains resource and utility controls.
- A “2 online” presence pill sits in the lower-right corner.

The important lesson is focus mode. A card can become the primary work surface without leaving the canvas.

### Screenshot 5 — empty agent state

Dimensions: 3470 × 2056.

- Earth from orbit is the background.
- One large empty agent card is centered.
- The body shows a quiet “Send a message to start” prompt.
- The composer remains fully available at the bottom.
- The large card is more transparent than an opaque editor, but darker than the surrounding room.
- The left and right rails are symmetrical in mass, not necessarily in action count.

The important lesson is that creating an agent immediately creates a usable chat card. There is no intermediate setup page.

### Screenshot 6 — arranged team plus browser

Dimensions: 1200 × 723.

- Six agent cards use a 3 × 2 arrangement on the left two-thirds of the room.
- A tall browser preview occupies the right third.
- Cards remain individually framed and interactive.
- The left rail exposes overview, back, file/resource, layout, focus, and background actions.
- The right rail exposes browser, code, resources, tasks, arrangement, and canvas-fit actions.
- One card can be a fresh “Getting Started” chat while others are active sessions.

The important lesson is that “Arrange as grid” is a command, not a permanent layout constraint.

## 3. The exact visual language

### 3.1 Signature element

The signature is **living glass over a cinematic room**.

The glass should visibly inherit blue, green, orange, or violet from the current background. A neutral gray glass system would lose the defining quality of the references. Each background preset therefore carries a glass tint and contrast profile in addition to the media asset.

The deliberate aesthetic risk is using nostalgic, saturated, even slightly kitschy scenic backgrounds inside a serious developer tool. The surrounding chrome must stay disciplined so the room feels charming rather than noisy.

### 3.2 Color tokens

These are base tokens. A background preset may tint them but must preserve their luminance relationships.

| Token | Value | Purpose |
|---|---:|---|
| `--jarvis-ink` | `#F4F7FB` | Primary text and icons |
| `--jarvis-ink-muted` | `rgba(244, 247, 251, 0.64)` | Secondary labels and inactive controls |
| `--jarvis-glass-base` | `rgba(13, 19, 27, 0.46)` | Card and command-bar base |
| `--jarvis-glass-strong` | `rgba(8, 12, 18, 0.72)` | Task drawer and high-contrast surfaces |
| `--jarvis-glass-edge` | `rgba(255, 255, 255, 0.18)` | One-pixel glass edge |
| `--jarvis-accent` | `#79A9FF` | Focus, selection, and active-provider accent |
| `--jarvis-success` | `#39D98A` | Running/connected state |
| `--jarvis-warning` | `#FFC857` | Attention state |
| `--jarvis-danger` | `#FF6B7A` | Error/destructive state |

Glass recipe:

```css
background:
	linear-gradient(145deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.025) 34%, rgba(0, 0, 0, 0.08)),
	color-mix(in srgb, var(--jarvis-glass-tint) 18%, var(--jarvis-glass-base));
border: 1px solid var(--jarvis-glass-edge);
box-shadow:
	0 20px 55px rgba(0, 0, 0, 0.22),
	inset 0 1px 0 rgba(255, 255, 255, 0.08);
backdrop-filter: blur(24px) saturate(145%) brightness(0.92);
```

Use one glass layer per surface. Do not nest three translucent boxes around the same content.

### 3.3 Background treatment

Every preset needs:

```ts
interface IJarvisBackgroundPreset {
	readonly id: string;
	readonly label: string;
	readonly kind: 'image' | 'video';
	readonly source: string;
	readonly focalPoint: { readonly x: number; readonly y: number };
	readonly glassTint: string;
	readonly scrim: number;
	readonly vignette: number;
}
```

Rendering order:

1. Background image or muted looping video.
2. A very slow camera-linked parallax transform, capped at 24 px.
3. A preset-specific dark scrim.
4. A subtle radial vignette at the outer 12% of the viewport.
5. Canvas cards.
6. Screen-fixed controls.

The background remains viewport-filling. It does not tile across world space. Panning the canvas introduces only slow parallax, which preserves the illusion of a large room without creating seams.

Initial preset families:

- Fuji lake and spring flowers.
- Earth from orbit.
- Pixel-art rainy city.
- Windows-XP-like green hill.
- Bright clouds and floating landscape.
- User-selected local image or video.

Do not ship third-party artwork without a license. Exact visual parity requires the original assets or licensed/generated equivalents with the same composition and focal points.

### 3.4 Typography

The screenshots use quiet operating-system typography, not a branded display face. Exactness matters more than novelty here.

- Interface and chat: `-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif`.
- Code and terminal: `var(--vscode-editor-font-family, "SFMono-Regular", Menlo, Monaco, Consolas, monospace)`.
- Card title: 13 px, 600 weight, `-0.01em`.
- Body/chat: 13–14 px, 400–500 weight, 1.48 line-height.
- Utility/status: 11–12 px, 500–600 weight.
- Global command model label: 14 px, 650 weight.

Avoid all-uppercase labels except tiny protocol/status abbreviations.

### 3.5 Geometry

| Element | Geometry |
|---|---|
| Window safe edge | 20 px desktop, 12 px compact |
| Card corner radius | 16 px |
| Card header | 38 px |
| Card internal padding | 16 px |
| Command capsule | 52 px primary row; optional 34 px result row |
| Command capsule radius | 26 px primary; 24 px combined shell |
| Side rail width | 48 px |
| Side rail radius | 22 px |
| Rail icon target | 38 × 38 px |
| Presence pill height | 42 px |
| Default agent card | 470 × 620 world units at a 1200 × 800 viewport |
| Compact agent card | 220–310 × 235–320 world units, computed from viewport |
| Default terminal card | 720 × 430 world units |
| Default browser card | 760 × 720 world units |
| Default file card | 760 × 620 world units |
| Minimum card size | 320 × 240 world units |

At a 1200 px-wide viewport, use 12–16 px gaps in arranged mode. At wide desktop sizes, use 20–24 px.

### 3.6 Structure

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                     [ global command capsule ]                            │
│                                                                           │
│ [left rail]        ┌──────── agent card ────────┐       ┌── browser ───┐ │
│ [overview]         │                             │       │ chrome       │ │
│ [new agent]        │ transcript / tool stream    │       │              │ │
│ [terminal]         │                             │       │ live page    │ │
│ [resources]        │ composer                    │       │              │ │
│ [focus]            └─────────────────────────────┘       └──────────────┘ │
│ [background]                                                            │
│                                                      [right rail]         │
│                                                      [browser]            │
│                                                      [file]               │
│                                                      [tasks]              │
│                                                      [Backboard]          │
│                                              [presence: 2 online]          │
└───────────────────────────────────────────────────────────────────────────┘
```

All cards live in world space. The command capsule, rails, drawers, presence pill, window controls, toasts, and context menus live in screen space.

## 4. Canvas behavior

### 4.1 Camera

Use the existing `IJarvisCamera` convention:

```text
screen = (world - camera) × zoom
world = screen / zoom + camera
```

Recommended limits:

- Minimum zoom: `0.32`.
- Maximum zoom: `1.80`.
- Default zoom: `0.86`.
- Trackpad pinch/wheel step: continuous.
- Keyboard step: `0.10`.
- Zoom anchor: pointer position; viewport center when invoked from the keyboard.

The canvas is practically unlimited. Geometry should use ordinary finite numbers, but no visible world bounds.

### 4.2 Pan

- Drag empty canvas with primary pointer to pan.
- Hold Space and drag anywhere to pan.
- Trackpad two-finger scrolling pans.
- Middle-mouse drag pans.
- Do not begin a pan from interactive card content.
- Apply a small inertial tail for trackpad pan only.
- Escape cancels an active pointer operation.

### 4.3 Card movement and resizing

- Drag from the 38 px header.
- Bring the card to front on pointer-down or keyboard focus.
- Resize from all edges and corners; keep the visible lower-right handle from the current `JarvisCard`.
- Hold Shift to preserve aspect ratio for browser/video cards.
- Hold Option/Alt to resize around center.
- Hold Command/Ctrl to disable alignment guides.
- Show 1 px alignment guides when edges or centers are within 8 screen pixels.
- Never snap card positions to a permanent grid.

### 4.4 Selection and focus

- Single click focuses and raises a card.
- Shift-click creates a multi-selection.
- Dragging empty space creates a marquee selection after a 4 px movement threshold.
- Press Delete/Backspace to close selected cards, with confirmation only for a running terminal or unsaved file.
- Double-click a header or press `Cmd/Ctrl+Enter` to focus a card.
- Focus mode centers the card at zoom `1.0`, dims other cards to 18%, and leaves the fixed controls accessible.
- Escape exits focus mode and restores the prior camera exactly.

### 4.5 Semantic zoom

Use three rendering bands:

| Zoom | Behavior |
|---:|---|
| `< 0.48` | Overview: hide transcript details and composers; show title, provider, state, progress, changed files, and last activity |
| `0.48–0.74` | Compact: render transcript summaries and terminal/browser snapshots; disable tiny inline controls |
| `> 0.74` | Full: render live interactive content |

This is essential for the Screenshot 3 scale. Do not merely shrink a fully interactive DOM tree to illegibility.

Browser `WebContentsView`s must be hidden below the full-interaction threshold and replaced with their last captured screenshot. This also prevents expensive native-view relayout while rapidly zooming.

### 4.6 Arrange commands

Provide commands, not permanent modes:

- Arrange as grid.
- Arrange by type.
- Arrange active agents.
- Stack selected cards.
- Tidy visible cards.
- Fit all cards.
- Fit selection.
- Reset view.

The 3 × 2 team layout in Screenshot 6 is the expected output of “Arrange as grid.”

## 5. Screen-fixed chrome

### 5.1 Global command capsule

Position:

```css
position: fixed;
top: max(16px, env(titlebar-area-height, 16px));
left: 50%;
width: clamp(560px, 42vw, 1400px);
transform: translateX(-50%);
z-index: var(--jarvis-z-command);
```

Content from left to right:

1. Active orchestrator/model icon and label.
2. Separator.
3. Natural-language input.
4. Goal/context button.
5. Options button.
6. Microphone.
7. Send/stop.

Placeholder:

> Command Jarvis — launch agents, open terminals, preview localhost, or arrange the room…

When a command runs, a secondary row may appear below the input with a concise result such as “Opened two Backboard agents and arranged the active room.” It collapses after six seconds unless pinned.

The command bar dispatches structured commands. It must not directly manipulate card DOM.

### 5.2 Left rail

Recommended exact action order:

1. Overview / Fit All.
2. New Agent.
3. New Terminal.
4. Add Resource.
5. Arrange.
6. Focus Selection.
7. Backgrounds.

“Add Resource” opens a compact picker containing Browser, File, Folder, Note, and Task View.

### 5.3 Right rail

Recommended exact action order:

1. New Browser.
2. Open File.
3. Open Folder/Workspace.
4. Tasks Drawer.
5. Backboard.
6. Divider.
7. Sync/Share Room.

The two rails intentionally overlap in capability: the left rail is spatial/creation-oriented, while the right rail is resource/product-oriented.

### 5.4 Window controls

On macOS, retain native traffic lights in the top-left. A small split-view/window-mode button sits to their right. Do not draw a full title bar.

### 5.5 Presence

Bottom-right pill:

- Up to three overlapping avatars.
- Label such as “2 online.”
- Click opens a participant popover.
- Remote collaborator cursors use saturated, user-specific colors with white outlines.
- Presence is optional in the first implementation but the layout must reserve the safe corner.

## 6. Card types

### 6.1 Agent card

The agent card is a Jarvis-native chat surface backed by the Sessions services.
It must not visually embed the standard Sessions/new-chat view: the screenshots
use a much quieter card hierarchy, denser transcript, and permanently docked
glass composer. A detached compatibility `SessionView` may remain available to
workbench extension points such as attachments and workspace selection, but it
does not render visible UI.

Header:

- Provider icon.
- Session title.
- Small provider badge when the title does not identify the runtime.
- Running/idle/needs-input indicator.
- Information button.
- More menu.
- Close.

Body:

- A compact transcript projected from the underlying chat model.
- User messages aligned right.
- Agent responses aligned left.
- Change summaries and task progress use Jarvis-native compact rows.
- Scroll position is card-specific and preserved.

Composer:

- Model picker.
- Permission/mode picker.
- Add context.
- Image/file attachment.
- Microphone.
- Send/stop.

Creation flow:

1. User chooses New Agent.
2. Backboard remains the first-class native action; the BYOS picker shows every available non-Backboard agent-host session type.
3. User optionally chooses workspace, model, and isolation.
4. Jarvis immediately creates an empty card at the viewport center.
5. The first prompt graduates the draft through the existing sessions provider.

“BYOS” is a presentation category, not a hard-coded provider ID. Build it from `ISessionsProvidersService.getProviders()` and `ISessionsManagementService.getSessionTypesForFolder(...)`, then filter to agent-host session types and exclude Backboard itself. This keeps Claude, Codex, and future external agent hosts dynamic without leaking generic Cloud or Local session modes into the picker.

Backboard should map to `AgentSessionProviders.AgentHostBackboard` / the appropriate registered sessions provider rather than a separate Jarvis-only backend.

### 6.2 Terminal card

Use the workbench terminal service rather than the legacy Jarvis raw-PTY bridge.

Header:

- Terminal icon and title.
- Workspace/cwd label.
- Shell/profile menu.
- Split, restart, and close actions under the overflow menu.

Body:

- Real xterm surface.
- Transparent terminal background.
- Terminal ANSI colors preserved.
- Card resize calls the terminal instance layout path.

Create through `ITerminalService.createTerminal(...)`, attach the returned `ITerminalInstance` with `attachToElement(...)`, and use a hidden/persistent workbench terminal location appropriate for canvas ownership. This retains shell integration, profiles, links, accessibility, persistent processes, and existing lifecycle behavior.

Do not create a second terminal implementation in Jarvis.

### 6.3 Browser card

Use the existing integrated-browser infrastructure.

Chrome:

- Optional scope/platform switch.
- Back, forward, reload.
- URL field.
- Share-with-agent indicator.
- Device emulation.
- DevTools and overflow actions.

Body:

- `WebContentsView` managed by `BrowserViewModel`.
- True localhost and authenticated browsing.
- 14 px inner corner radius below the toolbar.

Important native-view rule:

The browser is not part of the transformed DOM plane. On every settled camera/card layout, convert the card content rectangle into screen coordinates and call `IBrowserViewModel.layout(...)`. During active pan/zoom, either throttle to one layout per animation frame or show the latest screenshot placeholder. Call `setVisible(false)` when a card is offscreen, minimized, below semantic-zoom threshold, occluded by a modal drawer, or closed.

Use `IBrowserViewWorkbenchService.getOrCreateLazy(...)` and resolve the resulting `BrowserEditorInput` model. Reuse navigation, storage scopes, screenshots, emulation, console logs, Playwright sharing, and certificate handling.

Do not use an iframe or enable Electron's `<webview>` tag.

### 6.4 File card

The file card is an embedded code editor bound to a real text-file model.

Header:

- File icon and basename.
- Relative path.
- Dirty indicator.
- Language mode.
- “Open in Editor” action.
- Close.

Body:

- `CodeEditorWidget` created through the scoped instantiation service.
- Model resolved through `ITextFileService.files.resolve(uri)` or `ITextModelService.createModelReference(uri)`.
- Normal language features, decorations, and save behavior.
- Read-only fallback for binary/unsupported resources.

`Cmd/Ctrl+S` saves the card's model. “Open in Editor” must call `IEditorService.openEditor(...)`; never bypass the editor service with a direct active-group open.

For the first release, support text files only. Add diff, notebook, and image cards after the core interaction is stable.

### 6.5 Note card

Notes are lightweight markdown/text cards persisted with the room. They do not create workspace files unless the user explicitly exports them.

### 6.6 Tasks drawer

The task drawer from Screenshot 3 is screen-fixed, not a canvas card.

- Width: `min(420px, calc(100vw - 32px))`.
- Right inset: 18 px.
- Top/bottom inset: 18 px.
- Strong glass surface.
- Overall progress bar.
- Suggested and unassigned task sections.
- One collapsible section per agent.
- Status, completed count, current work, and idle state.

It may be implemented after the four required card types, but the rail action and z-index layer should be reserved from the beginning.

## 7. State and persistence

Persist room state through `IStorageService`, not `localStorage`.

```ts
type JarvisCardKind = 'agent' | 'terminal' | 'browser' | 'file' | 'note';

interface ISerializedJarvisCard {
	readonly id: string;
	readonly kind: JarvisCardKind;
	readonly geometry: IJarvisRect;
	readonly zIndex: number;
	readonly minimized?: boolean;
	readonly resource?: string;
	readonly metadata?: Record<string, string | number | boolean>;
}

interface ISerializedJarvisRoom {
	readonly version: 1;
	readonly camera: IJarvisCamera;
	readonly backgroundId: string;
	readonly customBackground?: string;
	readonly cards: readonly ISerializedJarvisCard[];
}
```

Storage rules:

- Room geometry and card references: `StorageScope.WORKSPACE`, `StorageTarget.MACHINE`.
- Background preference: `StorageScope.PROFILE`, `StorageTarget.USER`.
- Per-workspace last camera: workspace scope.
- Do not serialize transcripts, terminal output, browser page data, or file contents into the Jarvis layout record.
- Persist after a 250 ms debounce and immediately on shutdown.
- Version the schema and fail soft: unknown card kinds are skipped, not fatal.

Resource identifiers:

- Agent: session resource URI plus active chat resource URI.
- Terminal: persistent terminal resource when available; otherwise create a fresh shell and mark it as restored.
- Browser: browser view ID and initial/current URL.
- File: file URI.
- Note: note ID, with content in a separate storage key.

## 8. Architecture for this repository

### 8.1 Existing infrastructure to keep

| Existing file/service | Use |
|---|---|
| `src/vs/jarvis/jarvis.desktop.main.ts` | Keep the full Sessions workbench imports. This is the correct runtime foundation. |
| `src/vs/jarvis/jarvis.common.main.ts` | Register Jarvis-specific parts and contribution once the missing files exist. |
| `src/vs/jarvis/common/jarvisCanvasTypes.ts` | Extend the current camera/point/rect definitions. |
| `src/vs/jarvis/browser/parts/jarvisCard.ts` | Keep as the abstract geometry/focus/close base; add interaction hooks without putting type-specific logic here. |
| `src/vs/jarvis/browser/jarvisPaneCompositePartService.ts` | Keep for Jarvis-specific pane-composite ownership. |
| `src/vs/sessions/browser/parts/sessionView.ts` | Keep only as an off-screen compatibility target for workbench actions; Jarvis renders its own visible chat UI. |
| `IChatService` / `IChatModel` | Feed Jarvis-native transcript, activity, request state, and send/stop controls. |
| `src/vs/optimus/browser/parts/optimusCard.ts` | Reuse its model acquisition, status observation, diff summary, and transcript-loading patterns. |
| `ISessionsManagementService` and `ISessionsProvidersService` | Create Backboard and BYOS agents through registered providers. |
| `ITerminalService` / `ITerminalInstance` | Create and render terminal cards. |
| `IBrowserViewWorkbenchService` / `IBrowserViewModel` | Create and position browser cards. |
| `ITextFileService`, `ITextModelService`, `CodeEditorWidget` | Resolve and render file cards. |
| `IEditorService` | Open a file card's resource in the conventional editor surface when requested. |
| `IStorageService` | Persist room layout and preferences. |

### 8.2 Legacy path to retire

`src/vs/jarvis/browser/jarvisApp.ts`, `src/vs/jarvis/browser/media/jarvis.css`, `src/vs/jarvis/common/jarvisTypes.ts`, and `src/vs/jarvis/electron-browser/jarvisBridge.ts` describe the old standalone single-terminal-panel implementation.

They should not be the base of the canvas. The current `jarvis.desktop.main.ts` already boots the full Sessions workbench, so new Jarvis work belongs in workbench parts and services.

Keep only the voice/text interpretation pieces temporarily if they are still needed. Move their public surface into a Jarvis command service, then delete the terminal-specific IPC after all terminal cards use `ITerminalService`.

### 8.3 New files

```text
src/vs/jarvis/
├── browser/
│   ├── jarvisBackgroundService.ts
│   ├── jarvisCommandService.ts
│   ├── jarvisLayoutStore.ts
│   └── parts/
│       ├── jarvisCanvasPart.ts
│       ├── jarvisSessionsParts.ts
│       ├── jarvisAgentCard.ts
│       ├── jarvisTerminalCard.ts
│       ├── jarvisBrowserCard.ts
│       ├── jarvisFileCard.ts
│       ├── jarvisNoteCard.ts
│       ├── jarvisCommandBar.ts
│       ├── jarvisSideRail.ts
│       └── media/
│           └── jarvisCanvas.css
├── common/
│   ├── jarvisCanvasTypes.ts
│   └── jarvisCommands.ts
└── contrib/
    └── jarvis.contribution.ts
```

### 8.4 Responsibilities

#### `JarvisCanvasPart`

- Extends `Part` and registers as `Parts.SESSIONS_PART`.
- Owns the background, camera, world plane, overlay plane, command bar, rails, and task drawer host.
- Owns the card map and z-order.
- Performs screen/world coordinate conversion.
- Performs drag, resize, pan, zoom, selection, hit testing, semantic zoom, and browser native-view layout.
- Restores and persists the room.
- Exposes commands such as `addCard`, `removeCard`, `focusCard`, `fitAll`, and `arrange`.

#### `JarvisSessionsParts`

- Implements `ISessionsPartService`, following `OptimusSessionsParts`.
- Translates Sessions-visible items into `JarvisAgentCard`s.
- Preserves card identity by session resource, not by grid index.
- Brings the active session card to front.
- Returns an off-screen compatibility `SessionView` from `getSessionView(...)`; visible agent pixels remain Jarvis-native.
- Does not force a 3 × 2 limit.

#### `JarvisCard`

- Remains type-agnostic.
- Owns frame DOM, geometry, z-index, title, focus, close request, resize anchors, selected state, and semantic-zoom state.
- Adds events for pointer-operation start and content-bound changes.
- Does not persist itself or call global services.

#### Concrete cards

- Own only the embedded tool and its lifecycle.
- Implement `layoutContent(width, height)`.
- Expose a serializable resource reference.
- Set visibility appropriately when offscreen or zoomed out.

#### `JarvisCommandService`

- Registers a typed command registry.
- Converts natural-language or voice results into commands.
- Runs commands against `JarvisCanvasPart` and existing workbench services.
- Emits concise activity summaries for the command capsule.

Example commands:

```text
jarvis.newAgent
jarvis.newTerminal
jarvis.newBrowser
jarvis.openFile
jarvis.setBackground
jarvis.arrangeGrid
jarvis.fitAll
jarvis.focusCard
jarvis.closeCard
jarvis.toggleTasks
```

### 8.5 Workbench layout changes

Add `SessionsLayoutPolicy.getJarvisPartVisibilityDefaults()`:

```ts
return {
	sidebar: false,
	auxiliaryBar: false,
	panel: false,
	sessions: true,
	editor: false
};
```

When `isJarvisWindow` is true:

- Use the Jarvis defaults on first render.
- The sessions part fills the entire workbench client area.
- Do not reveal the standard sidebar/auxiliary bar when a canvas resource opens.
- “Open in Editor” may intentionally reveal the editor part or switch to Editor mode, but ordinary card creation must not.
- Hide standard title, activity, status, and panel chrome unless explicitly requested.

The existing comments in `SessionsWorkbench` already identify Jarvis as an infinite-canvas surface, but the separate Jarvis visibility policy still needs to be completed.

## 9. Command interpretation

The global command bar should support direct syntax first and model interpretation second.

Examples:

- “Open a terminal in the API folder.”
- “Create two Backboard agents and one Codex agent.”
- “Open localhost 3000 in a browser.”
- “Open `src/vs/jarvis/browser/parts/jarvisCard.ts`.”
- “Arrange the active agents in a grid.”
- “Focus the browser.”
- “Change the background to Earth.”
- “Close every completed agent.”

Tool schema:

```text
create_agent(provider?, sessionType?, workspace?, model?, prompt?, count?)
create_terminal(cwd?, profile?, command?, count?)
create_browser(url?, shareWithAgent?)
open_file(uri?)
set_background(id?)
arrange_cards(mode, cardIds?)
focus_card(cardId?)
close_card(cardId?)
fit_canvas(target?)
toggle_tasks()
```

Every tool call routes through a registered command or service method. The LLM never emits raw DOM coordinates. Spatial instructions such as “put the browser to the right of Mars” are resolved by a deterministic layout helper.

## 10. Motion

Use one coherent motion language:

- Card create: 180 ms opacity plus scale from `0.96` with a 10 px upward drift.
- Card focus: 140 ms edge/shadow transition.
- Focus mode: 240 ms camera interpolation with `cubic-bezier(0.2, 0, 0, 1)`.
- Arrange: 320 ms spring-like interpolation; cards move without cross-fading.
- Command result row: 160 ms expand/collapse.
- Background change: 500 ms cross-fade.
- Rail tooltips: 300 ms hover delay, 100 ms fade.

Respect reduced motion:

- Remove scale, parallax, inertia, and spring behavior.
- Use short opacity changes.
- Camera jumps to its final location.

## 11. Accessibility and input

- All cards are keyboard-focusable groups with descriptive labels.
- `Cmd/Ctrl+K, Cmd/Ctrl+J` focuses the global command bar.
- `Cmd/Ctrl+Shift+A/T/B/O` creates Agent/Terminal/Browser/Open File.
- Arrow keys move a selected card by 8 world units; Shift+Arrow moves by 32.
- `Cmd/Ctrl+0` resets view.
- `Cmd/Ctrl+1` focuses the selected card.
- Rail actions use `IHoverService` for accessible descriptions.
- Keep all visible text at a minimum 4.5:1 contrast after preset scrims.
- High-contrast mode removes backdrop blur, uses opaque theme backgrounds, and shows 2 px borders.
- Browser native views must relinquish focus with a discoverable keyboard chord.
- Screen readers receive card type, title, status, and position order; decorative wallpaper is hidden.

## 12. Performance rules

- One `requestAnimationFrame` camera/layout pass, even if several pointer events arrive.
- Use a single transformed world plane for normal DOM cards.
- Do not separately mutate `left/top` for every card during pan; only update the plane transform.
- Browser cards are the exception because their `WebContentsView` bounds are native.
- Virtualize cards outside the viewport plus a 400 px screen-space margin.
- Suspend heavy chat list layout below semantic zoom `0.48`.
- Use browser screenshots while panning/zooming quickly.
- Cap simultaneously live full chat cards at a configurable threshold; inactive overview cards retain reactive status but not a fully laid-out transcript.
- Decode only the active background video. Pause background video when the window is hidden.
- Use `ResizeObserver` per live card content, but dispose it immediately with the card.
- Register every event, model reference, terminal instance, browser view, and observer in the owning disposable store.

## 13. Implementation sequence

### Phase 0 — finish the runtime pivot

1. Keep `jarvis.desktop.main.ts` on the full Sessions workbench path.
2. Add `jarvisSessionsParts.ts` and `jarvis.contribution.ts`.
3. Uncomment their imports in `jarvis.common.main.ts`.
4. Add `getJarvisPartVisibilityDefaults()` and make the canvas the only default center part.
5. Verify Jarvis opens without the standard workbench chrome.

Exit condition: Jarvis boots into an empty full-window canvas part.

### Phase 1 — canvas and clean glass shell

1. Implement camera transforms, pan, zoom, selection, z-order, drag, and resize.
2. Implement layout persistence.
3. Implement backgrounds, command capsule, rails, presence placeholder, and glass tokens.
4. Implement note cards as the lowest-risk concrete card.
5. Add Fit All, Reset View, Focus Selection, and Arrange Grid.

Exit condition: note cards can be freely created, moved, resized, zoomed, focused, restored, and arranged over every background preset.

### Phase 2 — Backboard and BYOS agents

1. Implement `JarvisSessionsParts`.
2. Implement a Jarvis-native agent transcript and composer backed by `IChatService`.
3. Present Backboard as the native agent and expand BYOS into each registered non-Backboard session type.
4. Support multiple draft cards with `keepPreviousDraft`.
5. Add overview semantic-zoom rendering.

Exit condition: native Backboard plus registered BYOS providers such as Claude, Codex, and future remote agent hosts can run concurrently in separate cards.

### Phase 3 — terminal, browser, and file cards

1. Terminal card through `ITerminalService`.
2. Browser card through `IBrowserViewWorkbenchService`.
3. Native browser-view layout and screenshot fallback.
4. File picker and `CodeEditorWidget` file card.
5. Dirty-file and running-terminal close protection.

Exit condition: all four requested work surfaces are live and survive ordinary canvas operations.

### Phase 4 — command and voice orchestration

1. Register deterministic Jarvis commands.
2. Expand the natural-language tool schema.
3. Move reusable voice/text interpretation out of the legacy app.
4. Add relative spatial placement and multi-create.
5. Surface command results in the secondary capsule row.

Exit condition: every common mouse action has a voice/text equivalent.

### Phase 5 — exact-reference polish

1. Task drawer.
2. Collaborator cursors and presence.
3. More background presets and custom media.
4. Browser/card overlap polish.
5. Background-aware glass tint profiles.
6. Wide-screen and compact-laptop tuning.

Exit condition: Screenshot 1, 3, 4, 5, and 6 compositions can be recreated from saved fixture rooms with no manual CSS changes.

## 14. Validation plan

### Functional

- Create, move, resize, focus, close, and restore every card kind.
- Run multiple agents from different providers simultaneously.
- Run a persistent terminal, resize it repeatedly, and restore the room.
- Load local and external URLs, then pan/zoom without native browser-view drift.
- Edit and save a file, including external-file-change handling.
- Switch backgrounds and restart the window.
- Run every global command by keyboard, typed natural language, and voice where supported.

### Visual fixture rooms

Create deterministic fixture layouts mirroring the references:

1. Two agents plus tall browser on XP-like hill.
2. Two agents on Fuji lake.
3. Many agents, note, browser, and task drawer on Fuji.
4. One focused running agent on pixel city.
5. One empty centered agent on Earth.
6. Six-agent grid plus tall browser on Fuji.

Capture at:

- 1200 × 723.
- 1440 × 900.
- 1728 × 1117.
- 2560 × 1440.
- 3680 × 2188.

Compare:

- Fixed-control position.
- Card geometry.
- Blur/tint/contrast.
- Background focal point.
- Semantic-zoom behavior.
- Native browser bounds.
- Focus rings and keyboard state.

### Required repository validation

1. Run `npm run typecheck-client` before any test.
2. Fix every compilation error before running tests.
3. Add unit tests for coordinate conversion, zoom anchoring, arrange layout, persistence migration, and command parsing.
4. Add browser tests for pointer drag/resize and semantic zoom.
5. Add lifecycle tests proving closed cards dispose models, terminals, browser views, observers, and listeners.
6. Run `npm run valid-layers-check` for the new Jarvis imports.

## 15. Acceptance criteria

The implementation is complete when:

- Jarvis opens as a full-bleed scenic room with no visible standard VS Code workbench chrome.
- The user can pan and zoom an effectively unlimited canvas.
- Agent, terminal, browser, and text-file cards can be created from rails, keyboard commands, and the global command bar.
- Backboard and all registered BYOS providers are available without hard-coded duplication.
- Cards freely overlap, resize, focus, and arrange.
- Browser native views remain exactly aligned with their cards.
- The room restores camera, background, geometry, z-order, and resource references after restart.
- Overview scale remains useful rather than becoming tiny unreadable live DOM.
- Glass surfaces stay readable over every shipped background.
- The five supplied reference compositions can be reproduced as fixture rooms.
- The result feels like an inhabited visual workspace, not a themed editor grid.

## 16. Non-goals for the first release

- Connecting cards with node-graph edges.
- Arbitrary rotation.
- A multiplayer server if presence infrastructure is not already available.
- Canvas-hosted notebooks, image editors, diff editors, or settings editors.
- A separate Jarvis terminal, browser, file, or agent backend.
- Perfect persistence of non-persistent shell processes across a crash.
- Recreating or redistributing unlicensed wallpaper artwork.

The cleanest path is to make Jarvis a spatial host for services Backboard already owns. The canvas supplies geometry, atmosphere, and orchestration; terminals remain terminals, browser views remain browser views, files remain text models, and agents remain Sessions providers.
