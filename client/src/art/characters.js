/**
 * The angler sprites.
 *
 * There are several interchangeable sheets, one per look, listed in
 * `ANGLER_VARIANTS`. Each player is assigned one at random when their avatar
 * first appears, so a busy harbor reads as a crowd of different people rather
 * than one man cloned.
 *
 * Every sheet is the same shape: four columns of animation frames by eight
 * rows of poses (four walking facings, then the four casting ones), 96x96
 * cells, feet grounded on the same row. That shared geometry -- frame size,
 * rows, frame counts, feet anchor -- comes out of `fisherman.json`, built by
 * `tools/build_character.py` for the original sheet; the extra sheets were
 * drawn to match it. Nothing here hardcodes the layout.
 *
 * The one thing that genuinely differs per sheet is the rod: each is drawn at
 * a slightly different length and angle, so a sheet may carry its own
 * `rodTips` and `rodTipFor` prefers those over the manifest's.
 *
 * (This replaces the old hue-shifted-outfit scheme. That only ever worked on
 * the flat-palette chibi template; the current painterly art has thousands of
 * near-unique colours and nothing to swap, so every player rendered
 * identically. Variety now comes from genuinely different sheets.)
 */

export const POSE_WALK = 'walk';
export const POSE_FISH = 'fish';

/**
 * The interchangeable angler sheets.
 *
 * `image` is the path Phaser loads (relative to `client/public/`); `key` is
 * both the loader key and the texture key the sprites end up using.
 *
 * `rodTips` overrides the rod-tip offsets from `fisherman.json` for sheets
 * whose rod reaches further than the original's. Offsets are in frame pixels
 * relative to the feet anchor -- the same space `fisherman.json` uses -- and
 * were measured off each sheet's own casting rows. `null` means "use the
 * manifest's", which is right for the sheet the manifest was built from.
 *
 * To add another look: drop a 384x768 sheet into `client/public/assets/`,
 * append an entry here, and it joins the rotation. Nothing else needs editing.
 */
export const ANGLER_VARIANTS = [
  {
    key: 'fisherman',
    image: 'assets/fisherman.png',
    rodTips: null,
  },
  {
    key: 'fisherman-2',
    image: 'assets/fisherman-2.png',
    rodTips: {
      'fish-down': { x: 24, y: 2 },
      'fish-right': { x: 29, y: -27 },
      'fish-up': { x: 28, y: -29 },
      'fish-left': { x: -27, y: -28 },
    },
  },
  {
    key: 'fisherman-3',
    image: 'assets/fisherman-3.png',
    rodTips: {
      'fish-down': { x: 24, y: 2 },
      'fish-right': { x: 23, y: -28 },
      'fish-up': { x: 23, y: -26 },
      'fish-left': { x: -30, y: -29 },
    },
  },
  {
    key: 'fisherman-4',
    image: 'assets/fisherman-4.png',
    rodTips: {
      'fish-down': { x: 18, y: 0 },
      'fish-right': { x: 22, y: -25 },
      'fish-up': { x: 22, y: -31 },
      'fish-left': { x: -26, y: -26 },
    },
  },
];

/** A random sheet index. Callers cache the result per player -- see HarborScene. */
export function randomVariantIndex() {
  return Math.floor(Math.random() * ANGLER_VARIANTS.length);
}

/** Bounds-checked lookup, so a stale or out-of-range index can never crash a spawn. */
export function variantAt(index) {
  return ANGLER_VARIANTS[index % ANGLER_VARIANTS.length] ?? ANGLER_VARIANTS[0];
}

/* ---------------------------------------------------------------- textures */

/**
 * Names every frame on a variant's sheet as `${pose}-${index}` and returns its
 * texture key. Cheap to call repeatedly -- the frames are added once, so every
 * later player on the same sheet reuses them.
 */
export function makeAnglerTexture(scene, variantIndex, meta) {
  const { key } = variantAt(variantIndex);
  const texture = scene.textures.get(key);

  // `walk-down-0` is added first below, so its presence means this sheet has
  // already been cut and there is nothing left to do.
  if (texture.has('walk-down-0')) return key;

  const { frameWidth, frameHeight, poses } = meta;
  for (const [pose, info] of Object.entries(poses)) {
    for (let index = 0; index < info.frames; index += 1) {
      texture.add(
        `${pose}-${index}`,
        0,
        index * frameWidth,
        info.row * frameHeight,
        frameWidth,
        frameHeight,
      );
    }
  }

  return key;
}

/** Frame name for a pose/facing/frame, falling back if the sheet lacks it. */
export function frameName(meta, kind, facing, index) {
  const pose = `${kind}-${facing}`;
  if (meta.poses[pose]) return `${pose}-${index % meta.poses[pose].frames}`;
  return `walk-down-0`;
}

/**
 * Where the line meets the water for a facing, relative to the feet anchor.
 *
 * Prefers the variant's own measurement, because the sheets draw the rod at
 * different lengths; falls back to the manifest, then to a stub just above the
 * feet so a missing pose can never produce a NaN line.
 */
export function rodTipFor(meta, facing, variantIndex = 0) {
  const pose = `fish-${facing}`;
  return variantAt(variantIndex).rodTips?.[pose]
    ?? meta.poses[pose]?.rodTip
    ?? { x: 0, y: -4 };
}
