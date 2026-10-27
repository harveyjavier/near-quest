"""Build the bait sprite from the supplied curled-worm art, at full resolution.

Bait used to be the third cell cut from the Resources_Icon.png plate (see
`tools/build_icons.py`), then a tin-of-worms icon; it now uses a new supplied
pink curled-worm icon instead, the same situation the gem tiers were already
in, so this follows the same technique: the source is used pixel-for-pixel,
cropped to its alpha bounding box -- no resize, no resample, no quantise.
Whatever the client asks for is a scale on the frame, not a rebuild of the
plate.

The frame size the client reads (bait.json's frameWidth/frameHeight) is the
cropped art's own size, not a number picked here. Declaring anything else would
have the browser resample the plate before a caller's `scale` ever applies --
at 1x the art has to land on screen pixel for pixel.

Run from the repository root:

    python tools/build_bait_icon.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/bait.png + .json
"""

import json
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

SOURCE = "pink-worm-bait-pixel-art-16.png"
OPAQUE = 128


def alpha_bbox(rgba):
    solid = rgba[:, :, 3] > OPAQUE
    ys, xs = np.nonzero(solid)
    if len(xs) == 0:
        raise SystemExit("source has no opaque pixels")
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def main():
    rgba = np.asarray(Image.open(SOURCE_DIR / SOURCE).convert("RGBA"))
    x0, y0, x1, y1 = alpha_bbox(rgba)
    crop = rgba[y0:y1, x0:x1]
    h, w = crop.shape[:2]

    # The declared frame is square (DISPLAY_SIZE x DISPLAY_SIZE), same as
    # every other sheet here -- background-size stretches to that box, so a
    # non-square crop left as-is would come out squashed. Centring it in a
    # square canvas keeps the tin's real proportions.
    cell = max(w, h)
    frame = np.zeros((cell, cell, 4), dtype=np.uint8)
    ox, oy = (cell - w) // 2, (cell - h) // 2
    frame[oy:oy + h, ox:ox + w] = crop

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(frame, "RGBA").save(OUT_DIR / "bait.png")

    (OUT_DIR / "bait.json").write_text(
        json.dumps(
            {
                "image": "bait.png",
                "frameWidth": cell,
                "frameHeight": cell,
                "frames": {"bait": 0},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote bait.png  {cell}x{cell} native, 1:1 at scale 1")
    print("  -> SHEETS.bait in client/src/art/icons.js must say the same size")


if __name__ == "__main__":
    main()
