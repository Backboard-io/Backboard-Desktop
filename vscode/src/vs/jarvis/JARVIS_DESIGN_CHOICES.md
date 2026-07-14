# Jarvis Page Design Choices

## Product Direction

Jarvis is a standalone voice-controlled terminal launcher. It is not a workbench page, not Optimus, and not the editor chat surface. Its main job is to let the user open and control up to four named Backboard/Codex terminal sessions with voice or typed natural language.

The page should feel like a retro control surface: clean, flat, readable, low-chrome, and direct. The strongest visual signal should be the background scene and the terminal panel, not nested panels.

## Visual Principles

- Fewer containers are better. Avoid wrapping controls in multiple glass boxes.
- Rounded corners should be minimal. Current direction uses `0px` or `2px` corners instead of large pills.
- Use thin, visible borders instead of heavy shadows.
- Prefer hard pixel-like shadows only where depth is useful, such as the active terminal panel or the microphone button.
- Use monospace for controls, labels, hints, and terminal-related UI to make the page feel more retro and operational.
- Keep backgrounds immersive, but darken them enough that controls and terminals remain readable.

## Layout

- The page is a full-screen scene over a video or image background.
- The top controls are intentionally flat and unboxed: mode switch, workspace selector, background selector, page label, and status.
- The side rail is a functional quick launcher for named terminals, not decoration.
- The bottom command bar is the primary voice/text command surface.
- The terminal area is a single fixed panel: a tab bar above it switches between open terminals, one visible at a time.

## Terminal Tabs And Panel

- Each open terminal (Erin, Seif, Youseph, Nir) gets a tab in the tab bar; only the active tab's terminal is shown in the panel below.
- Switching tabs re-parents the existing xterm instance into the panel rather than recreating it, so scrollback and running state are preserved for background terminals.
- Closing a terminal removes its tab; if it was the active tab, the view falls back to another open tab or the empty state.
- The panel resizes with the window; the renderer forwards terminal size changes to the backing PTY so Backboard/Codex sees the new terminal dimensions.
- The panel should look like a flat retro terminal window: thin borders, square corners, dark transparent fill, minimal header.

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
- Do not hide the terminal panel behind explanatory copy.
- Do not use a busy one-note palette; the background carries the mood and the UI stays restrained.

## Acceptance Notes

- The page should read as retro, clean, and operational at first glance.
- A user should understand that they can open named terminal sessions immediately.
- Switching between open terminals should feel instant, like switching browser tabs.
- The terminal panel should feel like a working terminal, not a preview card.
- Background changing should be visible but not visually dominant.
