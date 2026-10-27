/**
 * The game's colour palette, shared by the Phaser scenes and the DOM HUD.
 *
 * Kept as plain hex strings here and mirrored as CSS custom properties in
 * style.css, so a palette change is a two-file edit rather than a hunt.
 */

export const PALETTE = {
  skyTop: '#1b3a5c',
  skyBottom: '#2d5f86',

  waterDeep: '#14496e',
  waterMid: '#1d5f8a',
  waterLight: '#2b7ba8',
  waterFoam: '#7fc4dd',

  dockDark: '#4a2f1c',
  dockMid: '#6b4526',
  dockLight: '#8a5c33',
  dockPlank: '#a3743f',

  grassDark: '#1f5c2a',
  grassMid: '#2c7a38',
  grassLight: '#3d9648',

  panel: '#1e2749',
  panelLight: '#2b376b',
  panelBorder: '#4a5aa8',
  panelInk: '#e8ecff',
  panelMuted: '#8f9bd0',

  gold: '#f5c542',
  goldDark: '#c99a1f',

  bait: '#b5762f',
  coin: '#f7cf5a',
  gem: '#b45cf0',

  rarity: {
    common: '#9fb7c4',
    uncommon: '#6fbf73',
    rare: '#4a9fd8',
    epic: '#a95fd8',
    legendary: '#f5c542',
  },

  /**
   * Chest body colours per tier.
   *
   * COUPLING: mirrors CHEST_TIERS in server/src/config/rewards.config.js. The
   * server sends its colour with every chest for the HUD to use; these are for
   * the world sprite, which is baked per tier at boot rather than tinted --
   * tinting multiplies, so a brown chest tinted brown just goes black.
   */
  chest: {
    common: '#a8763f',
    rare: '#4a9fd8',
    epic: '#a95fd8',
    legendary: '#f5c542',
  },

  ink: '#0d1226',
  white: '#ffffff',
};

/** Phaser wants integers; the DOM wants strings. */
export const hex = (value) => Number.parseInt(value.replace('#', ''), 16);

/**
 * The one face the whole game uses, for canvas text as well as the DOM.
 *
 * Declared here rather than read back off the stylesheet because Phaser builds
 * a canvas font shorthand from it, and the @font-face rule in style.css is
 * what actually loads the file. Keep the two in step.
 */
export const FONT_FAMILY =
  '"Jersey 10", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
