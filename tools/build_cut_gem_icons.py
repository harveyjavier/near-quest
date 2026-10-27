"""Build the cut-gem sprite sheet from the supplied gem art, at full resolution.

Companion to `tools/build_gem_icons.py`: that one builds the *uncut* ore a gem
tier drops as (a rough stone with a seam showing); this one builds what the
appraisal counter switches to once a stone has been graded -- the same tier,
now a faceted, finished gem.

Same technique as the uncut sheet, for the same reason: each tier's supplied
plate (assets/generated/cut-<tier>-gem-*.png) is used pixel-for-pixel, cropped
to its alpha bounding box and centred into one shared square cell sized to the
largest of the four -- no resize, no resample, no quantise. The frame size the
client reads (gems-cut.json's frameWidth/frameHeight) is 24, matching
gems.json, so the same `scale` a caller already passes for the uncut sheet
produces the same on-screen size for the cut one.

There is no Spark here -- Sparks are never appraised, so the cut sheet only
ever needs the four gem tiers.

Run from the repository root:

    python tools/build_cut_gem_icons.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/gems-cut.png + .json
"""

import json
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

# Matches build_gem_icons.py's DISPLAY_SIZE, so a caller's existing `scale`
# argument means the same thing on both sheets.
DISPLAY_SIZE = 24

OPAQUE = 128  # source alpha above which a pixel counts as part of the art

TIERS = [
    {"id": "emerald",  "source": "cut-emerald-gem-pixel-art.png"},
    {"id": "ruby",     "source": "cut-ruby-gem-pixel-art.png"},
    {"id": "sapphire", "source": "cut-sapphire-gem-pixel-art.png"},
    {"id": "diamond",  "source": "cut-diamond-gem-pixel-art.png"},
]


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


def main():
    sources = []
    boxes = []
    for tier in TIERS:
        rgba = np.asarray(Image.open(SOURCE_DIR / tier["source"]).convert("RGBA"))
        sources.append(rgba)
        boxes.append(alpha_bbox(rgba))

    cell = max(max(x1 - x0, y1 - y0) for x0, y0, x1, y1 in boxes)

    frames = [gem_frame(rgba, box, cell) for rgba, box in zip(sources, boxes)]
    ids = [tier["id"] for tier in TIERS]

    sheet = np.concatenate(frames, axis=1)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(sheet, "RGBA").save(OUT_DIR / "gems-cut.png")

    (OUT_DIR / "gems-cut.json").write_text(
        json.dumps(
            {
                "image": "gems-cut.png",
                "frameWidth": DISPLAY_SIZE,
                "frameHeight": DISPLAY_SIZE,
                "frames": {item: i for i, item in enumerate(ids)},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote gems-cut.png  {cell}x{cell} native per frame, "
          f"{DISPLAY_SIZE}x{DISPLAY_SIZE} display, x{len(frames)}")


if __name__ == "__main__":
    main()
