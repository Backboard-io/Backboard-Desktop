#!/usr/bin/env python3
"""Render the DMG installer-window background art.

Emits a 1x and a 2x PNG per channel; build_layout_assets.sh folds the pair into
a single multi-resolution TIFF via tiffutil so the window stays crisp on Retina.

The geometry constants here are the single source of truth for the installer
window: author_dsstore_finder.sh reads them back via --dump-geometry so the icon
positions Finder records line up with the artwork instead of drifting from it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Installer window content geometry, in 1x points.
WIDTH = 660
HEIGHT = 360
ICON_SIZE = 128
ICON_CENTER_Y = 198
APP_CENTER_X = 172
APPS_CENTER_X = 488

BACKGROUND = (255, 255, 255)
TITLE_COLOR = (29, 29, 31)
SUBTITLE_COLOR = (110, 110, 115)

CHANNELS = {
    "stable": {
        "title": "Backboard Studio",
        "accent": (46, 92, 209),
    },
    "sandbox": {
        "title": "Backboard Studio Sandbox",
        # Sandbox keeps a distinct amber accent so a sandbox DMG is never
        # mistaken for a stable one; darkened from the on-dark value to hold
        # contrast against white.
        "accent": (198, 126, 20),
    },
}


def load_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size, index=1 if bold else 0)
            except (OSError, ValueError):
                try:
                    return ImageFont.truetype(path, size=size)
                except OSError:
                    continue
    return ImageFont.load_default()


def centered(draw, text, font, cx, cy, fill):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (right - left) / 2 - left, cy - (bottom - top) / 2 - top),
              text, font=font, fill=fill)


def draw_arrow(draw, x0, x1, y, accent, scale):
    """A tapered shaft plus solid head, pointing at the Applications slot."""
    shaft_h = max(2, round(3 * scale))
    head_w = round(22 * scale)
    head_h = round(20 * scale)
    shaft_end = x1 - head_w
    draw.rounded_rectangle(
        [x0, y - shaft_h / 2, shaft_end, y + shaft_h / 2],
        radius=shaft_h / 2,
        fill=accent + (215,),
    )
    draw.polygon(
        [(x1, y), (shaft_end, y - head_h / 2), (shaft_end, y + head_h / 2)],
        fill=accent + (235,),
    )


def render(channel: str, scale: int, out_path: Path) -> None:
    cfg = CHANNELS[channel]
    w, h = WIDTH * scale, HEIGHT * scale

    img = Image.new("RGBA", (w, h), BACKGROUND + (255,))
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    accent = cfg["accent"]

    cy = ICON_CENTER_Y * scale
    app_cx = APP_CENTER_X * scale
    apps_cx = APPS_CENTER_X * scale

    gap_pad = (ICON_SIZE / 2 + 34) * scale
    draw_arrow(draw, app_cx + gap_pad, apps_cx - gap_pad, cy, accent, scale)

    title_font = load_font(round(23 * scale), bold=True)
    sub_font = load_font(round(13 * scale))
    centered(draw, cfg["title"], title_font, w / 2, 52 * scale, TITLE_COLOR + (255,))
    centered(draw, "Drag the app onto Applications to install",
             sub_font, w / 2, 82 * scale, SUBTITLE_COLOR + (255,))

    # No icon captions here: Finder draws its own labels under both icons, and
    # painting them into the art too renders them twice, offset.

    out = Image.alpha_composite(img, overlay).convert("RGB")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path, format="PNG")


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
