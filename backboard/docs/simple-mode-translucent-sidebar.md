# The Simple-mode translucent left panel — full rendering map

How the see-through sidebar actually works, every layer from the macOS desktop
to a session row's hover fill, every place the pipeline can (and did) break,
and every mitigation that exists today. Written while chasing the
ghosting/flicker artifacts (stale pixels of modals, previous pages, and
scrolled-away list rows smearing over the glass).

Fix status is tracked in [§7](#7-failure-catalogue--what-you-actually-see) and
[§8](#8-mitigation-inventory). **The two root-cause fixes are in the main
process — they do nothing until the app is fully quit and relaunched.**

---

## 1. The one-sentence version

The sidebar is NOT blurred in-app: the *window itself* has a macOS native
vibrancy material behind it, the web page paints **fully transparent** pixels
where the sidebar is, and a 52%-alpha tint on top — so "see-through" is the OS
compositor showing the desktop through a hole in the page. Every artifact in
this bug family is stale pixels surviving inside that hole.

---

## 2. Physical layer stack (bottom → top)

```
                     what you see on screen
  ┌────────────────────────────────────────────────────────────┐
  │  ⑥ Chromium renderer output (delegated compositing:        │
  │     the page's paint, delivered to macOS as a tree of      │
  │     CALayers; has REAL alpha — transparent in the sidebar  │
  │     region, opaque everywhere else)                        │
  ├────────────────────────────────────────────────────────────┤
  │  ⑤ BrowserWindow native background  #01000000              │
  │     (alpha 1/255 — see §6, THE load-bearing value)         │
  ├────────────────────────────────────────────────────────────┤
  │  ④ NSVisualEffectView, material = 'sidebar'                │
  │     visualEffectState = 'active'                           │
  │     (this is what blurs/diffuses the desktop — there is    │
  │     NO CSS backdrop-filter anywhere in this pipeline)      │
  ├────────────────────────────────────────────────────────────┤
  │  ③ NSWindow (frameless, rounded corners)                   │
  ├────────────────────────────────────────────────────────────┤
  │  ② macOS window compositor (WindowServer)                  │
  ├────────────────────────────────────────────────────────────┤
  │  ① Desktop wallpaper / windows behind                      │
  └────────────────────────────────────────────────────────────┘
```

Layers ④ and ⑤ are set up in the **main process**:

| Thing | Where | Value |
| --- | --- | --- |
| Vibrancy material | `src/vs/platform/windows/electron-main/windowImpl.ts` (`AGENTS_WINDOW_VIBRANCY`) | `'sidebar'` |
| Applied at creation | `windowImpl.ts` ctor → `defaultBrowserWindowOptions(..., { vibrancy })` | Simple (`isSessionsWindow`) **and** Advanced (`isOptimusWindow`), macOS only |
| Native background | `src/vs/platform/windows/electron-main/windows.ts` → `VIBRANCY_CLEAR_BACKGROUND` | `#01000000` |
| `visualEffectState` | `windows.ts`, vibrancy override block | `'active'` (material stays lit when window unfocused) |

> **Advanced (Optimus) note:** the *window* gets the vibrancy material too, but
> the *page* never paints alpha there (see §4), so the material is invisible
> and the artifact family cannot show. Jarvis windows get no vibrancy at all.

---

## 3. Window geometry — where the alpha actually is

```
   Simple window (top-down view of what the page paints)
  ┌─────────────┬──────────────────────────────────────────────┐
  │ TRANSLUCENT │                OPAQUE                        │
  │             │                                              │
  │ .part.      │  .part.sessionspart  (chat transcript,       │
  │  sidebar    │   composer, headers…)                        │
  │             │                                              │
  │ 52% tint    │  --sessions-main-region-background           │
  │ over        │  (fully opaque — artifacts CANNOT show here) │
  │ alpha 0     │                                              │
  │             │                                              │
  │ ← ghosts    │                                              │
  │   live here │                                              │
  ├─────────────┴──────────────────────────────────────────────┤
  │  (titlebar row is part of the same translucent band)       │
  └────────────────────────────────────────────────────────────┘
```

Only the left band has alpha. Every ghost/flicker report — modal remnants,
previous-page Explorer after a mode switch, doubled session rows while
scrolling — is confined to this band. That is a *diagnostic tool*: if you see
an artifact over the chat area, it is a different bug.

---

## 4. The CSS side — who paints what

All in `src/vs/sessions/browser/media/style.css` ("Sidebar & Auxiliary Bar
Card Appearance" section) unless noted.

```
  DOM / paint tree                       background
  ─────────────────────────────────────  ─────────────────────────────
  .monaco-workbench
   .agent-sessions-workbench
   .shell-gradient-background
   .mac:not(.optimus-window)             transparent          ◄── the hole
   :not(.jarvis-window)…                 (base rule paints
      │                                   --sessions-main-region-background;
      │                                   the .mac Simple rule overrides
      │                                   it to `transparent`)
      ├── ::before                       gradient wash, opacity 0.03
      │                                  (faint colour for the glass to
      │                                   diffuse; z-index 0, isolated)
      │
      ├── > .monaco-grid-view            transparent
      │      │
      │      ├── .part.sidebar           color-mix(sideBar.background 52%,
      │      │      │                    transparent)   ◄── the tint
      │      │      │                    · dark:  52%
      │      │      │                    · light: 32% of a foreground-mixed
      │      │      │                      colour (vibrancy renders lighter
      │      │      │                      in light appearance)
      │      │      │
      │      │      └── sessions list    rows: transparent
      │      │          (monaco-list)    hover/selection: list-hover fills
      │      │                           (translucent theme colours)
      │      │
      │      └── .part.sessionspart      OPAQUE main region
      │           └── chat widget        OPAQUE (t3Theme pins pure black
      │                                  in dark themes)
      │
      └── overlays (context menus,       own opaque surfaces, but they
          dialogs, modal editor part)    DRAW OVER the translucent band
                                         and then disappear  ◄── trigger
```

Key deliberate decisions encoded here:

- **No `backdrop-filter`.** Removed per user request (twice — see the comment
  block; do not re-add). All diffusion comes from the native material ④.
- **Escape hatches to opaque:** `prefers-reduced-transparency`, `hc-black`,
  `hc-light`, non-mac, web — all collapse the sidebar to an opaque
  `sideBar.background`.
- **Advanced/Jarvis are excluded by CSS**, with this exact justification in
  the source comment: *"the Advanced (Optimus) and Jarvis windows scroll dense
  content beside the panel, and **painting alpha over the native vibrancy
  there smears while scrolling**"*. The authors had already met the
  scroll-smear failure mode and chose opacity for those windows. The Simple
  window keeps alpha because the see-through sidebar is its signature look —
  which is why it is the only place the artifact family can appear.

---

## 5. What lives in the band — the scrolling part

The left panel content (New chat, Projects, workspace rows, the chats list,
profile footer) is a **`monaco-list`** (`agentSessionsControl` /
agent-sessions viewer, `src/vs/workbench/contrib/chat/browser/agentSessions/`).

Two properties matter for flicker:

1. **It is its own compositor layer.** `listView.ts` applies
   `transformOptimization`: the rows container gets
   `transform: translate3d(0,0,0)` + `contain: strict`. Scrolling is
   *synthetic* (no native scroller): every wheel tick repositions/recycles row
   DOM inside that layer and produces a fresh frame of damage.

2. **Its pixels have alpha all the way down.** Rows are transparent over the
   52% tint over the transparent root. So the damage stream from scrolling is
   composited against the native material *every frame*.

```
  scroll event
      │
      ▼
  Scrollable (rAF-scheduled; 125ms animated if smoothScrolling)
      │
      ▼
  ListView renders/recycles rows  ──►  damage rects in the rows layer
      │
      ▼
  cc (Chromium compositor) partial swap: present ONLY damaged regions
      │
      ▼                                   ┌─────────────────────────────┐
  CALayer updates over the vibrancy  ──►  │ if backing alpha == 0:      │
  material (delegated compositing)        │ Chromium SKIPS clearing     │
                                          │ damaged regions → last      │
                                          │ frame's rows stay visible   │
                                          │ under the new ones = SMEAR  │
                                          └─────────────────────────────┘
```

Note: `workbench.list.smoothScrolling` now defaults to **on** in agents
windows (`agentsWindow: { default: true }` in `listService.ts`, added for the
chat transcript glide). Animated scrolling produces *more* in-flight frames,
which makes any smear easier to catch — it does not cause it. Toggling it off
is a useful A/B while testing: `"workbench.list.smoothScrolling": false`.

---

## 6. THE load-bearing value: `#01000000` vs `#00000000`

This is the root cause of the whole artifact family.

- Vibrancy needs the native window background to be transparent.
- But at **alpha 0** (`#00000000`), Chromium on macOS **skips clearing damaged
  regions**. Anything that painted into a region and went away stays there:
  closed modals, dismissed menus, the previous document after an in-window
  navigation, and scrolled-away list rows.
- At **alpha 1/255** (`#01000000`) the behaviour flips: damaged regions are
  properly cleared every frame. Visually indistinguishable from alpha 0.

The value is now the exported constant
`VIBRANCY_CLEAR_BACKGROUND` in `windows.ts`, used everywhere.

### The downgrade cycle (the bug as it shipped, pre-fix)

```
   window created                       ┌──────────────────────────┐
   #01000000  ✔ healthy                 │  HEALTHY                 │
        │                               │  clears happen,          │
        │  'ready-to-show' fires        │  no ghosts possible      │
        │  (moments after launch!)      └──────────────────────────┘
        ▼
   reapplyVibrancy()  ← also on: enter/leave full-screen,
        │               maximize/unmaximize, colour-scheme change
        │
        │  wrote setBackgroundColor('#00000000')   ← THE BUG
        ▼
   ┌──────────────────────────┐
   │  BUGGY (alpha 0)         │   every window entered this state
   │  damage never cleared:   │   seconds after opening, and every
   │  · modal close → ghost   │   later re-assert kept it there
   │  · menu close  → ghost   │
   │  · mode switch → ghost   │
   │  · list scroll → SMEAR   │   ◄── the "scrolling through chats"
   └──────────────────────────┘       flicker
```

`reapplyVibrancy` — the function whose whole job is *fixing* vibrancy glitches
— was re-introducing the Chromium bug on every call. Both alpha-0 writes
(`reapplyVibrancy` and the window-reuse load path) now use
`VIBRANCY_CLEAR_BACKGROUND`.

### The second root cause: window reuse across modes

Editor→Simple (and Simple→Editor) **reuses the same BrowserWindow** and
navigates it in place (`forceReuseWindow` → `CodeWindow.load()` → `loadURL`).
The compositor holds the previous document's frame across the navigation and
does not reliably clear it over a transparent backing → the old Explorer
ghosts through the new translucent sidebar. Pre-fix, the load path:

- only ran its vibrancy handling when the vibrancy state *changed* — a
  vibrancy→vibrancy switch (Advanced→Simple) did nothing at all;
- never called `webContents.invalidate()` to replace the held frame.

Now (`windowImpl.ts` `load()`): the backing is made **opaque for the duration
of the navigation** (old frame can never blend through mid-load), and on
`did-finish-load` the correct state is re-asserted **plus a full
`invalidate()`** replaces the held frame.

---

## 7. Failure catalogue — what you actually see

| Symptom | Trigger | Mechanism | Status |
| --- | --- | --- | --- |
| Old Explorer/editor UI blended into Simple sidebar | Mode switch (window reuse navigation) | Held previous-document frame + alpha backing | **Fixed** (load-path: opaque interstitial + invalidate) — needs relaunch |
| Modal remnants over the sidebar | Modal/dialog/menu teardown | Damage-skip at alpha 0 | **Fixed** (alpha 1/255 everywhere) — needs relaunch |
| Doubled/smeared chat rows while scrolling the list | Scrolling the sessions list | Continuous damage stream at alpha 0 | **Fixed by the same alpha change** — needs relaunch. If it *still* reproduces after a full quit+relaunch, escalate: see §9 |
| Sidebar reads flat/opaque (no see-through) | macOS drops the material (full-screen, appearance change, first paint) | Material detached from NSWindow | Mitigated: `reapplyVibrancy` on those events |
| Opaque flash of theme colour over the glass | Parts-splash save repainting the native background | `saveWindowSplash` → `updateBackgroundColor` | Guarded: `hasVibrancy` check in `nativeHostMainService.saveWindowSplash` (fails closed) |

**Verification order matters:** every fix above lives in the **main process**.
A running instance from before the fix keeps the old code no matter how many
times the window reloads. Fully quit Backboard Studio, relaunch, then re-test:
1. scroll the chats list hard (with and without `smoothScrolling`),
2. open/close a modal over the sidebar,
3. switch Editor→Simple→Editor a few times.

---

## 8. Mitigation inventory

Everything that defends the pipeline today, in firing order:

| Event | Handler | Where |
| --- | --- | --- |
| Window creation | `vibrancy: 'sidebar'`, `visualEffectState: 'active'`, bg `VIBRANCY_CLEAR_BACKGROUND` | `windows.ts` `defaultBrowserWindowOptions` |
| `ready-to-show` | `reapplyVibrancy` (bg + material + `invalidate()`) | `windowImpl.ts` |
| Enter/leave full-screen | `reapplyVibrancy` | `windowImpl.ts` |
| Maximize/unmaximize | `reapplyVibrancy` | `windowImpl.ts` |
| OS colour-scheme change | `reapplyVibrancy` | `windowImpl.ts` |
| Window focus | `invalidateVibrancyRepaint` (full repaint, wipes accumulated ghosts) | `windowImpl.ts` |
| Window reuse / mode-switch load | opaque interstitial → on `did-finish-load`: re-assert + `invalidate()` | `windowImpl.ts` `load()` |
| Parts-splash save | skip native bg write when `hasVibrancy` (fail closed on missing window) | `nativeHostMainService.ts` |
| Reduced transparency | fully opaque sidebar + root | `style.css` media query |
| High contrast / non-mac / web | opaque (never enters the alpha path) | `style.css` root markers |
| Advanced/Jarvis | page paints opaque everywhere (CSS `:not()` markers) — material present but invisible | `style.css` |

Known *unguarded* moments (all tolerable **iff** the backing is alpha 1/255,
because clears then happen naturally): modal/menu teardown while the window
stays focused, display/resolution changes, sleep/wake. If artifacts return,
these are the first suspects — the fix pattern is another
`invalidateVibrancyRepaint(reason)` hook, not more CSS.

---

## 9. If scroll-smear survives the relaunch — escalation ladder

Ordered from least to most invasive; stop at the first one that holds:

1. **A/B the animation:** `"workbench.list.smoothScrolling": false` — fewer
   in-flight frames; confirms the smear is scroll-rate-sensitive.
2. **Invalidate on scroll idle:** debounce a `invalidateVibrancyRepaint`
   call when the sessions list stops scrolling (renderer → native host).
   Wipes any residue within one frame of letting go.
3. **Opaque-while-scrolling:** add a root class during active list scroll
   that temporarily pins `--sessions-sidebar-region-background` to the opaque
   sideBar colour (the Advanced-window strategy, applied only for the scroll's
   duration). The material pops back when the scroll settles.
4. **The Advanced strategy wholesale:** accept an opaque Simple sidebar
   (that is what `prefers-reduced-transparency` already ships). Last resort —
   it deletes the signature look.

---

## 10. File index

| File | Role |
| --- | --- |
| `src/vs/platform/windows/electron-main/windows.ts` | `VIBRANCY_CLEAR_BACKGROUND` constant + creation-time vibrancy options |
| `src/vs/platform/windows/electron-main/windowImpl.ts` | `AGENTS_WINDOW_VIBRANCY`, `reapplyVibrancy`, `invalidateVibrancyRepaint`, reuse/load handling |
| `src/vs/platform/native/electron-main/nativeHostMainService.ts` | splash-save `hasVibrancy` guard |
| `src/vs/sessions/browser/media/style.css` | all sidebar translucency CSS, tint values, opt-outs, Advanced/Jarvis exclusion |
| `src/vs/sessions/browser/workbench.ts` | root marker classes (`agent-sessions-workbench`, `optimus-window`, `jarvis-window`, `shell-gradient-background`) |
| `src/vs/workbench/contrib/chat/browser/agentSessions/` | the sessions list that scrolls inside the band |
| `src/vs/base/browser/ui/list/listView.ts` | `transformOptimization` layer + synthetic scrolling |
| `src/vs/platform/list/browser/listService.ts` | `workbench.list.smoothScrolling` (agents-window default: on) |
