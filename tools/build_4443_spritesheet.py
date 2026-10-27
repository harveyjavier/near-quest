"""Create a 384x768 transparent pixel-art angler sheet from the supplied pose sheet.

The source sheet supplies every silhouette, animation stage, and rod placement.
Only its palette and face/outfit details are changed to match character 4443.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(r"C:/Users/miker/Downloads/fisherman.png")
OUTPUT = ROOT / "assets/generated/fisherman-4443-spritesheet.png"
FRAME = 96
ROWS, COLUMNS = 8, 4

# Template palette -> the green-suited fisherman palette.  Every source
# transparent pixel remains transparent, so the output has no background.
PALETTE = {
    (47, 37, 34): (45, 25, 17),       # ink outline
    (250, 243, 232): (247, 191, 144), # face highlight
    (231, 213, 198): (222, 151, 111), # face midtone
    (209, 157, 167): (183, 108, 79),  # face shade
    (79, 158, 140): (65, 150, 89),    # jacket light
    (43, 96, 88): (31, 93, 58),       # jacket shadow
    (125, 90, 52): (166, 105, 48),    # fishing rod
    (185, 179, 161): (117, 75, 52),   # subdued cloth/edge shade
    (217, 201, 163): (246, 246, 239), # white shirt
}

INK = (45, 25, 17, 255)
HAT_DARK = (79, 42, 25, 255)
HAT = (119, 67, 42, 255)
HAT_LIGHT = (148, 87, 55, 255)
HAT_BAND = (67, 31, 43, 255)
HAIR = (67, 35, 21, 255)
BLUE = (20, 95, 214, 255)
LENS = (18, 29, 38, 255)
BEARD = (73, 38, 23, 255)
BEARD_LIGHT = (103, 56, 35, 255)
RED = (213, 35, 44, 255)
WHITE = (246, 246, 239, 255)


def put(frame: np.ndarray, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= x < FRAME and 0 <= y < FRAME:
        frame[y, x] = color


def rect(frame: np.ndarray, left: int, top: int, right: int, bottom: int,
         color: tuple[int, int, int, int]) -> None:
    left, right = max(0, left), min(FRAME - 1, right)
    top, bottom = max(0, top), min(FRAME - 1, bottom)
    if left <= right and top <= bottom:
        frame[top : bottom + 1, left : right + 1] = color


def body_bounds(frame: np.ndarray) -> tuple[int, int, int, int]:
    """Find the central character without letting a fishing rod change its bounds."""
    alpha = frame[:, :, 3] > 0
    ys, xs = np.where(alpha & (np.indices(alpha.shape)[1] >= 20) &
                      (np.indices(alpha.shape)[1] <= 75))
    if not len(xs):
        raise ValueError("empty frame")
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def hat(frame: np.ndarray, cx: int, top: int) -> None:
    """A compact fedora: stays inside the template's existing 32px-wide head space."""
    # crown outline and stepped brown crown
    rect(frame, cx - 8, top, cx + 8, top + 7, INK)
    rect(frame, cx - 6, top + 1, cx + 6, top + 6, HAT)
    rect(frame, cx - 5, top + 1, cx + 4, top + 2, HAT_LIGHT)
    rect(frame, cx - 7, top + 6, cx + 7, top + 7, HAT_BAND)
    # brim is deliberately bounded to the original character width.
    rect(frame, cx - 14, top + 8, cx + 14, top + 10, INK)
    rect(frame, cx - 13, top + 8, cx + 13, top + 9, HAT_DARK)
    rect(frame, cx - 10, top + 8, cx + 10, top + 8, HAT)


def front_details(frame: np.ndarray, cx: int, top: int) -> None:
    # blue sunglasses with two black lenses and a white glint
    rect(frame, cx - 12, top + 12, cx - 2, top + 17, BLUE)
    rect(frame, cx + 2, top + 12, cx + 12, top + 17, BLUE)
    rect(frame, cx - 10, top + 13, cx - 3, top + 16, LENS)
    rect(frame, cx + 3, top + 13, cx + 10, top + 16, LENS)
    rect(frame, cx - 2, top + 14, cx + 2, top + 15, BLUE)
    put(frame, cx - 9, top + 13, WHITE)
    put(frame, cx + 4, top + 13, WHITE)
    # beard covers the lower face while leaving the central mouth highlight.
    rect(frame, cx - 10, top + 22, cx + 10, top + 27, BEARD)
    rect(frame, cx - 8, top + 21, cx + 8, top + 23, BEARD)
    rect(frame, cx - 6, top + 24, cx + 6, top + 28, BEARD_LIGHT)
    rect(frame, cx - 2, top + 23, cx + 2, top + 25, (247, 191, 144, 255))


def side_details(frame: np.ndarray, cx: int, top: int, facing_right: bool) -> None:
    direction = 1 if facing_right else -1
    # A single blue lens projects from the face-facing side.
    lens_left = cx + (1 if facing_right else -11)
    rect(frame, lens_left, top + 12, lens_left + 9, top + 17, BLUE)
    rect(frame, lens_left + 2, top + 13, lens_left + 8, top + 16, LENS)
    put(frame, lens_left + 3, top + 13, WHITE)
    # Short side beard, shifted toward the nose/front of the pose.
    beard_left = cx - 2 if facing_right else cx - 9
    rect(frame, beard_left, top + 21, beard_left + 10, top + 28, BEARD)
    rect(frame, beard_left + (2 if facing_right else 0), top + 24,
         beard_left + (8 if facing_right else 6), top + 28, BEARD_LIGHT)
    # a small hair curl visible beneath the hat at the back of the head
    put(frame, cx - direction * 10, top + 17, HAIR)
    put(frame, cx - direction * 11, top + 18, HAIR)


def back_details(frame: np.ndarray, cx: int, top: int) -> None:
    # Hair below the fedora, visible across the back of the head.
    rect(frame, cx - 10, top + 12, cx + 10, top + 22, HAIR)
    rect(frame, cx - 8, top + 13, cx + 8, top + 17, (91, 49, 29, 255))


def tie(frame: np.ndarray, cx: int, top: int) -> None:
    # White collar and red tie sit on the template's existing torso.  The
    # narrow geometry preserves the original arms and walking/fishing pose.
    rect(frame, cx - 4, top + 30, cx + 4, top + 32, WHITE)
    rect(frame, cx - 2, top + 31, cx + 2, top + 37, RED)
    put(frame, cx - 1, top + 38, RED)
    put(frame, cx + 1, top + 38, RED)


def decorate(frame: np.ndarray, row: int) -> np.ndarray:
    left, top, right, _bottom = body_bounds(frame)
    cx = round((left + right) / 2)
    hat(frame, cx, top)
    if row in (0, 4):
        front_details(frame, cx, top)
        tie(frame, cx, top)
    elif row in (2, 6):
        back_details(frame, cx, top)
    else:
        side_details(frame, cx, top, facing_right=row in (1, 5))
        tie(frame, cx, top)
    return frame


def recolor(sheet: np.ndarray) -> np.ndarray:
    result = sheet.copy()
    for old, new in PALETTE.items():
        mask = np.all(result[:, :, :3] == old, axis=2) & (result[:, :, 3] > 0)
        result[mask, :3] = new
    return result


def main() -> None:
    source = np.asarray(Image.open(SOURCE).convert("RGBA"))
    if source.shape != (768, 384, 4):
        raise ValueError(f"Expected a 384x768 source sheet, got {source.shape[1]}x{source.shape[0]}")

    output = recolor(source)
    for row in range(ROWS):
        for column in range(COLUMNS):
            y, x = row * FRAME, column * FRAME
            output[y : y + FRAME, x : x + FRAME] = decorate(
                output[y : y + FRAME, x : x + FRAME].copy(), row
            )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(output, "RGBA").save(OUTPUT)
    print(OUTPUT)
    print(f"size={Image.open(OUTPUT).size}; mode={Image.open(OUTPUT).mode}")


if __name__ == "__main__":
    main()
