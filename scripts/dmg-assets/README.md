# DMG installer-window assets

These files give the release DMG a proper drag-to-Applications window — sized,
with background art and an arrow — that auto-opens when the image is mounted.
Without them Finder falls back to a bare two-icon list view.

## Files

| File | Purpose |
| --- | --- |
| `render_background.py` | Draws the background art. Owns the window/icon geometry. |
| `author_dsstore_finder.sh` | Drives Finder to produce a `.DS_Store` for one channel. |
| `build_layout_assets.sh` | Regenerates everything for both channels. |
| `background.tiff` / `background-sandbox.tiff` | Multi-resolution (1x + 2x) background art. |
| `DS_Store` / `DS_Store-sandbox` | Finder-authored window layout. |

## Regenerating

```bash
./scripts/dmg-assets/build_layout_assets.sh
```

Both channels by default; `CHANNELS=sandbox` limits it to one. Requires Python
with Pillow, and Automation permission to control Finder — the first run may
raise a system prompt.

## Two things that will silently break this

**The `.DS_Store` must be Finder-authored.** One written by a library
(`ds_store`, `dmgbuild`, …) mounts fine but never auto-opens its window on
Apple Silicon. `author_dsstore_finder.sh` mounts a scratch read-write image and
drives the real Finder over AppleScript precisely to avoid this.

**The scratch volume name must match the shipping DMG's volume name.** Finder
records the background as a volume-relative path, so if the names diverge the
window opens with the right geometry and no artwork. Volume names come from
`APP_DISPLAY_NAME` in `package_vscode_update_macos.sh`: `Backboard Studio` for
stable, `Backboard Studio Sandbox` for sandbox. The placeholder bundle name has
to match the shipping app's for the same reason — icon positions are keyed by
filename.

## Keep these committed

An earlier revision of this directory was listed in `.gitignore`, including the
generator scripts. The whole toolchain was lost, and because packaging treats
missing assets as a non-fatal warning, releases silently shipped with a default
Finder window until someone noticed at install time. Do not re-ignore them.
