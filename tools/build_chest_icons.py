"""Build the chest sprite sheet from the four supplied chest icons.

Unlike the fish and resource plates -- one image holding every icon, resampled
down to a pixel grid by `tools/build_icons.py` -- the chests arrive as four
separate files that are already real pixel art at the size the game draws them.
So this script does not touch them: no crop, no resample, no palette pass. It
lays the four frames out side by side in tier order and writes the metadata
`client/src/art/icons.js` reads back.

Every frame keeps the source's own padding, which is what holds the four
chests in register: they are drawn on a common 32x32 canvas, so a chest that
sits two pixels lower than its neighbour was drawn that way on purpose.

Run from the repository root:

    python tools/build_chest_icons.py

Outputs (committed, so a fresh clone needs no Python):
    client/public/assets/chests.png + .json
"""

import json
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "generated"
OUT_DIR = ROOT / "client" / "public" / "assets"

# Tier ids in frame order, written out rather than derived from a server
# config, so that reordering the catalog cannot silently swap every sprite.
CHESTS = [
    ("common", "chest-common.png"),
    ("rare", "chest-rare.png"),
    ("epic", "chest-epic.png"),
    ("legendary", "chest-legendary.png"),
]


def main():
    arts = [Image.open(SOURCE_DIR / source).convert("RGBA") for _, source in CHESTS]

    sizes = {art.size for art in arts}
    if len(sizes) != 1:
        raise SystemExit(f"chests differ in size: {sorted(sizes)}")
    frame_w, frame_h = arts[0].size

    sheet = Image.new("RGBA", (frame_w * len(arts), frame_h))
    for index, art in enumerate(arts):
        sheet.paste(art, (index * frame_w, 0))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT_DIR / "chests.png", optimize=True)

    meta = {
        "image": "chests.png",
        "frameWidth": frame_w,
        "frameHeight": frame_h,
        "frames": {tier: index for index, (tier, _) in enumerate(CHESTS)},
    }
    (OUT_DIR / "chests.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"chests.png  {frame_w}x{frame_h} per frame, {len(arts)} frames")


if __name__ == "__main__":
    main()
