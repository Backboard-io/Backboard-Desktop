"""Turn painted artwork into risograph-style halftone PNGs.

Each source is split into up to three spot inks (blue, pink, yellow), each
printed as rotated halftone dots with a slight misregistration, on a
transparent ground so the page can overprint it with mix-blend-mode: multiply.

    python3 scripts/riso.py
"""

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent / "public" / "assets"
OUT = ROOT / "riso"

INKS = {
    "blue": ((29, 63, 216), 15),
    "pink": ((255, 79, 160), 75),
    "yellow": ((255, 214, 26), 0),
    "orange": ((255, 122, 61), 45),
}


def separations(rgb: np.ndarray) -> dict[str, np.ndarray]:
    r, g, b = (rgb[..., i] / 255.0 for i in range(3))
    c, m, y = 1 - r, 1 - g, 1 - b
    k = np.minimum(np.minimum(c, m), y)
    return {
        "blue": np.clip(c * 0.85 + k * 0.6, 0, 1),
        "pink": np.clip((m - k) * 1.1 + k * 0.25, 0, 1),
        "yellow": np.clip((y - k) * 1.0, 0, 1),
        "orange": np.clip(np.minimum(m, y) - k, 0, 1),
    }


def halftone(density, alpha, color, angle, cell, scale, offset):
    h, w = density.shape
    W, H = w * scale, h * scale
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    a = math.radians(angle)
    ca, sa = math.cos(a), math.sin(a)
    diag = int(math.hypot(w, h) / cell) + 2
    for i in range(-diag, diag):
        for j in range(-diag, diag):
            u, v = i * cell, j * cell
            x = w / 2 + u * ca - v * sa
            y = h / 2 + u * sa + v * ca
            if not (0 <= x < w and 0 <= y < h):
                continue
            d = density[int(y), int(x)] * alpha[int(y), int(x)]
            if d < 0.04:
                continue
            rad = cell * 0.62 * math.sqrt(d) * scale
            cx, cy = (x + offset[0]) * scale, (y + offset[1]) * scale
            draw.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=color + (235,))
    return layer.resize((w, h), Image.LANCZOS)


def riso(src, dst, inks, width=1400, cell=7.0, gain=None):
    im = Image.open(ROOT / src).convert("RGBA")
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    arr = np.asarray(im.filter(ImageFilter.GaussianBlur(cell / 3))).astype(float)
    alpha = arr[..., 3] / 255.0
    seps = separations(arr[..., :3])
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    for n, ink in enumerate(inks):
        color, angle = INKS[ink]
        dens = np.clip(seps[ink] * (gain or {}).get(ink, 1.0), 0, 1)
        off = ((n - 1) * 1.6, (1 - n) * 1.2)
        layer = halftone(dens, alpha, color, angle, cell, 3, off)
        out = Image.alpha_composite(out, layer)
    OUT.mkdir(parents=True, exist_ok=True)
    out.save((OUT / dst).with_suffix(".webp"), quality=86, method=6)
    print("wrote", dst, out.size)


if __name__ == "__main__":
    riso("sun-study-2026-09-27/08-painted-sun.png", "sun.png",
         ["pink", "orange", "yellow"], width=900, cell=8,
         gain={"yellow": 1.25, "orange": 1.25, "pink": 0.8})
    riso("kevin-sunset-shore.png", "shore.png", ["yellow", "pink", "blue"],
         width=1800, cell=6, gain={"blue": 1.1})
    riso("kevin-surf-lineup.png", "lineup.png", ["yellow", "pink", "blue"],
         width=1400, cell=6)
    riso("kevin-wave-ribbon.png", "wave.png", ["yellow", "blue"], width=1800, cell=6)
    riso("kevin-reef-cove.png", "reef.png", ["yellow", "pink", "blue"],
         width=1000, cell=6, gain={"blue": 0.6, "pink": 0.8, "yellow": 1.3})
    riso("sun-study-2026-09-27/04-sun-walk.png", "sun-walk.png",
         ["yellow", "orange", "blue"], width=2000, cell=6,
         gain={"yellow": 1.6, "orange": 1.6, "blue": 1.2})
