"""Pixel versions of the surf paintings for the Studio home page.

Each painting is flattened onto black, ordered-dithered (Bayer 8x8) to 1-bit
white-on-black at low resolution, and saved as a tiny PNG. The page scales it up
with `image-rendering: pixelated` and screen-blends it onto a navy band, so the
dots read as navy pixel art; hovering fades in the matching colour version.

Run from website/:  python3 scripts/dither.py
"""

from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parent.parent / "public" / "assets"
OUT = ROOT / "pixel"
PAPER = (246, 241, 231)

BAYER = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]


def dither(gray: Image.Image) -> Image.Image:
    w, h = gray.size
    src = gray.load()
    out = Image.new("1", (w, h))
    dst = out.load()
    for y in range(h):
        row = BAYER[y % 8]
        for x in range(w):
            dst[x, y] = 255 if src[x, y] > (row[x % 8] + 0.5) * 4 else 0
    return out


def scene(size, pieces, bg):
    """Lay transparent paintings out on a canvas. pieces: (file, x, y, width) in 0-1 units."""
    W, H = size
    canvas = Image.new("RGBA", size, bg + (255,))
    for name, x, y, w in pieces:
        art = Image.open(ROOT / "surf" / name).convert("RGBA")
        pw = int(W * w)
        art = art.resize((pw, int(art.height * pw / art.width)), Image.LANCZOS)
        canvas.alpha_composite(art, (int(W * x), int(H * y)))
    return canvas.convert("RGB")


def pixelate(img: Image.Image, width: int, contrast=1.35, gamma=0.9) -> Image.Image:
    small = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    gray = ImageOps.grayscale(small)
    gray = ImageEnhance.Contrast(gray).enhance(contrast)
    gray = gray.point(lambda v: 255 * (v / 255) ** gamma)
    return dither(gray)


JOBS = {
    # name: (canvas size, pieces, pixel width)
    "band": (
        (2400, 900),
        [
            ("reef-cove.webp", -0.04, -0.12, 0.26),
            ("wave-ribbon.webp", 0.2, 0.18, 0.62),
            ("sun.webp", 0.8, 0.04, 0.14),
            ("surf-lineup.webp", 0.02, 0.52, 0.34),
            ("sunset-shore.webp", 0.66, 0.5, 0.36),
        ],
        600,
    ),
    "desktop": ((1600, 1000), [("wave-ribbon.webp", -0.05, 0.3, 1.1), ("sun.webp", 0.78, 0.02, 0.2)], 400),
    "cli": ((1600, 1000), [("reef-cove.webp", 0.5, -0.1, 0.56), ("surf-lineup.webp", -0.08, 0.45, 0.62)], 400),
    "giggsfields": ((1600, 1000), [("sun.webp", 0.3, 0.08, 0.4), ("sunray.webp", -0.05, 0.62, 1.1)], 400),
    "apps": ((1600, 1000), [("sunset-shore.webp", -0.02, 0.1, 1.04)], 400),
}


def main():
    OUT.mkdir(exist_ok=True)
    for name, (size, pieces, px) in JOBS.items():
        pixelate(scene(size, pieces, (0, 0, 0)), px).save(OUT / f"{name}.png", optimize=True)
        scene(size, pieces, PAPER).save(OUT / f"{name}-color.webp", quality=82, method=6)
    # Nash: the afterglow painting is already a full scene.
    # Its sky is pale cream, so dither on saturation: sun and sea become dots.
    after = Image.open(ROOT / "surf" / "afterglow.webp").convert("RGB")
    sat = after.convert("HSV").split()[1].convert("RGB")
    pixelate(sat, 400, contrast=1.5, gamma=0.8).save(OUT / "nash.png", optimize=True)
    after.save(OUT / "nash-color.webp", quality=82, method=6)
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size)


if __name__ == "__main__":
    main()
