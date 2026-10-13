#!/usr/bin/env python3
"""Render the DMG installer-window background art.

Emits a 1x and a 2x PNG per channel; build_layout_assets.sh folds the pair into
a single multi-resolution TIFF via tiffutil so the window stays crisp on Retina.

The geometry constants here are the single source of truth for the installer
window: author_dsstore_finder.sh reads them back via --dump-geometry so the icon
positions Finder records line up with the artwork instead of drifting from it.

Look: white canvas with a faint square grid that bows into arcs around the
bottom-left corner, and a thin dark arrow between the two icon slots. No text —
Finder draws the labels under both icons itself.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Installer window content geometry, in 1x points.
WIDTH = 660
HEIGHT = 360
ICON_SIZE = 128
ICON_CENTER_Y = 168
APP_CENTER_X = 172
APPS_CENTER_X = 488

BACKGROUND = (255, 255, 255)
GRID_COLOR = (233, 233, 234)
GRID_SPACING = 40

# The corner motif is a crossfade, all radii measured in 1x points from the
# bottom-left corner: the straight grid fades out approaching the corner, true
# concentric arcs fade in to replace it, and a mild barrel warp leans the
# straight lines into the transition so the two systems appear to melt into
# each other rather than merely overlap.
GRID_FADE_IN = (70.0, 200.0)   # straight grid: invisible below, full above
ARC_FADE_OUT = (140.0, 280.0)  # arcs: full below, gone above

WARP_CENTER = (-10.0, HEIGHT + 10.0)
WARP_STRENGTH = 0.25
WARP_RADIUS = 130.0

CHANNELS = {
    "stable": {
        "arrow": (23, 23, 26),
    },
    "sandbox": {
        # Sandbox keeps a distinct amber arrow so a sandbox DMG is never
        # mistaken for a stable one; the artwork is otherwise identical.
        "arrow": (198, 126, 20),
    },
}


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def fade_color(t: float) -> tuple[int, int, int]:
    """Grid color at visibility t, blended toward the flat white background."""
    return tuple(round(255 + (c - 255) * t) for c in GRID_COLOR)


def warp(x: float, y: float, s: float) -> tuple[float, float]:
    cx, cy = WARP_CENTER[0] * s, WARP_CENTER[1] * s
    dx, dy = x - cx, y - cy
    r = math.hypot(dx, dy)
    if r < 1e-9:
        return (x, y)
    m = 1.0 + WARP_STRENGTH * math.exp(-((r / (WARP_RADIUS * s)) ** 2))
    return (cx + dx * m, cy + dy * m)


def draw_fading_polyline(draw: ImageDraw.ImageDraw, pts, s: float, line_w: int) -> None:
    """Draw a polyline whose opacity ramps up with distance from the corner."""
    cx, cy = 0.0, HEIGHT * s
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        r = math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) / s
        t = smoothstep(*GRID_FADE_IN, r)
        if t <= 0.01:
            continue
        draw.line([(x0, y0), (x1, y1)], fill=fade_color(t), width=line_w)


def draw_corner_arcs(draw: ImageDraw.ImageDraw, s: float, line_w: int) -> None:
    cx, cy = 0.0, HEIGHT * s
    for k in range(1, math.ceil(ARC_FADE_OUT[1] / GRID_SPACING) + 1):
        radius = k * GRID_SPACING
        t = 1.0 - smoothstep(*ARC_FADE_OUT, radius)
        if t <= 0.01:
            continue
        rr = radius * s
        # 265..5 rather than an exact quarter so clipping, not the arc's own
        # endpoints, decides where it meets the canvas edges.
        draw.arc([cx - rr, cy - rr, cx + rr, cy + rr], 265, 5,
                 fill=fade_color(t), width=line_w)


def draw_grid(draw: ImageDraw.ImageDraw, w: int, h: int, s: float) -> None:
    spacing = GRID_SPACING * s
    line_w = max(1, round(s))
    step = max(2, round(3 * s))
    # Overhang past every edge: the warp stretches lines outward, so the
    # preimage of the visible canvas extends beyond it.
    over = round(2 * spacing)

    for i in range(-2, math.ceil(w / spacing) + 3):
        x = i * spacing
        pts = [warp(x, y, s) for y in range(-over, h + over, step)]
        draw_fading_polyline(draw, pts, s, line_w)
    for j in range(-2, math.ceil(h / spacing) + 3):
        y = j * spacing
        pts = [warp(x, y, s) for x in range(-over, w + over, step)]
        draw_fading_polyline(draw, pts, s, line_w)

    draw_corner_arcs(draw, s, line_w)


def draw_arrow(draw: ImageDraw.ImageDraw, x0: float, x1: float, y: float,
               color: tuple[int, int, int], s: float) -> None:
    """A thin shaft with a compact solid head, pointing at Applications."""
    shaft_h = max(2, round(2.6 * s))
    head_w = round(15 * s)
    head_h = round(13 * s)
    # Tuck the shaft slightly under the head so no seam shows at the joint.
    shaft_end = x1 - head_w + s
    draw.rounded_rectangle(
        [x0, y - shaft_h / 2, shaft_end, y + shaft_h / 2],
        radius=shaft_h / 2,
        fill=color,
    )
    draw.polygon(
        [(x1, y), (x1 - head_w, y - head_h / 2), (x1 - head_w, y + head_h / 2)],
        fill=color,
    )


def render(channel: str, scale: int, out_path: Path) -> None:
    cfg = CHANNELS[channel]
    # Render supersampled and fold back down so the warped grid and the arrow
    # come out antialiased; PIL draws hard-edged primitives otherwise.
    ss = 2
    s = scale * ss
    w, h = WIDTH * s, HEIGHT * s

    img = Image.new("RGB", (w, h), BACKGROUND)
    draw = ImageDraw.Draw(img)

    draw_grid(draw, w, h, s)

    cy = ICON_CENTER_Y * s
    gap_pad = (ICON_SIZE / 2 + 42) * s
    draw_arrow(draw, APP_CENTER_X * s + gap_pad, APPS_CENTER_X * s - gap_pad,
               cy, cfg["arrow"], s)

    img = img.resize((WIDTH * scale, HEIGHT * scale), Image.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, format="PNG")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", choices=sorted(CHANNELS), required=False)
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dump-geometry", action="store_true",
                    help="Print window/icon geometry as JSON and exit.")
    args = ap.parse_args()

    if args.dump_geometry:
        json.dump({
            "width": WIDTH,
            "height": HEIGHT,
            "icon_size": ICON_SIZE,
            "icon_center_y": ICON_CENTER_Y,
            "app_center_x": APP_CENTER_X,
            "apps_center_x": APPS_CENTER_X,
        }, sys.stdout)
        print()
        return 0

    if not args.channel or not args.out:
        ap.error("--channel and --out are required unless --dump-geometry is given")

    render(args.channel, args.scale, args.out)
    print(f"rendered {args.channel} @{args.scale}x -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
