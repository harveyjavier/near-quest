"""Build the uncut-gem sprite sheet from the supplied ore art, at full resolution.

Each tier's supplied plate (assets/generated/uncut-<tier>-ore-*.png) is used
pixel-for-pixel: cropped to its alpha bounding box and centred into one shared
square cell sized to the largest of the four, so the sheet's per-frame grid
stays uniform -- no resize, no resample, no quantise.

The frame size the rest of the client reads (gems.json's frameWidth /
frameHeight) stays 24, exactly as it was for the old procedurally-drawn sheet.
Nothing else in the client needs to change for that: `applySprite` in
client/src/art/icons.js already scales the *whole* sheet image to whatever CSS
size it is told to render at (`background-size`), regardless of the source
PNG's own resolution -- shrinking a big image down to a small on-screen box is
the browser's job, and it already does that well. Keeping the source at full
resolution just means the bigger uses (the 5x appraisal counter) still have
real detail to show instead of a stretched-up 24px block.

Spark has no supplied art and is still drawn, at the same shared cell size so
it downscales the same way as the other four rather than being stretched up
from a small original.

Run from the repository root:

    python tools/build_gem_icons.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/gems.png + .json
"""

import json
import pathlib

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

# The logical frame size the rest of the client reads from gems.json. The
# *stored* PNG is much larger than this -- see the module docstring.
DISPLAY_SIZE = 24

OPAQUE = 128  # source alpha above which a pixel counts as part of the art

TIERS = [
    {"id": "emerald",  "source": "uncut-emerald-ore-pixel-art.png"},
    {"id": "ruby",     "source": "uncut-ruby-ore-pixel-art-v2.png"},
    {"id": "sapphire", "source": "uncut-sapphire-ore-pixel-art-v2.png"},
    {"id": "diamond",  "source": "uncut-diamond-ore-pixel-art.png"},
]

SPARK = {"body": "#7fe9ff", "core": "#ffffff", "edge": "#2f7fa8"}


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def alpha_bbox(rgba):
    """The tight box around a source's non-transparent pixels."""
    solid = rgba[:, :, 3] > OPAQUE
    ys, xs = np.nonzero(solid)
    if len(xs) == 0:
        raise SystemExit("source has no opaque pixels")
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def gem_frame(rgba, box, cell):
    """Crops to `box` -- untouched pixels, no resampling -- and centres the
    result in a transparent `cell` x `cell` canvas."""
    x0, y0, x1, y1 = box
    crop = rgba[y0:y1, x0:x1]
    h, w = crop.shape[:2]

    frame = np.zeros((cell, cell, 4), dtype=np.uint8)
    ox, oy = (cell - w) // 2, (cell - h) // 2
    frame[oy:oy + h, ox:ox + w] = crop
    return frame


def spark_frame(cell):
    """A four-point star, drawn at the shared cell's own resolution so it
    downscales alongside the supplied art rather than being stretched up from
    a small original."""
    body, core, edge = (hex_rgb(SPARK[key]) for key in ("body", "core", "edge"))
    ss = 4  # supersampled, then resampled down for a smooth (not blocky) edge
    c = (cell * ss) / 2
    arm, waist = cell * ss * 0.417, cell * ss * 0.108
    stroke = max(1, cell * ss // 90)

    canvas = Image.new("RGBA", (cell * ss, cell * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    points = [
        (c, c - arm), (c + waist, c - waist), (c + arm, c), (c + waist, c + waist),
        (c, c + arm), (c - waist, c + waist), (c - arm, c), (c - waist, c - waist),
    ]
    draw.polygon(points, fill=(*body, 255), outline=(*edge, 255), width=stroke)

    r = cell * ss * 0.10
    draw.ellipse([c - r, c - r, c + r, c + r], fill=(*core, 255))

    return np.array(canvas.resize((cell, cell), Image.LANCZOS))


def main():
    sources = []
    boxes = []
    for tier in TIERS:
        rgba = np.asarray(Image.open(SOURCE_DIR / tier["source"]).convert("RGBA"))
        sources.append(rgba)
        boxes.append(alpha_bbox(rgba))

    # One shared cell, sized to whichever tier's art is biggest either way --
    # every frame keeps its own native pixels, so this only decides how much
    # transparent margin the smaller ones sit in.
    cell = max(max(x1 - x0, y1 - y0) for x0, y0, x1, y1 in boxes)

    frames = [gem_frame(rgba, box, cell) for rgba, box in zip(sources, boxes)]
    frames.append(spark_frame(cell))
    ids = [tier["id"] for tier in TIERS] + ["spark"]

    sheet = np.concatenate(frames, axis=1)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(sheet, "RGBA").save(OUT_DIR / "gems.png")

    (OUT_DIR / "gems.json").write_text(
        json.dumps(
            {
                "image": "gems.png",
                "frameWidth": DISPLAY_SIZE,
                "frameHeight": DISPLAY_SIZE,
                "frames": {item: i for i, item in enumerate(ids)},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote gems.png  {cell}x{cell} native per frame, "
          f"{DISPLAY_SIZE}x{DISPLAY_SIZE} display, x{len(frames)}")


if __name__ == "__main__":
    main()
