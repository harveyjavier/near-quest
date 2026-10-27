"""Cut the bait shopkeeper out of his plate and size him for the shop panel.

The plate is drawn on a lit vignette rather than on transparency, so the keeper
cannot be dropped beside a parchment dialog as-is. This lifts him off it, trims
to what is actually drawn, and writes the one size the HUD uses.

Two things defeat the obvious approaches, and both were tried here first:

  * A brightness test cannot find the backdrop. The keeper's own darks -- the
    lantern's iron, the net, the shadow under the counter -- are as dark as the
    vignette's corners, while the warm glow behind his head is brighter than
    much of the art. Either way round, the threshold cuts through him.
  * A flood fill from the border cannot either. His outlines run right to the
    edge of the silhouette and are as dark as what surrounds them, so the fill
    steps onto one and walks it into the middle of the drawing, emptying him
    from the inside out.

What actually separates the two is texture, not colour: the vignette is a
smooth gradient everywhere, and the art is not. So the backdrop is seeded from
flatness, and the two seeds then compete for the pixels in between --  every
undecided pixel goes to whichever it is nearer, the art or the backdrop, with a
couple of pixels of ramp either side of the tie so the edge stays soft. An
outline is nearer the art it outlines, which is what keeps it.

Run from the repository root:

    python tools/build_shopkeeper.py

Source (not shipped):
    assets/generated/bait-shopkeeper-chibi-pixel-art.png

Output (committed, so a fresh clone needs no Python):
    client/public/assets/shopkeeper.png
"""

from collections import deque
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/generated/bait-shopkeeper-chibi-pixel-art.png"
OUTPUT = ROOT / "client/public/assets/shopkeeper.png"

# Window the local contrast is measured over, and how much of it a pixel may
# have and still count as backdrop. Measured off the plate: the vignette runs a
# local range of 1-2 at the corners and stays in single figures across the
# glow, while the art sits around 34 and its outlines far higher.
TEXTURE_RADIUS = 3
SMOOTH_MAX = 14

# The backdrop seed is eroded before the fill so a stray flat patch inside the
# art -- a lit cheek, a flat panel of jacket -- cannot become a way in.
ERODE_RADIUS = 6

# How far the two seeds are allowed to compete over. Nothing undecided is
# wider than this, and capping keeps the distance passes cheap.
DISTANCE_CAP = 24

# Half-width of the ramp across the tie line, in source pixels.
FEATHER = 2.5

# Alpha at or below which a pixel does not count as drawn, for the trim.
TRIM_FLOOR = 8

# Drawn at 2x the width the panel shows him at, so he stays sharp on a retina
# screen without shipping the full 1536px plate.
TARGET_WIDTH = 520


def box_filter(values: np.ndarray, radius: int, combine) -> np.ndarray:
    """Separable min/max over a square window of the given radius."""
    out = values.copy()
    for shift in range(1, radius + 1):
        out = combine(out, np.roll(values, shift, axis=0))
        out = combine(out, np.roll(values, -shift, axis=0))
    rows = out.copy()
    for shift in range(1, radius + 1):
        out = combine(out, np.roll(rows, shift, axis=1))
        out = combine(out, np.roll(rows, -shift, axis=1))
    return out


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """True wherever any pixel within `radius` (Chebyshev) is true."""
    return box_filter(mask, radius, np.logical_or)


def erode(mask: np.ndarray, radius: int) -> np.ndarray:
    """True only where every pixel within `radius` (Chebyshev) is true."""
    out = ~dilate(~mask, radius)
    # `roll` wraps, so the outermost rows and columns are unreliable. They are
    # all backdrop on this plate, and seeding them is exactly what is wanted.
    out[:radius, :] = mask[:radius, :]
    out[-radius:, :] = mask[-radius:, :]
    out[:, :radius] = mask[:, :radius]
    out[:, -radius:] = mask[:, -radius:]
    return out


def flood_from_border(mask: np.ndarray) -> np.ndarray:
    """Every cell of `mask` reachable four-way from the image border."""
    height, width = mask.shape
    filled = np.zeros_like(mask)
    queue = deque()

    def seed(y: int, x: int) -> None:
        if mask[y, x] and not filled[y, x]:
            filled[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        if y > 0:
            seed(y - 1, x)
        if y + 1 < height:
            seed(y + 1, x)
        if x > 0:
            seed(y, x - 1)
        if x + 1 < width:
            seed(y, x + 1)

    return filled


def distance_to(mask: np.ndarray, cap: int) -> np.ndarray:
    """Chebyshev distance to the nearest true cell, saturating at `cap`."""
    distance = np.full(mask.shape, cap, dtype=np.int16)
    distance[mask] = 0
    reached = mask.copy()

    for step in range(1, cap):
        grown = dilate(mask, step)
        distance[grown & ~reached] = step
        reached = grown

    return distance


def cut_background(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image).astype(np.int16).copy()
    value = rgba[:, :, :3].max(axis=2)

    texture = (box_filter(value, TEXTURE_RADIUS, np.maximum)
               - box_filter(value, TEXTURE_RADIUS, np.minimum))
    smooth = texture <= SMOOTH_MAX

    # `roll` wraps, so the outermost band compares the top of the plate against
    # the bottom and reads as texture that is not there -- which left a dashed
    # line of stray pixels along the top edge. The plate's border is backdrop
    # all the way round, so it is simply declared so.
    smooth[:TEXTURE_RADIUS, :] = True
    smooth[-TEXTURE_RADIUS:, :] = True
    smooth[:, :TEXTURE_RADIUS] = True
    smooth[:, -TEXTURE_RADIUS:] = True

    backdrop = flood_from_border(erode(smooth, ERODE_RADIUS))
    artwork = (~smooth) & (~backdrop)

    to_backdrop = distance_to(backdrop, DISTANCE_CAP).astype(np.float32)
    to_artwork = distance_to(artwork, DISTANCE_CAP).astype(np.float32)

    alpha = np.clip((to_backdrop - to_artwork + FEATHER) / (2 * FEATHER), 0, 1) * 255
    alpha = np.where(artwork, 255, alpha)
    alpha = np.where(backdrop, 0, alpha)

    rgba[:, :, 3] = alpha.astype(np.int16)
    return Image.fromarray(rgba.astype(np.uint8), "RGBA")


def trim(image: Image.Image) -> Image.Image:
    """Crops to what is actually drawn, ignoring the odd near-clear speck."""
    alpha = np.asarray(image)[:, :, 3]
    rows = np.flatnonzero((alpha > TRIM_FLOOR).any(axis=1))
    columns = np.flatnonzero((alpha > TRIM_FLOOR).any(axis=0))
    if rows.size == 0 or columns.size == 0:
        raise SystemExit("The cut removed everything -- check SMOOTH_MAX.")
    return image.crop((columns[0], rows[0], columns[-1] + 1, rows[-1] + 1))


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source plate: {SOURCE}")

    image = trim(cut_background(Image.open(SOURCE).convert("RGBA")))

    height = round(image.height * TARGET_WIDTH / image.width)
    image = image.resize((TARGET_WIDTH, height), Image.LANCZOS)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUTPUT, optimize=True)
    print(f"{OUTPUT.relative_to(ROOT)}  {image.width}x{image.height}")


if __name__ == "__main__":
    main()
