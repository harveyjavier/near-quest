"""Build the angler sprite sheet from the detective-style character art.

Source: `assets/sprites/character-base.png` -- a single 1024x1536 sheet, 4
columns of animation frames by 8 rows of poses, each cell a 256x192 canvas.
Unlike the chibi template this replaces, this is painterly AI-generated
pixel-art-style art (soft shading, thousands of near-unique colours, no
flat palette to hue-shift), supplied already dressed and already holding a
rod in the fishing poses -- so there is no shirt-painting and no rod-drawing
step here, just extraction.

Row layout -- already in the exact order the game's poses need, no mirroring
required (the left-facing frames are drawn separately from the right-facing
ones, not simple mirrors of them):

    row 0  walk-down     row 4  fish-down
    row 1  walk-right    row 5  fish-right
    row 2  walk-up       row 6  fish-up
    row 3  walk-left     row 7  fish-left

Because the source art is hand/AI-composed per cell rather than drawn on a
mechanical baseline grid, the figure sits at a different height and scale in
every cell (a fishing pose with the rod held up reaches higher in its cell
than a walking pose does). Anchoring every frame to the same fixed
cell-relative point, the way the old chibi-template build did, would make the
figure bob up and down between poses. Instead each frame is auto-cropped to
its own alpha bounding box, scaled by one fixed factor common to the whole
sheet, and re-centred so its *own* feet sit on the same output row -- the
figure is always grounded, and the fixed scale keeps it the same size in
every pose.

Three cells (fish-down, fish-right, fish-up) also carry a small disconnected
fleck of opaque pixels below the figure -- the next pose's hat brim bleeding
a couple of pixels past its own cell boundary in the source generation.
`isolate_figure` drops anything not attached to the cell's main blob before
cropping, so a stray fleck never rides along into the output or skews a
bounding box. Two of those same three poses (fish-right, fish-up) also have
their hat crown clipped flat by the top of their own cell in the source
art itself -- a generation flaw already baked into the pixels, which no
amount of cropping here can recover.

No per-player outfit colour variation: the art has no small set of flat
jacket colours left to hue-shift (recolourBody in art/characters.js only
swaps exact colour matches, and here almost every pixel is unique), so the
sheet ships with no `recolour` entry and every player renders the same
look. `makeAnglerTexture` already treats a missing `recolour` as "skip
recolouring", so nothing elsewhere needs to change for that.

Run from the repository root:

    python tools/build_character.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/fisherman.png
    client/public/assets/fisherman.json
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/sprites/character-base.png"
OUT_DIR = ROOT / "client/public/assets"

#: The source sheet's own grid: 4 animation frames by 8 poses, each a
#: 256x192 canvas.
GRID_COLUMNS = 4
GRID_ROWS = 8
CELL_WIDTH = 256
CELL_HEIGHT = 192

#: Row order -- already the game's pose order, top to bottom.
POSE_ORDER = [
    "walk-down", "walk-right", "walk-up", "walk-left",
    "fish-down", "fish-right", "fish-up", "fish-left",
]

#: Below this alpha a pixel doesn't count as part of the figure -- keeps the
#: soft-edged antialiasing of this art from puffing up every bounding box.
ALPHA_THRESHOLD = 20

#: Three of the eight cells (fish-down, fish-right, fish-up) carry a second,
#: disconnected fleck of opaque pixels a few rows below the figure -- the
#: neighbouring pose's hat brim bleeding a couple of pixels past its own
#: cell boundary. Anything not attached to the figure's own solid mass
#: (alpha above this, well past antialiasing) is discarded before the crop,
#: so a stray fleck never gets pasted in or pulls the bounding box down.
STRONG_ALPHA_THRESHOLD = 60
CORE_DILATION_PX = 3

#: Reference frame used to fix the sheet's scale: walk-down's first frame,
#: measured hat-to-boots. Every other frame is scaled by the same factor, so
#: the figure is one consistent size across every pose.
REFERENCE_POSE = "walk-down"
REFERENCE_FRAME = 0

#: Target hat-to-boots height in the output, chosen to match the world scale
#: the chibi template this replaces used (the harbour's tiles, railings and
#: NPCs were all sized around a ~48px-tall angler).
TARGET_BODY_HEIGHT = 48

#: Output geometry. Square frames big enough for the tallest, widest pose
#: (a fishing hold with the rod reaching up or out) once scaled, with the
#: figure's own bounding box re-centred into each frame every time.
FRAME = 96
FEET_Y = 64

#: A rod tip reads as a pale, near-white pixel far from the figure's centre
#: of mass -- true for every facing here, and distinct from the only other
#: near-white detail (the glasses' lens highlight), which sits close to the
#: head rather than out at the end of the rod.
PALE_CHANNEL_MIN = 170
PALE_ALPHA_MIN = 100


def load_sheet() -> np.ndarray:
    sheet = np.array(Image.open(SOURCE).convert("RGBA"))
    expected = (GRID_ROWS * CELL_HEIGHT, GRID_COLUMNS * CELL_WIDTH, 4)
    if sheet.shape != expected:
        raise RuntimeError(f"{SOURCE.name}: expected {expected}, got {sheet.shape}")
    return sheet


def cell(sheet: np.ndarray, row: int, column: int) -> np.ndarray:
    top, left = row * CELL_HEIGHT, column * CELL_WIDTH
    return sheet[top : top + CELL_HEIGHT, left : left + CELL_WIDTH]


def isolate_figure(figure: np.ndarray) -> np.ndarray:
    """Zeroes out any opaque pixels not attached to the cell's main figure.

    See STRONG_ALPHA_THRESHOLD above for why this is needed. Labels the
    solidly-opaque pixels into connected blobs, keeps only the largest, then
    grows that keep-mask a few pixels so the figure's own soft antialiased
    edge (which dips below STRONG_ALPHA_THRESHOLD) isn't cut off with it.
    """
    alpha = figure[:, :, 3]
    strong = alpha > STRONG_ALPHA_THRESHOLD
    labels, count = ndimage.label(strong)
    if count <= 1:
        return figure

    sizes = ndimage.sum(strong, labels, range(1, count + 1))
    largest = int(np.argmax(sizes)) + 1
    keep = ndimage.binary_dilation(labels == largest, iterations=CORE_DILATION_PX)

    cleaned = figure.copy()
    cleaned[~keep] = 0
    return cleaned


def bounds(figure: np.ndarray) -> tuple[int, int, int, int]:
    """Bounding box of the drawn figure as (top, left, bottom, right), both ends inclusive."""
    ys, xs = np.where(figure[:, :, 3] > ALPHA_THRESHOLD)
    if len(ys) == 0:
        raise RuntimeError("empty cell")
    return int(ys.min()), int(xs.min()), int(ys.max()), int(xs.max())


def find_rod_tip(figure: np.ndarray, top: int, left: int, bottom: int, right: int) -> tuple[int, int] | None:
    """The rod's tip: the palest pixel farthest from the figure's own bbox centre."""
    rgb = figure[:, :, :3].astype(int)
    alpha = figure[:, :, 3]
    pale = (
        (alpha > PALE_ALPHA_MIN)
        & (rgb[:, :, 0] > PALE_CHANNEL_MIN)
        & (rgb[:, :, 1] > PALE_CHANNEL_MIN)
        & (rgb[:, :, 2] > PALE_CHANNEL_MIN)
    )
    ys, xs = np.where(pale)
    if len(ys) == 0:
        return None
    cx, cy = (left + right) / 2, (top + bottom) / 2
    distance = (xs - cx) ** 2 + (ys - cy) ** 2
    index = int(np.argmax(distance))
    return int(xs[index]), int(ys[index])


def build_frame(
    figure: np.ndarray, scale: float, tip: tuple[int, int] | None,
) -> tuple[np.ndarray, tuple[int, int] | None]:
    """Crops `figure` to content, scales it, and re-centres it feet-down in an output frame."""
    top, left, bottom, right = bounds(figure)
    crop = figure[top : bottom + 1, left : right + 1]

    height, width = crop.shape[:2]
    scaled_w, scaled_h = max(1, round(width * scale)), max(1, round(height * scale))
    scaled = np.array(
        Image.fromarray(crop).resize((scaled_w, scaled_h), Image.LANCZOS)
    )

    dest_left = round(FRAME / 2 - scaled_w / 2)
    dest_top = round(FEET_Y - scaled_h)

    frame = np.zeros((FRAME, FRAME, 4), dtype=np.uint8)
    paste(frame, scaled, dest_top, dest_left)

    if tip is None:
        return frame, None

    tip_x, tip_y = tip
    out_x = dest_left + round((tip_x - left) * scale)
    out_y = dest_top + round((tip_y - top) * scale)
    return frame, (out_x - FRAME // 2, out_y - FEET_Y)


def paste(canvas: np.ndarray, patch: np.ndarray, top: int, left: int) -> None:
    """Copies the opaque pixels of `patch` onto `canvas`, clipping at the edges."""
    height, width = patch.shape[:2]
    dy0, dx0 = max(0, top), max(0, left)
    dy1 = min(canvas.shape[0], top + height)
    dx1 = min(canvas.shape[1], left + width)
    if dy1 <= dy0 or dx1 <= dx0:
        return

    source = patch[dy0 - top : dy1 - top, dx0 - left : dx1 - left]
    window = canvas[dy0:dy1, dx0:dx1]
    keep = source[:, :, 3] > 0
    window[keep] = source[keep]


def main() -> int:
    if not SOURCE.exists():
        print(f"Source sheet not found: {SOURCE}")
        return 1

    sheet = load_sheet()

    reference_row = POSE_ORDER.index(REFERENCE_POSE)
    ref_figure = isolate_figure(cell(sheet, reference_row, REFERENCE_FRAME))
    ref_top, _ref_left, ref_bottom, _ref_right = bounds(ref_figure)
    scale = TARGET_BODY_HEIGHT / (ref_bottom - ref_top + 1)

    frames: dict[str, list[np.ndarray]] = {}
    rod_tips: dict[str, tuple[int, int]] = {}

    for row_index, pose in enumerate(POSE_ORDER):
        built = []
        for column in range(GRID_COLUMNS):
            figure = isolate_figure(cell(sheet, row_index, column))
            tip = None
            if pose.startswith("fish-") and pose not in rod_tips:
                top, left, bottom, right = bounds(figure)
                tip = find_rod_tip(figure, top, left, bottom, right)
            frame, out_tip = build_frame(figure, scale, tip)
            built.append(frame)
            if out_tip is not None:
                rod_tips[pose] = out_tip
        frames[pose] = built

    output = np.zeros((len(POSE_ORDER) * FRAME, GRID_COLUMNS * FRAME, 4), dtype=np.uint8)
    poses: dict[str, dict] = {}
    for row_index, pose in enumerate(POSE_ORDER):
        for column_index, frame in enumerate(frames[pose]):
            output[
                row_index * FRAME : (row_index + 1) * FRAME,
                column_index * FRAME : (column_index + 1) * FRAME,
            ] = frame
        poses[pose] = {"row": row_index, "frames": len(frames[pose])}
        if pose in rod_tips:
            x, y = rod_tips[pose]
            poses[pose]["rodTip"] = {"x": x, "y": y}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(output, "RGBA").save(OUT_DIR / "fisherman.png")
    (OUT_DIR / "fisherman.json").write_text(
        json.dumps(
            {
                "image": "fisherman.png",
                "frameWidth": FRAME,
                "frameHeight": FRAME,
                "columns": GRID_COLUMNS,
                "feetY": FEET_Y,
                "bodyHeight": TARGET_BODY_HEIGHT,
                "poses": poses,
                "source": SOURCE.name,
            },
            indent=2,
        )
        + "\n"
    )

    print(f"Wrote {len(poses)} poses at {FRAME}x{FRAME} to {OUT_DIR}")
    print(f"  scale {scale:.3f}x, body {TARGET_BODY_HEIGHT}px, feet row {FEET_Y}")
    for pose, entry in poses.items():
        tip = entry.get("rodTip")
        print(f"  {pose:12s} row {entry['row']} frames {entry['frames']}"
              + (f"  rodTip {tip}" if tip else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
