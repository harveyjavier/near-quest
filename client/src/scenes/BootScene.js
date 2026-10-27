/**
 * Loads the harbor, angler and fish artwork, generates effect textures, then
 * hands over to HarborScene. Required asset failures show a loading error.
 */

import Phaser from 'phaser';

import { ANGLER_VARIANTS } from '../art/characters.js';
import { makeEffectTextures } from '../art/effects.js';
import { FONT_FAMILY, PALETTE } from '../art/palette.js';
import { SHEETS } from '../art/icons.js';
import { TILE } from '../world/level.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    this.showProgress();

    // The environment is a single illustrated 1536x1024 harbor backdrop.
    // Movement still uses a separate invisible collision grid in level.js.
    this.load.image('harbor-environment', 'assets/harbor-environment.png');

    // Every interchangeable angler sheet loads as a plain image; frames are
    // named per pose the first time a player is spawned onto that sheet (see
    // art/characters.js). They all share one manifest -- same grid, same rows,
    // same feet anchor -- so only the images vary.
    for (const variant of ANGLER_VARIANTS) {
      this.load.image(variant.key, variant.image);
    }
    this.load.json('fisherman-meta', 'assets/fisherman.json');

    // Species sprites, cut from the GDD's fish plate by tools/build_icons.py.
    // Frame size comes from art/icons.js, which the DOM HUD reads too.
    this.load.spritesheet('fish', 'assets/fish.png', {
      frameWidth: SHEETS.fish.width,
      frameHeight: SHEETS.fish.height,
    });

    this.load.on('loaderror', (file) => {
      console.error('Failed to load asset:', file.key, file.src);
      this.loadFailed = true;
    });
  }

  create() {
    makeEffectTextures(this);

    if (this.loadFailed) {
      this.showLoadFailure();
      return;
    }

    const anglerMeta = this.cache.json.get('fisherman-meta');
    if (!anglerMeta?.poses) {
      this.showLoadFailure();
      return;
    }

    this.scene.start('Harbor', { anglerMeta });
  }

  showProgress() {
    const { width, height } = this.scale;
    const barWidth = Math.min(280, width * 0.6);

    const label = this.add.text(width / 2, height / 2 - 28, 'Loading the harbor', {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: PALETTE.panelInk,
    }).setOrigin(0.5);

    const track = this.add.rectangle(width / 2, height / 2, barWidth, 10, 0x000000, 0.35);
    const fill = this.add.rectangle(
      width / 2 - barWidth / 2, height / 2, 2, 10, Number.parseInt(PALETTE.gold.slice(1), 16),
    ).setOrigin(0, 0.5);

    this.load.on('progress', (value) => {
      fill.width = Math.max(2, barWidth * value);
    });

    this.load.on('complete', () => {
      label.destroy();
      track.destroy();
      fill.destroy();
    });
  }

  showLoadFailure() {
    const { width, height } = this.scale;
    this.add.text(
      width / 2,
      height / 2,
      'Could not load the harbor art.\nCheck that /assets/harbor-environment.png was deployed.',
      {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        color: '#ff9a9a',
        align: 'center',
      },
    ).setOrigin(0.5);
  }
}
