# Jarvis Page Design Choices

## Product Direction

Jarvis is a standalone voice-controlled terminal canvas. It is not a workbench page, not Optimus, and not the editor chat surface. Its main job is to let the user open and control up to four named Backboard/Codex terminal sessions with voice or typed natural language.

The page should feel like a retro control surface: clean, flat, readable, low-chrome, and direct. The strongest visual signal should be the background scene and the terminal canvas, not nested panels.

## Visual Principles

- Fewer containers are better. Avoid wrapping controls in multiple glass boxes or nested cards.
- Rounded corners should be minimal. Current direction uses `0px` or `2px` corners instead of large pills.
- Use thin, visible borders instead of heavy shadows.
- Prefer hard pixel-like shadows only where depth is useful, such as active terminal cards or the microphone button.
- Use monospace for controls, labels, hints, and terminal-related UI to make the page feel more retro and operational.
- Keep backgrounds immersive, but darken them enough that controls and terminals remain readable.

## Layout

- The page is a full-screen canvas over a video or image background.
- The top controls are intentionally flat and unboxed: mode switch, workspace selector, background selector, page label, and status.
- The side rail is a functional quick launcher for named terminals, not decoration.
- The bottom command bar is the primary voice/text command surface.
- The terminal area is a scrollable canvas, not a fixed workbench grid.

## Canvas Behavior

- Terminal cards sit on a horizontally scrollable canvas.
- Users can scroll left/right and up/down.
- Dragging empty canvas space pans the canvas.
- Shift + mouse wheel scrolls horizontally.
- The canvas should not move when interacting with terminal content, inputs, buttons, or cards.

## Terminal Cards

- Terminal cards are resizable.
- Resizing a card resizes the xterm viewport.
- The renderer forwards terminal size changes to the backing PTY so Backboard/Codex sees the new terminal dimensions.
- Cards preserve manual size across Jarvis re-renders.
- Cards should look like flat retro terminal windows: thin borders, square corners, dark transparent fill, minimal header.

## Empty State

- When no terminals are open, the page should not feel empty or like just wallpaper.
- The empty state provides direct launch buttons for Erin, Seif, Youseph, and Nir.
- Example prompts are included as small hints, not as a large tutorial panel.

## Voice And Command Surface

- The visible command surface has no Run button.
- Typed commands submit with Enter.
- The microphone button is the dominant action.
- Voice goes through Backboard voice handling and then Backboard tool-call interpretation.
- The UI should make voice feel primary without making typed input feel hidden.

## Backgrounds

- Jarvis supports built-in backgrounds and custom local image/video backgrounds.
- Built-ins currently include Sky Island, Cloud Drift, and Studio Glow.
- Custom selections are loaded through Electron IPC and converted to a browser-loadable `vscode-file` URI.
- The selected background is persisted in `localStorage`.

## Current Implementation References

- Page logic: `src/vs/jarvis/browser/jarvisApp.ts`
- Page styling: `src/vs/jarvis/browser/media/jarvis.css`
- Renderer bridge: `src/vs/jarvis/electron-browser/jarvisBridge.ts`
- Shared types: `src/vs/jarvis/common/jarvisTypes.ts`
- Main-process IPC and PTY handling: `src/vs/code/electron-main/app.ts`
- Bundled backgrounds: `src/vs/jarvis/browser/media/`

## Design Anti-Goals

- Do not make Jarvis look like VS Code workbench.
- Do not add large rounded glass panels around every section.
- Do not add decorative controls that do nothing.
- Do not make a marketing/landing page.
- Do not hide the terminal canvas behind explanatory copy.
- Do not use a busy one-note palette; the background carries the mood and the UI stays restrained.

## Acceptance Notes

- The page should read as retro, clean, and operational at first glance.
- A user should understand that they can open named terminal sessions immediately.
- The canvas should feel movable and spatial.
- Terminal cards should feel like working terminals, not preview cards.
- Background changing should be visible but not visually dominant.
