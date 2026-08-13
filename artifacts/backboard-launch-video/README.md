# Backboard Studio launch video

This folder contains the 75-second launch-film treatment, a reproducible rough-cut renderer, and the current review export.

## Files

- `launch-script.md` — frame-accurate shot list, panel choreography, on-screen copy, music, sound design, and optional alternate voiceover.
- `render_roughcut.py` — FFmpeg renderer. It uses real Backboard screenshots for readable product demonstrations.
- `assets/editor-code.jpg` — live Editor-mode capture used in the current cut.
- `out/backboard-studio-launch-roughcut.mp4` — 1920×1080, 30 fps, H.264/AAC review file.

## Higgsfield hero clips

The renderer automatically uses the following clips when present:

```text
assets/higgsfield-simple.mp4
assets/higgsfield-editor.mp4
assets/higgsfield-advanced.mp4
```

Without them, it falls back to authentic UI stills. This keeps the edit reproducible while Higgsfield jobs render.

`assets/higgsfield-advanced-rejected.mp4` is retained for comparison but intentionally excluded: generated card copy drifted during the shot, so the approved Advanced beat uses the real capture.

## Render

```bash
python3 artifacts/backboard-launch-video/render_roughcut.py
```

Requirements: macOS system SF fonts and `ffmpeg` on `PATH`.

## Product constraints

- Simple, Editor, and Advanced are shown.
- Jarvis is excluded from the timeline and assets.
- Generated motion is restricted to mode hero transitions.
- Readable feature beats always use real Backboard captures.
