"""Slice the fishing UI sprite atlas into individual HUD assets.

The source (assets/ui/fishing-ui-sprite-atlas-16x16-v1.png) is a 1536x1024 sheet
whose "transparency" is a checkerboard painted into the pixels, so nothing can
be cut out of it until that is removed. This script:

  1. flood-fills the checkerboard away from the sheet edges (the same trick as
     tools/remove_checkerboard_background.py, vectorised),
  2. finds each sprite by scanning the resulting alpha,
  3. splits the few groups that sit too close together to separate
     automatically (the shelf tabs, the dividers, the corner ornaments),
  4. writes the two inventory slots still used by the HUD plus a manifest.

Sprites are exported at full source resolution. Unlike the world tileset, this
art is not 1px pixel art -- it is drawn at roughly 2x with gradients and
anti-aliased edges, so reducing it to a nominal grid throws detail away. The
HUD renders it with ordinary smooth scaling, which keeps it sharp on hi-DPI
screens; only the game world uses image-rendering: pixelated.

Run from the repository root:

    python tools/build_ui_pack.py

Outputs (committed, so a fresh clone needs no Python to build the client):
    client/public/assets/ui/*.png
    client/public/assets/ui/manifest.json
"""

from __future__ import annotations

import json
import pathlib
import sys
from collections import deque

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/ui/fishing-ui-sprite-atlas-16x16-v1.png"
OUT_DIR = ROOT / "client/public/assets/ui"

#: The canvas checkerboard is neutral and bright. Real art in this pack never
#: is: even the parchment fill sits around 230 with a warm cast.
CANVAS_MIN_BRIGHTNESS = 210
CANVAS_MAX_CHROMA = 10

#: Names in sheet order, row by row. A name of None drops that sprite.
ROW_NAMES: list[list[str | None]] = [
    ["panel-sm", "panel-md", "panel-lg", "pill-coin", "pill-fish", "pill-pearl"],
    ["slot", "slot-b", "slot-c", "slot-d",
     "slot-gold", "slot-gold-b", "slot-gold-c", "slot-gold-d"],
    ["icon-bag", "icon-map", "icon-rod", "icon-fish", "icon-boat",
     "icon-tackle", "icon-trophy", "icon-gear", "icon-home", "icon-shop"],
    ["item-coin", "item-wood", "item-fish", "item-bait", "item-pearl",
     "item-chest", "@shelf"],
    ["btn-wide", "btn-wide-b", "@dividers", "dot-red", "@corners-l", "@corners-r"],
]

#: Groups the gap-based split cannot separate, cut by even division instead.
#: name -> (pieces, axis) where axis "x" splits into columns, "y" into rows.
GROUP_SPLITS: dict[str, tuple[list[str], str]] = {
    "@shelf": (["tab-bag", "tab-rod", "tab-map"], "x"),
    "@dividers": (["divider-line", "divider-dots", "divider-rope"], "y"),
    "@corners-l": (["corner-tl", "corner-bl"], "y"),
    "@corners-r": (["corner-tr", "corner-br"], "y"),
}


def strip_canvas(image: Image.Image) -> np.ndarray:
    """Return an RGBA array with the checkerboard canvas made transparent.

    Flood-filled from the border rather than matched by colour alone, so a
    genuinely white-ish pixel *inside* a sprite (the gear icon, the pearl) is
    never punched out.
    """
    pixels = np.array(image.convert("RGBA"))
    height, width = pixels.shape[:2]

    channels = pixels[:, :, :3].astype(np.int16)
    brightest = channels.max(axis=2)
    darkest = channels.min(axis=2)
    canvas_like = (darkest >= CANVAS_MIN_BRIGHTNESS) & (
        (brightest - darkest) <= CANVAS_MAX_CHROMA
    )

    seen = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if canvas_like[y, x] and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < height and 0 <= nx < width:
                    seed(ny, nx)

    pixels[seen] = (0, 0, 0, 0)
    return pixels


def bands(mask: np.ndarray, min_length: int = 1) -> list[tuple[int, int]]:
    """Contiguous runs of True, as inclusive (start, end) pairs."""
    out: list[tuple[int, int]] = []
    start = None
    for index, value in enumerate(mask):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start >= min_length:
                out.append((start, index - 1))
            start = None
    if start is not None and len(mask) - start >= min_length:
        out.append((start, len(mask) - 1))
    return out


def find_sprites(alpha: np.ndarray) -> list[list[tuple[int, int, int, int]]]:
    """Sprite boxes grouped by sheet row, each as (x0, y0, x1, y1)."""
    opaque = alpha > 16

    rows: list[tuple[int, int]] = []
    for band in bands(opaque.any(axis=1), 3):
        # A drop shadow can leave a sliver just under a row; fold it in.
        if rows and band[0] - rows[-1][1] <= 10:
            rows[-1] = (rows[-1][0], band[1])
        else:
            rows.append(band)

    grouped: list[list[tuple[int, int, int, int]]] = []
    for y0, y1 in rows:
        strip = opaque[y0 : y1 + 1, :]
        columns: list[tuple[int, int]] = []
        for band in bands(strip.any(axis=0), 4):
            if columns and band[0] - columns[-1][1] <= 10:
                columns[-1] = (columns[-1][0], band[1])
            else:
                columns.append(band)

        boxes = []
        for x0, x1 in columns:
            sub = opaque[y0 : y1 + 1, x0 : x1 + 1]
            ys = np.where(sub.any(axis=1))[0]
            boxes.append((x0, y0 + int(ys[0]), x1 + 1, y0 + int(ys[-1]) + 1))
        grouped.append(boxes)
    return grouped


def trim(pixels: np.ndarray, box: tuple[int, int, int, int]) -> Image.Image:
    """Crop to `box`, then shrink to the sprite's own opaque bounds."""
    x0, y0, x1, y1 = box
    crop = pixels[y0:y1, x0:x1]
    opaque = crop[:, :, 3] > 16
    if not opaque.any():
        return Image.fromarray(crop, "RGBA")

    ys = np.where(opaque.any(axis=1))[0]
    xs = np.where(opaque.any(axis=0))[0]
    return Image.fromarray(
        crop[ys[0] : ys[-1] + 1, xs[0] : xs[-1] + 1], "RGBA"
    )


def split_group(image: Image.Image, pieces: list[str], axis: str) -> list[tuple[str, Image.Image]]:
    """Cut an evenly-spaced group that sat too close to separate by gap."""
    width, height = image.size
    count = len(pieces)
    out = []
    for index, name in enumerate(pieces):
        if axis == "x":
            box = (index * width // count, 0, (index + 1) * width // count, height)
        else:
            box = (0, index * height // count, width, (index + 1) * height // count)
        piece = image.crop(box)

        # Re-trim: an even cut leaves padding around each piece.
        data = np.array(piece)
        opaque = data[:, :, 3] > 16
        if opaque.any():
            ys = np.where(opaque.any(axis=1))[0]
            xs = np.where(opaque.any(axis=0))[0]
            piece = Image.fromarray(data[ys[0] : ys[-1] + 1, xs[0] : xs[-1] + 1], "RGBA")
        out.append((name, piece))
    return out


def main() -> int:
    if not SOURCE.exists():
        print(f"Source atlas not found: {SOURCE}", file=sys.stderr)
        return 1

    source = Image.open(SOURCE)
    pixels = strip_canvas(source)
    grouped = find_sprites(pixels[:, :, 3])

    print(f"Found {sum(len(row) for row in grouped)} sprites in {len(grouped)} rows")

    if len(grouped) != len(ROW_NAMES):
        print(
            f"  warn: sheet has {len(grouped)} rows but {len(ROW_NAMES)} are named",
            file=sys.stderr,
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)


    manifest: dict[str, dict[str, int]] = {}

    for row_index, boxes in enumerate(grouped):
        names = ROW_NAMES[row_index] if row_index < len(ROW_NAMES) else []
        if len(boxes) != len(names):
            print(
                f"  warn: row {row_index} has {len(boxes)} sprites, {len(names)} names",
                file=sys.stderr,
            )

        for box_index, box in enumerate(boxes):
            name = names[box_index] if box_index < len(names) else None
            if name not in {"slot", "slot-gold"}:
                continue

            sprite = trim(pixels, box)

            if name.startswith("@"):
                for piece_name, piece in split_group(sprite, *GROUP_SPLITS[name]):
                    piece.save(OUT_DIR / f"{piece_name}.png")
                    manifest[piece_name] = {"width": piece.width, "height": piece.height}
                continue

            sprite.save(OUT_DIR / f"{name}.png")
            manifest[name] = {"width": sprite.width, "height": sprite.height}

    (OUT_DIR / "manifest.json").write_text(
        json.dumps({"source": SOURCE.name, "sprites": manifest}, indent=2) + "\n"
    )

    print(f"Wrote {len(manifest)} sprites to {OUT_DIR}")
    for name in sorted(manifest):
        size = manifest[name]
        print(f"  {name:16s} {size['width']}x{size['height']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
