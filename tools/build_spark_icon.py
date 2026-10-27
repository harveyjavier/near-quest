"""Build the Fishing Power / XP sparkle.

`.icon--xp` in `client/src/style.css` was the emoji star at U+2B50, which is
whatever five-pointed cartoon star the viewer's emoji font happens to ship.
This replaces it with a four-pointed gold sparkle of our own, so the icon a
player sees for Fishing Power is the same on every machine.

Unlike `build_gold_icon.py` and `build_bait_icon.py`, this one has no supplied
plate to crop -- so it draws the sparkle instead, and that changes the rules:

  * Those scripts must not resample, because their source is pixel art and a
    resize would land the artist's pixels off the grid. This one is drawn
    smooth on purpose, so it renders on a supersampled field and box-filters
    down. That is the correct technique here and the wrong one there.
  * The output is 64px rather than the 12-14px those sheets carry, because the
    HUD draws this icon anywhere from a 16px list row up to the chest reveal,
    and a smooth icon should be filtered down rather than blown up.

If a plate does turn up -- drop a transparent PNG at
`assets/generated/spark-icon.png` -- this script prefers it and falls back to
cropping and centring it the way the other icon builders do, so swapping in
supplied art is a re-run rather than a rewrite.

Run from the repository root:

    python tools/build_spark_icon.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/spark.png
"""

import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

SOURCE = "spark-icon.png"
OPAQUE = 128

SIZE = 64        # the written frame, square
SS = 8           # supersample factor for the drawn version

# How concave the arms are. The shape is the superellipse |x|^n + |y|^n = r^n;
# below 1 it pinches inwards into a four-pointed star, and the lower it goes
# the thinner the arms. 2/3 is the astroid, which is spindlier than this icon
# wants -- 0.7 gives arms with enough body to still read as a sparkle at 16px.
EXPONENT = 0.7

# Centre outwards, keyed on the plain circular distance rather than on the
# star's own radius, so the bright core stays round and the colour deepens
# along the arms.
STOPS = [
    (0.00, (255, 250, 214)),
    (0.22, (255, 226, 120)),
    (0.50, (250, 182, 45)),
    (0.80, (238, 140, 22)),
    (1.00, (206, 98, 10)),
]

GLOW_RGB = (255, 178, 58)
GLOW_ALPHA = 0.30
GLOW_FALLOFF = 14.0


def alpha_bbox(rgba):
    solid = rgba[:, :, 3] > OPAQUE
    ys, xs = np.nonzero(solid)
    if len(xs) == 0:
        raise SystemExit("source has no opaque pixels")
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def from_plate(path):
    """The other builders' technique: crop to the art, centre it, no resample."""
    rgba = np.asarray(Image.open(path).convert("RGBA"))
    x0, y0, x1, y1 = alpha_bbox(rgba)
    crop = rgba[y0:y1, x0:x1]
    h, w = crop.shape[:2]

    cell = max(w, h)
    frame = np.zeros((cell, cell, 4), dtype=np.uint8)
    ox, oy = (cell - w) // 2, (cell - h) // 2
    frame[oy:oy + h, ox:ox + w] = crop
    return frame, f"{cell}x{cell} from {path.name}, 1:1"


def ramp(t):
    """The gradient above, sampled at t in [0, 1]. Returns float RGB."""
    positions = np.array([stop for stop, _ in STOPS])
    colours = np.array([rgb for _, rgb in STOPS], dtype=float)
    return np.stack(
        [np.interp(t, positions, colours[:, channel]) for channel in range(3)],
        axis=-1,
    )


def drawn():
    """Render the sparkle on an SS-times field, then box-filter it down."""
    hi = SIZE * SS
    # Pixel centres in a [-1, 1] square, so the tips land just inside the edge.
    axis = (np.arange(hi) + 0.5) / hi * 2 - 1
    y, x = np.meshgrid(axis, axis, indexing="ij")

    reach = 0.97
    ax, ay = np.abs(x) / reach, np.abs(y) / reach

    # The superellipse radius: 1 exactly on the star's outline, <1 inside.
    # `hypot`-style rather than a boolean test so the glow can key off it too.
    star = (ax ** EXPONENT + ay ** EXPONENT) ** (1 / EXPONENT)
    inside = star <= 1

    circular = np.clip(np.hypot(x, y) / reach, 0, 1)
    rgb = ramp(circular)

    alpha = inside.astype(float)

    # A soft halo just outside the outline, so the sparkle sits on the panel
    # rather than being cut out of it.
    glow = np.where(
        inside, 0.0, GLOW_ALPHA * np.exp(-GLOW_FALLOFF * (star - 1))
    )
    rgb = np.where(inside[..., None], rgb, np.array(GLOW_RGB, dtype=float))
    alpha = np.maximum(alpha, np.clip(glow, 0, 1))

    # Premultiply before downsampling: averaging straight colour across the
    # outline would pull the transparent pixels' RGB into the edge and fringe
    # it dark.
    premul = rgb * alpha[..., None]

    def box(field):
        shaped = field.reshape(SIZE, SS, SIZE, SS, -1)
        return shaped.mean(axis=(1, 3))

    small_premul = box(premul)
    small_alpha = box(alpha[..., None])[..., 0]

    with np.errstate(invalid="ignore", divide="ignore"):
        small_rgb = np.where(
            small_alpha[..., None] > 0,
            small_premul / np.maximum(small_alpha[..., None], 1e-6),
            0.0,
        )

    frame = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    frame[..., :3] = np.clip(np.rint(small_rgb), 0, 255).astype(np.uint8)
    frame[..., 3] = np.clip(np.rint(small_alpha * 255), 0, 255).astype(np.uint8)
    return frame, f"{SIZE}x{SIZE} drawn at {SS}x and filtered down"


def main():
    plate = SOURCE_DIR / SOURCE
    frame, note = from_plate(plate) if plate.exists() else drawn()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(frame, "RGBA").save(OUT_DIR / "spark.png")

    print(f"wrote spark.png  {note}")
    print("  -> .icon--xp in client/src/style.css draws this")


if __name__ == "__main__":
    main()
