/**
 * Item sprite sheets.
 *
 * Fish are built by `tools/build_icons.py` from the supplied icon plate; the
 * chests come from separate 32x32 icons, already pixel art at the size the game draws them,
 * and `tools/build_chest_icons.py` only lays them side by side. The gems are
 * built by `tools/build_gem_icons.py` (the rough, uncut stone a chest pays
 * out) and `tools/build_cut_gem_icons.py` (the finished gem the appraisal
 * counter switches to once a stone has been graded) -- two sheets, same four
 * tiers, same 24x24 frame size, so a caller's `scale` means the same thing
 * on either one. Bait, gold and pearl each have their own supplied art too,
 * built by `tools/build_bait_icon.py`, `tools/build_gold_icon.py` and
 * `tools/build_pearl_icon.py`. Frame indices are written out here rather
 * than derived from the catalog's array order, so that reordering a server
 * config cannot silently swap every sprite in the game.
 *
 * The DOM HUD draws these as CSS backgrounds and Phaser loads the same PNGs as
 * spritesheets, so the frame sizes below are the single source of truth for
 * both. They must match the generated `*.json` beside each PNG.
 */

export const SHEETS = {
  fish: {
    url: '/assets/fish.png',
    width: 45,
    height: 39,
    frames: {
      muddy_carp: 0,
      speckled_trout: 1,
      whiskered_catfish: 2,
      golden_koi: 3,
      moonfish: 4,
      leviathan: 5,
    },
  },
  chests: {
    url: '/assets/chests.png',
    width: 32,
    height: 32,
    frames: { common: 0, rare: 1, epic: 2, legendary: 3 },
  },
  gems: {
    url: '/assets/gems.png',
    width: 24,
    height: 24,
    frames: { emerald: 0, ruby: 1, sapphire: 2, diamond: 3, spark: 4 },
  },
  gemsCut: {
    url: '/assets/gems-cut.png',
    width: 24,
    height: 24,
    frames: { emerald: 0, ruby: 1, sapphire: 2, diamond: 3 },
  },
  bait: {
    url: '/assets/bait.png',
    width: 14,
    height: 14,
    frames: { bait: 0 },
  },
  gold: {
    url: '/assets/gold.png',
    width: 12,
    height: 12,
    frames: { gold: 0 },
  },
  pearl: {
    url: '/assets/pearl.png',
    width: 12,
    height: 12,
    frames: { pearls: 0 },
  },
};

/**
 * The `scale` that fits a sheet's frame inside a `box`-pixel square.
 *
 * Frame sizes differ per sheet -- a fish is 45x39, a curl of bait 14x14 -- so a
 * caller that wants a row of mixed items to read at one size asks for a box
 * rather than a multiplier, and lets each sheet work out its own.
 *
 * Enlarging snaps down to a whole multiple. A sprite blown up by 1.8x has one
 * source pixel covering two screen pixels and the next covering one, which on
 * art this small reads as mush; landing on 1x or 2x keeps every pixel square,
 * the same rule the chest reel already followed by hand. Shrinking has no such
 * step to land on, so it takes the exact fraction and lets the browser filter.
 */
export function fitScale(sheet, box) {
  const meta = SHEETS[sheet];
  if (!meta) return 1;
  const native = Math.max(meta.width, meta.height);
  return box >= native ? Math.floor(box / native) : box / native;
}

/** Frame index of `id` on `sheet`, or null when there is no artwork for it. */
export function frameIndex(sheet, id) {
  return SHEETS[sheet]?.frames[id] ?? null;
}

/**
 * A DOM sprite, or null when the sheet has no frame for `id` -- callers fall
 * back to the flat rarity colour they used before the sheets existed.
 *
 * `scale` multiplies the native frame size; the sheets are drawn with
 * `image-rendering: pixelated`, so whole-number scales stay crisp.
 */
export function spriteIcon(sheet, id, scale = 1) {
  const meta = SHEETS[sheet];
  const frame = frameIndex(sheet, id);
  if (!meta || frame === null) return null;

  const el = document.createElement('i');
  el.className = 'sprite';
  applySprite(el, sheet, id, scale);
  return el;
}

/** Paints an existing element as a sprite. Returns false if there is no frame. */
export function applySprite(el, sheet, id, scale = 1) {
  const meta = SHEETS[sheet];
  const frame = frameIndex(sheet, id);
  if (!meta || frame === null) return false;

  const width = meta.width * scale;
  const height = meta.height * scale;
  const count = Object.keys(meta.frames).length;

  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.style.backgroundImage = `url("${meta.url}")`;
  el.style.backgroundSize = `${width * count}px ${height}px`;
  el.style.backgroundPosition = `-${frame * width}px 0`;
  el.style.backgroundRepeat = 'no-repeat';
  return true;
}
