# Simple-Mode Sidebar Glass — Tuning Guide

Every layer that produces the left panel's see-through look, why it can read
"white-washed", and every knob you can turn. All paths are relative to
`ide/vscode/`.

## The compositing stack (bottom → top)

```
┌─────────────────────────────────────────────────────────────┐
│ 5. Sidebar CONTENT (rows, text, icons)                      │  sessionsViewPane.css / sessionsList.css
│ 4. Sidebar part TINT + backdrop-filter                      │  style.css  ← the alpha knob
│ 3. Workbench root (transparent on mac)                      │  style.css
│ 2. Electron window backing  #00000000                       │  windowImpl.ts / windows.ts
│ 1. macOS NSVisualEffectView material ('sidebar' vibrancy)   │  ← THE dominant term
│ 0. Whatever is behind the window (desktop / other windows)  │
└─────────────────────────────────────────────────────────────┘
```

The final pixel is roughly:

```
pixel = tint.alpha × tint.rgb + (1 − tint.alpha) × material
```

The **material** (layer 1) is not a fixed colour — macOS renders it in **light
or dark appearance**, and that choice dominates everything above it.

## Why it was white-washed

Your Mac runs in **light appearance**. Electron's `nativeTheme.themeSource`
was `'system'` (upstream default `window.systemColorTheme: 'default'`), so the
vibrancy material rendered its **light** variant — a near-white frosted sheet —
behind a *dark* app theme. Numerically:

```
light material ≈ #D8D8D8;  tint = 42% of #050505 (obsidian sideBar.background)
pixel ≈ 0.42 × #050505 + 0.58 × #D8D8D8 ≈ #808080   ← the milky grey you saw
dark  material ≈ #2A2A2A →  pixel ≈ #1B1B1B          ← proper dark glass
```

**Fixed** by defaulting `window.systemColorTheme` to `'auto'` (native
appearance follows the app theme):

- main-process default: [themeMainServiceImpl.ts#L52](../platform/theme/electron-main/themeMainServiceImpl.ts) (`SYSTEM_COLOR_THEME`, line 52)
- settings-schema default: [themes.contribution.ts#L31](../workbench/services/themes/electron-browser/themes.contribution.ts) (line 31)

> Takes effect on app restart (with a rebuilt `out/`). On an **already
> running** build you can flip it live: add `"window.systemColorTheme": "auto"`
> (or `"dark"`) to settings.json — the main process reacts to the setting
> change immediately, no restart.

## The knobs

| # | Knob | Where | Current |
|---|------|-------|---------|
| 1 | Native material | [windowImpl.ts#L73](../platform/windows/electron-main/windowImpl.ts) `AGENTS_WINDOW_VIBRANCY` | `'sidebar'` |
| 2 | Material appearance | [themeMainServiceImpl.ts#L52](../platform/theme/electron-main/themeMainServiceImpl.ts) via `window.systemColorTheme` | `'auto'` |
| 3 | Dark-mode tint alpha (mac) | [style.css#L145](browser/media/style.css) | 42% of `sideBar.background` |
| 4 | Light-theme tint (mac) | [style.css#L154](browser/media/style.css) | 32% mix |
| 5 | Backdrop filter (dark / light) | [style.css#L26](browser/media/style.css) / [#L41](browser/media/style.css), mac-light [#L155](browser/media/style.css) | `blur(30px) saturate(1.1) brightness(0.92)` |
| 6 | Maximized/fullscreen blue | [style.css#L176](browser/media/style.css) + [theme.ts#L57](common/theme.ts) `agentsSidebar.maximizedBackground` | `charts.blue` @ 30% (dark) / 22% (light) |
| 7 | Theme base colour | `extensions/theme-defaults/themes/backboard-obsidian.json` → `sideBar.background` | `#050505` |
| 8 | Inner pane transparency | [sessionsViewPane.css#L26](contrib/sessions/browser/media/sessionsViewPane.css) + [#L40](contrib/sessions/browser/media/sessionsViewPane.css) | `transparent` — **must stay transparent** |

### 1. Native material — `AGENTS_WINDOW_VIBRANCY`

One constant, used at window creation, in `reapplyVibrancy()`, and in the
mode-switch path in `load()`. Values worth trying (Electron `vibrancy`):

- `'sidebar'` — current. Finder/Notes side-panel glass; strongest desktop show-through.
- `'menu'` — previous value; much more contained/opaque in dark appearance (this is what made the old panel look static even when healthy).
- `'under-window'` / `'window'` — softer, brighter blends.
- `'hud'` — darkest translucent material.

Main-process code → **full app restart** required (watch/`npm run watch`
rebuilds `out/`, then relaunch).

### 2. Material appearance — `window.systemColorTheme`

The whitewash switch. `'auto'` = follow app theme (default now), `'default'` =
follow the OS, `'dark'`/`'light'` = force. Live-reactive setting.

### 3–4. Tint alpha — the "how see-through" knob

[style.css#L145](browser/media/style.css):

```css
--sessions-sidebar-region-background: color-mix(in srgb,
    var(--vscode-sideBar-background, var(--vscode-editor-background)) 42%, transparent);
```

- ↓ 20–30%: very glassy, text contrast depends on what's behind the window.
- ↑ 60–75%: rich solid-feeling panel, desktop barely visible (75% was the old
  "static black" look).

### 5. Backdrop filter

`blur()` smooths what leaks through **from inside the page** (the shell
gradient), *not* the native material (macOS blurs that itself).
`brightness()` < 1 darkens, `saturate()` > 1 adds colour depth. Cheap place to
fight glare on bright desktops without raising alpha: try
`brightness(0.8) saturate(1.2)`.

### 6. Maximized / fullscreen blue

When the workbench root has `.maximized` or `.fullscreen`, the tint var swaps
to the themable colour `agentsSidebar.maximizedBackground`
([theme.ts#L57](common/theme.ts)). Override per-theme in
`backboard-obsidian.json`, e.g.:

```jsonc
"colors": { "agentsSidebar.maximizedBackground": "#57A3F84D" } // any #RRGGBBAA
```

Keep alpha ≤ ~0x66 (40%) or the glass dies.

### 7. Theme base colour

The tint is derived from `sideBar.background`. Obsidian's `#050505` is the
darkest possible base; a slightly lifted base (`#101214`) reads less dead at
the same alpha.

### 8. Inner pane — the old bug, do not regress

`.agent-sessions-viewpane` and `.agent-sessions-container` painted **opaque**
`sideBar.background` over the whole panel (landed 2026-06-24). Any opaque
`background` on a full-bleed element inside `.part.sidebar` kills the entire
stack — the part supplies the only tint; hc / reduced-transparency / mobile
fallbacks are handled at the part level in style.css.

## Live playground (no rebuild)

Open DevTools in the Simple window (**Help → Toggle Developer Tools** or
`Cmd+Option+I`) and paste:

```js
const wb = document.querySelector('.monaco-workbench');

// Tint alpha — try 0.15 … 0.75 (theme base #050505 shown here)
wb.style.setProperty('--sessions-sidebar-region-background',
  'color-mix(in srgb, #050505 25%, transparent)');

// Any colour glass, e.g. warm smoke or blue
wb.style.setProperty('--sessions-sidebar-region-background', 'rgba(30, 20, 10, 0.35)');
wb.style.setProperty('--sessions-sidebar-region-background', 'rgba(87, 163, 248, 0.30)');

// Blur / brightness / saturation
wb.style.setProperty('--sessions-sidebar-backdrop-filter', 'blur(40px) saturate(1.3) brightness(0.8)');

// Preview the maximized blue without maximizing
wb.classList.add('maximized');   // and .remove(...) to undo

// Reset everything
['--sessions-sidebar-region-background', '--sessions-sidebar-backdrop-filter']
  .forEach(p => wb.style.removeProperty(p));
```

What you **cannot** change live from DevTools: the native material (#1) and
its appearance (#2) — those live in the main process. #2 is still live-tunable
via settings.json as described above.

## Iteration workflow for real edits

1. CSS edits (`style.css`, `sessionsViewPane.css`): with `npm run watch`
   running they land in `out/`; otherwise `cp` the file to the mirrored
   `out/vs/...` path. Then **Developer: Reload Window** in the Simple window.
2. TS edits in `src/vs/platform/**` (material, appearance default): rebuild +
   **full app restart** — the main process is not reloaded by window reload.
3. Sanity-check the stack from DevTools:
   ```js
   ['.monaco-workbench', '.part.sidebar', '.agent-sessions-viewpane', '.agent-sessions-container']
     .map(s => [s, getComputedStyle(document.querySelector(s)).backgroundColor])
   ```
   Expect: root transparent, sidebar = your tint, both inner layers transparent.
   Any opaque value inside the sidebar = the whitewash/static bug is back.

## Fallbacks that intentionally go opaque

- macOS **Reduce transparency** (System Settings → Accessibility → Display) →
  `@media (prefers-reduced-transparency: reduce)` paints the panel solid.
- High-contrast themes (`hc-black` / `hc-light`).
- The mobile overlay sidebar (`.mobile-overlay-sidebar`).
