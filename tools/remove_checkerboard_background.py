from collections import deque
from pathlib import Path
import sys

from PIL import Image


def is_checkerboard_pixel(red: int, green: int, blue: int, alpha: int) -> bool:
    """Match only the nearly white/gray squares used for the displayed canvas."""
    # The UI checkerboard is made of neutral white and gray shades, including
    # blended boundary pixels. Requiring a neutral color and a bright value
    # avoids treating the warm/cool highlights inside the actual tiles as canvas.
    return alpha > 0 and min(red, green, blue) >= 210 and max(red, green, blue) - min(red, green, blue) <= 8


def remove_connected_checkerboard(source: Path, destination: Path) -> None:
    image = Image.open(source).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    visited = bytearray(width * height)
    queue = deque()

    def add_if_background(x: int, y: int) -> None:
        index = y * width + x
        if not visited[index] and is_checkerboard_pixel(*pixels[x, y]):
            visited[index] = 1
            queue.append((x, y))

    for x in range(width):
        add_if_background(x, 0)
        add_if_background(x, height - 1)
    for y in range(height):
        add_if_background(0, y)
        add_if_background(width - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    add_if_background(nx, ny)

    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)


if __name__ == "__main__":
    remove_connected_checkerboard(Path(sys.argv[1]), Path(sys.argv[2]))
