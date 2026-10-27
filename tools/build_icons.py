"""Build the item sprite sheets from the supplied icon plates.

Sources (assets/generated/): Fish_Icons -- the GDD's sprite
references, supplied at high resolution with a real alpha channel. Each is a
single row or grid of items on transparency.

The gem sheet has no plate behind it and is drawn from scratch instead; see
`tools/build_gem_icons.py`. The chests are no longer cut from a plate either:
they arrive as four separate renders and are packed at their native resolution
by `tools/build_chest_icons.py`, which owns chests.png and .json.

They are *renders* of pixel art rather than pixel art, so there is no clean
native grid to recover: run-length and edge-snapping fits on the alpha
silhouette both come back with the block size drifting across the plate (the
same problem the character sheet had). Chasing the original grid is therefore
a dead end.

What works instead is to skip the question. Each item is cropped to its alpha
bounding box and resampled to a size *this* file chooses, so the grid is exact
by construction. Every output pixel takes the **mode** of the middle 40% of its
source region rather than an average -- averaging across the render's soft
edges invents colours that were never in the art, which is what produced
speckle when quantisation was tried on the character sheet. A final median cut
merges the render's near-duplicate values back down to a flat palette.

One scale is shared across all the items on a plate, so their relative sizes
survive: a Legendary Chest stays visibly bigger than a Common one.

Run from the repository root:

    python tools/build_icons.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/fish.png       + .json
"""

import json
import pathlib
from collections import Counter

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

INNER = 0.30, 0.70   # middle 40% of each source region feeds the mode
COVERAGE = 0.45      # alpha share in that region that makes an output pixel solid
OPAQUE = 128         # source alpha above which a pixel counts as part of the art

# Each plate: the sheet it produces, its grid, the box every frame is fitted
# into, how many colours to keep, and the ids in reading order. The ids are
# written out rather than derived, so that reordering a server config cannot
# silently swap every sprite in the game.
PLATES = [
    {
        "name": "fish",
        "source": "Fish_Icons.png",
        "columns": 3,
        "rows": 2,
        "box": (45, 39),
        "palette": 24,
        "ids": [
            "muddy_carp",
            "speckled_trout",
            "whiskered_catfish",
            "golden_koi",
            "moonfish",
            "leviathan",
        ],
    },
]


def cell_boxes(rgba, columns, rows):
    """Split the plate into a grid and return each item's alpha bounding box."""
    h, w, _ = rgba.shape
    cw, ch = w / columns, h / rows
    boxes = []

    for row in range(rows):
        for col in range(columns):
            x0, x1 = int(round(col * cw)), int(round((col + 1) * cw))
            y0, y1 = int(round(row * ch)), int(round((row + 1) * ch))

            solid = rgba[y0:y1, x0:x1, 3] > OPAQUE
            ys, xs = np.nonzero(solid)
            if len(xs) == 0:
                raise SystemExit(f"empty cell at row {row}, column {col}")

            boxes.append((x0 + xs.min(), y0 + ys.min(), x0 + xs.max() + 1, y0 + ys.max() + 1))

    return boxes


def resample(rgba, box, out_w, out_h):
    """Mode-of-inner-region resample of one bounding box to out_w x out_h RGBA."""
    x0, y0, x1, y1 = box
    region = rgba[y0:y1, x0:x1]
    bw, bh = (x1 - x0) / out_w, (y1 - y0) / out_h

    out = np.zeros((out_h, out_w, 4), dtype=np.uint8)

    for gy in range(out_h):
        sy0 = int(round(gy * bh + bh * INNER[0]))
        sy1 = max(int(round(gy * bh + bh * INNER[1])), sy0 + 1)
        for gx in range(out_w):
            sx0 = int(round(gx * bw + bw * INNER[0]))
            sx1 = max(int(round(gx * bw + bw * INNER[1])), sx0 + 1)

            block = region[sy0:sy1, sx0:sx1]
            solid = block[:, :, 3] > OPAQUE
            if solid.mean() < COVERAGE:
                continue

            colour, _ = Counter(map(tuple, block[:, :, :3][solid])).most_common(1)[0]
            out[gy, gx] = (*colour, 255)

    return out


def quantise(frame, colours):
    """Median-cut the opaque pixels, keeping the background out of the palette."""
    opaque = frame[:, :, 3] > 0
    if not opaque.any():
        return frame

    staged = frame[:, :, :3].copy()
    staged[~opaque] = (255, 0, 255)

    reduced = Image.fromarray(staged, "RGB").quantize(
        colors=colours + 1, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )

    out = frame.copy()
    out[:, :, :3] = np.asarray(reduced.convert("RGB"))
    out[~opaque] = 0
    return out


def build(plate):
    rgba = np.asarray(Image.open(SOURCE_DIR / plate["source"]).convert("RGBA"))
    boxes = cell_boxes(rgba, plate["columns"], plate["rows"])

    if len(boxes) != len(plate["ids"]):
        raise SystemExit(f"{plate['name']}: {len(boxes)} cells but {len(plate['ids'])} ids")

    box_w, box_h = plate["box"]

    # One scale for the whole plate, set by whichever item is largest relative
    # to the frame, so the items keep their sizes relative to each other.
    scale = max(
        max((x1 - x0) / box_w for x0, _, x1, _ in boxes),
        max((y1 - y0) / box_h for _, y0, _, y1 in boxes),
    )

    frames = []
    for box in boxes:
        x0, y0, x1, y1 = box
        w = max(1, min(box_w, round((x1 - x0) / scale)))
        h = max(1, min(box_h, round((y1 - y0) / scale)))

        art = quantise(resample(rgba, box, w, h), plate["palette"])

        # Centred horizontally, sat on the bottom of the frame: a fish reads
        # as an object standing on a surface, not floating in one.
        frame = np.zeros((box_h, box_w, 4), dtype=np.uint8)
        ox, oy = (box_w - w) // 2, box_h - h
        frame[oy:oy + h, ox:ox + w] = art
        frames.append(frame)

    # `ids` names every cell on the plate, in grid order -- that is what
    # `boxes` was sliced against. `emit` (defaulting to all of `ids`) is which
    # of those actually make it into the output sheet.
    ids = plate["ids"]
    emit = plate.get("emit", ids)
    frames = [frames[ids.index(name)] for name in emit]

    sheet = np.concatenate(frames, axis=1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(sheet, "RGBA").save(OUT_DIR / f"{plate['name']}.png")

    (OUT_DIR / f"{plate['name']}.json").write_text(
        json.dumps(
            {
                "image": f"{plate['name']}.png",
                "frameWidth": box_w,
                "frameHeight": box_h,
                "frames": {item: i for i, item in enumerate(emit)},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {plate['name']}.png  {box_w}x{box_h} x{len(frames)}")


def main():
    for plate in PLATES:
        build(plate)


if __name__ == "__main__":
    main()
