# Backboard Studio Cua Driver integration

This directory vendors the open-source
[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) so the
desktop-automation binary Backboard Studio ships can be built and audited from
the same repository.

## Upstream snapshot

- Repository: `https://github.com/trycua/cua`
- Path: `libs/cua-driver` (the rest of the monorepo — Lume, Fleets, Bench, the
  Python agent SDK — is not used and is not vendored)
- Commit: `bdaf8c2570e35254f5e50a317781374efe7aa91a`
- Driver version: `0.28.2`
- Snapshot date: `2026-09-18`
- License: MIT (see `LICENSE.md`, copied from the monorepo root)

## Studio integration patches

The tree is a `git archive` of the upstream path with the integration changes below. Added files include
this record, `LICENSE.md`, and the two small browser input scripts listed below. The layout is kept intact
because the Rust workspace reads fixtures from sibling directories
(`compat-fixtures/`, `tests/`, `wayland-helper/`) at compile time.

1. `rust/crates/platform-macos/src/browser/platform.rs`,
   `has_trusted_codesign_identity`: `--strict` is removed from the
   `codesign --verify` call that attests a system Chrome/Edge before an isolated
   launch. Strict mode rejects a genuinely signed browser whose bundle carries
   empty `com.apple.FinderInfo` extended attributes, which migration and copy
   tools leave behind; on the maintainer's machine 69 folders inside
   `Google Chrome.app` had them, and `browser_prepare` refused with
   `browser_route_unavailable`. The designated requirement (Apple anchor,
   vendor team id, bundle identifier) and the follow-up identity comparison are
   unchanged. The two `--strict` checks in `cua-driver/src/history_runtime.rs`
   guard the driver's own helper and are not touched. Marked in the source with
   `BACKBOARD PATCH`; reapply it after every snapshot update, or drop it if
   upstream relaxes the check.

2. `rust/crates/cua-driver-core/src/browser/semantic.rs`: retain DOM labels
   (`title`, tooltips, IDs, and explicitly marked CSS class fallbacks) for icon
   controls whose accessibility name is empty; expose visible canvases as pointer
   targets; do not mark checkbox/radio/button/color/range inputs as text fields.
   Use DOMSnapshot's `nodes.isClickable` evidence to retain controls with
   JavaScript-installed click handlers and no inline onclick/role/tabindex (such
   as JS Paint's tool buttons). Read its sparse indexes in DOM order, not layout
   order; static panels and disabled controls gain no click action.
3. `browser/tools.rs` and `browser/semantic_click.js`: the explicit `dom_event`
   click route sends pointer/mouse down and up before click. Editors such as
   Pixlr listen to `mousedown`. Recheck target visibility, disabled state, and
   occlusion, and report JavaScript exceptions rather than claiming dispatch.
   Clicks track the synthetic hover target; moving to another control or canvas
   sends leave events so tooltips do not remain over the drawing.
4. `browser/pointer.rs` and `browser/canvas_stroke.js`: optional bounded `path`
   or whole-plan `strokes` for `browser_pointer` drag. It requires an exact live
   canvas ref, `dom_event`, 2–256 normalized points per stroke, and no destination.
   A complete drawing is limited to 48 strokes and 4096 points. The driver fits
   the whole plan uniformly into the canvas center with margins, checking every
   stroke and intervening segment for obstruction before any brush-down input.
   This avoids workspace margins and floating editor controls. The drawing sends continuous pointer/mouse movement and
   restores temporary synthetic pointer-capture support on completion or error.
   It never executes model-generated JavaScript or writes canvas pixels directly.

The remaining integration lives outside this directory:

- `cli-ts/src/core/computer/CuaDriverSurface.ts` talks to the driver over a
  persistent `cua-driver mcp --direct --embedded` stdio connection.
  `--embedded` attributes macOS Accessibility to Backboard Studio, so users
  see no second permission prompt.
- `cli-ts/src/core/computer/JevUseLoop.ts` is the decide-act-observe loop. It
  follows the shape of upstream's `examples/jev-use` recipe but reaches
  TypeSafe Jev through Backboard (`system_one` on `/threads/messages`) instead
  of the TypeSafe SDK, so no separate TypeSafe key is needed.
- `scripts/build-cua-driver.sh` builds the binary into
  `extensions/backboard/bin/`, which is gitignored like the cli-ts binary.

## Telemetry

The driver sends product telemetry to its authors by default. Backboard turns
it off everywhere it runs the driver (`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`,
`CUA_TELEMETRY_ENABLED=false`). Re-check those variable names when updating
the snapshot: if upstream renames them, telemetry silently comes back on.

## Updating the snapshot

1. From a checkout of the desired upstream commit, replace this directory with
   `git archive <commit> libs/cua-driver` (tracked files only — never copy
   `rust/target/`), then restore this file and `LICENSE.md`.
2. Reapply the documented integration patches and update the commit, version,
   and date above.
3. Run `scripts/build-cua-driver.sh`. Upstream pins a Rust toolchain in
   `rust/rust-toolchain.toml`; 0.28.2 also builds with stable 1.95.
4. Run `cua-driver describe get_window_state`, `click`, `type_text`,
   `launch_app`, and `list_windows`, and reconcile any changed fields with
   `CuaDriverSurface.ts`. That file depends on `element_token`, `role`,
   `label`, and `value` in `structuredContent.elements`, and on `pid` from
   `launch_app`.

## Computer-use smoke test

Build the driver, then from `backboard/cli-ts` run:

```sh
bun run test:computer-use --app Brave --goal "open pixlr on brave and draw a picture of a cat"
```

This is an opt-in live test: it uses Backboard credentials and the configured
writer model. It exercises the production Computer tool and saves Jev requests,
answers, the result, and an exact-window screenshot. Inspect the screenshot;
`done` means Jev reported completion, not independent visual verification.
The browser runs in its own profile and closes when this smoke test exits.
The IDE keeps the browser for the lifetime of its Computer tool.
